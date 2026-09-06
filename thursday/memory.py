"""Persistent memory: conversation history, notes, facts and reminders.

Everything lives in one SQLite file so Thursday remembers across restarts.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    due_at      REAL NOT NULL,
    created_at  REAL NOT NULL,
    fired_at    REAL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(fired_at, due_at);
"""


def _now() -> float:
    return time.time()


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat(timespec="seconds")


@dataclass
class Reminder:
    id: int
    text: str
    due_at: float
    created_at: float
    fired_at: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "due_at": iso(self.due_at),
            "due_in_seconds": round(self.due_at - _now()),
            "fired": self.fired_at is not None,
        }


class Memory:
    """Thread-safe SQLite wrapper. Use `Memory(":memory:")` in tests."""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = str(db_path)
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
            return cur

    def _query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, tuple(params)).fetchall()

    # ---------------------------------------------------------------- history

    def append_message(self, session_id: str, role: str, content: Any) -> None:
        self._execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?,?)",
            (session_id, role, json.dumps(content, ensure_ascii=False, default=str), _now()),
        )

    def load_history(self, session_id: str, limit: int = 40) -> list[dict[str, Any]]:
        """Return the last `limit` messages for a session, oldest first.

        Both ends are trimmed to something the API will accept: a window may
        not begin with a tool result whose tool_use was cut off, nor end with a
        tool_use whose results were never written (a run that died mid-turn).
        """
        rows = self._query(
            "SELECT role, content FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        )
        history = [
            {"role": r["role"], "content": json.loads(r["content"])} for r in reversed(rows)
        ]
        while history and _starts_with_tool_result(history[0]):
            history.pop(0)
        while history and _has_tool_use(history[-1]):
            history.pop()
        return history

    def clear_session(self, session_id: str) -> int:
        cur = self._execute("DELETE FROM messages WHERE session_id=?", (session_id,))
        return cur.rowcount

    def sessions(self) -> list[dict[str, Any]]:
        rows = self._query(
            "SELECT session_id, COUNT(*) AS n, MAX(created_at) AS last "
            "FROM messages GROUP BY session_id ORDER BY last DESC"
        )
        return [
            {"session_id": r["session_id"], "messages": r["n"], "last_active": iso(r["last"])}
            for r in rows
        ]

    # ------------------------------------------------------------------ notes

    def add_note(self, title: str, body: str = "", tags: str = "") -> int:
        now = _now()
        cur = self._execute(
            "INSERT INTO notes (title, body, tags, created_at, updated_at) VALUES (?,?,?,?,?)",
            (title, body, tags, now, now),
        )
        return int(cur.lastrowid or 0)

    def list_notes(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self._query(
            "SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?", (limit,)
        )
        return [_note_dict(r) for r in rows]

    def search_notes(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        like = f"%{query}%"
        rows = self._query(
            "SELECT * FROM notes WHERE title LIKE ? OR body LIKE ? OR tags LIKE ? "
            "ORDER BY updated_at DESC LIMIT ?",
            (like, like, like, limit),
        )
        return [_note_dict(r) for r in rows]

    def delete_note(self, note_id: int) -> bool:
        return self._execute("DELETE FROM notes WHERE id=?", (note_id,)).rowcount > 0

    # ------------------------------------------------------------------ facts

    def remember(self, key: str, value: str) -> None:
        self._execute(
            "INSERT INTO facts (key, value, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key.strip().lower(), value, _now()),
        )

    def recall(self, key: str) -> str | None:
        rows = self._query("SELECT value FROM facts WHERE key=?", (key.strip().lower(),))
        return rows[0]["value"] if rows else None

    def all_facts(self) -> dict[str, str]:
        return {r["key"]: r["value"] for r in self._query("SELECT key, value FROM facts ORDER BY key")}

    def forget(self, key: str) -> bool:
        return self._execute("DELETE FROM facts WHERE key=?", (key.strip().lower(),)).rowcount > 0

    # -------------------------------------------------------------- reminders

    def add_reminder(self, text: str, due_at: float) -> Reminder:
        now = _now()
        cur = self._execute(
            "INSERT INTO reminders (text, due_at, created_at) VALUES (?,?,?)",
            (text, due_at, now),
        )
        return Reminder(int(cur.lastrowid or 0), text, due_at, now, None)

    def pending_reminders(self) -> list[Reminder]:
        rows = self._query(
            "SELECT * FROM reminders WHERE fired_at IS NULL ORDER BY due_at ASC"
        )
        return [_reminder(r) for r in rows]

    def due_reminders(self, now: float | None = None) -> list[Reminder]:
        moment = _now() if now is None else now
        rows = self._query(
            "SELECT * FROM reminders WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at",
            (moment,),
        )
        return [_reminder(r) for r in rows]

    def mark_fired(self, reminder_id: int) -> None:
        self._execute("UPDATE reminders SET fired_at=? WHERE id=?", (_now(), reminder_id))

    def cancel_reminder(self, reminder_id: int) -> bool:
        return self._execute(
            "DELETE FROM reminders WHERE id=? AND fired_at IS NULL", (reminder_id,)
        ).rowcount > 0


def _note_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"],
        "tags": row["tags"],
        "updated_at": iso(row["updated_at"]),
    }


def _reminder(row: sqlite3.Row) -> Reminder:
    return Reminder(
        id=row["id"],
        text=row["text"],
        due_at=row["due_at"],
        created_at=row["created_at"],
        fired_at=row["fired_at"],
    )


def _has_tool_use(message: dict[str, Any]) -> bool:
    """True for an assistant turn that called a tool."""
    if message.get("role") != "assistant":
        return False
    content = message.get("content")
    if not isinstance(content, list):
        return False
    return any(isinstance(block, dict) and block.get("type") == "tool_use" for block in content)


def _starts_with_tool_result(message: dict[str, Any]) -> bool:
    content = message.get("content")
    if not isinstance(content, list):
        return False
    return any(
        isinstance(block, dict) and block.get("type") == "tool_result" for block in content
    )
