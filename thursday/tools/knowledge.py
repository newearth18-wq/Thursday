"""Notes and long-term memory."""

from __future__ import annotations

from typing import Any

from . import ToolContext, ToolError, tool


def _memory(ctx: ToolContext | None):
    if ctx is None or ctx.memory is None:
        raise ToolError("persistent memory is unavailable")
    return ctx.memory


def _whose(ctx: ToolContext | None) -> str:
    """Who is being talked to, so their notes and facts are their own.

    Empty means nobody in particular, which is how a household of one - and
    everything written before there were people - behaves.
    """
    if ctx is None:
        return ""
    person = ctx.state.get("person")
    return getattr(person, "key", "") or ""


@tool
def add_note(title: str, body: str = "", tags: str = "", ctx: ToolContext = None) -> dict[str, Any]:
    """Save a note for the user.

    Args:
        title: A short title.
        body: The note body.
        tags: Optional comma-separated tags.
    """
    note_id = _memory(ctx).add_note(title, body, tags, person=_whose(ctx))
    return {"id": note_id, "title": title}


@tool
def search_notes(query: str = "", limit: int = 10, ctx: ToolContext = None) -> list[dict[str, Any]]:
    """Search saved notes, or list the most recent ones when query is empty.

    Args:
        query: Text to look for in the title, body or tags.
        limit: Maximum number of notes to return.
    """
    memory = _memory(ctx)
    whose = _whose(ctx)
    return (memory.search_notes(query, limit, whose) if query
            else memory.list_notes(limit, whose))


@tool
def delete_note(note_id: int, ctx: ToolContext = None) -> str:
    """Delete a note.

    Args:
        note_id: The note's id.
    """
    return "deleted" if _memory(ctx).delete_note(note_id, _whose(ctx)) else "no such note"


@tool
def search_history(query: str, limit: int = 8, this_session_only: bool = False, ctx: ToolContext = None) -> list[dict[str, Any]]:
    """Search everything the user has ever said to you, not just this conversation.

    Reach for this whenever the user refers to something from before - "what did
    we decide about the database", "the restaurant I mentioned last week".

    Args:
        query: Words to look for.
        limit: How many matches to return.
        this_session_only: Restrict the search to the current conversation.
    """
    session = ctx.state.get("session_id") if (ctx and this_session_only) else None
    return _memory(ctx).search_messages(query, limit, session)


@tool
def remember_fact(key: str, value: str, ctx: ToolContext = None) -> str:
    """Store a durable fact about the user, e.g. a preference or a birthday.

    Use this whenever the user says something worth recalling in later
    conversations.

    Args:
        key: A short identifier, e.g. "home_city" or "coffee_order".
        value: The value to remember.
    """
    _memory(ctx).remember(key, value, person=_whose(ctx))
    return f"remembered {key} = {value}"


@tool
def recall_facts(key: str = "", ctx: ToolContext = None) -> dict[str, Any]:
    """Look up stored facts about the user.

    Args:
        key: A specific key to recall. Leave empty to list everything.
    """
    memory = _memory(ctx)
    if key:
        value = memory.recall(key, _whose(ctx))
        return {key: value} if value is not None else {}
    return memory.all_facts(_whose(ctx))


@tool
def forget_fact(key: str, ctx: ToolContext = None) -> str:
    """Delete a stored fact.

    Args:
        key: The key to forget.
    """
    return "forgotten" if _memory(ctx).forget(key, _whose(ctx)) else "no such fact"
