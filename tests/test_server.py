"""The web front end, exercised through FastAPI's test client."""

from __future__ import annotations

import json

import pytest

fastapi_testclient = pytest.importorskip("fastapi.testclient")

from thursday import server as server_module  # noqa: E402
from thursday.config import Settings  # noqa: E402
from tests.test_agent import Block, Reply, StubClient  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A web app whose agents talk to a stub instead of the API."""
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    replies = [
        Reply([Block("tool_use", id="t1", name="write_file",
                     input={"path": "note.txt", "content": "hi"})], "tool_use"),
        Reply([Block("text", "Written, sir.")]),
    ]

    real_agent = server_module.Agent

    def make_agent(*args, **kwargs):
        kwargs["client"] = StubClient(replies)
        return real_agent(*args, **kwargs)

    monkeypatch.setattr(server_module, "Agent", make_agent)
    return fastapi_testclient.TestClient(server_module.create_app(settings))


def test_index_serves_the_ui(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "<title>Thursday</title>" in response.text


def test_status_lists_tools(client):
    payload = client.get("/api/status").json()
    assert payload["model"] == "claude-opus-5"
    names = {tool["name"] for tool in payload["tools"]}
    assert {"system_status", "read_file", "set_reminder"} <= names
    assert any(tool["dangerous"] for tool in payload["tools"])


def test_websocket_streams_a_turn_and_asks_for_confirmation(client, tmp_path):
    with client.websocket_connect("/ws") as socket:
        assert json.loads(socket.receive_text())["type"] == "ready"

        socket.send_text(json.dumps({"type": "message", "text": "write a note"}))

        events = []
        approved = False
        while True:
            event = json.loads(socket.receive_text())
            events.append(event["type"])
            if event["type"] == "confirm":
                # The browser is asked before anything touches the disk.
                assert "note.txt" in event["title"]
                socket.send_text(
                    json.dumps({"type": "confirm_response", "id": event["id"], "approved": True})
                )
                approved = True
            if event["type"] == "done":
                assert event["text"] == "Written, sir."
                break

        assert approved
        assert "tool_start" in events and "text" in events
        assert (tmp_path / "note.txt").read_text(encoding="utf-8") == "hi"


def test_declining_a_confirmation_leaves_the_disk_untouched(client, tmp_path):
    with client.websocket_connect("/ws") as socket:
        socket.receive_text()
        socket.send_text(json.dumps({"type": "message", "text": "write a note"}))

        while True:
            event = json.loads(socket.receive_text())
            if event["type"] == "confirm":
                socket.send_text(
                    json.dumps({"type": "confirm_response", "id": event["id"], "approved": False})
                )
            if event["type"] == "done":
                break

        assert not (tmp_path / "note.txt").exists()
