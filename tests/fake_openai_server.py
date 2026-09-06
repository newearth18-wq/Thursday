"""A stand-in for an OpenAI-compatible server (Ollama, LM Studio, vLLM, ...).

Real local runners are not available in CI, so the provider is exercised over
a real socket against this instead: SSE framing, tool-call fragments split
across chunks, and the /models endpoint all behave the way the real ones do.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class FakeServer:
    """Serves scripted turns; records the request bodies it received."""

    def __init__(self, turns: list[dict[str, Any]], models: list[str] | None = None) -> None:
        self.turns = list(turns)
        self.models = models or ["fake-model", "llama3.2"]
        self.requests: list[dict[str, Any]] = []
        self.headers_seen: list[dict[str, str]] = []
        self._server: ThreadingHTTPServer | None = None

    # ------------------------------------------------------------- lifecycle

    def start(self) -> str:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # keep the test output clean
                return

            def do_GET(self):
                if self.path.endswith("/models"):
                    body = json.dumps(
                        {"data": [{"id": name} for name in outer.models]}
                    ).encode()
                    self._respond(200, "application/json", body)
                else:
                    self._respond(404, "application/json", b"{}")

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append(payload)
                outer.headers_seen.append(dict(self.headers))

                turn = outer.turns.pop(0) if outer.turns else {"text": ""}
                if turn.get("status", 200) != 200:
                    self._respond(turn["status"], "application/json",
                                  json.dumps({"error": turn.get("error", "boom")}).encode())
                    return
                if turn.get("no_stream"):
                    self._respond(200, "application/json", json.dumps(_whole(turn)).encode())
                    return
                self._stream(turn)

            # -------------------------------------------------------- helpers

            def _respond(self, status: int, content_type: str, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _stream(self, turn: dict[str, Any]) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                for chunk in _chunks(turn):
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> "FakeServer":
        self.base_url = self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()


def _chunks(turn: dict[str, Any]) -> list[dict[str, Any]]:
    """Break a scripted turn into the fragments a real server would send."""
    chunks: list[dict[str, Any]] = []

    for word in (turn.get("text") or "").split(" "):
        if word:
            chunks.append(_delta({"content": word + " "}))

    for piece in turn.get("reasoning", "").split(" "):
        if piece:
            chunks.append(_delta({"reasoning_content": piece + " "}))

    for index, call in enumerate(turn.get("tool_calls") or []):
        # Name and id arrive first, then arguments in pieces - exactly how
        # OpenAI splits them.
        chunks.append(
            _delta(
                {
                    "tool_calls": [
                        {
                            "index": index,
                            "id": call["id"],
                            "type": "function",
                            "function": {"name": call["name"], "arguments": ""},
                        }
                    ]
                }
            )
        )
        arguments = json.dumps(call.get("arguments", {}))
        half = len(arguments) // 2
        for fragment in (arguments[:half], arguments[half:]):
            chunks.append(
                _delta(
                    {"tool_calls": [{"index": index, "function": {"arguments": fragment}}]}
                )
            )

    finish = "tool_calls" if turn.get("tool_calls") else turn.get("finish_reason", "stop")
    chunks.append({"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
    return chunks


def _delta(delta: dict[str, Any]) -> dict[str, Any]:
    return {"choices": [{"index": 0, "delta": delta, "finish_reason": None}]}


def _whole(turn: dict[str, Any]) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": turn.get("text") or ""}
    if turn.get("tool_calls"):
        message["tool_calls"] = [
            {
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call.get("arguments", {})),
                },
            }
            for call in turn["tool_calls"]
        ]
    return {
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if turn.get("tool_calls") else "stop",
            }
        ]
    }
