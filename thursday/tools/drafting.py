"""Writing mail and diary entries - and stopping short of sending them.

Every tool here ends at a draft. `send_draft` exists, but it refuses anything
the user has not approved, and `approve_draft` is not reachable from the
model: approval arrives from the terminal, the HUD or the chat bridge, where a
person is the one pressing it.
"""

from __future__ import annotations

from typing import Any

from ..drafts import Draft, DraftError, Mailer, Outbox
from . import ToolContext, ToolError, tool
from .timekeeping import parse_when


def _outbox(ctx: ToolContext) -> Outbox:
    if ctx is None or ctx.memory is None:
        raise ToolError("drafts need memory, which is not available here")
    existing = ctx.state.get("outbox")
    if isinstance(existing, Outbox):
        return existing
    out_dir = ctx.settings.data_dir / "invites" if ctx.settings else None
    outbox = Outbox(ctx.memory, out_dir=out_dir)
    ctx.state["outbox"] = outbox
    return outbox


def _shown(draft: Draft, outbox: Outbox) -> dict[str, Any]:
    payload = draft.as_dict()
    payload["next"] = (
        "Show this to the user and ask whether to send it. "
        "They approve it; you cannot."
    )
    if draft.kind == "email":
        problem = outbox.mailer.why_not()
        if problem:
            payload["warning"] = problem
    return payload


@tool
def draft_email(
    to: str,
    subject: str,
    body: str,
    cc: str = "",
    reply_to_message_id: str = "",
    ctx: ToolContext = None,
) -> dict[str, Any]:
    """Write an email for the user to look over. It is NOT sent.

    Use this for "reply to that", "email them about", "send a note to". Write
    the message as the user would send it, in their language, then show it and
    ask whether to send. Only the user can approve it.

    Args:
        to: Recipients, comma separated.
        subject: The subject line.
        body: The whole message, ready to send.
        cc: Anyone copied in, comma separated.
        reply_to_message_id: The id from check_mail, when this is a reply.
    """
    outbox = _outbox(ctx)
    try:
        draft = outbox.prepare(
            Draft(
                kind="email",
                to=[part.strip() for part in to.replace(";", ",").split(",") if part.strip()],
                cc=[part.strip() for part in cc.replace(";", ",").split(",") if part.strip()],
                subject=subject,
                body=body,
                reply_to_message_id=reply_to_message_id,
            )
        )
    except DraftError as exc:
        raise ToolError(str(exc)) from exc
    return _shown(draft, outbox)


@tool
def draft_event(
    title: str,
    when: str,
    minutes: int = 60,
    guests: str = "",
    location: str = "",
    notes: str = "",
    ctx: ToolContext = None,
) -> dict[str, Any]:
    """Write a calendar entry for the user to look over. It is NOT added.

    Once approved it is saved as an .ics file, which every calendar app opens
    - so this needs no write access to their calendar account.

    Args:
        title: What the event is called.
        when: When it starts, in plain words: "tomorrow 14:00", "friday 9am".
        minutes: How long it runs.
        guests: Email addresses to invite, comma separated.
        location: Where it is.
        notes: Anything else worth putting in the description.
    """
    starts_at = parse_when(when)
    if starts_at is None:
        raise ToolError(
            f"I could not read {when!r} as a time. Try 'tomorrow 14:00' or 'friday 9am'."
        )
    outbox = _outbox(ctx)
    try:
        draft = outbox.prepare(
            Draft(
                kind="event",
                subject=title,
                body=notes,
                to=[part.strip() for part in guests.replace(";", ",").split(",") if part.strip()],
                starts_at=starts_at,
                minutes=max(1, minutes),
                location=location,
            )
        )
    except DraftError as exc:
        raise ToolError(str(exc)) from exc
    return _shown(draft, outbox)


@tool
def list_drafts(status: str = "", ctx: ToolContext = None) -> dict[str, Any]:
    """What is waiting to be sent, and what has already gone.

    Args:
        status: Narrow to one of draft, approved, sent, failed.
    """
    outbox = _outbox(ctx)
    drafts = outbox.list(status.strip().lower())
    return {
        "count": len(drafts),
        "drafts": [draft.as_dict(full=False) for draft in drafts],
        "waiting": sum(1 for draft in drafts if draft.status == "draft"),
    }


@tool
def read_draft(draft_id: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Read one draft back in full, exactly as it would go out.

    Args:
        draft_id: The id from draft_email, draft_event or list_drafts.
    """
    outbox = _outbox(ctx)
    try:
        return outbox.get(draft_id).as_dict()
    except DraftError as exc:
        raise ToolError(str(exc)) from exc


@tool
def revise_draft(
    draft_id: str, subject: str = "", body: str = "", to: str = "", ctx: ToolContext = None
) -> dict[str, Any]:
    """Change a draft the user has asked you to fix.

    Revising sends it back to unapproved, so a message can never be edited
    after the user has agreed to it.

    Args:
        draft_id: Which draft.
        subject: A new subject, if it should change.
        body: A new body, if it should change.
        to: New recipients, if they should change.
    """
    outbox = _outbox(ctx)
    try:
        draft = outbox.get(draft_id)
        if draft.status == "sent":
            raise ToolError(f"draft {draft_id} has already gone out; write a new one")
        if subject:
            draft.subject = subject
        if body:
            draft.body = body
        if to:
            draft.to = [part.strip() for part in to.replace(";", ",").split(",") if part.strip()]
        outbox.prepare(draft)   # prepare() resets it to 'draft'
    except DraftError as exc:
        raise ToolError(str(exc)) from exc
    return _shown(draft, outbox)


@tool
def discard_draft(draft_id: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Throw a draft away.

    Args:
        draft_id: Which draft.
    """
    outbox = _outbox(ctx)
    try:
        outbox.discard(draft_id)
    except DraftError as exc:
        raise ToolError(str(exc)) from exc
    return {"id": draft_id, "status": "discarded"}


@tool(dangerous=True)
async def send_draft(draft_id: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Send a draft the user has ALREADY approved.

    This refuses anything not approved, so calling it is not a way to send
    something the user has not agreed to. Ask them to approve it first.

    Args:
        draft_id: Which draft.
    """
    outbox = _outbox(ctx)
    try:
        draft = outbox.get(draft_id)
    except DraftError as exc:
        raise ToolError(str(exc)) from exc

    if draft.status != "approved":
        raise ToolError(
            f"draft {draft_id} is {draft.status}, not approved. "
            "Show it to the user and let them approve it - you cannot approve it yourself."
        )
    if ctx is not None:
        where = ", ".join(draft.to) or "your calendar"
        agreed = await ctx.request_confirmation(
            f"Send \"{draft.subject}\"?", f"To {where}\n\n{draft.body[:600]}"
        )
        if not agreed:
            raise ToolError("the user declined to send it")
    try:
        return outbox.send(draft_id)
    except DraftError as exc:
        raise ToolError(str(exc)) from exc


@tool
def mail_setup(ctx: ToolContext = None) -> dict[str, Any]:
    """Whether Thursday can send mail at all, and what is missing if not."""
    mailer = Mailer.from_env()
    problem = mailer.why_not()
    return {
        "can_send": not problem,
        "host": mailer.host or "(not set)",
        "from": mailer.from_address or "(not set)",
        "detail": problem or "ready; drafts still need your approval before anything goes out",
    }
