"""Routines: named instructions the user can trigger by name.

A routine is not a hard-coded macro - it is a saved instruction that Claude
carries out with whatever tools it needs. "Run my morning routine" expands to
the saved text, and Thursday follows it.
"""

from __future__ import annotations

from typing import Any

from . import ToolContext, ToolError, tool


def _memory(ctx: ToolContext | None):
    if ctx is None or ctx.memory is None:
        raise ToolError("persistent memory is unavailable")
    return ctx.memory


@tool
def save_routine(name: str, instruction: str, ctx: ToolContext = None) -> str:
    """Save a named routine the user can ask for later.

    Write the instruction as a direct order to yourself, e.g. "Give the weather
    for Bangkok, then read out today's reminders, then the top headlines."

    Args:
        name: A short name, e.g. "morning" or "shutdown".
        instruction: What to do when the routine runs.
    """
    if not instruction.strip():
        raise ToolError("a routine needs an instruction")
    _memory(ctx).save_routine(name, instruction.strip())
    return f"saved the routine {name.strip().lower()!r}"


@tool
def list_routines(ctx: ToolContext = None) -> list[dict[str, Any]]:
    """List the routines the user has saved."""
    return _memory(ctx).list_routines()


@tool
def run_routine(name: str, ctx: ToolContext = None) -> str:
    """Look up a saved routine so you can carry it out.

    This returns the routine's instruction - follow it immediately, using
    whatever other tools it needs, then report the result as one answer.

    Args:
        name: The routine's name.
    """
    memory = _memory(ctx)
    routine = memory.get_routine(name)
    if routine is None:
        saved = [r["name"] for r in memory.list_routines()]
        raise ToolError(
            f"no routine called {name!r}"
            + (f"; saved routines: {', '.join(saved)}" if saved else "; none are saved yet")
        )
    memory.touch_routine(name)
    return (
        f"Routine {routine['name']!r} - carry out these instructions now:\n"
        f"{routine['instruction']}"
    )


@tool
def delete_routine(name: str, ctx: ToolContext = None) -> str:
    """Delete a saved routine.

    Args:
        name: The routine's name.
    """
    return "deleted" if _memory(ctx).delete_routine(name) else "no such routine"
