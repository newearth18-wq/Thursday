"""Putting a file back the way it was.

Confirmation catches the writes you did not want. It does not catch the ones
you agreed to and then regretted, or the ones where the assistant did exactly
what you asked and what you asked was wrong. "Tidy up my notes" is a
reasonable request with an unreasonable number of ways to go badly.

So: before a file is written or deleted, whatever was there is copied aside,
and the change is written down. `undo` puts it back.

What this is not. It is not version control, and it does not try to be - a
repository does this properly and Thursday should not be a worse one. It is
not a safety net for the shell, which can do anything at all; that is what
confirmation is for. And it does not survive housekeeping: entries age out,
because keeping every version of every file for ever is how a personal
assistant quietly fills a disk.

What it is: the ten minutes after "actually, put that back".
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: What was done to a file.
ACTIONS = ("write", "append", "delete", "create")

#: Bigger than this and the copy costs more than the convenience is worth.
#: The change still happens; it is recorded as not undoable, and says why.
MAX_KEPT_BYTES = 20_000_000

#: How long a saved version is worth keeping.
KEEP_SECONDS = 7 * 24 * 3600

#: And how many, whatever their age.
KEEP_MOST_RECENT = 200


class UndoError(Exception):
    """The change cannot be undone, and this is why."""


@dataclass
class Change:
    """One thing that happened to one file."""

    id: int
    action: str
    path: str
    #: Where the previous contents were put, empty if there were none.
    backup: str = ""
    size: int = 0
    undone: bool = False
    reason: str = ""
    when: str = ""

    @property
    def undoable(self) -> bool:
        return not self.undone and not self.reason

    def describe(self) -> str:
        name = Path(self.path).name
        if self.action == "create":
            return f"created {name}"
        if self.action == "delete":
            return f"deleted {name}"
        return f"{self.action} to {name} ({self.size} bytes)"

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "action": self.action,
            "path": self.path,
            "what": self.describe(),
            "when": self.when,
            "undone": self.undone,
            "undoable": self.undoable,
            "reason": self.reason,
        }


class Journal:
    """What has been changed, and how to put it back."""

    def __init__(self, memory: Any, store: Path | str) -> None:
        self.memory = memory
        self.store = Path(store)

    # ------------------------------------------------------------- writing

    def before(self, path: Path | str, action: str) -> int:
        """Record a change about to happen, keeping whatever is there now.

        Called *before* the write, so if the write then fails there is a
        harmless spare entry rather than a missing one - the direction that
        costs a little disk instead of a file.
        """
        target = Path(path)
        if action not in ACTIONS:
            raise UndoError(f"an action is one of {', '.join(ACTIONS)}")

        if not target.exists():
            # Nothing to keep: undoing a creation means deleting it again.
            return self.memory.record_change("create", str(target), "", 0, "")

        try:
            size = target.stat().st_size
        except OSError as exc:
            return self.memory.record_change(action, str(target), "", 0, str(exc))

        if size > MAX_KEPT_BYTES:
            return self.memory.record_change(
                action, str(target), "", size,
                f"too big to keep a copy of ({size // 1_000_000} MB)",
            )

        try:
            backup = self._keep(target)
        except OSError as exc:
            log.warning("could not keep a copy of %s: %s", target, exc)
            return self.memory.record_change(action, str(target), "", size, str(exc))
        return self.memory.record_change(action, str(target), str(backup), size, "")

    def _keep(self, target: Path) -> Path:
        """Copy a file aside, named so two versions never collide."""
        self.store.mkdir(parents=True, exist_ok=True)
        stamp = f"{time.time():.6f}"
        digest = hashlib.sha256(f"{target}{stamp}".encode()).hexdigest()[:16]
        backup = self.store / f"{digest}{target.suffix}"
        shutil.copy2(target, backup)
        return backup

    # ------------------------------------------------------------- reading

    def recent(self, limit: int = 20) -> list[Change]:
        return [self._build(row) for row in self.memory.changes(limit)]

    def get(self, change_id: int) -> Change:
        row = self.memory.change(change_id)
        if row is None:
            raise UndoError(f"there is no change {change_id}")
        return self._build(row)

    def _build(self, row: Any) -> Change:
        from .memory import iso

        return Change(
            id=row["id"],
            action=row["action"],
            path=row["path"],
            backup=row["backup"] or "",
            size=int(row["size"] or 0),
            undone=bool(row["undone"]),
            reason=row["reason"] or "",
            when=iso(row["created_at"]),
        )

    # ------------------------------------------------------------- undoing

    def undo(self, change_id: int = 0) -> Change:
        """Put one change back. Zero means the most recent undoable one."""
        change = self._latest() if not change_id else self.get(change_id)
        if change.undone:
            raise UndoError(f"change {change.id} has already been put back")
        if change.reason:
            raise UndoError(f"change {change.id} cannot be undone: {change.reason}")

        target = Path(change.path)
        if change.action == "create":
            # It did not exist before, so putting it back means removing it.
            if target.exists():
                try:
                    target.unlink()
                except OSError as exc:
                    raise UndoError(f"could not remove {target}: {exc}") from exc
        else:
            backup = Path(change.backup)
            if not backup.is_file():
                raise UndoError(
                    f"the saved copy of {target.name} is gone; it may have aged out"
                )
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup, target)
            except OSError as exc:
                raise UndoError(f"could not put {target} back: {exc}") from exc

        self.memory.mark_undone(change.id)
        return self.get(change.id)

    def _latest(self) -> Change:
        for change in self.recent(50):
            if change.undoable:
                return change
        raise UndoError("there is nothing to put back")

    # --------------------------------------------------------- housekeeping

    def tidy(self, now: float | None = None) -> int:
        """Drop old saved copies. Keeping every version for ever is how a
        personal assistant quietly fills a disk."""
        moment = time.time() if now is None else now
        stale = self.memory.stale_changes(moment - KEEP_SECONDS, KEEP_MOST_RECENT)
        removed = 0
        for row in stale:
            backup = row["backup"]
            if backup:
                try:
                    Path(backup).unlink(missing_ok=True)
                    removed += 1
                except OSError as exc:  # pragma: no cover - a locked file
                    log.debug("could not remove %s: %s", backup, exc)
            self.memory.drop_change(row["id"])
        return removed
