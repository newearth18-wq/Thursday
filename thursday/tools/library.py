"""Reading and searching your own documents."""

from __future__ import annotations

from typing import Any

from ..documents import Library, Unreadable
from . import ToolContext, ToolError, tool
from .files import resolve


def _library(ctx: ToolContext | None) -> Library:
    if ctx is None or ctx.memory is None:
        raise ToolError("persistent memory is unavailable")
    # One library per process, kept on the context so the embedder and its
    # connection are not rebuilt for every call.
    existing = ctx.state.get("library")
    if existing is None:
        existing = Library(ctx.memory, policy=ctx.state.get("policy"))
        ctx.state["library"] = existing
    return existing


@tool
def index_documents(path: str, pattern: str = "*", ctx: ToolContext = None) -> dict[str, Any]:
    """Read a file or folder into your searchable library.

    Handles PDF, Word, Markdown, text and code. Re-indexing is cheap: files
    that have not changed are skipped.

    Args:
        path: A file, or a folder to index everything readable inside.
        pattern: When indexing a folder, only files matching this glob.
    """
    target = resolve(ctx, path)
    library = _library(ctx)

    if target.is_dir():
        result = library.index_tree(target, pattern)
        return {
            "indexed": len(result["indexed"]),
            "skipped": len(result["skipped"]),
            "files": [entry["path"] for entry in result["indexed"][:20]],
            "problems": result["skipped"][:5],
        }

    if not target.is_file():
        raise ToolError(f"{target} is not a file or folder")
    try:
        return library.index(target)
    except Unreadable as exc:
        raise ToolError(str(exc)) from exc


@tool
def search_documents(query: str, limit: int = 5, ctx: ToolContext = None) -> list[dict[str, Any]]:
    """Search your indexed documents by meaning, not just by keyword.

    Use this for questions about the user's own files - what a contract says,
    what was in a report, where something was written down. Quote the passages
    you get back rather than paraphrasing from memory.

    Args:
        query: What you are looking for, in plain words.
        limit: How many passages to return.
    """
    hits = _library(ctx).search(query, limit)
    if not hits:
        return []
    return [hit.as_dict() for hit in hits]


@tool
def list_documents(ctx: ToolContext = None) -> list[dict[str, Any]]:
    """List the documents in the library."""
    return _library(ctx).documents()


@tool
def forget_document(path: str, ctx: ToolContext = None) -> str:
    """Remove a document from the library.

    Args:
        path: The path it was indexed under.
    """
    target = resolve(ctx, path)
    return "removed" if _library(ctx).forget(str(target)) else "that was not in the library"
