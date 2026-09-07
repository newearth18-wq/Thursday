"""Speech to text.

Backends are chosen by `THURSDAY_STT_BACKEND`; everything is imported lazily so
the rest of Thursday runs on a machine with no audio stack at all.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger(__name__)


class Transcriber(Protocol):
    """Turns mono PCM audio into text."""

    def transcribe(self, audio: Any, sample_rate: int) -> str: ...


class MissingBackend(RuntimeError):
    """Raised when the configured backend is not installed."""


def write_wav(path: Path, audio: Any, sample_rate: int) -> Path:
    """Write float32 (-1..1) or int16 mono samples to a 16-bit WAV file."""
    import numpy as np

    samples = np.asarray(audio)
    if samples.dtype != np.int16:
        samples = np.clip(samples, -1.0, 1.0)
        samples = (samples * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(samples.tobytes())
    return path


class WhisperTranscriber:
    """faster-whisper: local, accurate, handles Thai and English out of the box."""

    def __init__(self, model: str = "base", language: str | None = None) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # pragma: no cover - depends on the install
            raise MissingBackend(
                "faster-whisper is not installed; run: pip install 'thursday[voice]'"
            ) from exc
        log.info("loading whisper model %s", model)
        self._model = WhisperModel(model, device="auto", compute_type="int8")
        self._language = language

    def transcribe(self, audio: Any, sample_rate: int) -> str:
        import numpy as np

        samples = np.asarray(audio, dtype=np.float32).flatten()
        if sample_rate != 16000:  # whisper expects 16 kHz
            samples = _resample(samples, sample_rate, 16000)
        segments, _ = self._model.transcribe(
            samples,
            language=self._language,
            vad_filter=True,
            beam_size=5,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()


class VoskTranscriber:
    """Vosk: much smaller and faster than whisper, at some cost in accuracy."""

    def __init__(self, model_path: str) -> None:
        try:
            from vosk import KaldiRecognizer, Model
        except ImportError as exc:  # pragma: no cover
            raise MissingBackend("vosk is not installed; run: pip install vosk") from exc
        self._model = Model(model_path)
        self._recognizer_cls = KaldiRecognizer

    def transcribe(self, audio: Any, sample_rate: int) -> str:
        import json

        import numpy as np

        samples = np.asarray(audio)
        if samples.dtype != np.int16:
            samples = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
        recognizer = self._recognizer_cls(self._model, sample_rate)
        recognizer.AcceptWaveform(samples.tobytes())
        return json.loads(recognizer.FinalResult()).get("text", "").strip()


class WhisperCppTranscriber:
    """Shells out to a whisper.cpp binary, for setups that already have one."""

    def __init__(self, binary: str, model_path: str, language: str | None = None) -> None:
        resolved = shutil.which(binary)
        if resolved is None:
            raise MissingBackend(f"{binary} is not on PATH")
        self._binary = resolved
        self._model_path = model_path
        self._language = language

    def transcribe(self, audio: Any, sample_rate: int) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            wav = write_wav(Path(tmp) / "input.wav", audio, sample_rate)
            command = [self._binary, "-m", self._model_path, "-f", str(wav), "-nt"]
            if self._language:
                command += ["-l", self._language]
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            return result.stdout.strip()


def _resample(samples: Any, source_rate: int, target_rate: int) -> Any:
    """Linear resampling - good enough ahead of whisper's own front end."""
    import numpy as np

    if source_rate == target_rate:
        return samples
    duration = len(samples) / source_rate
    target_length = int(duration * target_rate)
    if target_length <= 0:
        return samples
    source_index = np.linspace(0, len(samples) - 1, num=target_length)
    return np.interp(source_index, np.arange(len(samples)), samples).astype(np.float32)


def build_transcriber(voice_settings: Any) -> Transcriber | None:
    """Instantiate the configured backend, or return None if speech is off."""
    backend = (getattr(voice_settings, "stt_backend", "") or "").lower()
    if backend in {"", "none", "off"}:
        return None
    if backend in {"faster-whisper", "whisper"}:
        return WhisperTranscriber(
            getattr(voice_settings, "stt_model", "base"),
            getattr(voice_settings, "stt_language", None),
        )
    if backend == "vosk":
        return VoskTranscriber(getattr(voice_settings, "stt_model", "model"))
    if backend in {"whisper.cpp", "whisper-cpp"}:
        return WhisperCppTranscriber(
            "whisper-cli",
            getattr(voice_settings, "stt_model", "models/ggml-base.bin"),
            getattr(voice_settings, "stt_language", None),
        )
    raise MissingBackend(f"unknown STT backend: {backend}")
