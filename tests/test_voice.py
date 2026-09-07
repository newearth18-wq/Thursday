"""Voice helpers - the parts that work without a microphone."""

from __future__ import annotations

import pytest

from thursday.voice.loop import SentenceBuffer, classify_answer, strip_wake_word
from thursday.voice.stt import build_transcriber
from thursday.voice.tts import PrintSpeaker, build_speaker, clean_for_speech


def test_sentence_buffer_releases_whole_sentences():
    buffer = SentenceBuffer()

    assert buffer.push("Good morning") == []
    assert buffer.push(", sir. The car ") == ["Good morning, sir."]
    assert buffer.push("is ready.\n") == ["The car is ready."]
    assert buffer.flush() == ""


def test_sentence_buffer_breaks_up_run_on_text():
    # Thai often has no sentence-ending punctuation, so length has to break it.
    buffer = SentenceBuffer(max_chars=30)
    released = buffer.push("word " * 20)

    assert released
    assert all(len(sentence) <= 30 for sentence in released)


def test_sentence_buffer_flush_returns_the_tail():
    buffer = SentenceBuffer()
    buffer.push("No punctuation here")
    assert buffer.flush() == "No punctuation here"
    assert buffer.flush() == ""


@pytest.mark.parametrize(
    ("heard", "expected"),
    [
        ("hey thursday what is the time", (True, "what is the time")),
        ("Thursday, lights on", (True, "lights on")),
        ("เธิร์สเดย์ เปิดไฟหน่อย", (True, "เปิดไฟหน่อย")),
        ("what is the time", (False, "what is the time")),
        ("thursday", (True, "")),
    ],
)
def test_strip_wake_word(heard, expected):
    assert strip_wake_word(heard, ("thursday", "เธิร์สเดย์")) == expected


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ("yes please", True),
        ("go ahead", True),
        ("ตกลง", True),
        ("no, stop", False),
        ("ไม่", False),
        ("the weather is nice", None),
    ],
)
def test_classify_answer(answer, expected):
    assert classify_answer(answer) is expected


def test_clean_for_speech_removes_things_that_sound_wrong():
    spoken = clean_for_speech("**Ready**, sir. See https://example.com/x for `details` 🎉")
    assert spoken == "Ready, sir. See a link for details"


def test_speech_disabled_returns_no_transcriber():
    class VoiceSettings:
        stt_backend = "none"

    assert build_transcriber(VoiceSettings()) is None


def test_unknown_stt_backend_is_reported():
    from thursday.voice.stt import MissingBackend

    class VoiceSettings:
        stt_backend = "telepathy"

    with pytest.raises(MissingBackend):
        build_transcriber(VoiceSettings())


def test_speaker_falls_back_when_nothing_is_installed():
    class VoiceSettings:
        tts_backend = "none"
        tts_voice = ""
        tts_rate = 175

    assert isinstance(build_speaker(VoiceSettings()), PrintSpeaker)


# ------------------------------------------------------- who is speaking


def test_the_voice_loop_tells_the_agent_who_it_is_talking_to(tmp_path, monkeypatch):
    """Recognising the voice is only half of it. The other half is whose:
    without this, a member or guest whose voice passed the check was still
    served as the owner, with every tool the owner has."""
    import asyncio

    from thursday.voice import loop as loop_module
    from thursday.voice.loop import VoiceLoop

    # The microphone wants a sound stack this machine has no reason to have.
    monkeypatch.setattr(loop_module, "Microphone", lambda *a, **k: None)

    class FakeAgent:
        def __init__(self):
            from thursday.config import Settings

            self.settings = Settings(
                workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=()
            )
            self.told = []

        def set_confirm_handler(self, handler):
            pass

        def speaking_to(self, name):
            self.told.append(name)

        async def start(self):
            pass

        async def close(self):
            pass

        async def run(self, text, session_id="", on_event=None):
            self._running = False
            return "ok"

    class Silent:
        def say(self, text):
            pass

        def wait(self):
            pass

        def stop(self):
            pass

    agent = FakeAgent()
    loop = VoiceLoop(agent, transcriber=None, speaker=Silent())

    heard = iter(["thursday, what time is it", ""])

    async def listen(start_timeout=0.0):
        try:
            return next(heard)
        except StopIteration:
            loop._running = False
            return ""

    async def allowed():
        return True, "Nok"

    loop._listen = listen
    loop._speaker_allowed = allowed
    loop._answer = lambda command: asyncio.sleep(0)
    loop._build_proactive = lambda: type(
        "P", (), {"start": lambda self: type("T", (), {"cancel": lambda self: None})()}
    )()

    asyncio.run(loop.run())

    assert agent.told == ["Nok"]


def test_nobody_recognised_resets_to_the_default(tmp_path):
    """Otherwise a guest's restrictions would linger over whoever spoke next."""
    from thursday.voice.loop import VoiceLoop

    source = __import__("inspect").getsource(VoiceLoop.run)

    assert "self.agent.speaking_to(who or None)" in source
