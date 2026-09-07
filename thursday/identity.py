"""Recognising who is in front of Thursday, by face and by voice.

**This is identification, not authentication.** A photograph on a phone screen
will pass a face check and a recording will pass a voice check, so nothing
here is what stops a stranger using your assistant - `auth.py` and its token
do that. What this adds is the assistant knowing *which* person it is talking
to, and refusing to act for someone it does not know.

Enrolment stores embeddings - short lists of numbers - never photographs or
recordings. The matching is plain Python so it works everywhere and can be
tested; only the backends that turn an image or a clip into an embedding need
optional libraries, and they say plainly when they are missing.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import logging
import math
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

log = logging.getLogger(__name__)

Embedding = Sequence[float]

#: How close two embeddings must be to count as the same person. Lower is
#: stricter. The face default follows dlib's usual 0.6 recommendation.
FACE_THRESHOLD = 0.6
VOICE_THRESHOLD = 0.32

#: off - anyone may talk; face/voice - that check must pass; either - one of
#: them; both - both of them.
POLICIES = ("off", "face", "voice", "either", "both")


# ------------------------------------------------------------------- maths


def distance(left: Embedding, right: Embedding) -> float:
    """Euclidean distance between two embeddings of the same length."""
    if len(left) != len(right):
        raise ValueError(f"embeddings differ in length: {len(left)} vs {len(right)}")
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right)))


def cosine_distance(left: Embedding, right: Embedding) -> float:
    """1 - cosine similarity, which is what speaker models usually want."""
    if len(left) != len(right):
        raise ValueError(f"embeddings differ in length: {len(left)} vs {len(right)}")
    dot = sum(a * b for a, b in zip(left, right))
    norm = math.sqrt(sum(a * a for a in left)) * math.sqrt(sum(b * b for b in right))
    if norm == 0:
        return 1.0
    return 1.0 - (dot / norm)


@dataclass
class Match:
    """Who the sample looked like, and how sure that is."""

    name: str = ""
    distance: float = float("inf")
    threshold: float = 0.0
    modality: str = ""

    @property
    def recognised(self) -> bool:
        return bool(self.name) and self.distance <= self.threshold

    @property
    def confidence(self) -> float:
        """0 at the threshold, 1 for an exact match. For display only."""
        if not self.threshold:
            return 0.0
        return max(0.0, min(1.0, 1.0 - self.distance / self.threshold))

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "recognised": self.recognised,
            "distance": round(self.distance, 4) if self.distance != float("inf") else None,
            "confidence": round(self.confidence, 3),
            "modality": self.modality,
        }


# ---------------------------------------------------------------- storage


@dataclass
class Enrolment:
    """Everyone Thursday has been introduced to."""

    path: Path
    #: name -> modality -> list of embeddings
    people: dict[str, dict[str, list[list[float]]]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | str) -> "Enrolment":
        target = Path(path)
        try:
            raw = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = {}
        people: dict[str, dict[str, list[list[float]]]] = {}
        for name, modalities in (raw.get("people") or {}).items():
            if not isinstance(modalities, dict):
                continue
            people[name] = {
                modality: [[float(x) for x in sample] for sample in samples if sample]
                for modality, samples in modalities.items()
                if isinstance(samples, list)
            }
        return cls(path=target, people=people)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps({"people": self.people, "updated": time.time()}, indent=2),
            encoding="utf-8",
        )
        try:
            self.path.chmod(0o600)
        except OSError:  # pragma: no cover - filesystem without permissions
            pass

    # -------------------------------------------------------------- editing

    def add(self, name: str, modality: str, embedding: Embedding) -> int:
        """Record another sample for someone. Returns how many they now have."""
        person = self.people.setdefault(name.strip(), {})
        samples = person.setdefault(modality, [])
        samples.append([float(x) for x in embedding])
        self.save()
        return len(samples)

    def forget(self, name: str, modality: str = "") -> bool:
        """Remove one modality for a person, or the person entirely."""
        person = self.people.get(name)
        if person is None:
            return False
        if modality:
            removed = person.pop(modality, None) is not None
            if not person:
                self.people.pop(name, None)
        else:
            self.people.pop(name, None)
            removed = True
        self.save()
        return removed

    # -------------------------------------------------------------- reading

    def names(self, modality: str = "") -> list[str]:
        if not modality:
            return sorted(self.people)
        return sorted(name for name, kinds in self.people.items() if kinds.get(modality))

    def summary(self) -> list[dict[str, Any]]:
        return [
            {
                "name": name,
                "face": len(kinds.get("face", [])),
                "voice": len(kinds.get("voice", [])),
            }
            for name, kinds in sorted(self.people.items())
        ]

    def knows_anyone(self, modality: str = "") -> bool:
        return bool(self.names(modality))

    def identify(
        self, embedding: Embedding, modality: str, threshold: float | None = None
    ) -> Match:
        """The closest enrolled person, if any is close enough."""
        limit = threshold if threshold is not None else (
            FACE_THRESHOLD if modality == "face" else VOICE_THRESHOLD
        )
        measure = distance if modality == "face" else cosine_distance

        best = Match(threshold=limit, modality=modality)
        for name, kinds in self.people.items():
            for sample in kinds.get(modality, []):
                try:
                    apart = measure(embedding, sample)
                except ValueError:
                    continue  # an embedding from a different model; skip it
                if apart < best.distance:
                    best = Match(name=name, distance=apart, threshold=limit, modality=modality)
        return best


# --------------------------------------------------------------- backends


class MissingBackend(RuntimeError):
    """The library that turns a sample into an embedding is not installed."""


class FaceEncoder:
    """Turns an image into a face embedding, using `face_recognition`."""

    modality = "face"

    def __init__(self) -> None:
        if importlib.util.find_spec("face_recognition") is None:  # pragma: no cover
            raise MissingBackend(
                "face recognition needs the `face_recognition` package: "
                "pip install 'thursday[identity]'"
            )

    def encode(self, image_bytes: bytes) -> list[float]:  # pragma: no cover - needs the model
        import io

        import face_recognition
        import numpy as np
        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as picture:
            frame = np.array(picture.convert("RGB"))

        encodings = face_recognition.face_encodings(frame)
        if not encodings:
            raise ValueError("no face found in that image")
        if len(encodings) > 1:
            raise ValueError("more than one face in that image; use one at a time")
        return [float(value) for value in encodings[0]]


class VoiceEncoder:
    """Turns a clip into a speaker embedding, using `resemblyzer`."""

    modality = "voice"

    def __init__(self) -> None:
        if importlib.util.find_spec("resemblyzer") is None:  # pragma: no cover
            raise MissingBackend(
                "voice recognition needs the `resemblyzer` package: "
                "pip install 'thursday[identity]'"
            )
        from resemblyzer import VoiceEncoder as Model

        self._model = Model()

    def encode(self, audio: Any, sample_rate: int = 16000) -> list[float]:  # pragma: no cover
        import numpy as np
        from resemblyzer import preprocess_wav

        samples = np.asarray(audio, dtype=np.float32).flatten()
        return [float(value) for value in self._model.embed_utterance(preprocess_wav(samples, sample_rate))]


def build_encoder(modality: str) -> Any:
    """The encoder for a modality, or None when it is switched off."""
    if modality == "face":
        return FaceEncoder()
    if modality == "voice":
        return VoiceEncoder()
    raise MissingBackend(f"unknown modality: {modality}")


def decode_data_url(data: str) -> bytes:
    """Accept either a bare base64 string or a data: URL from a browser."""
    if data.startswith("data:"):
        _, _, data = data.partition(",")
    return base64.b64decode(data, validate=False)


# ----------------------------------------------------------------- policy


@dataclass
class Doorman:
    """Applies the identity policy to a set of checks."""

    policy: str = "off"
    enrolment: Enrolment | None = None

    @classmethod
    def from_env(cls, enrolment: Enrolment | None = None) -> "Doorman":
        policy = os.environ.get("THURSDAY_IDENTITY", "off").strip().lower()
        return cls(policy=policy if policy in POLICIES else "off", enrolment=enrolment)

    @property
    def required(self) -> tuple[str, ...]:
        if self.policy in {"face", "voice"}:
            return (self.policy,)
        if self.policy in {"either", "both"}:
            return ("face", "voice")
        return ()

    def enforced(self) -> bool:
        """Whether the policy can actually be applied.

        A policy with nobody enrolled would lock the owner out of their own
        assistant, so it stays open until someone is registered.
        """
        if self.policy == "off" or self.enrolment is None:
            return False
        return any(self.enrolment.knows_anyone(modality) for modality in self.required)

    def admits(self, matches: Iterable[Match]) -> tuple[bool, str]:
        """Whether these checks satisfy the policy, and who was recognised."""
        if not self.enforced():
            return True, ""

        found = {match.modality: match for match in matches if match.recognised}
        if self.policy == "both":
            needed = [m for m in self.required if self.enrolment.knows_anyone(m)]
            if not all(modality in found for modality in needed):
                return False, ""

            # And that they agree about who. Two checks that both said yes
            # about two different people is not a stronger answer than one -
            # it is a contradiction, and admitting on it let whichever
            # modality happened to be listed first put its name to the turn.
            names = {found[modality].name.strip().lower() for modality in needed}
            if len(names) > 1:
                log.warning(
                    "the identity checks disagree about who is here: %s",
                    ", ".join(sorted(found[m].name for m in needed)),
                )
                return False, ""
            return True, found[needed[0]].name

        if found:
            return True, next(iter(found.values())).name
        return False, ""
