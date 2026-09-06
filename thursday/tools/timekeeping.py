"""Time, timers and reminders."""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import ToolContext, ToolError, tool

# English and Thai duration units, longest alternatives first so "minutes"
# never matches as "m".
_DURATION_RE = re.compile(
    r"(?P<value>\d+(?:\.\d+)?)\s*"
    r"(?P<unit>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|"
    r"\u0e27\u0e34\u0e19\u0e32\u0e17\u0e35|\u0e19\u0e32\u0e17\u0e35|"
    r"\u0e0a\u0e31\u0e48\u0e27\u0e42\u0e21\u0e07|\u0e0a\u0e21|\u0e27\u0e31\u0e19|"
    r"s|m|h|d)(?![a-z])",
    re.IGNORECASE,
)
_UNIT_SECONDS = {
    "s": 1,
    "sec": 1,
    "second": 1,
    "m": 60,
    "min": 60,
    "minute": 60,
    "h": 3600,
    "hr": 3600,
    "hour": 3600,
    "d": 86400,
    "day": 86400,
    "\u0e27\u0e34\u0e19\u0e32\u0e17\u0e35": 1,      # winathi - second
    "\u0e19\u0e32\u0e17\u0e35": 60,           # nathi - minute
    "\u0e0a\u0e31\u0e48\u0e27\u0e42\u0e21\u0e07": 3600,    # chuamong - hour
    "\u0e0a\u0e21": 3600,                # chm - colloquial hour
    "\u0e27\u0e31\u0e19": 86400,           # wan - day
}


def parse_duration(text: str) -> float | None:
    """Turn "5 minutes", "1h30m", "90s" or "10 \u0e19\u0e32\u0e17\u0e35" into seconds."""
    total = 0.0
    for match in _DURATION_RE.finditer(text):
        unit = match.group("unit").lower()
        seconds = (
            _UNIT_SECONDS.get(unit)
            or _UNIT_SECONDS.get(unit.rstrip("s"))
            or _UNIT_SECONDS.get(unit[:3])
        )
        if seconds:
            total += float(match.group("value")) * seconds
    return total or None


def parse_when(text: str, now: datetime | None = None) -> datetime | None:
    """Parse a due time: a duration ("in 10 minutes"), a clock time ("18:30")
    or an ISO timestamp."""
    moment = now or datetime.now().astimezone()
    cleaned = text.strip()

    duration = parse_duration(cleaned)
    if duration:
        return moment + timedelta(seconds=duration)

    try:
        parsed = datetime.fromisoformat(cleaned)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=moment.tzinfo)
    except ValueError:
        pass

    clock = re.search(r"\b(?P<h>\d{1,2})[:.](?P<m>\d{2})\b", cleaned)
    if clock:
        hour, minute = int(clock.group("h")), int(clock.group("m"))
        if 0 <= hour < 24 and 0 <= minute < 60:
            target = moment.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if target <= moment:
                target += timedelta(days=1)
            return target
    return None


@tool
def current_time(timezone_name: str = "") -> dict[str, Any]:
    """Get the current date and time.

    Args:
        timezone_name: An IANA timezone such as "Asia/Bangkok". Defaults to the
            machine's local timezone.
    """
    if timezone_name:
        try:
            zone: Any = ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ToolError(f"unknown timezone {timezone_name!r}") from exc
        now = datetime.now(zone)
    else:
        now = datetime.now().astimezone()
    return {
        "iso": now.isoformat(timespec="seconds"),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M:%S"),
        "weekday": now.strftime("%A"),
        "timezone": str(now.tzinfo),
        "unix": int(now.timestamp()),
    }


REPEAT_SECONDS = {
    "": None,
    "once": None,
    "hourly": 3600.0,
    "daily": 86400.0,
    "weekdays": 86400.0,  # rolled forward a day at a time; skipping weekends
    "weekly": 604800.0,   # is left to the user cancelling it
    "monthly": 2592000.0,  # 30 days - calendar months are not fixed-length
}


@tool
def set_reminder(
    text: str,
    when: str,
    repeat: Literal["once", "hourly", "daily", "weekly", "monthly"] = "once",
    ctx: ToolContext = None,
) -> dict[str, Any]:
    """Remind the user about something at a given time, once or on a repeat.

    Args:
        text: What to remind the user about.
        when: When to fire it first - "in 10 minutes", "18:30", or an ISO timestamp.
        repeat: How often to repeat after that. "once" does not repeat.
    """
    if ctx is None or ctx.memory is None:
        raise ToolError("reminders need persistent memory, which is unavailable")
    due = parse_when(when)
    if due is None:
        raise ToolError(
            f"could not understand the time {when!r}; try '15 minutes' or '18:30'"
        )
    if repeat not in REPEAT_SECONDS:
        raise ToolError(f"unknown repeat {repeat!r}; use one of {', '.join(REPEAT_SECONDS)}")

    every = REPEAT_SECONDS[repeat]
    reminder = ctx.memory.add_reminder(text, due.timestamp(), every)
    result = {
        "id": reminder.id,
        "text": text,
        "due_at": due.isoformat(timespec="seconds"),
        "in_seconds": round(due.timestamp() - time.time()),
    }
    if every:
        result["repeat"] = repeat
    return result


@tool
def list_reminders(ctx: ToolContext = None) -> list[dict[str, Any]]:
    """List reminders that have not fired yet."""
    if ctx is None or ctx.memory is None:
        return []
    return [r.as_dict() for r in ctx.memory.pending_reminders()]


@tool
def cancel_reminder(reminder_id: int, ctx: ToolContext = None) -> str:
    """Cancel a pending reminder.

    Args:
        reminder_id: The id returned by set_reminder or list_reminders.
    """
    if ctx is None or ctx.memory is None:
        raise ToolError("no memory available")
    return "cancelled" if ctx.memory.cancel_reminder(reminder_id) else "no such pending reminder"


@tool
def set_timer(duration: str, label: str = "timer", ctx: ToolContext = None) -> dict[str, Any]:
    """Start a countdown timer, e.g. a 10 minute kitchen timer.

    Args:
        duration: How long to wait, e.g. "10 minutes" or "1h30m".
        label: What the timer is for.
    """
    seconds = parse_duration(duration)
    if seconds is None:
        raise ToolError(f"could not understand the duration {duration!r}")
    due = datetime.now(timezone.utc) + timedelta(seconds=seconds)
    if ctx is None or ctx.memory is None:
        raise ToolError("timers need persistent memory, which is unavailable")
    reminder = ctx.memory.add_reminder(label, due.timestamp())
    return {
        "id": reminder.id,
        "label": label,
        "seconds": round(seconds),
        "fires_at": due.astimezone().isoformat(timespec="seconds"),
    }
