"""Work Thursday has prepared but not carried out.

Reading mail and the calendar is safe; sending mail and putting things in
someone's diary is not. The gap between them is not a reason to stay
read-only, though - "reply to this" and "book that" are most of what an
assistant is for. So the assistant writes, and you send.

A draft is stored, shown to you in full, and only leaves the machine when you
approve it by name. Nothing here sends on its own: there is no timer, no
"send unless you object", and approving one draft says nothing about the
next. An instruction picked up from a web page or an email can therefore
produce a draft, which is a thing you read, rather than a message, which is a
thing your colleagues read.

Approval is also the only path: `send` refuses a draft that is not marked
approved, so a model that calls it directly gets a refusal rather than a sent
message.
"""

from __future__ import annotations

import logging
import os
import re
import smtplib
import ssl
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, formatdate, parseaddr
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: What a draft can be.
KINDS = ("email", "event")

#: draft -> approved -> sent. A draft that fails to send goes back to
#: `approved` rather than to `sent`, so retrying does not need a new approval,
#: and `failed` is never mistaken for delivered.
STATES = ("draft", "approved", "sent", "failed", "discarded")

_ADDRESS = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class DraftError(Exception):
    """Something about the draft itself is wrong."""


def valid_address(value: str) -> bool:
    _, address = parseaddr(value)
    return bool(_ADDRESS.match(address))


def addresses(raw: str | list[str] | None) -> list[str]:
    """Split a recipient list however it was written."""
    if not raw:
        return []
    if isinstance(raw, str):
        parts = [part.strip() for part in re.split(r"[,;]", raw)]
    else:
        parts = [str(part).strip() for part in raw]
    return [part for part in parts if part]


# --------------------------------------------------------------------- email


@dataclass
class Mailer:
    """Where approved mail goes out. Separate from the IMAP side on purpose:
    plenty of people read from one host and send through another."""

    host: str = ""
    user: str = ""
    password: str = ""
    port: int = 587
    from_address: str = ""
    from_name: str = ""
    starttls: bool = True

    @classmethod
    def from_env(cls) -> "Mailer":
        host = os.environ.get("THURSDAY_SMTP_HOST", "").strip()
        user = os.environ.get("THURSDAY_SMTP_USER", "").strip()
        password = os.environ.get("THURSDAY_SMTP_PASSWORD", "")
        # Reading and sending usually share an account, so fall back to the
        # IMAP credentials rather than making you type them twice.
        if not user:
            user = os.environ.get("THURSDAY_IMAP_USER", "").strip()
        if not password:
            password = os.environ.get("THURSDAY_IMAP_PASSWORD", "")
        port = int(os.environ.get("THURSDAY_SMTP_PORT", "587") or 587)
        return cls(
            host=host,
            user=user,
            password=password,
            port=port,
            from_address=os.environ.get("THURSDAY_SMTP_FROM", "").strip() or user,
            from_name=os.environ.get("THURSDAY_SMTP_FROM_NAME", "").strip(),
            # 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
            starttls=port != 465,
        )

    @property
    def configured(self) -> bool:
        return bool(self.host and self.from_address)

    def why_not(self) -> str:
        if not self.host:
            return (
                "no outgoing mail server is configured; set THURSDAY_SMTP_HOST "
                "(and _USER / _PASSWORD if it needs a login) under Config. "
                "Gmail and Outlook want an app password, not your account password."
            )
        if not self.from_address:
            return "set THURSDAY_SMTP_FROM to the address mail should come from"
        return ""

    def build(self, draft: "Draft") -> EmailMessage:
        message = EmailMessage()
        message["From"] = (
            formataddr((self.from_name, self.from_address))
            if self.from_name
            else self.from_address
        )
        message["To"] = ", ".join(draft.to)
        if draft.cc:
            message["Cc"] = ", ".join(draft.cc)
        message["Subject"] = draft.subject
        message["Date"] = formatdate(localtime=True)
        if draft.reply_to_message_id:
            message["In-Reply-To"] = draft.reply_to_message_id
            message["References"] = draft.reply_to_message_id
        message.set_content(draft.body)
        return message

    def send(self, draft: "Draft") -> str:
        """Actually send. Only called for an approved draft."""
        problem = self.why_not()
        if problem:
            raise DraftError(problem)

        message = self.build(draft)
        recipients = [*draft.to, *draft.cc, *draft.bcc]
        try:
            if self.starttls:
                with smtplib.SMTP(self.host, self.port, timeout=30) as server:
                    server.ehlo()
                    try:
                        server.starttls(context=ssl.create_default_context())
                        server.ehlo()
                    except smtplib.SMTPNotSupportedError:
                        # A local relay on 25 with no TLS is a normal setup.
                        log.info("%s does not offer STARTTLS", self.host)
                    if self.user:
                        server.login(self.user, self.password)
                    server.send_message(message, to_addrs=recipients)
            else:
                with smtplib.SMTP_SSL(
                    self.host, self.port, timeout=30, context=ssl.create_default_context()
                ) as server:
                    if self.user:
                        server.login(self.user, self.password)
                    server.send_message(message, to_addrs=recipients)
        except smtplib.SMTPAuthenticationError as exc:
            raise DraftError(
                f"the mail server refused the login: {exc}. "
                "If this is Gmail or Outlook, use an app password."
            ) from exc
        except (smtplib.SMTPException, OSError) as exc:
            raise DraftError(f"could not send through {self.host}: {exc}") from exc
        return ", ".join(recipients)


# ------------------------------------------------------------------ calendar


def _stamp(moment: datetime) -> str:
    return moment.astimezone().strftime("%Y%m%dT%H%M%S")


def _escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def _fold(line: str) -> str:
    """ICS lines wrap at 75 octets, continuation lines starting with a space."""
    if len(line) <= 75:
        return line
    head, rest = line[:75], line[75:]
    chunks = [rest[i : i + 74] for i in range(0, len(rest), 74)]
    return "\r\n ".join([head, *chunks])


def to_ics(draft: "Draft") -> str:
    """One event as a calendar file any app can open.

    Written rather than pushed: an .ics is understood by Google, Apple,
    Outlook, Fastmail and Nextcloud alike, and needs no write credential for
    the user's calendar - which is a permission worth not asking for.
    """
    if draft.starts_at is None:
        raise DraftError("an event needs a start time")
    end = draft.ends_at or (draft.starts_at + timedelta(minutes=max(1, draft.minutes)))

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Thursday//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        f"UID:{draft.id}@thursday",
        f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        f"DTSTART:{_stamp(draft.starts_at)}",
        f"DTEND:{_stamp(end)}",
        f"SUMMARY:{_escape(draft.subject)}",
    ]
    if draft.body:
        lines.append(f"DESCRIPTION:{_escape(draft.body)}")
    if draft.location:
        lines.append(f"LOCATION:{_escape(draft.location)}")
    for guest in draft.to:
        _, address = parseaddr(guest)
        if address:
            lines.append(f"ATTENDEE;RSVP=TRUE:mailto:{address}")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


# --------------------------------------------------------------------- draft


@dataclass
class Draft:
    """One prepared thing, and everything needed to judge it."""

    kind: str = "email"
    subject: str = ""
    body: str = ""
    to: list[str] = field(default_factory=list)
    cc: list[str] = field(default_factory=list)
    bcc: list[str] = field(default_factory=list)
    reply_to_message_id: str = ""
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    minutes: int = 60
    location: str = ""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    status: str = "draft"
    note: str = ""

    def check(self) -> None:
        """Refuse a draft that could not be sent, at the point it is written."""
        if self.kind not in KINDS:
            raise DraftError(f"a draft is one of {', '.join(KINDS)}, not {self.kind!r}")
        if not self.subject.strip():
            raise DraftError("a draft needs a subject")
        if self.kind == "email":
            if not self.to:
                raise DraftError("an email needs at least one recipient")
            bad = [entry for entry in (*self.to, *self.cc, *self.bcc) if not valid_address(entry)]
            if bad:
                raise DraftError(f"that does not look like an email address: {', '.join(bad)}")
        if self.kind == "event" and self.starts_at is None:
            raise DraftError("an event needs a start time")

    # The model sees this, and so does the page - one shape, so what you
    # approve is exactly what you were shown.
    def as_dict(self, full: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "subject": self.subject,
        }
        if self.to:
            payload["to"] = list(self.to)
        if self.cc:
            payload["cc"] = list(self.cc)
        if self.bcc:
            payload["bcc"] = list(self.bcc)
        if self.starts_at:
            payload["starts_at"] = self.starts_at.astimezone().isoformat(timespec="minutes")
            payload["minutes"] = self.minutes
        if self.location:
            payload["location"] = self.location
        if self.note:
            payload["note"] = self.note
        if full:
            payload["body"] = self.body
        return payload

    def as_row(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "subject": self.subject,
            "body": self.body,
            "recipients": ", ".join(self.to),
            "cc": ", ".join(self.cc),
            "bcc": ", ".join(self.bcc),
            "reply_to": self.reply_to_message_id,
            "starts_at": self.starts_at.timestamp() if self.starts_at else None,
            "minutes": self.minutes,
            "location": self.location,
            "status": self.status,
            "note": self.note,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Draft":
        starts = row["starts_at"]
        return cls(
            id=row["id"],
            kind=row["kind"],
            subject=row["subject"],
            body=row["body"],
            to=addresses(row["recipients"]),
            cc=addresses(row["cc"]),
            bcc=addresses(row["bcc"]),
            reply_to_message_id=row["reply_to"] or "",
            starts_at=datetime.fromtimestamp(starts).astimezone() if starts else None,
            minutes=int(row["minutes"] or 60),
            location=row["location"] or "",
            status=row["status"],
            note=row["note"] or "",
        )


class Outbox:
    """Drafts, and the one door they leave by."""

    def __init__(self, memory: Any, mailer: Mailer | None = None, out_dir: Path | None = None):
        self.memory = memory
        self.mailer = mailer or Mailer.from_env()
        self.out_dir = Path(out_dir) if out_dir else None

    # ------------------------------------------------------------ preparing

    def prepare(self, draft: Draft) -> Draft:
        draft.check()
        draft.status = "draft"
        self.memory.save_draft(draft.id, draft.as_row())
        return draft

    def get(self, draft_id: str) -> Draft:
        row = self.memory.draft(draft_id)
        if row is None:
            raise DraftError(f"there is no draft {draft_id}")
        return Draft.from_row(row)

    def list(self, status: str = "") -> list[Draft]:
        return [Draft.from_row(row) for row in self.memory.drafts(status)]

    # ------------------------------------------------------------- deciding

    def approve(self, draft_id: str) -> Draft:
        """Mark a draft as approved. Only a person does this."""
        draft = self.get(draft_id)
        if draft.status == "sent":
            raise DraftError(f"draft {draft_id} has already gone out")
        draft.check()
        draft.status = "approved"
        self.memory.set_draft_status(draft_id, "approved")
        return draft

    def discard(self, draft_id: str) -> Draft:
        draft = self.get(draft_id)
        if draft.status == "sent":
            raise DraftError(f"draft {draft_id} has already gone out; it cannot be unsent")
        draft.status = "discarded"
        self.memory.set_draft_status(draft_id, "discarded")
        return draft

    # -------------------------------------------------------------- sending

    def send(self, draft_id: str) -> dict[str, Any]:
        """Carry out an approved draft. Approval is checked here, not upstream,
        because this is the only place that matters."""
        draft = self.get(draft_id)
        if draft.status == "sent":
            raise DraftError(f"draft {draft_id} has already gone out")
        if draft.status != "approved":
            raise DraftError(
                f"draft {draft_id} has not been approved. Show it to the user and "
                "let them approve it; you cannot approve it yourself."
            )

        if draft.kind == "email":
            try:
                went_to = self.mailer.send(draft)
            except DraftError:
                self.memory.set_draft_status(draft_id, "failed")
                raise
            self.memory.set_draft_status(draft_id, "sent")
            return {"id": draft_id, "sent_to": went_to, "subject": draft.subject}

        path = self.write_invite(draft)
        self.memory.set_draft_status(draft_id, "sent")
        return {"id": draft_id, "saved_to": str(path), "subject": draft.subject}

    def write_invite(self, draft: Draft) -> Path:
        target = self.out_dir or Path.cwd()
        target.mkdir(parents=True, exist_ok=True)
        # Only strip what a filesystem objects to. A character class of \w
        # would drop Thai vowel marks, which are not alphanumeric, and turn
        # "รีวิวงาน" into "ร-ว-วงาน".
        safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", draft.subject).strip(" .-")[:60] or "event"
        path = target / f"{safe}-{draft.id}.ics"
        path.write_text(to_ics(draft), encoding="utf-8")
        return path
