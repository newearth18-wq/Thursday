"""Reaching into an Obsidian vault.

Thursday's own notes still live in SQLite - fast, searchable, and private to
it. The vault is the other half: things worth keeping in a form that outlives
Thursday, in files you can open, edit and sync yourself.

Which is which is a judgement the model makes, and the tool descriptions say
how: passing details go in a note, things you would want to find again in two
years go in the vault.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..connect import Connector
from ..vault import Vault, VaultError
from . import ToolContext, ToolError, tool


def _vault(ctx: ToolContext) -> Vault:
    if ctx is None or ctx.settings is None:
        raise ToolError("the vault is not available here")
    existing = ctx.state.get("vault")
    if isinstance(existing, Vault):
        return existing

    root = getattr(ctx.settings, "vault_path", None)
    if not root:
        raise ToolError(
            "no Obsidian vault is set up. Set THURSDAY_VAULT to the folder that "
            "holds your vault - the one containing the .obsidian directory - or "
            "set it under Config on the Thursday page."
        )
    # The same journal file writes go through, so a note Thursday edits can be
    # put back with undo_change like anything else.
    journal = ctx.state.get("journal")
    if journal is None and ctx.memory is not None:
        from ..undo import Journal

        journal = Journal(ctx.memory, Path(ctx.settings.data_dir) / "undo")
        ctx.state["journal"] = journal

    vault = Vault(root, journal=journal)
    try:
        vault.check()
    except VaultError as exc:
        raise ToolError(str(exc)) from exc
    ctx.state["vault"] = vault
    return vault


def _connector(ctx: ToolContext) -> Connector:
    from ..embeddings import Embedder

    return Connector(_vault(ctx), Embedder.from_env())


# ------------------------------------------------------------------ reading


@tool
def vault_search(query: str, limit: int = 8, ctx: ToolContext = None) -> dict[str, Any]:
    """Search the user's Obsidian vault by title, tag and text.

    Use this when they refer to something they wrote down - "my note about
    the lease", "what did I write about that supplier". For a question about
    meaning rather than words, search_documents is the better tool once the
    vault has been indexed.

    Args:
        query: What to look for, in any language.
        limit: How many notes to return.
    """
    vault = _vault(ctx)
    try:
        notes = vault.search(query, limit)
    except VaultError as exc:
        raise ToolError(str(exc)) from exc
    return {
        "count": len(notes),
        "notes": [note.as_dict() for note in notes],
    }


@tool
def vault_read(title: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Read one note from the vault in full.

    Args:
        title: The note's title, as it appears in Obsidian.
    """
    note = _vault(ctx).find(title)
    if note is None:
        raise ToolError(f"there is no note called {title!r} in the vault")
    return note.as_dict(full=True)


@tool
def vault_related(title: str, limit: int = 6, ctx: ToolContext = None) -> dict[str, Any]:
    """What else in the vault belongs with this note, and why.

    Answers "what do I already know about this" - the question a second brain
    exists for. Says its evidence for each one, so a wrong suggestion is
    obvious rather than mysterious.

    Args:
        title: The note to start from.
        limit: How many to return.
    """
    connector = _connector(ctx)
    found = connector.related_to(title, limit)
    if not found and connector.vault.find(title) is None:
        raise ToolError(f"there is no note called {title!r} in the vault")
    return {
        "note": title,
        "count": len(found),
        "related": [connection.as_dict() for connection in found],
        "by_meaning": connector.used_meaning,
    }


@tool
def vault_map(ctx: ToolContext = None) -> dict[str, Any]:
    """The shape of the vault: how many notes, how connected, what is adrift.

    The orphan count is the useful number - notes nothing links to are the
    ones the vault has quietly lost.
    """
    vault = _vault(ctx)
    summary = vault.describe()
    summary["adrift"] = vault.orphans()[:20]
    return summary


# ------------------------------------------------------------------ writing


@tool
def vault_write(
    title: str, text: str, tags: str = "", append: bool = False, ctx: ToolContext = None
) -> dict[str, Any]:
    """Write a note into the user's vault, in Thursday's own folder.

    Use this for things worth keeping: what was decided, what was learned, a
    summary of something researched. Passing details belong in add_note
    instead - the vault is for what they would want to find again in two
    years.

    Link to other notes with [[double brackets]] where you know the title;
    that is what makes the vault a graph rather than a pile.

    Args:
        title: The note's title, which becomes its filename.
        text: The note in Markdown.
        tags: Comma-separated tags, without the #.
        append: Add to the note if it already exists, rather than replacing it.
    """
    vault = _vault(ctx)
    try:
        path = vault.write(
            title,
            text,
            tags=[part.strip() for part in tags.split(",") if part.strip()],
            append=append,
        )
    except VaultError as exc:
        raise ToolError(str(exc)) from exc
    return {"title": title, "path": str(path), "appended": append}


@tool
def vault_journal(text: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Add a line to today's daily note in the vault.

    For things that belong to today rather than to a subject: what happened,
    what was decided, what to pick up tomorrow.

    Args:
        text: The line to add.
    """
    vault = _vault(ctx)
    folder = getattr(ctx.settings, "vault_daily_folder", "") or ""
    try:
        path = vault.add_to_daily(text, folder)
    except VaultError as exc:
        raise ToolError(str(exc)) from exc
    return {"path": str(path), "added": text}


@tool(dangerous=True)
async def vault_connect(
    apply: bool = False, limit: int = 20, ctx: ToolContext = None
) -> dict[str, Any]:
    """Find connections between notes that nobody has drawn yet.

    This is what keeps the vault growing as a graph rather than a pile. It
    only ever suggests pairs it has not suggested before, so running it again
    next month finds what has turned up since.

    Reads by default. With apply=True it writes the links into the notes -
    inside a marked block at the end, so nothing the user wrote is touched,
    and undo_change puts any note back.

    Args:
        apply: Write the links in. Leave false to just see them.
        limit: How many connections to consider.
    """
    connector = _connector(ctx)
    try:
        found = connector.suggest()[: max(1, limit)]
    except VaultError as exc:
        raise ToolError(str(exc)) from exc

    payload: dict[str, Any] = {
        "found": len(found),
        "connections": [connection.as_dict() for connection in found],
        "by_meaning": connector.used_meaning,
        "written": False,
    }
    if not found:
        payload["detail"] = (
            "nothing new - every connection I can see is already written down"
        )
        return payload
    if not apply:
        payload["next"] = "Show these to the user; call again with apply=true if they want them written in."
        return payload

    if ctx is not None:
        agreed = await ctx.request_confirmation(
            f"Add {len(found)} links to your vault?",
            "\n".join(f"{c.source} → {c.target} ({c.reason})" for c in found[:12])
            + "\n\nThey go in a marked block at the end of each note; nothing you "
            "wrote is changed, and undo puts it back.",
        )
        if not agreed:
            payload["detail"] = "the user declined"
            return payload

    payload["written"] = True
    payload["notes"] = connector.apply(found)
    return payload
