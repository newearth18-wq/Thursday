"""Filesystem tools, sandboxed to the configured workspace."""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path
from typing import Any

from . import ToolContext, ToolError, tool

MAX_READ_BYTES = 200_000
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".mypy_cache"}


def workspace_root(ctx: ToolContext) -> Path:
    root = getattr(ctx.settings, "workspace", None) if ctx.settings else None
    return Path(root).expanduser().resolve() if root else Path.cwd().resolve()


def resolve(ctx: ToolContext, path: str) -> Path:
    """Resolve `path` inside the workspace, refusing anything that escapes it."""
    root = workspace_root(ctx)
    candidate = Path(path).expanduser()
    resolved = (candidate if candidate.is_absolute() else root / candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise ToolError(
            f"{resolved} is outside the workspace ({root}); ask the user to move the "
            "file in or to restart Thursday with THURSDAY_WORKSPACE set."
        )
    return resolved


@tool
def read_file(path: str, max_bytes: int = MAX_READ_BYTES, ctx: ToolContext = None) -> str:
    """Read a UTF-8 text file from the workspace.

    Args:
        path: Path relative to the workspace, or an absolute path inside it.
        max_bytes: Stop after this many bytes.
    """
    target = resolve(ctx, path)
    if not target.is_file():
        raise ToolError(f"{target} is not a file")
    data = target.read_bytes()[: max(1, max_bytes)]
    text = data.decode("utf-8", errors="replace")
    suffix = "\n...(truncated)" if target.stat().st_size > len(data) else ""
    return text + suffix


@tool(dangerous=True)
async def write_file(path: str, content: str, append: bool = False, ctx: ToolContext = None) -> str:
    """Create or overwrite a text file in the workspace. Asks the user first.

    Args:
        path: Destination path.
        content: The text to write.
        append: Append instead of replacing the file.
    """
    target = resolve(ctx, path)
    action = "Append to" if append else "Write"
    preview = content if len(content) <= 400 else content[:400] + "..."
    approved = await ctx.request_confirmation(
        f"{action} {target}", f"{len(content)} characters:\n{preview}"
    )
    if not approved:
        return "the user declined this write"

    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a" if append else "w", encoding="utf-8") as handle:
        handle.write(content)
    return f"{'appended to' if append else 'wrote'} {target} ({len(content)} chars)"


@tool
def list_files(path: str = ".", pattern: str = "*", limit: int = 100, ctx: ToolContext = None) -> list[str]:
    """List files and folders in a workspace directory.

    Args:
        path: Directory to list.
        pattern: Glob applied to the entry names, e.g. "*.py".
        limit: Maximum number of entries.
    """
    target = resolve(ctx, path)
    if not target.is_dir():
        raise ToolError(f"{target} is not a directory")
    root = workspace_root(ctx)
    entries: list[str] = []
    for entry in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if entry.name.startswith(".") or entry.name in SKIP_DIRS:
            continue
        if not fnmatch.fnmatch(entry.name, pattern):
            continue
        rel = os.path.relpath(entry, root)
        entries.append(f"{rel}/" if entry.is_dir() else rel)
        if len(entries) >= limit:
            break
    return entries


@tool
def search_files(
    query: str,
    path: str = ".",
    pattern: str = "*",
    limit: int = 40,
    ctx: ToolContext = None,
) -> list[dict[str, Any]]:
    """Search file contents for a literal string, like a simple grep.

    Args:
        query: Text to look for (case-insensitive).
        path: Directory to search under.
        pattern: Only search files whose name matches this glob.
        limit: Maximum number of matches to return.
    """
    root = resolve(ctx, path)
    needle = query.lower()
    matches: list[dict[str, Any]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for filename in filenames:
            if not fnmatch.fnmatch(filename, pattern):
                continue
            file_path = Path(dirpath) / filename
            try:
                if file_path.stat().st_size > 2_000_000:
                    continue
                text = file_path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for number, line in enumerate(text.splitlines(), start=1):
                if needle in line.lower():
                    matches.append(
                        {
                            "file": os.path.relpath(file_path, workspace_root(ctx)),
                            "line": number,
                            "text": line.strip()[:200],
                        }
                    )
                    if len(matches) >= limit:
                        return matches
    return matches
