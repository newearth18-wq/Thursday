"""Stand-ins for an embedding model, so the document path can be tested.

`BagOfWords` computes a deterministic vector from the words in a text - crude,
but it makes "find the passage about termination" genuinely work, which is
what the search logic needs to be tested against. `FakeEmbeddingServer` speaks
the same HTTP shape a real model does, so the transport is tested too.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from thursday.embeddings import Embedder, normalise

DIMENSIONS = 64


def bag_of_words(text: str, dimensions: int = DIMENSIONS) -> list[float]:
    """A hashing vectoriser: same words in, same vector out."""
    vector = [0.0] * dimensions
    for word in re.findall(r"\w+", text.lower()):
        if len(word) <= 2:
            continue
        slot = int(hashlib.sha1(word.encode()).hexdigest(), 16) % dimensions
        vector[slot] += 1.0
    return normalise(vector)


class BagOfWords(Embedder):
    """An Embedder that needs no server at all."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(name="fake", base_url="", model="bag-of-words", local=True, **kwargs)

    def embed(self, texts):
        return [bag_of_words(text) for text in texts]

    def available(self):
        return True, ""


class FakeEmbeddingServer:
    """An OpenAI-shaped /embeddings endpoint over a real socket."""

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.requests: list[dict[str, Any]] = []
        self._server: ThreadingHTTPServer | None = None

    def start(self) -> str:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append(payload)

                if outer.fail:
                    body = json.dumps({"error": "model not loaded"}).encode()
                    self.send_response(503)
                else:
                    texts = payload.get("input") or []
                    if isinstance(texts, str):
                        texts = [texts]
                    body = json.dumps(
                        {"data": [{"embedding": bag_of_words(text)} for text in texts]}
                    ).encode()
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> "FakeEmbeddingServer":
        self.base_url = self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()
