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


#: Days named relative to today, in both languages people ask in here.
_DAY_WORDS: dict[str, int] = {
    "today": 0, "tonight": 0, "\u0e27\u0e31\u0e19\u0e19\u0e35\u0e49": 0, "\u0e04\u0e37\u0e19\u0e19\u0e35\u0e49": 0,
    "tomorrow": 1, "\u0e1e\u0e23\u0e38\u0e48\u0e07\u0e19\u0e35\u0e49": 1, "\u0e04\u0e37\u0e19\u0e1e\u0e23\u0e38\u0e48\u0e07\u0e19\u0e35\u0e49": 1,
    "overmorrow": 2, "\u0e21\u0e30\u0e23\u0e37\u0e19": 2, "\u0e21\u0e30\u0e23\u0e37\u0e19\u0e19\u0e35\u0e49": 2,
}

#: Weekday names, Monday = 0 to match datetime.weekday().
_WEEKDAYS: dict[str, int] = {
    "monday": 0, "mon": 0, "\u0e08\u0e31\u0e19\u0e17\u0e23\u0e4c": 0,
    "tuesday": 1, "tue": 1, "tues": 1, "\u0e2d\u0e31\u0e07\u0e04\u0e32\u0e23": 1,
    "wednesday": 2, "wed": 2, "\u0e1e\u0e38\u0e18": 2,
    "thursday": 3, "thu": 3, "thur": 3, "thurs": 3, "\u0e1e\u0e24\u0e2b\u0e31\u0e2a": 3,
    "friday": 4, "fri": 4, "\u0e28\u0e38\u0e01\u0e23\u0e4c": 4,
    "saturday": 5, "sat": 5, "\u0e40\u0e2a\u0e32\u0e23\u0e4c": 5,
    "sunday": 6, "sun": 6, "\u0e2d\u0e32\u0e17\u0e34\u0e15\u0e22\u0e4c": 6,
}

#: Whole times of day that name themselves.
_THAI_PERIODS = (
    ("\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07\u0e04\u0e37\u0e19", 0),   # thiang khuen - midnight
    ("\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07\u0e27\u0e31\u0e19", 12),  # thiang wan - noon
    ("\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07", 12),       # thiang - noon
    ("\u0e15\u0e35\u0e2b\u0e19\u0e36\u0e48\u0e07", 1), ("\u0e15\u0e35\u0e2a\u0e2d\u0e07", 2), ("\u0e15\u0e35\u0e2a\u0e32\u0e21", 3),
    ("\u0e15\u0e35\u0e2a\u0e35\u0e48", 4), ("\u0e15\u0e35\u0e2b\u0e49\u0e32", 5),
)

#: Thai number words that turn up in times, one to twelve.
_THAI_NUMBERS = {
    "\u0e2b\u0e19\u0e36\u0e48\u0e07": 1, "\u0e2a\u0e2d\u0e07": 2, "\u0e2a\u0e32\u0e21": 3, "\u0e2a\u0e35\u0e48": 4, "\u0e2b\u0e49\u0e32": 5, "\u0e2b\u0e01": 6,
    "\u0e40\u0e08\u0e47\u0e14": 7, "\u0e41\u0e1b\u0e14": 8, "\u0e40\u0e01\u0e49\u0e32": 9, "\u0e2a\u0e34\u0e1a": 10, "\u0e2a\u0e34\u0e1a\u0e40\u0e2d\u0e47\u0e14": 11, "\u0e2a\u0e34\u0e1a\u0e2a\u0e2d\u0e07": 12,
}
_THAI_NUMBER_RE = "|".join(sorted(_THAI_NUMBERS, key=len, reverse=True))


def _thai_number(word: str) -> int:
    word = (word or "").strip()
    if word.isdigit():
        return int(word)
    return _THAI_NUMBERS.get(word, 0)


def _thai_clock(text: str) -> tuple[int, int] | None:
    """The Thai way of telling the time, where the hour is not an offset.

    Thai counts the day in stretches rather than in halves, and the number can
    sit on either side of the word: "\u0e1a\u0e48\u0e32\u0e22\u0e2a\u0e2d\u0e07" and "\u0e2a\u0e2d\u0e07\u0e17\u0e38\u0e48\u0e21" both put it
    first for an English reader and second for a Thai one.
    """
    number = _THAI_NUMBER_RE

    # N \u0e17\u0e38\u0e48\u0e21 - evening, 19:00 to 23:00. "\u0e2a\u0e2d\u0e07\u0e17\u0e38\u0e48\u0e21" is 20:00.
    evening = re.search(rf"(\d{{1,2}}|{number})?\s*\u0e17\u0e38\u0e48\u0e21", text)
    if evening:
        hour = _thai_number(evening.group(1)) or 1
        if 1 <= hour <= 6:
            return (hour + 18, 0)

    # \u0e1a\u0e48\u0e32\u0e22 N (\u0e42\u0e21\u0e07) - afternoon. "\u0e1a\u0e48\u0e32\u0e22\u0e42\u0e21\u0e07" alone is 13:00.
    afternoon = re.search(rf"\u0e1a\u0e48\u0e32\u0e22\s*(\d{{1,2}}|{number})?", text)
    if afternoon:
        hour = _thai_number(afternoon.group(1)) or 1
        if 1 <= hour <= 5:
            return (hour + 12, 0)
        if 13 <= hour <= 18:            # "\u0e1a\u0e48\u0e32\u0e22 14:00" said the 24-hour way
            return (hour, 0)

    # N \u0e42\u0e21\u0e07\u0e40\u0e22\u0e47\u0e19 - late afternoon, 16:00 to 18:00.
    late = re.search(rf"(\d{{1,2}}|{number})\s*\u0e42\u0e21\u0e07\u0e40\u0e22\u0e47\u0e19", text)
    if late:
        hour = _thai_number(late.group(1))
        if 1 <= hour <= 6:
            return (hour + 12, 0)

    # N \u0e42\u0e21\u0e07(\u0e40\u0e0a\u0e49\u0e32) - morning, taken as given.
    morning = re.search(rf"(\d{{1,2}}|{number})\s*\u0e42\u0e21\u0e07", text)
    if morning:
        hour = _thai_number(morning.group(1))
        if 6 <= hour <= 11:
            return (hour, 0)
        if 1 <= hour <= 5:              # "\u0e15\u0e35\u0e2a\u0e2d\u0e07\u0e42\u0e21\u0e07" and the like
            return (hour, 0)

    for word, hour in _THAI_PERIODS:
        if word in text:
            return (hour, 0)
    return None


def _clock_in(text: str) -> tuple[int, int] | None:
    """The time of day named in a string, if any.

    Handles 18:30, 6.30pm, "9am", "2 pm", and the Thai forms above.
    """
    lowered = text.lower()

    thai = _thai_clock(lowered)
    if thai:
        return thai

    # 18:30, 6.30pm, then a bare 9am / 2 pm.
    match = re.search(r"\b(?P<h>\d{1,2})[:.](?P<m>\d{2})\s*(?P<ampm>am|pm)?", lowered)
    if match:
        hour, minute = int(match.group("h")), int(match.group("m"))
    else:
        match = re.search(r"\b(?P<h>\d{1,2})\s*(?P<ampm>am|pm)\b", lowered)
        if not match:
            return None
        hour, minute = int(match.group("h")), 0
    period = match.group("ampm")
    if period == "pm" and hour < 12:
        hour += 12
    elif period == "am" and hour == 12:
        hour = 0
    if 0 <= hour < 24 and 0 <= minute < 60:
        return (hour, minute)
    return None


def parse_when(text: str, now: datetime | None = None) -> datetime | None:
    """Parse a due time however a person said it.

    Understands a duration ("in 10 minutes", "10 \u0e19\u0e32\u0e17\u0e35"), an ISO timestamp, a
    clock time ("18:30", "9am", "\u0e1a\u0e48\u0e32\u0e22\u0e2a\u0e2d\u0e07"), a named day ("tomorrow 14:00",
    "\u0e1e\u0e23\u0e38\u0e48\u0e07\u0e19\u0e35\u0e49\u0e40\u0e0a\u0e49\u0e32 9 \u0e42\u0e21\u0e07") and a weekday ("friday 9am", "\u0e28\u0e38\u0e01\u0e23\u0e4c 10:00").

    A named day is taken at its word: "tomorrow 14:00" is tomorrow even when
    14:00 has not happened yet today. Only a bare time rolls forward.
    """
    moment = now or datetime.now().astimezone()
    cleaned = text.strip()
    if not cleaned:
        return None

    duration = parse_duration(cleaned)
    if duration:
        return moment + timedelta(seconds=duration)

    try:
        parsed = datetime.fromisoformat(cleaned)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=moment.tzinfo)
    except ValueError:
        pass

    lowered = cleaned.lower()
    clock = _clock_in(lowered)

    # A named day fixes the date, so the time is taken as given.
    for word, offset in _DAY_WORDS.items():
        if word in lowered:
            hour, minute = clock or (9, 0)
            return (moment + timedelta(days=offset)).replace(
                hour=hour, minute=minute, second=0, microsecond=0
            )

    for word, weekday in _WEEKDAYS.items():
        # Word boundaries keep "sat" out of "saturate"; Thai has no boundaries
        # the regex engine can see, so those are matched as plain substrings.
        pattern = rf"\b{word}\b" if word.isascii() else re.escape(word)
        if re.search(pattern, lowered):
            ahead = (weekday - moment.weekday()) % 7 or 7   # "friday" on a Friday means next one
            hour, minute = clock or (9, 0)
            return (moment + timedelta(days=ahead)).replace(
                hour=hour, minute=minute, second=0, microsecond=0
            )

    if clock:
        hour, minute = clock
        target = moment.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= moment:      # a bare time that has passed means tomorrow
            target += timedelta(days=1)
        return target
    return None


def _whose(ctx: ToolContext | None) -> str:
    """Whose reminder this is, so it is theirs and not the household's."""
    if ctx is None:
        return ""
    return getattr(ctx.state.get("person"), "key", "") or ""


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
    reminder = ctx.memory.add_reminder(text, due.timestamp(), every, person=_whose(ctx))
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
    return [r.as_dict() for r in ctx.memory.pending_reminders(_whose(ctx))]


@tool
def cancel_reminder(reminder_id: int, ctx: ToolContext = None) -> str:
    """Cancel a pending reminder.

    Args:
        reminder_id: The id returned by set_reminder or list_reminders.
    """
    if ctx is None or ctx.memory is None:
        raise ToolError("no memory available")
    return ("cancelled" if ctx.memory.cancel_reminder(reminder_id, _whose(ctx))
            else "no such pending reminder")


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
    reminder = ctx.memory.add_reminder(label, due.timestamp(), person=_whose(ctx))
    return {
        "id": reminder.id,
        "label": label,
        "seconds": round(seconds),
        "fires_at": due.astimezone().isoformat(timespec="seconds"),
    }
