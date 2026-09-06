"""Talking to Thursday from a phone.

A webhook is a URL on the open internet and behind it is an assistant with a
shell, so almost every test here is about refusing someone.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json

import pytest

from thursday.bridge import Bridge, Channel, Incoming, parse_line, parse_telegram
from thursday.profiles import builtin_map


ME = "U1234567890"
SOMEONE_ELSE = "Uffffffffff"


def line_channel(**kwargs):
    return Channel(platform="line", secret="s3cr3t", token="bot-token",
                   allowed=(ME,), **kwargs)


def telegram_channel(**kwargs):
    return Channel(platform="telegram", secret="hookword", token="123:abc",
                   allowed=(ME,), **kwargs)


def line_body(text="hello", user=ME):
    return json.dumps({
        "events": [{
            "type": "message",
            "replyToken": "reply-1",
            "source": {"type": "user", "userId": user},
            "message": {"type": "text", "text": text},
        }]
    }).encode()


def line_signature(body, secret="s3cr3t"):
    return base64.b64encode(
        hmac.new(secret.encode(), body, hashlib.sha256).digest()
    ).decode()


def telegram_body(text="hello", user=ME):
    return json.dumps({
        "message": {"chat": {"id": user}, "from": {"id": user}, "text": text}
    }).encode()


class FakeAgent:
    profiles = builtin_map()

    def __init__(self):
        self.asked = []

    async def run(self, text, session_id="default", profile=None, **kwargs):
        self.asked.append((text, session_id, profile))
        return "the answer"


# ------------------------------------------------------- gate one: signature


def test_a_line_message_with_a_good_signature_is_accepted():
    body = line_body()
    bridge = Bridge(line_channel(), FakeAgent)

    accepted = bridge.accept(body, {"X-Line-Signature": line_signature(body)})

    assert len(accepted) == 1
    assert accepted[0].text == "hello"
    assert accepted[0].reply_token == "reply-1"


def test_a_line_message_with_a_bad_signature_is_dropped():
    body = line_body()
    bridge = Bridge(line_channel(), FakeAgent)

    assert bridge.accept(body, {"X-Line-Signature": "nope"}) == []
    assert bridge.accept(body, {}) == []


def test_a_signature_over_different_content_is_dropped():
    """Replaying yesterday's signature with today's text must not work."""
    bridge = Bridge(line_channel(), FakeAgent)
    signed = line_signature(line_body("what is the time"))

    assert bridge.accept(line_body("rm -rf everything"), {"X-Line-Signature": signed}) == []


def test_telegram_checks_the_secret_header():
    bridge = Bridge(telegram_channel(), FakeAgent)
    body = telegram_body()

    assert bridge.accept(body, {"X-Telegram-Bot-Api-Secret-Token": "hookword"})
    assert bridge.accept(body, {"X-Telegram-Bot-Api-Secret-Token": "wrong"}) == []
    assert bridge.accept(body, {}) == []


def test_no_secret_configured_means_nothing_verifies():
    """Fail closed: an unconfigured bridge answers nobody, not everybody."""
    channel = Channel(platform="line", token="bot", allowed=(ME,))

    assert channel.signature_ok(b"{}", {"X-Line-Signature": ""}) is False


# ------------------------------------------------------ gate two: who it is


def test_a_stranger_with_a_valid_signature_is_still_refused():
    """The signature only proves it came through LINE, not that it is you."""
    body = line_body(user=SOMEONE_ELSE)
    bridge = Bridge(line_channel(), FakeAgent)

    assert bridge.accept(body, {"X-Line-Signature": line_signature(body)}) == []


def test_an_empty_allow_list_answers_nobody():
    channel = Channel(platform="line", secret="s3cr3t", token="bot")
    body = line_body()
    bridge = Bridge(channel, FakeAgent)

    assert bridge.accept(body, {"X-Line-Signature": line_signature(body)}) == []
    assert "ALLOW" in channel.why_not()


def test_in_a_group_the_person_speaking_is_who_is_trusted():
    """The room is what we reply to; the speaker is who we believe."""
    body = json.dumps({
        "events": [{
            "type": "message",
            "replyToken": "reply-1",
            "source": {"type": "group", "groupId": "Gaaa", "userId": ME},
            "message": {"type": "text", "text": "hello"},
        }]
    }).encode()
    bridge = Bridge(line_channel(), FakeAgent)

    accepted = bridge.accept(body, {"X-Line-Signature": line_signature(body)})

    assert len(accepted) == 1
    assert accepted[0].chat_id == "Gaaa"      # reply to the room
    assert accepted[0].sender == ME           # trusted because of who spoke


def test_a_stranger_in_an_allowed_group_is_refused():
    body = json.dumps({
        "events": [{
            "type": "message",
            "replyToken": "r",
            "source": {"type": "group", "groupId": "Gaaa", "userId": SOMEONE_ELSE},
            "message": {"type": "text", "text": "hello"},
        }]
    }).encode()
    bridge = Bridge(line_channel(), FakeAgent)

    assert bridge.accept(body, {"X-Line-Signature": line_signature(body)}) == []


# -------------------------------------------------------------- what arrives


def test_only_text_messages_are_answered():
    body = json.dumps({
        "events": [
            {"type": "follow", "source": {"userId": ME}},
            {"type": "message", "source": {"userId": ME},
             "message": {"type": "sticker", "packageId": "1"}},
        ]
    }).encode()
    bridge = Bridge(line_channel(), FakeAgent)

    assert bridge.accept(body, {"X-Line-Signature": line_signature(body)}) == []


def test_a_body_that_is_not_json_is_dropped():
    body = b"not json at all"
    bridge = Bridge(line_channel(), FakeAgent)

    assert bridge.accept(body, {"X-Line-Signature": line_signature(body)}) == []


def test_telegram_edits_count_as_messages():
    payload = {"edited_message": {"chat": {"id": ME}, "from": {"id": ME}, "text": "fixed"}}

    assert parse_telegram(payload)[0].text == "fixed"


def test_an_empty_delivery_is_no_messages():
    assert parse_line({}) == []
    assert parse_telegram({}) == []


# ----------------------------------------------------- gate three: what it may do


def test_chat_cannot_reach_the_shell_or_write_files():
    """Nobody is at the keyboard to approve anything, so nothing that needs
    approving is even offered."""
    chat = builtin_map()["chat"]

    for name in ("run_shell", "write_file", "browse", "send_draft", "lock_screen"):
        assert not chat.allows(name), f"chat should not allow {name}"
    for name in ("current_time", "search_notes", "whats_on", "check_mail", "draft_email"):
        assert chat.allows(name), f"chat should allow {name}"


def test_a_message_runs_under_the_chat_profile():
    agent = FakeAgent()
    bridge = Bridge(line_channel(), lambda: agent)

    reply = asyncio.run(bridge.answer(Incoming(chat_id=ME, text="what is on today")))

    assert reply == "the answer"
    text, session, profile = agent.asked[0]
    assert profile == "chat"
    assert session == f"chat-line-{ME}"


def test_each_chat_keeps_its_own_conversation():
    """The phone and the desk should not tangle each other's context."""
    agent = FakeAgent()
    bridge = Bridge(telegram_channel(), lambda: agent)

    asyncio.run(bridge.answer(Incoming(chat_id="111", text="a")))
    asyncio.run(bridge.answer(Incoming(chat_id="222", text="b")))

    assert agent.asked[0][1] != agent.asked[1][1]


def test_an_unknown_profile_name_falls_back_to_the_router(monkeypatch):
    monkeypatch.setenv("THURSDAY_CHAT_PROFILE", "no-such-profile")
    bridge = Bridge(line_channel(), FakeAgent)

    assert bridge.profile_name(FakeAgent()) is None


def test_a_failure_comes_back_as_a_message_not_a_crash():
    class Broken:
        profiles = builtin_map()

        async def run(self, *args, **kwargs):
            raise RuntimeError("the model was unreachable")

    bridge = Bridge(line_channel(), Broken)

    reply = asyncio.run(bridge.answer(Incoming(chat_id=ME, text="hi")))

    assert "unreachable" in reply


# ------------------------------------------------------------------ replying


def test_a_long_reply_is_trimmed_rather_than_rejected(monkeypatch):
    sent = {}

    class Response:
        def raise_for_status(self):
            return None

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json=None, headers=None):
            sent.update(url=url, json=json, headers=headers)
            return Response()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: Client())
    bridge = Bridge(telegram_channel(), FakeAgent)

    assert asyncio.run(bridge.send(Incoming(chat_id="42", text=""), "x" * 5000))
    assert "api.telegram.org" in sent["url"]
    assert sent["json"]["chat_id"] == "42"
    assert len(sent["json"]["text"]) < 2000
    assert sent["json"]["text"].endswith("…")


def test_a_reply_that_cannot_be_delivered_is_reported_not_raised(monkeypatch):
    import httpx

    def explode(*args, **kwargs):
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(httpx, "AsyncClient", explode)
    bridge = Bridge(line_channel(), FakeAgent)

    assert asyncio.run(bridge.send(Incoming(chat_id=ME, text=""), "hello")) is False


# --------------------------------------------------------------- the endpoint


def test_the_webhook_says_nothing_about_why_it_refused(tmp_path):
    """Telling a prober which gate stopped them tells them which to work on."""
    testclient = pytest.importorskip("fastapi.testclient")
    from thursday import server as server_module
    from thursday.config import Settings

    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data",
                        plugin_dirs=(), auth="off")
    client = testclient.TestClient(server_module.create_app(settings))

    good = client.post("/hooks/line", content=line_body())
    unknown = client.post("/hooks/nowhere", content=b"{}")

    # Unconfigured, so nothing is answered - but the reply is the same 200
    # a real delivery gets.
    assert good.status_code == 200 and good.json() == {"ok": True}
    assert unknown.status_code == 404
