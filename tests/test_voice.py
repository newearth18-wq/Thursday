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
