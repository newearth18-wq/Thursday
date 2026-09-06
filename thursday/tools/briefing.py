"""Asking for the day in one go."""

from __future__ import annotations

from typing import Any

from . import ToolContext, ToolError, tool


@tool
async def daily_brief(hours: int = 12, ctx: ToolContext = None) -> dict[str, Any]:
    """Everything that needs the user: calendar, inbox, reminders, drafts, work.

    Use this for "what's my day", "anything I should know", "สรุปวันนี้", and
    at the start of a morning routine. Read it back in the user's own words -
    do not just list it - and leave out the parts that are empty.

    Args:
        hours: How far ahead to look in the calendar.
    """
    agent = ctx.state.get("agent") if ctx else None
    if agent is None:
        raise ToolError("the brief needs the assistant, which is not available here")

    from ..briefing import Briefing

    person = getattr(ctx.state.get("person"), "key", "") or ""
    brief = await Briefing(agent).gather(person=person, hours=max(1, hours))
    return brief.as_dict()
