"""What your day looks like, gathered in one place.

Everything in a brief is already available: whats_on reads the calendar,
check_mail the inbox, list_reminders the reminders. Asking for them one at a
time is six questions to get one answer, and the assistant has to remember to
ask all six.

The gathering is plain Python, not a model turn. Six sources are read
concurrently and the result is a structure - so the same brief can be spoken
aloud, drawn on the HUD, or handed to the model to summarise in the user's own
language, and so it costs nothing to render when nothing has changed.

A source that fails does not sink the brief. A calendar feed that times out
means the brief says the calendar could not be read, which is a useful thing
to be told, and everything else still arrives.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

log = logging.getLogger(__name__)

#: How long to wait on any one source before giving up on it.
SOURCE_TIMEOUT = 20.0


@dataclass
class Section:
    """One part of the brief."""

    name: str
    items: list[str] = field(default_factory=list)
    #: Why this section is empty, when it is empty for a reason worth saying.
    note: str = ""

    @property
    def empty(self) -> bool:
        return not self.items

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"name": self.name, "items": list(self.items)}
        if self.note:
            payload["note"] = self.note
        return payload


@dataclass
class Brief:
    """The whole thing."""

    when: str = ""
    greeting: str = ""
    sections: list[Section] = field(default_factory=list)

    def section(self, name: str) -> Section | None:
        for section in self.sections:
            if section.name == name:
                return section
        return None

    @property
    def anything(self) -> bool:
        return any(not section.empty for section in self.sections)

    def as_dict(self) -> dict[str, Any]:
        return {
            "when": self.when,
            "greeting": self.greeting,
            "sections": [section.as_dict() for section in self.sections],
            "anything": self.anything,
        }

    def as_text(self) -> str:
        """The brief as something a person can read, or hear.

        Empty sections are left out entirely: "you have no email, no meetings,
        no reminders and no jobs" is a worse morning than silence.
        """
        lines = [self.greeting] if self.greeting else []
        for section in self.sections:
            if section.empty:
                if section.note:
                    lines.append(f"{section.name}: {section.note}")
                continue
            lines.append(f"{section.name}:")
            lines.extend(f"  · {item}" for item in section.items)
        if not lines:
            return "Nothing needs you."
        return "\n".join(lines)


def greeting_for(moment: datetime, name: str = "") -> str:
    hour = moment.hour
    if hour < 5:
        part = "You are up late"
    elif hour < 12:
        part = "Good morning"
    elif hour < 17:
        part = "Good afternoon"
    elif hour < 22:
        part = "Good evening"
    else:
        part = "Good evening"
    return f"{part}, {name}." if name else f"{part}."


class Briefing:
    """Gathers a brief. Reads; changes nothing."""

    def __init__(self, agent: Any) -> None:
        self.agent = agent

    async def gather(self, person: str = "", hours: int = 12) -> Brief:
        moment = datetime.now().astimezone()
        brief = Brief(
            when=moment.isoformat(timespec="minutes"),
            greeting=greeting_for(moment, self.agent.settings.user_name),
        )

        # Concurrently, because the slow ones are network-bound and waiting on
        # them one after another is most of the time a brief takes.
        sources = (
            ("Calendar", self._calendar(hours)),
            ("Inbox", self._mail()),
            ("Reminders", self._reminders(person)),
            ("Waiting on you", self._drafts()),
            ("In progress", self._work()),
            ("Noticed", self._watchers()),
        )
        results = await asyncio.gather(
            *(self._guarded(name, work) for name, work in sources)
        )
        brief.sections = list(results)
        return brief

    async def _guarded(self, name: str, work: Any) -> Section:
        """One source, where failing is a note rather than an exception.

        A calendar feed that times out means the brief says so - which is
        itself worth knowing - and the other five still arrive.
        """
        try:
            return await asyncio.wait_for(work, timeout=SOURCE_TIMEOUT)
        except asyncio.TimeoutError:
            log.warning("%s took too long for the brief", name)
            return Section(name, note="took too long to read")
        except Exception as exc:
            log.warning("%s could not be read for the brief: %s", name, exc)
            return Section(name, note=f"could not be read ({type(exc).__name__})")

    # ------------------------------------------------------------- sources

    async def _calendar(self, hours: int) -> Section:
        from .tools.calendar import load, parse_ics, sources, within

        feeds = sources()
        if not feeds:
            return Section("Calendar", note="")     # not set up; say nothing
        now = datetime.now().astimezone()
        events: list[Any] = []
        for feed in feeds:
            raw = await asyncio.to_thread(load, feed)
            events.extend(parse_ics(raw))

        soon = within(events, now, now + timedelta(hours=max(1, hours)))
        items = []
        for event in soon[:8]:
            when = event.start.strftime("%H:%M") if hasattr(event.start, "strftime") else "all day"
            where = f" ({event.location})" if event.location else ""
            items.append(f"{when} {event.summary}{where}")
        return Section("Calendar", items)

    async def _mail(self) -> Section:
        import email
        import email.policy

        from .tools.mail import Mailbox, summarise

        mailbox = Mailbox.from_env()
        if not mailbox.configured:
            return Section("Inbox", note="")

        def read() -> list[str]:
            connection = mailbox.connect()
            try:
                connection.select(mailbox.folder, readonly=True)
                status, data = connection.search(None, "(UNSEEN)")
                ids = (data[0] or b"").split()[-6:] if status == "OK" else []
                found = []
                for message_id in reversed(ids):
                    status, fetched = connection.fetch(message_id, "(BODY.PEEK[HEADER])")
                    if status != "OK" or not fetched or not isinstance(fetched[0], tuple):
                        continue
                    parsed = email.message_from_bytes(
                        fetched[0][1], policy=email.policy.default
                    )
                    summary = summarise(parsed)
                    sender = summary["from"].split("<")[0].strip() or summary["from"]
                    found.append(f"{summary['subject']} — {sender}")
                return found
            finally:
                try:
                    connection.logout()
                except Exception:  # pragma: no cover - a socket already gone
                    pass

        return Section("Inbox", await asyncio.to_thread(read))

    async def _reminders(self, person: str) -> Section:
        pending = self.agent.memory.pending_reminders(person)
        now = time.time()
        items = []
        for reminder in pending[:8]:
            gap = reminder.due_at - now
            if gap < 0:
                when = "overdue"
            elif gap < 60:
                when = "any moment"
            elif gap < 3600:
                # Rounded, not floored: a reminder set for ten minutes' time
                # reads "in 9 min" a heartbeat later, which looks like a bug.
                when = f"in {round(gap / 60)} min"
            elif gap < 86400:
                when = f"in {round(gap / 3600)} h"
            else:
                when = datetime.fromtimestamp(reminder.due_at).astimezone().strftime("%a %H:%M")
            items.append(f"{reminder.text} ({when})")
        return Section("Reminders", items)

    async def _drafts(self) -> Section:
        from .drafts import Outbox

        outbox = Outbox(self.agent.memory, out_dir=self.agent.settings.data_dir / "invites")
        waiting = [d for d in outbox.list() if d.status in {"draft", "approved"}]
        return Section(
            "Waiting on you",
            [
                f"{d.subject} — {'ready to send' if d.status == 'approved' else 'needs your ok'}"
                for d in waiting[:6]
            ],
        )

    async def _work(self) -> Section:
        from .planner import Planner

        items = []
        plan = Planner(self.agent.memory).current()
        if plan is not None:
            current = plan.current
            where = f" — {current.text}" if current else ""
            items.append(f"{plan.title} ({plan.done_count}/{len(plan.steps)}){where}")
        for job in self.agent.memory.jobs(status="running") + self.agent.memory.jobs(
            status="queued"
        ):
            items.append(f"{job['title']} ({job['status']})")
        return Section("In progress", items[:6])

    async def _watchers(self) -> Section:
        """What is being kept an eye on, and anything that has gone wrong.

        The watchers are not re-run here: they announce their own findings
        when they fire, and a brief that quietly triggered six network reads
        would be a slow brief that also duplicated them.
        """
        from .watchers import Watch

        watch = Watch(self.agent.memory)
        broken = [entry for entry in watch.all() if entry["last_error"]]
        items = [
            f"{entry['name']} stopped: {entry['last_error'][:80]}" for entry in broken[:4]
        ]
        return Section("Noticed", items)
