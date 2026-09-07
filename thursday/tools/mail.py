"""Reading email over IMAP, which every provider still speaks.

Read-only on purpose. An assistant that can send mail on your behalf is a
much larger decision than one that can tell you what arrived, and this is the
half that makes "what needs my attention" work.

Credentials come from the environment, and Gmail/Outlook want an app password
rather than your real one - the error messages say so.
"""

from __future__ import annotations

import email
import email.policy
import imaplib
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from email.header import decode_header, make_header
from typing import Any

from . import ToolContext, ToolError, tool

log = logging.getLogger(__name__)

MAX_BODY = 4000


@dataclass
class Mailbox:
    host: str = ""
    user: str = ""
    password: str = ""
    port: int = 993
    folder: str = "INBOX"

    @classmethod
    def from_env(cls) -> "Mailbox":
        return cls(
            host=os.environ.get("THURSDAY_IMAP_HOST", "").strip(),
            user=os.environ.get("THURSDAY_IMAP_USER", "").strip(),
            password=os.environ.get("THURSDAY_IMAP_PASSWORD", ""),
            port=int(os.environ.get("THURSDAY_IMAP_PORT", "993") or 993),
            folder=os.environ.get("THURSDAY_IMAP_FOLDER", "INBOX").strip() or "INBOX",
        )

    @property
    def configured(self) -> bool:
        return bool(self.host and self.user and self.password)

    def connect(self) -> imaplib.IMAP4_SSL:
        if not self.configured:
            raise ToolError(
                "no mailbox is configured; set THURSDAY_IMAP_HOST, _USER and "
                "_PASSWORD under Config. Gmail and Outlook need an app password, "
                "not your account password."
            )
        try:
            connection = imaplib.IMAP4_SSL(self.host, self.port)
            connection.login(self.user, self.password)
        except imaplib.IMAP4.error as exc:
            raise ToolError(
                f"the mail server refused the login: {exc}. "
                "If this is Gmail or Outlook, use an app password."
            ) from exc
        except OSError as exc:
            raise ToolError(f"could not reach {self.host}:{self.port}: {exc}") from exc
        return connection


def decode(value: str | None) -> str:
    """Headers arrive RFC 2047 encoded more often than not."""
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def body_of(message: Any) -> str:
    """The readable text of a message, preferring plain text over HTML."""
    if message.is_multipart():
        for part in message.walk():
            if part.get_content_type() == "text/plain":
                try:
                    return part.get_content()
                except Exception:
                    continue
        for part in message.walk():
            if part.get_content_type() == "text/html":
                try:
                    return strip_html(part.get_content())
                except Exception:
                    continue
        return ""
    try:
        content = message.get_content()
    except Exception:
        return ""
    return strip_html(content) if message.get_content_type() == "text/html" else content


_TAGS = re.compile(r"<[^>]+>")
_SCRIPTS = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)


def strip_html(raw: str) -> str:
    import html as html_module

    text = _TAGS.sub(" ", _SCRIPTS.sub(" ", raw))
    return re.sub(r"\s+", " ", html_module.unescape(text)).strip()


def summarise(message: Any, include_body: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "from": decode(message.get("From")),
        "subject": decode(message.get("Subject")) or "(no subject)",
        "date": decode(message.get("Date")),
    }
    if include_body:
        text = body_of(message).strip()
        payload["body"] = text[:MAX_BODY] + ("…" if len(text) > MAX_BODY else "")
    return payload


@tool
def check_mail(
    unread_only: bool = True, days: int = 3, limit: int = 15, ctx: ToolContext = None
) -> dict[str, Any]:
    """Look at the user's inbox.

    Use this for "any important email", "what came in today", "did they
    reply". Returns senders and subjects; use read_mail for a whole message.

    Args:
        unread_only: Only messages that have not been read.
        days: How far back to look.
        limit: Maximum number of messages to list.
    """
    mailbox = Mailbox.from_env()
    connection = mailbox.connect()
    try:
        connection.select(mailbox.folder, readonly=True)   # never marks as read
        since = (datetime.now() - timedelta(days=max(1, days))).strftime("%d-%b-%Y")
        criteria = f'(SINCE "{since}")'
        if unread_only:
            criteria = f'(UNSEEN SINCE "{since}")'

        status, data = connection.search(None, criteria)
        if status != "OK":
            raise ToolError(f"the mail server refused that search: {status}")

        ids = (data[0] or b"").split()[-max(1, limit):]
        messages = []
        for message_id in reversed(ids):
            status, fetched = connection.fetch(message_id, "(BODY.PEEK[HEADER])")
            if status != "OK" or not fetched or not isinstance(fetched[0], tuple):
                continue
            parsed = email.message_from_bytes(fetched[0][1], policy=email.policy.default)
            summary = summarise(parsed)
            summary["id"] = message_id.decode()
            messages.append(summary)
    finally:
        try:
            connection.logout()
        except Exception:  # pragma: no cover - a socket already gone
            pass

    return {
        "folder": mailbox.folder,
        "unread_only": unread_only,
        "count": len(messages),
        "messages": messages,
    }


@tool
def read_mail(message_id: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Read one email in full.

    Args:
        message_id: The id from check_mail.
    """
    mailbox = Mailbox.from_env()
    connection = mailbox.connect()
    try:
        connection.select(mailbox.folder, readonly=True)
        status, fetched = connection.fetch(message_id.encode(), "(BODY.PEEK[])")
        if status != "OK" or not fetched or not isinstance(fetched[0], tuple):
            raise ToolError(f"no message with id {message_id}")
        parsed = email.message_from_bytes(fetched[0][1], policy=email.policy.default)
        return summarise(parsed, include_body=True)
    finally:
        try:
            connection.logout()
        except Exception:  # pragma: no cover
            pass
