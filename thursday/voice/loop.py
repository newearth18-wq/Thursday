"""The always-on voice loop: wake word, listen, answer, speak."""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import re
import time
from typing import Any, Callable

from ..agent import Agent
from ..events import Event
from ..identity import Doorman, Enrolment, MissingBackend, build_encoder

log = logging.getLogger(__name__)

# Sentence enders for English and Thai text; Thai often has none, so the
# chunker also breaks on newlines and on length.
_SENTENCE_END = re.compile(r"(?<=[.!?ฯ。])\s+|\n+")
_AFFIRMATIVE = ("yes", "yeah", "yep", "sure", "do it", "go ahead", "confirm", "ok", "okay",
                "ใช่", "ตกลง", "เอาเลย", "ทำเลย", "โอเค")
_NEGATIVE = ("no", "nope", "stop", "cancel", "don't", "do not", "ไม่", "หยุด", "ยกเลิก")


class SentenceBuffer:
    """Collects streamed tokens and releases whole sentences for speaking."""

    def __init__(self, max_chars: int = 160) -> None:
        self._buffer = ""
        self._max_chars = max_chars

    def push(self, text: str) -> list[str]:
        self._buffer += text
        sentences: list[str] = []
        while True:
            match = _SENTENCE_END.search(self._buffer)
            if match:
                sentence = self._buffer[: match.start()].strip()
                self._buffer = self._buffer[match.end():]
                if sentence:
                    sentences.append(sentence)
                continue
            if len(self._buffer) > self._max_chars:
                cut = self._buffer.rfind(" ", 0, self._max_chars)
                if cut <= 0:
                    cut = self._max_chars
                sentence = self._buffer[:cut].strip()
                self._buffer = self._buffer[cut:].lstrip()
                if sentence:
                    sentences.append(sentence)
                continue
            return sentences

    def flush(self) -> str:
        remainder, self._buffer = self._buffer.strip(), ""
        return remainder


class Microphone:
    """Records utterances: waits for speech, stops on silence."""

    def __init__(self, sample_rate: int = 16000, block_ms: int = 30) -> None:
        if importlib.util.find_spec("sounddevice") is None:  # pragma: no cover
            raise RuntimeError(
                "sounddevice is not installed; run: pip install 'thursday[voice]'"
            )
        self.sample_rate = sample_rate
        self.block_size = int(sample_rate * block_ms / 1000)

    def record_utterance(
        self,
        threshold: float = 0.02,
        silence_timeout: float = 1.2,
        max_seconds: float = 20.0,
        start_timeout: float = 0.0,
    ) -> Any:
        """Return the recorded samples, or None if nobody spoke."""
        import numpy as np
        import sounddevice as sd

        frames: list[Any] = []
        started = False
        last_voice = time.monotonic()
        begin = time.monotonic()

        with sd.InputStream(
            samplerate=self.sample_rate, channels=1, dtype="float32", blocksize=self.block_size
        ) as stream:
            while True:
                block, _ = stream.read(self.block_size)
                mono = block[:, 0]
                level = float(np.sqrt(np.mean(np.square(mono))))
                now = time.monotonic()

                if level > threshold:
                    if not started:
                        started = True
                    last_voice = now
                    frames.append(mono.copy())
                elif started:
                    frames.append(mono.copy())
                    if now - last_voice > silence_timeout:
                        break
                elif start_timeout and now - begin > start_timeout:
                    return None

                if started and now - begin > max_seconds:
                    break

        if not frames:
            return None
        return np.concatenate(frames)


def strip_wake_word(text: str, wake_words: tuple[str, ...]) -> tuple[bool, str]:
    """Return (heard_wake_word, the command with the wake word removed)."""
    lowered = text.lower()
    for word in wake_words:
        index = lowered.find(word.lower())
        if index == -1:
            continue
        remainder = text[index + len(word):]
        return True, remainder.lstrip(" ,.!?ๆ").strip()
    return False, text.strip()


def classify_answer(text: str) -> bool | None:
    """Interpret a spoken yes/no. None means it was neither."""
    lowered = text.lower().strip()
    if any(word in lowered for word in _NEGATIVE):
        return False
    if any(word in lowered for word in _AFFIRMATIVE):
        return True
    return None


class VoiceLoop:
    """Ties microphone, transcriber, agent and speaker together."""

    def __init__(
        self,
        agent: Agent,
        transcriber: Any,
        speaker: Any,
        session_id: str = "voice",
        on_transcript: Callable[[str, str], None] | None = None,
    ) -> None:
        self.agent = agent
        self.transcriber = transcriber
        self.speaker = speaker
        self.session_id = session_id
        self.settings = agent.settings.voice
        self.microphone = Microphone(self.settings.sample_rate)
        self.on_transcript = on_transcript or (lambda who, text: None)
        self._last_audio: Any = None
        self._running = False
        agent.set_confirm_handler(self._confirm_by_voice)

        # Speaker recognition, when asked for. It identifies rather than
        # authenticates - a recording of your voice would pass - so it gates
        # who Thursday acts for, not what protects your keys.
        self.enrolment = Enrolment.load(agent.settings.enrolment_path)
        self.doorman = Doorman(policy=agent.settings.identity, enrolment=self.enrolment)
        self._voice_encoder: Any = None
        if self.doorman.policy in {"voice", "either", "both"}:
            try:
                self._voice_encoder = build_encoder("voice")
            except MissingBackend as exc:
                log.warning("speaker recognition unavailable: %s", exc)

    # ----------------------------------------------------------------- pieces

    async def _listen(self, start_timeout: float = 0.0) -> str:
        audio = await asyncio.to_thread(
            self.microphone.record_utterance,
            self.settings.vad_threshold,
            self.settings.silence_timeout,
            self.settings.max_utterance,
            start_timeout,
        )
        if audio is None:
            self._last_audio = None
            return ""
        self._last_audio = audio      # kept for the speaker check
        text = await asyncio.to_thread(
            self.transcriber.transcribe, audio, self.settings.sample_rate
        )
        return text.strip()

    async def _speaker_allowed(self) -> tuple[bool, str]:
        """Whether the person who just spoke is someone Thursday knows."""
        if not self.doorman.enforced() or self._voice_encoder is None:
            return True, ""
        if self._last_audio is None:
            return True, ""

        try:
            embedding = await asyncio.to_thread(
                self._voice_encoder.encode, self._last_audio, self.settings.sample_rate
            )
        except Exception:  # a failed check must not lock the owner out silently
            log.exception("speaker check failed")
            return True, ""

        match = self.enrolment.identify(embedding, "voice")
        return self.doorman.admits([match])

    async def _confirm_by_voice(self, title: str, detail: str) -> bool:
        """Tool confirmation, asked out loud."""
        question = f"{title}. Shall I go ahead?"
        self.on_transcript("thursday", question)
        self.speaker.say(question)
        self.speaker.wait()
        for _ in range(2):
            answer = await self._listen(start_timeout=8.0)
            if not answer:
                break
            self.on_transcript("you", answer)
            decision = classify_answer(answer)
            if decision is not None:
                return decision
            self.speaker.say("Yes or no?")
            self.speaker.wait()
        return False

    async def _answer(self, command: str) -> None:
        buffer = SentenceBuffer()

        async def on_event(event: Event) -> None:
            if event.type == "text":
                for sentence in buffer.push(event.text):
                    self.speaker.say(sentence)
            elif event.type == "error":
                self.speaker.say(event.text)

        await self.agent.run(command, session_id=self.session_id, on_event=on_event)
        remainder = buffer.flush()
        if remainder:
            self.speaker.say(remainder)
        self.speaker.wait()

    async def _reminder_watcher(self) -> None:
        """Speak reminders when they come due."""
        while self._running:
            try:
                for reminder in self.agent.memory.due_reminders():
                    line = f"Reminder: {reminder.text}"
                    self.on_transcript("thursday", line)
                    self.speaker.say(line)
                    self.agent.memory.mark_fired(reminder.id)
            except Exception:  # pragma: no cover - never kill the loop
                log.exception("reminder check failed")
            await asyncio.sleep(15)

    # ------------------------------------------------------------------- loop

    async def run(self) -> None:
        """Listen until interrupted."""
        self._running = True
        await self.agent.start()
        watcher = asyncio.create_task(self._reminder_watcher())
        wake_words = self.settings.wake_words
        try:
            while self._running:
                heard = await self._listen()
                if not heard:
                    continue

                if self.settings.always_listening:
                    command = heard
                else:
                    woken, command = strip_wake_word(heard, wake_words)
                    if not woken:
                        log.debug("ignored (no wake word): %s", heard)
                        continue
                    if not command:
                        # Woken with nothing after it - acknowledge and listen on.
                        self.speaker.say("Yes?")
                        self.speaker.wait()
                        command = await self._listen(start_timeout=6.0)
                        if not command:
                            continue

                allowed, who = await self._speaker_allowed()
                if not allowed:
                    log.info("ignored a command from an unrecognised voice")
                    self.speaker.say("I do not recognise your voice.")
                    self.speaker.wait()
                    continue

                self.on_transcript("you", command)
                self.speaker.stop()  # barge-in: drop whatever we were saying
                await self._answer(command)
        finally:
            self._running = False
            watcher.cancel()
            await self.agent.close()

    def stop(self) -> None:
        self._running = False
