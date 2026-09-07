"""Your calendar, read from an .ics feed or a CalDAV server.

Deliberately not tied to any one provider: Google, Fastmail, iCloud, Nextcloud
and Outlook all publish an ICS URL, and the same parser reads a file exported
to disk. Reading only - an assistant that can quietly move meetings is a
different, riskier feature.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from . import ToolContext, ToolError, tool

log = logging.getLogger(__name__)

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

#: Unfolding: ICS wraps long lines with a leading space or tab.
_FOLD = re.compile(r"\r?\n[ \t]")


@dataclass
class Event:
    summary: str
    start: datetime | date | None
    end: datetime | date | None
    location: str = ""
    description: str = ""

    @property
    def all_day(self) -> bool:
        return isinstance(self.start, date) and not isinstance(self.start, datetime)

    def as_dict(self) -> dict[str, Any]:
        return {
            "what": self.summary,
            "when": self._when(),
            "where": self.location,
            **({"notes": self.description[:300]} if self.description else {}),
        }

    def _when(self) -> str:
        if self.start is None:
            return "unknown"
        if self.all_day:
            return f"{self.start.isoformat()} (all day)"
        text = self.start.strftime("%a %d %b %H:%M")
        if isinstance(self.end, datetime):
            text += self.end.strftime("–%H:%M")
        return text


def _unfold(raw: str) -> list[str]:
    return _FOLD.sub("", raw).splitlines()


def _zone(tzid: str) -> Any:
    """The zone a TZID names, or None if this machine cannot look it up.

    Windows ships no IANA database, so ZoneInfo("Asia/Bangkok") raises there
    unless the tzdata package is installed - which it is, as a dependency, but
    a missing zone must degrade to "assume local" rather than lose the event.
    """
    if not tzid:
        return None
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(tzid)
    except Exception:
        log.debug("unknown calendar timezone %r; reading it as local time", tzid)
        return None


def _parse_moment(value: str, tzid: str = "") -> datetime | date | None:
    """ICS times: 20260906T083000Z, 20260906T083000, or 20260906 for all-day.

    Everything comes back in this machine's own timezone, converted rather
    than relabelled. Stamping local tzinfo onto a UTC reading keeps the digits
    and changes the moment, which is how an 08:30 UTC meeting used to show up
    as 08:30 in Bangkok - seven hours out, and looking perfectly reasonable.
    """
    value = value.strip()
    try:
        if value.endswith("Z"):
            return (
                datetime.strptime(value, "%Y%m%dT%H%M%SZ")
                .replace(tzinfo=timezone.utc)
                .astimezone()
            )
        if "T" in value:
            moment = datetime.strptime(value, "%Y%m%dT%H%M%S")
            zone = _zone(tzid)
            # No TZID is a "floating" time in the spec: whatever the clock on
            # the wall says, wherever you are. astimezone() reads it that way.
            return moment.replace(tzinfo=zone).astimezone() if zone else moment.astimezone()
        if len(value) == 8:
            return datetime.strptime(value, "%Y%m%d").date()
    except ValueError:
        log.debug("could not read an ICS time: %r", value)
    return None


def _unescape(value: str) -> str:
    return (
        value.replace("\\n", "\n").replace("\\,", ",").replace("\;", ";").replace("\\\\", "\\")
    )


def parse_ics(raw: str) -> list[Event]:
    """Pull the events out of an ICS calendar."""
    events: list[Event] = []
    current: dict[str, str] | None = None

    for line in _unfold(raw):
        if line.startswith("BEGIN:VEVENT"):
            current = {}
            continue
        if line.startswith("END:VEVENT"):
            if current is not None:
                events.append(
                    Event(
                        summary=_unescape(current.get("SUMMARY", "(untitled)")),
                        start=_parse_moment(
                            current.get("DTSTART", ""), current.get("DTSTART.TZID", "")
                        ),
                        end=_parse_moment(
                            current.get("DTEND", ""), current.get("DTEND.TZID", "")
                        ),
                        location=_unescape(current.get("LOCATION", "")),
                        description=_unescape(current.get("DESCRIPTION", "")),
                    )
                )
            current = None
            continue
        if current is None or ":" not in line:
            continue
        name, _, value = line.partition(":")
        # DTSTART;TZID=Europe/London:20260906T090000 - the parameters carry
        # the timezone, so they are read rather than thrown away. Dropping
        # the TZID left 09:00 London to be read as 09:00 wherever the machine
        # happened to be.
        parameters = name.split(";")
        key = parameters[0].upper()
        if key in {"SUMMARY", "DTSTART", "DTEND", "LOCATION", "DESCRIPTION"}:
            current[key] = value
            for parameter in parameters[1:]:
                label, _, setting = parameter.partition("=")
                if label.strip().upper() == "TZID":
                    current[f"{key}.TZID"] = setting.strip().strip('"')

    return events


def sources() -> list[str]:
    """Calendars to read, from THURSDAY_CALENDARS (URLs or paths)."""
    raw = os.environ.get("THURSDAY_CALENDARS", "")
    return [entry.strip() for entry in raw.split(",") if entry.strip()]


def load(source: str, timeout: float = 30.0) -> str:
    """Fetch one calendar, from the web or from disk."""
    if source.startswith(("http://", "https://", "webcal://")):
        if httpx is None:  # pragma: no cover
            raise ToolError("httpx is not installed")
        url = source.replace("webcal://", "https://", 1)
        try:
            response = httpx.get(url, timeout=timeout, follow_redirects=True)
            response.raise_for_status()
            return response.text
        except Exception as exc:
            raise ToolError(f"could not fetch the calendar: {exc}") from exc

    path = Path(source).expanduser()
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ToolError(f"could not read {path}: {exc}") from exc


def within(events: Iterable[Event], start: datetime, end: datetime) -> list[Event]:
    """Events that fall in a window, earliest first."""
    chosen = []
    for event in events:
        moment = event.start
        if moment is None:
            continue
        if isinstance(moment, datetime):
            when = moment
        else:  # an all-day event counts as starting at midnight
            when = datetime.combine(moment, datetime.min.time()).astimezone()
        if start <= when <= end:
            chosen.append((when, event))
    chosen.sort(key=lambda pair: pair[0])
    return [event for _, event in chosen]


@tool
def whats_on(days: int = 1, ctx: ToolContext = None) -> dict[str, Any]:
    """Look at the user's calendar.

    Use this for "what's on today", "am I free on Thursday", "what's my week
    like". Needs THURSDAY_CALENDARS set to one or more .ics URLs or files.

    Args:
        days: How many days ahead to look. 1 is the rest of today.
    """
    feeds = sources()
    if not feeds:
        raise ToolError(
            "no calendar is configured; set THURSDAY_CALENDARS to an .ics URL "
            "(every calendar app publishes one) under Config"
        )

    now = datetime.now().astimezone()
    end = (now + timedelta(days=max(1, days))).replace(hour=23, minute=59)

    events: list[Event] = []
    problems: list[str] = []
    for feed in feeds:
        try:
            events += parse_ics(load(feed))
        except ToolError as exc:
            problems.append(str(exc))

    upcoming = within(events, now.replace(hour=0, minute=0), end)
    result: dict[str, Any] = {
        "window": f"{now:%a %d %b} to {end:%a %d %b}",
        "events": [event.as_dict() for event in upcoming[:40]],
        "count": len(upcoming),
    }
    if problems:
        result["problems"] = problems
    if not upcoming and not problems:
        result["events"] = []
        result["note"] = "nothing in that window"
    return result
