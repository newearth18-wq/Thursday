"""Talking to Thursday from a phone, through LINE or Telegram.

The web UI already works on a phone, but only if you can reach the machine:
on the same network, or through a tunnel, with the token typed in. A chat app
is the thing that is already open, already logged in, and already gets
notifications - so this is what "ask Thursday from the bus" actually looks
like in practice.

The whole of this module is about one question: is this really the owner?
A webhook is a URL on the open internet, and behind it is an assistant with a
shell. So there are three gates, and all three must pass:

1. **The request is really from the platform.** LINE signs the body with the
   channel secret; Telegram echoes a secret header set when the webhook was
   registered. Both are compared in constant time.
2. **The sender is on the allow list.** A valid signature only proves the
   message came through LINE - not that it came from you. Nothing is answered
   until a chat id is explicitly allowed, and an empty allow list answers
   nobody rather than everybody.
3. **The profile is restricted.** Chat runs under its own profile, which by
   default cannot reach the shell, write files, or drive the browser. Being on
   a bus is not the moment to approve `rm`, and a confirmation prompt with no
   one at the keyboard would hang until it timed out.

Replies go back out through the platform's own API, so nothing here needs an
inbound port beyond the webhook itself.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

#: What a chat session may not do, whatever the profile says. Imported
#: rather than written out again: this was a second copy that nothing
#: read, so the promise in the docstring above rested entirely on the
#: built-in "chat" profile happening to list the same tools.
from .profiles import CHAT_DENIED

log = logging.getLogger(__name__)

#: The platforms understood.
PLATFORMS = ("line", "telegram")

#: Chat apps get unhappy above a few thousand characters, and nobody reads a
#: wall of text on a phone anyway.
MAX_REPLY = 1800


def _people(raw: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in re.split(r"[,\s]+", raw or "") if part.strip())


@dataclass
class Channel:
    """One chat platform's credentials and who may use it."""

    platform: str
    #: LINE: the channel secret, used to verify the signature.
    #: Telegram: the secret token echoed in X-Telegram-Bot-Api-Secret-Token.
    secret: str = ""
    #: The bot's own credential for sending replies.
    token: str = ""
    #: Chat or user ids allowed to talk to it. Empty means nobody.
    allowed: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_env(cls, platform: str) -> "Channel":
        upper = platform.upper()
        return cls(
            platform=platform,
            secret=os.environ.get(f"THURSDAY_{upper}_SECRET", "").strip(),
            token=os.environ.get(f"THURSDAY_{upper}_TOKEN", "").strip(),
            allowed=_people(os.environ.get(f"THURSDAY_{upper}_ALLOW", "")),
        )

    @property
    def configured(self) -> bool:
        return bool(self.token and self.secret)

    def why_not(self) -> str:
        upper = self.platform.upper()
        if not self.token:
            return f"set THURSDAY_{upper}_TOKEN to the bot's own credential"
        if not self.secret:
            return (
                f"set THURSDAY_{upper}_SECRET"
                + (" to the channel secret" if self.platform == "line"
                   else " to the secret token you gave setWebhook")
            )
        if not self.allowed:
            return (
                f"set THURSDAY_{upper}_ALLOW to your own chat id. Until then "
                "nothing is answered - an open bot is an open shell."
            )
        return ""

    # ------------------------------------------------------------ gate one

    def signature_ok(self, body: bytes, headers: dict[str, str]) -> bool:
        """Whether this really came from the platform."""
        lowered = {key.lower(): value for key, value in headers.items()}
        if not self.secret:
            return False

        if self.platform == "line":
            # base64(HMAC-SHA256(channel secret, raw body)) in X-Line-Signature.
            sent = lowered.get("x-line-signature", "")
            expected = base64.b64encode(
                hmac.new(self.secret.encode(), body, hashlib.sha256).digest()
            ).decode()
            return hmac.compare_digest(sent, expected)

        # Telegram does not sign; it echoes a token you chose at setWebhook.
        sent = lowered.get("x-telegram-bot-api-secret-token", "")
        return hmac.compare_digest(sent, self.secret)

    # ------------------------------------------------------------ gate two

    def may_speak(self, chat_id: str) -> bool:
        """Whether this particular person is allowed to. An empty allow list
        answers nobody, which is the safe direction to fail in."""
        return bool(chat_id) and chat_id in self.allowed


@dataclass
class Incoming:
    """One message, in whichever shape the platform sent it."""

    chat_id: str
    text: str
    #: LINE gives a one-shot token for a cheap reply; Telegram has none.
    reply_token: str = ""
    sender: str = ""


def parse_line(payload: dict[str, Any]) -> list[Incoming]:
    messages = []
    for event in payload.get("events") or []:
        if event.get("type") != "message":
            continue
        message = event.get("message") or {}
        if message.get("type") != "text":
            continue
        source = event.get("source") or {}
        # A group or room id is the thing to reply to; the user id is who
        # spoke. Both are checked against the allow list below.
        chat_id = source.get("groupId") or source.get("roomId") or source.get("userId") or ""
        messages.append(
            Incoming(
                chat_id=str(chat_id),
                text=str(message.get("text") or ""),
                reply_token=str(event.get("replyToken") or ""),
                sender=str(source.get("userId") or ""),
            )
        )
    return messages


def parse_telegram(payload: dict[str, Any]) -> list[Incoming]:
    message = payload.get("message") or payload.get("edited_message") or {}
    text = message.get("text")
    chat = message.get("chat") or {}
    if not text or not chat.get("id"):
        return []
    sender = (message.get("from") or {}).get("id")
    return [
        Incoming(
            chat_id=str(chat["id"]),
            text=str(text),
            sender=str(sender) if sender else "",
        )
    ]


PARSERS = {"line": parse_line, "telegram": parse_telegram}


class Bridge:
    """Turns a webhook delivery into an answer, and sends it back."""

    def __init__(self, channel: Channel, agent_factory: Any) -> None:
        self.channel = channel
        #: Called with no arguments to get an Agent. A factory rather than an
        #: agent so each message starts from a clean tool context, and so the
        #: web app can hand over its own configured builder.
        self.agent_factory = agent_factory

    # -------------------------------------------------------------- reading

    def accept(self, body: bytes, headers: dict[str, str]) -> list[Incoming]:
        """Everything from a delivery that we are willing to answer.

        Raises nothing: a bad signature and an unknown sender both simply
        produce no messages, because an error body tells whoever is probing
        which of the two they got wrong.
        """
        if not self.channel.signature_ok(body, headers):
            log.warning("%s webhook: signature did not verify", self.channel.platform)
            return []
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            log.warning("%s webhook: body was not JSON", self.channel.platform)
            return []

        parser = PARSERS.get(self.channel.platform)
        if parser is None:  # pragma: no cover - guarded by PLATFORMS
            return []

        allowed = []
        for message in parser(payload):
            # In a group the room is what we reply to, but the person who
            # spoke is who we are trusting - so both have to be allowed.
            speaker_ok = self.channel.may_speak(message.sender) if message.sender else False
            if self.channel.may_speak(message.chat_id) or speaker_ok:
                allowed.append(message)
            else:
                log.warning(
                    "%s webhook: %s is not on the allow list",
                    self.channel.platform, message.chat_id,
                )
        return allowed

    # -------------------------------------------------------------- working

    def restrain(self, agent: Any) -> None:
        """Take the dangerous tools off the table, whatever profile is chosen.

        The profile is a preference, not a guarantee: THURSDAY_CHAT_PROFILE
        can name any profile at all, and a name that matches nothing falls
        back to letting the router choose - which could be the everyday one,
        shell and all. This is the floor underneath that choice, and it is
        the third of the three gates the module docstring promises.
        """
        policy = getattr(agent, "policy", None)
        if policy is not None:
            policy.deny_always(CHAT_DENIED)

    async def answer(self, message: Incoming) -> str:
        """Run one message through the assistant."""
        agent = self.agent_factory()
        self.restrain(agent)
        # One session per chat, so a conversation on the phone has a memory
        # of itself without being tangled up with the one at the desk.
        session = f"chat-{self.channel.platform}-{message.chat_id}"
        try:
            reply = await agent.run(
                message.text, session_id=session, profile=self.profile_name(agent)
            )
        except Exception as exc:
            log.exception("chat message failed")
            return f"Something went wrong: {type(exc).__name__}: {exc}"
        return (reply or "").strip() or "(nothing came back)"

    def profile_name(self, agent: Any) -> str | None:
        """The profile chat runs under.

        A name rather than a hard-coded tool list, so someone who has decided
        they do want the shell on their phone can say so in profiles.json
        instead of editing this file. None lets the router choose, which is
        what an unknown name falls back to.
        """
        wanted = os.environ.get("THURSDAY_CHAT_PROFILE", "chat").strip() or "chat"
        return wanted if wanted in getattr(agent, "profiles", {}) else None

    # -------------------------------------------------------------- replying

    async def send(self, message: Incoming, text: str) -> bool:
        """Send the answer back the way it came."""
        import httpx

        body = text[:MAX_REPLY] + ("…" if len(text) > MAX_REPLY else "")
        if self.channel.platform == "line":
            url = "https://api.line.me/v2/bot/message/reply"
            payload = {
                "replyToken": message.reply_token,
                "messages": [{"type": "text", "text": body}],
            }
            headers = {"Authorization": f"Bearer {self.channel.token}"}
        else:
            url = f"https://api.telegram.org/bot{self.channel.token}/sendMessage"
            payload = {"chat_id": message.chat_id, "text": body}
            headers = {}

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()
        except Exception as exc:
            log.error("could not reply on %s: %s", self.channel.platform, exc)
            return False
        return True
