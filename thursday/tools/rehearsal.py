"""Saying what would happen, and putting things back.

`show_changes` and `undo_change` are ordinary tools: the user can ask in
words. Turning dry-run on and off is deliberately *not* a tool - it is set
from the terminal or the page, because a model that could switch off "show me
what you would do first" would make the whole idea pointless.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..undo import Journal, UndoError
from . import ToolContext, ToolError, tool


def _journal(ctx: ToolContext) -> Journal:
    if ctx is None or ctx.memory is None or ctx.settings is None:
        raise ToolError("the change journal is not available here")
    existing = ctx.state.get("journal")
    if isinstance(existing, Journal):
        return existing
    made = Journal(ctx.memory, Path(ctx.settings.data_dir) / "undo")
    ctx.state["journal"] = made
    return made


@tool
def show_changes(limit: int = 10, ctx: ToolContext = None) -> dict[str, Any]:
    """What has been changed on this machine, and what can be put back.

    Use this for "what did you just do", "what changed", "can you undo that".

    Args:
        limit: How many changes to list, most recent first.
    """
    changes = _journal(ctx).recent(limit)
    return {
        "count": len(changes),
        "changes": [change.as_dict() for change in changes],
        "undoable": sum(1 for change in changes if change.undoable),
    }


@tool(dangerous=True)
async def undo_change(change_id: int = 0, ctx: ToolContext = None) -> str:
    """Put a file back the way it was before a change.

    This overwrites what is there now, so it asks first - the file may have
    been edited since.

    Args:
        change_id: Which change, from show_changes. Leave at 0 for the last one.
    """
    book = _journal(ctx)
    try:
        change = book.get(change_id) if change_id else book._latest()
    except UndoError as exc:
        raise ToolError(str(exc)) from exc

    if ctx is not None:
        agreed = await ctx.request_confirmation(
            f"Undo: {change.describe()}?",
            f"{change.path}\nThis replaces whatever is there now, from {change.when}.",
        )
        if not agreed:
            return "the user declined to undo it"

    try:
        book.undo(change.id)
    except UndoError as exc:
        raise ToolError(str(exc)) from exc
    return f"put back: {change.describe()}"
