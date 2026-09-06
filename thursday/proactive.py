"""The part of Thursday that acts without being asked.

One loop, shared by every front end: it fires reminders when they come due and
runs scheduled routines on their own timetable, then hands whatever came back
to a callback so the terminal prints it, the browser shows it and the voice
loop speaks it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, Awaitable, Callable

from .events import Event
from .notify import notify_desktop
from .schedule import parse

log = logging.getLogger(__name__)

#: How often to look for something to do. A minute is fine: nothing here is
#: to-the-second, and a tighter loop would only spin the CPU.
TICK_SECONDS = 30

Announce = Callable[[str, str], Awaitable[None]]


async def _say_nothing(kind: str, text: str) -> None:  # pragma: no cover - default
    return None


class Proactive:
    """Reminders and scheduled routines, running in the background."""

    def __init__(
        self,
        agent: Any,
        announce: Announce | None = None,
        on_event=None,
        session_id: str = "scheduled",
        tick: float = TICK_SECONDS,
    ) -> None:
        self.agent = agent
        self.announce = announce or _say_nothing
        self.on_event = on_event
        self.session_id = session_id
        self.tick = tick
        self._task: asyncio.Task[None] | None = None

    # ---------------------------------------------------------------- runner

    def start(self) -> asyncio.Task[None]:
        self._task = asyncio.create_task(self.run())
        return self._task

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def run(self) -> None:
        while True:
            try:
                await self.tick_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # a bad tick must not end the loop
                log.exception("proactive tick failed")
            await asyncio.sleep(self.tick)

    async def tick_once(self) -> None:
        await self.fire_reminders()
        await self.run_schedules()
        await self.reflect()

    # ------------------------------------------------------------- reminders

    async def fire_reminders(self) -> list[str]:
        fired = []
        for reminder in self.agent.memory.due_reminders():
            text = reminder.text
            await self.announce("reminder", text)
            await asyncio.to_thread(
                notify_desktop, f"{self.agent.settings.assistant_name} reminder", text
            )
            self.agent.memory.mark_fired(reminder.id)
            fired.append(text)
        return fired

    # ------------------------------------------------------------- schedules

    async def run_schedules(self) -> list[str]:
        """Carry out anything whose time has come."""
        ran = []
        for entry in self.agent.memory.due_schedules():
            # Reschedule first: if the turn fails or the process dies, the
            # schedule must not fire again immediately in a loop.
            schedule = parse(entry["spec"])
            following = schedule.next_after(datetime.now().astimezone())
            self.agent.memory.mark_scheduled_run(
                entry["name"], following.timestamp() if following else None
            )

            prompt = self._prompt_for(entry)
            if not prompt:
                continue

            await self.announce("schedule", entry["name"])
            try:
                reply = await self.agent.run(
                    prompt, session_id=self.session_id, on_event=self.on_event
                )
            except Exception as exc:
                log.exception("scheduled routine %s failed", entry["name"])
                reply = f"the scheduled routine {entry['name']} failed: {exc}"

            if reply:
                await self.announce("result", reply)
                await asyncio.to_thread(
                    notify_desktop, f"{self.agent.settings.assistant_name}: {entry['name']}", reply[:220]
                )
            ran.append(entry["name"])
        return ran

    # ------------------------------------------------------------- learning

    async def reflect(self, now: float | None = None) -> list[str]:
        """Notice what is worth remembering from recent conversation.

        Thursday only ever remembered what it was explicitly told to. This
        reads back what was actually said and files the durable parts, so it
        gets to know its owner without being dictated to.
        """
        settings = self.agent.settings
        if not getattr(settings, "reflect_hours", 0):
            return []

        moment = time.time() if now is None else now
        last = self.agent.memory.recall("__last_reflection__")
        if last and moment - float(last) < settings.reflect_hours * 3600:
            return []
        # Record the attempt first: a failure should not retry every tick.
        self.agent.memory.remember("__last_reflection__", str(moment))

        transcript = self.agent.memory.recent_text(
            since=moment - settings.reflect_hours * 3600, limit=120
        )
        if len(transcript) < 400:
            return []   # not enough said to be worth a call

        known = self.agent.memory.all_facts()
        prompt = (
            "Read this recent conversation and note anything durable worth "
            "remembering about the user - preferences, people, routines, "
            "projects, constraints. Save each with remember_fact, using short "
            "snake_case keys. Skip anything already known, anything "
            "one-off, and anything sensitive they did not clearly want kept. "
            "If nothing qualifies, say so and save nothing.\n\n"
            f"Already known: {', '.join(sorted(known)) or 'nothing yet'}\n\n"
            f"Conversation:\n{transcript[-12000:]}"
        )

        before = set(known)
        try:
            await self.agent.run(prompt, session_id="reflection", profile="quick")
        except Exception:
            log.exception("reflection failed")
            return []

        learned = sorted(set(self.agent.memory.all_facts()) - before - {"__last_reflection__"})
        if learned:
            log.info("learned: %s", ", ".join(learned))
        return learned

    def _prompt_for(self, entry: dict[str, Any]) -> str:
        """What to say to the agent when this schedule fires."""
        routine = entry.get("routine") or ""
        if routine.startswith("__routine__:"):
            name = routine.split(":", 1)[1]
            saved = self.agent.memory.get_routine(name)
            if saved is None:
                log.warning("schedule %s points at a missing routine %s", entry["name"], name)
                return ""
            return (
                f"Your scheduled routine {name!r} is due. Carry it out now and "
                f"report the result briefly:\n{saved['instruction']}"
            )
        return f"This is a scheduled task. Carry it out now and report briefly:\n{routine}"


def event_to_announcement(event: Event) -> tuple[str, str] | None:  # pragma: no cover - helper
    """Small adapter for front ends that only want the finished text."""
    if event.type == "done" and event.text:
        return ("result", event.text)
    return None
