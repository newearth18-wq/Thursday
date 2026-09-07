"""Voice front end: microphone in, speech out."""

from __future__ import annotations

__all__ = ["build_transcriber", "build_speaker", "VoiceLoop"]


def __getattr__(name: str):  # lazy so importing the package never needs audio deps
    if name == "build_transcriber":
        from .stt import build_transcriber

        return build_transcriber
    if name == "build_speaker":
        from .tts import build_speaker

        return build_speaker
    if name == "VoiceLoop":
        from .loop import VoiceLoop

        return VoiceLoop
    raise AttributeError(name)
