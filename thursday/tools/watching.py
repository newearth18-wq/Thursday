"""Asking Thursday to keep an eye on something."""

from __future__ import annotations

from typing import Any

from ..watchers import KINDS, Watch, WatchError
from . import ToolContext, ToolError, tool


def _watch(ctx: ToolContext) -> Watch:
    if ctx is None or ctx.memory is None:
        raise ToolError("watchers need memory, which is not available here")
    return Watch(ctx.memory)


@tool
def watch_for(
    name: str,
    kind: str,
    target: str = "",
    then: str = "",
    from_sender: str = "",
    pattern: str = "",
    minutes: int = 15,
    contains: str = "",
    ctx: ToolContext = None,
) -> dict[str, Any]:
    """Keep an eye on something and speak up when it changes.

    Use this for "tell me when the report lands in Downloads", "let me know if
    the landlord replies", "warn me before meetings", "watch that page".

    What can be watched:
      folder    - files appearing in a directory; target is the path.
      mail      - unread email, optionally only from someone.
      calendar  - an event starting soon; target may be empty for your own.
      page      - a web page changing; target is the URL.

    Args:
        name: A short name, so it can be listed and cancelled later.
        kind: folder, mail, calendar or page.
        target: The path, URL, or feed. Not needed for mail or your calendar.
        then: What Thursday should DO about it. Leave empty just to be told.
        from_sender: For mail, only messages from an address containing this.
        pattern: For a folder, only files matching this glob, e.g. "*.pdf".
        minutes: For a calendar, how long before an event to speak up.
        contains: For a page, only care about lines containing this.
    """
    options: dict[str, Any] = {}
    if from_sender:
        options["from"] = from_sender
    if pattern:
        options["pattern"] = pattern
    if kind == "calendar":
        options["minutes"] = max(1, minutes)
    if contains:
        options["contains"] = contains

    try:
        return _watch(ctx).add(
            name=name,
            kind=kind.strip().lower(),
            target=target,
            action="run" if then.strip() else "tell",
            instruction=then,
            options=options,
        )
    except WatchError as exc:
        raise ToolError(str(exc)) from exc


@tool
def list_watches(ctx: ToolContext = None) -> dict[str, Any]:
    """What Thursday is keeping an eye on."""
    watches = _watch(ctx).all()
    return {
        "count": len(watches),
        "watching": watches,
        "kinds_available": list(KINDS),
    }


@tool
def stop_watching(name: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Stop watching something.

    Args:
        name: The watcher's name, from list_watches.
    """
    try:
        _watch(ctx).remove(name)
    except WatchError as exc:
        raise ToolError(str(exc)) from exc
    return {"name": name, "watching": False}


@tool
def check_watches_now(ctx: ToolContext = None) -> dict[str, Any]:
    """Look at everything being watched right now, without waiting for the
    next round. Use this when the user asks "anything new?"."""
    watch = _watch(ctx)
    findings = []
    for row in watch.all(enabled_only=True):
        record = ctx.memory.watcher(row["name"])
        findings.extend(finding.as_dict() for finding in watch.check(record))
    return {"count": len(findings), "found": findings} if findings else {
        "count": 0,
        "detail": "nothing new since the last look",
    }
