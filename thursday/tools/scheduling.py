"""Making Thursday do things on its own schedule."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ..schedule import parse
from . import ToolContext, ToolError, tool


def _memory(ctx: ToolContext | None):
    if ctx is None or ctx.memory is None:
        raise ToolError("persistent memory is unavailable")
    return ctx.memory


@tool
def schedule_routine(name: str, when: str, instruction: str = "", ctx: ToolContext = None) -> dict[str, Any]:
    """Have something happen on its own, on a repeating schedule.

    Use this for "every morning", "every half hour", "weekdays at six". For a
    one-off nudge use set_reminder instead.

    Args:
        name: A short name for this schedule, e.g. "morning brief".
        when: When to run it - "08:00", "weekdays 09:15", "every 30m",
            "mon,thu 20:00".
        instruction: What to do. Leave empty to run the saved routine whose
            name matches, which is the tidier way to do it.
    """
    memory = _memory(ctx)
    schedule = parse(when)
    if schedule.kind == "never":
        raise ToolError(
            f"could not understand {when!r}; try '08:00', 'weekdays 09:15' or 'every 30m'"
        )

    target = instruction.strip()
    if not target:
        routine = memory.get_routine(name)
        if routine is None:
            raise ToolError(
                f"no routine called {name!r} to run; either save one first or "
                "pass the instruction here"
            )
        target = f"__routine__:{routine['name']}"

    next_run = schedule.next_after(datetime.now().astimezone())
    memory.save_schedule(name, target, when, next_run.timestamp() if next_run else None)
    return {
        "name": name.strip().lower(),
        "when": schedule.describe(),
        "next_run": next_run.isoformat(timespec="minutes") if next_run else None,
    }


@tool
def list_schedules(ctx: ToolContext = None) -> list[dict[str, Any]]:
    """List the things Thursday does on its own."""
    return [
        {
            "name": entry["name"],
            "when": parse(entry["spec"]).describe(),
            "next_run": entry["next_run_at"],
            "last_run": entry["last_run_at"],
        }
        for entry in _memory(ctx).list_schedules()
    ]


@tool
def cancel_schedule(name: str, ctx: ToolContext = None) -> str:
    """Stop a scheduled routine from running again.

    Args:
        name: The schedule's name.
    """
    return "cancelled" if _memory(ctx).cancel_schedule(name) else "no such schedule"
