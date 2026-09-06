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


def test_images_from_the_browser_reach_the_agent(tmp_path, monkeypatch):
    """An attachment posted by the page is forwarded as an image block."""
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    captured = {}
    real_agent = server_module.Agent

    def make_agent(*args, **kwargs):
        client = StubClient([Reply([Block("text", "A cat.")])])
        captured["client"] = client
        kwargs["client"] = client
        return real_agent(*args, **kwargs)

    monkeypatch.setattr(server_module, "Agent", make_agent)
    client = fastapi_testclient.TestClient(server_module.create_app(settings))

    with client.websocket_connect("/ws") as socket:
        socket.receive_text()
        socket.send_text(
            json.dumps(
                {
                    "type": "message",
                    "text": "what is this?",
                    "images": [
                        {"media_type": "image/png", "data": "AAAA"},
                        {"media_type": "text/html", "data": "<script>"},  # dropped
                    ],
                }
            )
        )
        while json.loads(socket.receive_text())["type"] != "done":
            pass

    content = captured["client"].requests[0]["messages"][0]["content"]
    images = [block for block in content if block["type"] == "image"]
    assert len(images) == 1
    assert images[0]["source"]["media_type"] == "image/png"


def test_an_attachment_with_no_text_still_starts_a_turn(tmp_path, monkeypatch):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    real_agent = server_module.Agent
    monkeypatch.setattr(
        server_module,
        "Agent",
        lambda *a, **k: real_agent(*a, **{**k, "client": StubClient([Reply([Block("text", "ok")])])}),
    )
    client = fastapi_testclient.TestClient(server_module.create_app(settings))

    with client.websocket_connect("/ws") as socket:
        socket.receive_text()
        socket.send_text(
            json.dumps({"type": "message", "text": "", "images": [{"media_type": "image/png", "data": "AAAA"}]})
        )
        while True:
            event = json.loads(socket.receive_text())
            if event["type"] == "done":
                assert event["text"] == "ok"
                break


@pytest.fixture()
def plain_client(tmp_path, monkeypatch):
    """A web app whose agent just answers, with no tool call to confirm."""
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    real_agent = server_module.Agent

    def make_agent(*args, **kwargs):
        kwargs["client"] = StubClient([Reply([Block("text", "ok")]) for _ in range(8)])
        return real_agent(*args, **kwargs)

    monkeypatch.setattr(server_module, "Agent", make_agent)
    return fastapi_testclient.TestClient(server_module.create_app(settings))


def _profile_of(socket, payload):
    """Send a turn and report which profile handled it."""
    socket.send_text(json.dumps(payload))
    chosen = None
    while True:
        event = json.loads(socket.receive_text())
        if event["type"] == "profile":
            chosen = event["data"]
        if event["type"] == "done":
            return chosen


def test_the_page_is_told_which_profiles_exist(plain_client):
    with plain_client.websocket_connect("/ws") as socket:
        ready = json.loads(socket.receive_text())

    assert ready["type"] == "ready"
    assert ready["provider"] == "anthropic"
    names = {profile["name"] for profile in ready["profiles"]}
    assert {"default", "quick", "deep", "coder", "private"} <= names


def test_the_page_can_choose_a_profile(plain_client):
    with plain_client.websocket_connect("/ws") as socket:
        socket.receive_text()
        chosen = _profile_of(socket, {"type": "message", "text": "hello", "profile": "deep"})

    assert chosen["profile"] == "deep"
    assert chosen["reason"] == "requested"


def test_an_unknown_profile_from_the_page_falls_back_to_routing(plain_client):
    """The page does not get to name anything it likes."""
    with plain_client.websocket_connect("/ws") as socket:
        socket.receive_text()
        chosen = _profile_of(socket, {"type": "message", "text": "hello", "profile": "../etc/passwd"})

    assert chosen["profile"] == "default"


def test_the_page_is_told_the_mood_as_the_turn_runs(client, tmp_path):
    """The HUD and the avatar both draw the state, so it has to arrive."""
    with client.websocket_connect("/ws") as socket:
        socket.receive_text()
        socket.send_text(json.dumps({"type": "message", "text": "write a note"}))

        states = []
        while True:
            event = json.loads(socket.receive_text())
            if event["type"] == "state":
                states.append((event["mood"], event["activity"]))
            if event["type"] == "confirm":
                socket.send_text(
                    json.dumps({"type": "confirm_response", "id": event["id"], "approved": True})
                )
            if event["type"] == "done":
                # The state for a finished turn is sent just after `done`.
                for _ in range(3):
                    trailing = json.loads(socket.receive_text())
                    if trailing["type"] == "state":
                        states.append((trailing["mood"], trailing["activity"]))
                        break
                break

    moods = [mood for mood, _ in states]
    assert moods[0] == "attentive"          # it heard you
    assert "working" in moods               # it ran the tool
    assert moods[-1] == "pleased"           # and it went well
    # The activity is a phrase a person can read, not a tool identifier.
    assert ("working", "writing a file") in states


def test_the_wake_words_reach_the_page(plain_client):
    with plain_client.websocket_connect("/ws") as socket:
        ready = json.loads(socket.receive_text())

    assert ready["name"] == "Thursday"
    assert "thursday" in ready["wake_words"]


def test_the_page_can_see_what_thursday_may_do(plain_client, tmp_path):
    """The Access panel reads this: the rules, and what was refused."""
    from thursday.memory import Memory

    memory = Memory(tmp_path / "data" / "thursday.db")
    memory.record_access("read_file", {"path": ".env"}, "denied", "that one is protected")
    memory.close()

    payload = plain_client.get("/api/permissions").json()

    assert payload["protected_paths"] > 0
    assert payload["confirmations"] is True
    assert payload["tools"]["run_shell"] == "confirm"
    assert payload["workspace"] == str(tmp_path)
    assert payload["recent"][0]["tool"] == "read_file"
    assert payload["recent"][0]["outcome"] == "denied"
    assert {"tool": "read_file", "outcome": "denied", "count": 1} in payload["summary"]


def test_the_permissions_view_needs_the_token_from_elsewhere(tmp_path, monkeypatch):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=(), auth="always")
    monkeypatch.setenv("THURSDAY_ACCESS_TOKEN", "letmein")
    client = fastapi_testclient.TestClient(server_module.create_app(settings))

    assert client.get("/api/permissions").status_code == 401
