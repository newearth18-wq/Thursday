"""Turning text into vectors, locally by default.

Document search should not require sending your files to anyone, so the
default backend is whatever model is running on this machine - Ollama's
`nomic-embed-text`, LM Studio, anything with an OpenAI-shaped `/embeddings`
endpoint. A hosted provider is available when you want it, and when no
embedding model exists at all the document tools fall back to keyword search
rather than pretending to be smarter than they are.
"""

from __future__ import annotations

import logging
import math
import os
import struct
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

log = logging.getLogger(__name__)

try:
    import httpx
except ImportError:  # pragma: no cover - httpx is a core dependency
    httpx = None  # type: ignore[assignment]

Vector = Sequence[float]

#: Known embedding endpoints. Local ones come first on purpose.
PRESETS: dict[str, dict[str, Any]] = {
    "ollama": {
        "base_url": "http://localhost:11434/v1",
        "model": "nomic-embed-text",
        "local": True,
        "hint": "ollama pull nomic-embed-text",
    },
    "lmstudio": {
        "base_url": "http://localhost:1234/v1",
        "model": "text-embedding-nomic-embed-text-v1.5",
        "local": True,
        "hint": "load an embedding model in LM Studio",
    },
    "llamacpp": {
        "base_url": "http://localhost:8080/v1",
        "model": "local-model",
        "local": True,
        "hint": "llama-server --embedding",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": "text-embedding-3-small",
        "key_env": "OPENAI_API_KEY",
        "local": False,
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "text-embedding-004",
        "key_env": "GEMINI_API_KEY",
        "local": False,
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "model": "BAAI/bge-large-en-v1.5",
        "key_env": "TOGETHER_API_KEY",
        "local": False,
    },
}


class EmbeddingUnavailable(RuntimeError):
    """No embedding model could be reached."""


# ------------------------------------------------------------------ maths


def pack(vector: Vector) -> bytes:
    """Store a vector compactly - float32 is plenty for similarity."""
    return struct.pack(f"<{len(vector)}f", *vector)


def unpack(blob: bytes) -> list[float]:
    return list(struct.unpack(f"<{len(blob) // 4}f", blob))


def normalise(vector: Vector) -> list[float]:
    """Unit length, so similarity is a plain dot product afterwards."""
    length = math.sqrt(sum(value * value for value in vector))
    if length == 0:
        return list(vector)
    return [value / length for value in vector]


def similarity(left: Vector, right: Vector) -> float:
    """Cosine similarity, 1 being identical."""
    if len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    norm = math.sqrt(sum(a * a for a in left)) * math.sqrt(sum(b * b for b in right))
    return 0.0 if norm == 0 else dot / norm


def rank(query: Vector, candidates: Iterable[tuple[Any, Vector]], limit: int = 8) -> list[tuple[Any, float]]:
    """The closest candidates, best first.

    Plain Python: at personal scale - thousands of chunks - this is a few
    milliseconds, and it keeps the dependency list honest.
    """
    scored = [(key, similarity(query, vector)) for key, vector in candidates]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored[:limit]


# --------------------------------------------------------------- backend


@dataclass
class Embedder:
    """An OpenAI-shaped `/embeddings` endpoint, local or hosted."""

    name: str = "ollama"
    base_url: str = "http://localhost:11434/v1"
    model: str = "nomic-embed-text"
    api_key: str = ""
    local: bool = True
    hint: str = ""
    timeout: float = 120.0

    def __post_init__(self) -> None:
        # Fill in what the preset knows, so an Embedder built in code still
        # gives the "try: ollama pull ..." advice when it cannot connect.
        preset = PRESETS.get(self.name)
        if preset is None:
            return
        if not self.hint:
            self.hint = str(preset.get("hint", ""))
        if not self.model:
            self.model = str(preset.get("model", ""))

    @classmethod
    def from_env(cls) -> "Embedder":
        name = os.environ.get("THURSDAY_EMBED_PROVIDER", "ollama").strip().lower()
        preset = PRESETS.get(name, PRESETS["ollama"])
        key_env = preset.get("key_env", "")
        return cls(
            name=name if name in PRESETS else "ollama",
            base_url=os.environ.get("THURSDAY_EMBED_BASE_URL") or preset["base_url"],
            model=os.environ.get("THURSDAY_EMBED_MODEL") or preset["model"],
            api_key=os.environ.get("THURSDAY_EMBED_API_KEY") or (os.environ.get(key_env, "") if key_env else ""),
            local=bool(preset.get("local")),
            hint=str(preset.get("hint", "")),
        )

    def _client(self) -> Any:
        if httpx is None:  # pragma: no cover
            raise EmbeddingUnavailable("httpx is not installed")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return httpx.Client(base_url=self.base_url.rstrip("/"), headers=headers, timeout=self.timeout)

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed a batch. Raises EmbeddingUnavailable when it cannot."""
        if not texts:
            return []
        try:
            with self._client() as client:
                response = client.post("/embeddings", json={"model": self.model, "input": list(texts)})
                if response.status_code >= 400:
                    raise EmbeddingUnavailable(
                        f"{self.name} returned {response.status_code}: {response.text[:200]}"
                        + (f" ({self.hint})" if self.hint else "")
                    )
                payload = response.json()
        except EmbeddingUnavailable:
            raise
        except Exception as exc:
            raise EmbeddingUnavailable(
                f"could not reach the embedding model at {self.base_url}: {exc}"
                + (f" — try: {self.hint}" if self.hint else "")
            ) from exc

        rows = payload.get("data") or []
        if len(rows) != len(texts):
            raise EmbeddingUnavailable(
                f"{self.name} returned {len(rows)} embeddings for {len(texts)} inputs"
            )
        # Normalised on the way in, so ranking is a dot product later.
        return [normalise([float(value) for value in row.get("embedding") or []]) for row in rows]

    def embed_one(self, text: str) -> list[float]:
        vectors = self.embed([text])
        if not vectors or not vectors[0]:
            raise EmbeddingUnavailable(f"{self.name} returned an empty embedding")
        return vectors[0]

    def available(self) -> tuple[bool, str]:
        """Whether this backend can actually embed something right now."""
        try:
            self.embed_one("ping")
        except EmbeddingUnavailable as exc:
            return False, str(exc)
        except Exception as exc:  # pragma: no cover - unexpected transport trouble
            return False, str(exc)
        return True, ""


def build_embedder(settings: Any = None) -> Embedder:
    """The configured embedder. Local unless told otherwise."""
    return Embedder.from_env()
