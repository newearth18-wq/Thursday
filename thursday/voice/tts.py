"""Text to speech.

`auto` picks the best backend that is actually present: piper (local neural
voices), macOS `say`, espeak-ng, then pyttsx3. Speech runs in a worker thread so
a long reply never blocks the microphone.
"""

from __future__ import annotations

import logging
import platform
import queue
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger(__name__)

# Strip things that sound like noise when read out loud.
_MARKDOWN_RE = re.compile(r"(\*\*|__|`{1,3}|^#{1,6}\s*|^\s*[-*]\s+)", re.MULTILINE)
_URL_RE = re.compile(r"https?://\S+")
_EMOJI_RE = re.compile("[\U0001f300-\U0001faff\U00002600-\U000027bf]")


def clean_for_speech(text: str) -> str:
    """Make written text sound reasonable when spoken."""
    text = _URL_RE.sub("a link", text)
    text = _MARKDOWN_RE.sub("", text)
    text = _EMOJI_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


class Speaker(Protocol):
    def say(self, text: str) -> None: ...
    def stop(self) -> None: ...
    def wait(self) -> None: ...


class _SubprocessSpeaker:
    """Base for backends that shell out to a command line synthesiser."""

    def __init__(self) -> None:
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._process: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()
        self._idle = threading.Event()
        self._idle.set()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def _command(self, text: str) -> list[str]:  # pragma: no cover - overridden
        raise NotImplementedError

    def _speak_now(self, text: str) -> None:
        command = self._command(text)
        with self._lock:
            self._process = subprocess.Popen(
                command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        self._process.wait()
        with self._lock:
            self._process = None

    def _run(self) -> None:
        while True:
            text = self._queue.get()
            if text is None:
                return
            self._idle.clear()
            try:
                self._speak_now(text)
            except Exception:  # a failed synthesiser must not kill the thread
                log.exception("speech failed")
            finally:
                if self._queue.empty():
                    self._idle.set()

    def say(self, text: str) -> None:
        cleaned = clean_for_speech(text)
        if cleaned:
            self._idle.clear()
            self._queue.put(cleaned)

    def stop(self) -> None:
        """Drop anything queued and cut off the current utterance."""
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                self._process.terminate()
        self._idle.set()

    def wait(self) -> None:
        """Block until everything queued has been spoken."""
        self._idle.wait()


class MacSpeaker(_SubprocessSpeaker):
    def __init__(self, voice: str = "", rate: int = 175) -> None:
        self._voice = voice
        self._rate = rate
        super().__init__()

    def _command(self, text: str) -> list[str]:
        command = ["say", "-r", str(self._rate)]
        if self._voice:
            command += ["-v", self._voice]
        return [*command, text]


class EspeakSpeaker(_SubprocessSpeaker):
    def __init__(self, voice: str = "", rate: int = 175, binary: str = "espeak-ng") -> None:
        self._binary = binary
        self._voice = voice
        self._rate = rate
        super().__init__()

    def _command(self, text: str) -> list[str]:
        command = [self._binary, "-s", str(self._rate)]
        if self._voice:
            command += ["-v", self._voice]
        return [*command, text]


class PiperSpeaker:
    """piper-tts writes a WAV, which we hand to whatever player is available."""

    def __init__(self, model: str, player: str | None = None) -> None:
        if shutil.which("piper") is None:
            raise RuntimeError("piper is not on PATH; pip install piper-tts")
        self._model = model
        self._player = player or _find_player()
        if self._player is None:
            raise RuntimeError("no audio player found (install sox, ffmpeg or alsa-utils)")
        self._lock = threading.Lock()

    def say(self, text: str) -> None:
        cleaned = clean_for_speech(text)
        if not cleaned:
            return
        with self._lock, tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "speech.wav"
            subprocess.run(
                ["piper", "--model", self._model, "--output_file", str(wav)],
                input=cleaned.encode("utf-8"),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            subprocess.run(
                [*self._player, str(wav)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )

    def stop(self) -> None:
        return None

    def wait(self) -> None:
        return None


class Pyttsx3Speaker:
    """Cross-platform fallback built on the system's native voices."""

    def __init__(self, voice: str = "", rate: int = 175) -> None:
        import pyttsx3

        self._engine = pyttsx3.init()
        self._engine.setProperty("rate", rate)
        if voice:
            self._engine.setProperty("voice", voice)
        self._lock = threading.Lock()

    def say(self, text: str) -> None:
        cleaned = clean_for_speech(text)
        if not cleaned:
            return
        with self._lock:
            self._engine.say(cleaned)
            self._engine.runAndWait()

    def stop(self) -> None:
        try:
            self._engine.stop()
        except Exception:  # pragma: no cover
            pass

    def wait(self) -> None:
        return None


class PrintSpeaker:
    """No synthesiser available - show what would have been said."""

    def say(self, text: str) -> None:
        cleaned = clean_for_speech(text)
        if cleaned:
            print(f"[speech] {cleaned}")

    def stop(self) -> None:
        return None

    def wait(self) -> None:
        return None


def _find_player() -> list[str] | None:
    for candidate in (["play", "-q"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"], ["aplay", "-q"]):
        if shutil.which(candidate[0]):
            return candidate
    return None


def build_speaker(voice_settings: Any) -> Speaker:
    """Build the configured speaker, falling back until something works."""
    backend = (getattr(voice_settings, "tts_backend", "auto") or "auto").lower()
    voice = getattr(voice_settings, "tts_voice", "")
    rate = getattr(voice_settings, "tts_rate", 175)

    def make(name: str) -> Speaker | None:
        try:
            if name == "piper":
                if not voice:
                    return None
                return PiperSpeaker(voice)
            if name == "say":
                return MacSpeaker(voice, rate) if shutil.which("say") else None
            if name == "espeak":
                binary = shutil.which("espeak-ng") or shutil.which("espeak")
                return EspeakSpeaker(voice, rate, binary) if binary else None
            if name == "pyttsx3":
                return Pyttsx3Speaker(voice, rate)
            if name == "none":
                return PrintSpeaker()
        except Exception as exc:
            log.warning("TTS backend %s unavailable: %s", name, exc)
        return None

    if backend != "auto":
        return make(backend) or PrintSpeaker()

    order = ["piper", "say", "espeak", "pyttsx3"]
    if platform.system() != "Darwin":
        order.remove("say")
        order.append("say")
    for name in order:
        speaker = make(name)
        if speaker is not None:
            log.info("using TTS backend: %s", name)
            return speaker
    return PrintSpeaker()
