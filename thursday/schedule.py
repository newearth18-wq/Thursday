"""Routines that fire on their own, so Thursday does not only ever react.

A schedule is a saved routine plus a time: "every weekday at 08:00, run the
morning routine". When it fires, Thursday carries the routine out exactly as
if you had asked, and the answer arrives as a desktop notification and in
whatever front end is attached.

Times are expressed the way people say them - `08:00`, `every 30m`,
`weekdays 09:15`, `mon,thu 20:00` - because a personal assistant should not
ask its owner to write cron.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Iterable

log = logging.getLogger(__name__)

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
DAY_SETS = {
    "daily": set(range(7)),
    "everyday": set(range(7)),
    "weekdays": {0, 1, 2, 3, 4},
    "weekends": {5, 6},
}

_TIME = re.compile(r"\b(?P<hour>[01]?\d|2[0-3])[:.](?P<minute>[0-5]\d)\b")
_EVERY = re.compile(r"\bevery\s+(?P<value>\d+)\s*(?P<unit>m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b", re.I)


@dataclass
class Schedule:
    """When a routine should run."""

    #: Minutes between runs, for an interval schedule.
    every_minutes: int = 0
    #: Local time of day, for a clock schedule.
    hour: int = -1
    minute: int = 0
    #: Weekdays it may run on; empty means every day.
    days: frozenset[int] = frozenset()
    raw: str = ""

    @property
    def kind(self) -> str:
        if self.every_minutes:
            return "interval"
        return "clock" if self.hour >= 0 else "never"

    def describe(self) -> str:
        if self.kind == "interval":
            if self.every_minutes % 60 == 0:
                hours = self.every_minutes // 60
                return f"every {hours} hour{'s' if hours > 1 else ''}"
            return f"every {self.every_minutes} minutes"
        if self.kind == "clock":
            when = f"{self.hour:02d}:{self.minute:02d}"
            if not self.days or len(self.days) == 7:
                return f"every day at {when}"
            if self.days == DAY_SETS["weekdays"]:
                return f"weekdays at {when}"
            if self.days == DAY_SETS["weekends"]:
                return f"weekends at {when}"
            names = ", ".join(DAYS[index] for index in sorted(self.days))
            return f"{names} at {when}"
        return "never"

    def next_after(self, moment: datetime) -> datetime | None:
        """The first time this fires strictly after `moment`."""
        if self.kind == "interval":
            return moment + timedelta(minutes=self.every_minutes)
        if self.kind != "clock":
            return None

        allowed = self.days or frozenset(range(7))
        candidate = moment.replace(hour=self.hour, minute=self.minute, second=0, microsecond=0)
        if candidate <= moment:
            candidate += timedelta(days=1)
        for _ in range(8):
            if candidate.weekday() in allowed:
                return candidate
            candidate += timedelta(days=1)
        return None


def parse(text: str) -> Schedule:
    """Turn "weekdays 08:00" or "every 30m" into a Schedule."""
    raw = (text or "").strip()
    lowered = raw.lower()

    interval = _EVERY.search(lowered)
    if interval:
        value = int(interval.group("value"))
        unit = interval.group("unit").lower()
        minutes = value * (60 if unit.startswith("h") else 1)
        return Schedule(every_minutes=max(1, minutes), raw=raw)

    clock = _TIME.search(lowered)
    if not clock:
        return Schedule(raw=raw)

    days: set[int] = set()
    for name, group in DAY_SETS.items():
        if name in lowered:
            days |= group
    for index, name in enumerate(DAYS):
        if re.search(rf"\b{name}", lowered):
            days.add(index)

    return Schedule(
        hour=int(clock.group("hour")),
        minute=int(clock.group("minute")),
        days=frozenset(days),
        raw=raw,
    )


def due(schedules: Iterable[dict[str, Any]], now: datetime | None = None) -> list[dict[str, Any]]:
    """Which saved schedules should run now."""
    moment = now or datetime.now().astimezone()
    ready = []
    for entry in schedules:
        next_run = entry.get("next_run")
        if next_run is None:
            continue
        when = datetime.fromtimestamp(next_run, tz=moment.tzinfo)
        if when <= moment:
            ready.append(entry)
    return ready
