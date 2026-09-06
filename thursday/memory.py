"""Persistent memory: conversation history, notes, facts and reminders.

Everything lives in one SQLite file so Thursday remembers across restarts.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    -- The readable text of `content`, kept separately so search never has to
    -- parse JSON and never matches on block types or base64.
    plain       TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    -- Whose note this is. Empty means shared, which is what everything
    -- written before there were people becomes.
    person      TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

-- Keyed on (person, key) rather than key alone, so two people can each
-- have a "home_city" without overwriting one another.
CREATE TABLE IF NOT EXISTS facts (
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    person      TEXT NOT NULL DEFAULT '',
    updated_at  REAL NOT NULL,
    PRIMARY KEY (person, key)
);

CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    due_at      REAL NOT NULL,
    person      TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    fired_at    REAL,
    repeat_seconds REAL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(fired_at, due_at);

CREATE TABLE IF NOT EXISTS usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    profile       TEXT NOT NULL DEFAULT '',
    provider      TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_tokens  INTEGER NOT NULL DEFAULT 0,
    -- NULL where the model's price is unknown, never a guess.
    cost          REAL,
    created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);

CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tool        TEXT NOT NULL,
    arguments   TEXT NOT NULL DEFAULT '',
    -- allowed | confirmed | declined | denied | failed
    outcome     TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    session_id  TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(created_at);

CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    instruction TEXT NOT NULL,
    -- queued | running | done | failed | cancelled
    status      TEXT NOT NULL DEFAULT 'queued',
    result      TEXT NOT NULL DEFAULT '',
    session_id  TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    started_at  REAL,
    finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);

CREATE TABLE IF NOT EXISTS schedules (
    name        TEXT PRIMARY KEY,
    -- What to carry out: either a saved routine's name or a literal instruction.
    routine     TEXT NOT NULL,
    spec        TEXT NOT NULL,
    next_run    REAL,
    last_run    REAL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run);

CREATE TABLE IF NOT EXISTS routines (
    name        TEXT PRIMARY KEY,
    instruction TEXT NOT NULL,
    created_at  REAL NOT NULL,
    used_at     REAL,
    uses        INTEGER NOT NULL DEFAULT 0
);

-- Mail and calendar entries Thursday has written but not carried out. The
-- status column is the whole safety story: nothing leaves on anything but
-- 'approved', and only a person sets that.
CREATE TABLE IF NOT EXISTS drafts (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL DEFAULT 'email',
    subject     TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    recipients  TEXT NOT NULL DEFAULT '',
    cc          TEXT NOT NULL DEFAULT '',
    bcc         TEXT NOT NULL DEFAULT '',
    reply_to    TEXT NOT NULL DEFAULT '',
    starts_at   REAL,
    minutes     INTEGER NOT NULL DEFAULT 60,
    location    TEXT NOT NULL DEFAULT '',
    -- draft | approved | sent | failed | discarded
    status      TEXT NOT NULL DEFAULT 'draft',
    note        TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, created_at);

-- Work too big for one turn, written down before it starts so you can see
-- what is meant to happen and where it has got to.
CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    -- open | finished | abandoned
    state       TEXT NOT NULL DEFAULT 'open',
    session_id  TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_state ON plans(state, id);

-- Things to keep an eye on. `state` is whatever the watcher needs to tell
-- new from already-seen, and is written before anything is announced.
CREATE TABLE IF NOT EXISTS watchers (
    name          TEXT PRIMARY KEY,
    -- folder | mail | calendar | page
    kind          TEXT NOT NULL,
    target        TEXT NOT NULL DEFAULT '',
    -- tell | run
    action        TEXT NOT NULL DEFAULT 'tell',
    instruction   TEXT NOT NULL DEFAULT '',
    options       TEXT NOT NULL DEFAULT '{}',
    state         TEXT NOT NULL DEFAULT '{}',
    every_seconds REAL NOT NULL DEFAULT 300,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_checked  REAL,
    failures      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT NOT NULL DEFAULT '',
    created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchers_due ON watchers(enabled, last_checked);

CREATE TABLE IF NOT EXISTS plan_steps (
    plan_id     INTEGER NOT NULL,
    number      INTEGER NOT NULL,
    text        TEXT NOT NULL,
    -- todo | doing | done | skipped | failed
    state       TEXT NOT NULL DEFAULT 'todo',
    result      TEXT NOT NULL DEFAULT '',
    updated_at  REAL NOT NULL,
    PRIMARY KEY (plan_id, number)
);
"""


#: "Mine, or the household's." Used everywhere a person's own things are
#: read: they see what they wrote plus what is shared, and never what someone
#: else wrote. Bound to one parameter, which every caller passes.
_MINE = "(person = ? OR person = '')"


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
    repeat_seconds: float | None = None

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "text": self.text,
            "due_at": iso(self.due_at),
            "due_in_seconds": round(self.due_at - _now()),
            "fired": self.fired_at is not None,
        }
        if self.repeat_seconds:
            payload["repeats_every_seconds"] = round(self.repeat_seconds)
        return payload


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
            self._migrate()
            self._conn.commit()

    def _migrate(self) -> None:
        """Bring a database created by an older version up to date."""
        columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(reminders)")}
        if "repeat_seconds" not in columns:
            self._conn.execute("ALTER TABLE reminders ADD COLUMN repeat_seconds REAL")

        # More than one person can use this assistant, and their notes,
        # facts and reminders are their own. An empty person is shared -
        # which is what everything written before this existed becomes.
        for table in ("notes", "reminders"):
            columns = {row["name"] for row in self._conn.execute(f"PRAGMA table_info({table})")}
            if "person" not in columns:
                self._conn.execute(
                    f"ALTER TABLE {table} ADD COLUMN person TEXT NOT NULL DEFAULT ''"
                )

        # facts needs its primary key widened from (key) to (person, key), so
        # two people can each have a "home_city". SQLite cannot alter a
        # primary key, so the table is rebuilt - which is also why this checks
        # the key rather than the column: an older database that only had the
        # column added would still refuse the second person's fact.
        fact_columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(facts)")}
        # PRAGMA reports pk as a 1-based position, and lists columns in
        # declaration order - so this is compared as a set, or the table would
        # be rebuilt on every single startup.
        keys = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(facts)")
            if row["pk"]
        }
        if fact_columns and keys != {"person", "key"}:
            log.info("rebuilding facts so each person has their own")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS facts_new (
                    key         TEXT NOT NULL,
                    value       TEXT NOT NULL,
                    person      TEXT NOT NULL DEFAULT '',
                    updated_at  REAL NOT NULL,
                    PRIMARY KEY (person, key)
                );
                """
            )
            self._conn.execute(
                "INSERT OR REPLACE INTO facts_new (key, value, person, updated_at) "
                "SELECT key, value, {person}, updated_at FROM facts".format(
                    person="person" if "person" in fact_columns else "''"
                )
            )
            self._conn.execute("DROP TABLE facts")
            self._conn.execute("ALTER TABLE facts_new RENAME TO facts")

        message_columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(messages)")}
        if "plain" not in message_columns:
            self._conn.execute("ALTER TABLE messages ADD COLUMN plain TEXT NOT NULL DEFAULT ''")
            # Backfill so old conversations are searchable too.
            for row in self._conn.execute("SELECT id, content FROM messages").fetchall():
                try:
                    text = plain_text(json.loads(row["content"]))
                except (json.JSONDecodeError, TypeError):
                    text = ""
                self._conn.execute(
                    "UPDATE messages SET plain=? WHERE id=?", (text, row["id"])
                )

        self._setup_search()

    def _setup_search(self) -> None:
        """Build the full-text index, if this SQLite has FTS5.

        The trigram tokenizer, rather than the default one: Thai does not put
        spaces between words, so a word-based tokenizer would index a whole
        sentence as one term and never match anything inside it. Trigram also
        gives case-insensitive substring matching for free, at the cost of
        needing queries of at least three characters - short ones fall back to
        LIKE below.
        """
        self.search_available = False
        try:
            self._conn.executescript(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS message_search
                    USING fts5(plain, content='messages', content_rowid='id',
                               tokenize='trigram');

                CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO message_search(rowid, plain) VALUES (new.id, new.plain);
                END;
                CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO message_search(message_search, rowid, plain)
                        VALUES ('delete', old.id, old.plain);
                END;
                """
            )
            # Populate for databases whose messages predate the index.
            if not self._conn.execute("SELECT rowid FROM message_search LIMIT 1").fetchone():
                self._conn.execute(
                    "INSERT INTO message_search(rowid, plain) "
                    "SELECT id, plain FROM messages WHERE plain <> ''"
                )
            self.search_available = True
        except sqlite3.OperationalError as exc:  # SQLite built without FTS5
            log.info("full-text search unavailable, falling back to LIKE: %s", exc)

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
            "INSERT INTO messages (session_id, role, content, plain, created_at) "
            "VALUES (?,?,?,?,?)",
            (
                session_id,
                role,
                json.dumps(content, ensure_ascii=False, default=str),
                plain_text(content),
                _now(),
            ),
        )

    def recent_text(self, since: float, limit: int = 100) -> str:
        """Readable transcript of what was said lately, for reflection."""
        rows = self._query(
            "SELECT role, plain FROM messages WHERE created_at >= ? AND plain <> '' "
            "AND session_id NOT IN ('reflection') ORDER BY id DESC LIMIT ?",
            (since, limit),
        )
        lines = [
            f"{'user' if row['role'] == 'user' else 'assistant'}: {row['plain']}"
            for row in reversed(rows)
        ]
        return "\n".join(lines)

    def search_messages(
        self, query: str, limit: int = 10, session_id: str | None = None
    ) -> list[dict[str, Any]]:
        """Search everything ever said, not just the recent window."""
        query = query.strip()
        if not query:
            return []

        # Trigram indexes cannot answer a query shorter than three
        # characters; LIKE can.
        if self.search_available and len(query) >= 3:
            sql = (
                "SELECT m.session_id, m.role, m.plain, m.created_at "
                "FROM message_search s JOIN messages m ON m.id = s.rowid "
                "WHERE message_search MATCH ?"
            )
            params: list[Any] = [_fts_query(query)]
            if session_id:
                sql += " AND m.session_id = ?"
                params.append(session_id)
            sql += " ORDER BY rank LIMIT ?"
            params.append(limit)
            try:
                rows = self._query(sql, params)
            except sqlite3.OperationalError:
                rows = []  # a query FTS5 could not parse; fall through to LIKE
            if rows:
                return [_hit(row) for row in rows]

        sql = "SELECT session_id, role, plain, created_at FROM messages WHERE plain LIKE ?"
        params = [f"%{query}%"]
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [_hit(row) for row in self._query(sql, params)]

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

    def add_note(self, title: str, body: str = "", tags: str = "", person: str = "") -> int:
        now = _now()
        cur = self._execute(
            "INSERT INTO notes (title, body, tags, person, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (title, body, tags, person, now, now),
        )
        return int(cur.lastrowid or 0)

    def list_notes(self, limit: int = 20, person: str = "") -> list[dict[str, Any]]:
        rows = self._query(
            f"SELECT * FROM notes WHERE {_MINE} ORDER BY updated_at DESC LIMIT ?",
            (person, limit),
        )
        return [_note_dict(r) for r in rows]

    def search_notes(
        self, query: str, limit: int = 20, person: str = ""
    ) -> list[dict[str, Any]]:
        like = f"%{query}%"
        rows = self._query(
            f"SELECT * FROM notes WHERE {_MINE} AND "
            "(title LIKE ? OR body LIKE ? OR tags LIKE ?) "
            "ORDER BY updated_at DESC LIMIT ?",
            (person, like, like, like, limit),
        )
        return [_note_dict(r) for r in rows]

    def delete_note(self, note_id: int, person: str = "") -> bool:
        """Delete a note. Somebody else's is simply not found."""
        return self._execute(
            f"DELETE FROM notes WHERE id=? AND {_MINE}", (note_id, person)
        ).rowcount > 0

    # ------------------------------------------------------------------ facts

    def remember(self, key: str, value: str, person: str = "") -> None:
        self._execute(
            "INSERT INTO facts (key, value, person, updated_at) VALUES (?,?,?,?) "
            "ON CONFLICT(person, key) DO UPDATE SET "
            "value=excluded.value, updated_at=excluded.updated_at",
            (key.strip().lower(), value, person, _now()),
        )

    def recall(self, key: str, person: str = "") -> str | None:
        """A person's own answer, falling back to the shared one.

        Their own wins: if the house has a "home_city" and so do they, the
        one that answers a question they asked is theirs.
        """
        rows = self._query(
            f"SELECT value FROM facts WHERE key=? AND {_MINE} "
            "ORDER BY person DESC LIMIT 1",
            (key.strip().lower(), person),
        )
        return rows[0]["value"] if rows else None

    def all_facts(self, person: str = "") -> dict[str, str]:
        # Shared first so a personal answer for the same key overwrites it,
        # matching what recall() would return for each one.
        rows = self._query(
            f"SELECT key, value FROM facts WHERE {_MINE} ORDER BY person, key", (person,)
        )
        return {r["key"]: r["value"] for r in rows}

    def forget(self, key: str, person: str = "") -> bool:
        return self._execute(
            f"DELETE FROM facts WHERE key=? AND {_MINE}",
            (key.strip().lower(), person),
        ).rowcount > 0

    # -------------------------------------------------------------- reminders

    def add_reminder(
        self, text: str, due_at: float, repeat_seconds: float | None = None,
        person: str = "",
    ) -> Reminder:
        now = _now()
        cur = self._execute(
            "INSERT INTO reminders (text, due_at, person, created_at, repeat_seconds) "
            "VALUES (?,?,?,?,?)",
            (text, due_at, person, now, repeat_seconds),
        )
        return Reminder(int(cur.lastrowid or 0), text, due_at, now, None, repeat_seconds)

    def pending_reminders(self, person: str = "") -> list[Reminder]:
        rows = self._query(
            f"SELECT * FROM reminders WHERE fired_at IS NULL AND {_MINE} ORDER BY due_at ASC",
            (person,),
        )
        return [_reminder(r) for r in rows]

    def due_reminders(self, now: float | None = None) -> list[Reminder]:
        """Everyone's, deliberately: the proactive loop fires them all, and
        says whose each one is. Scoping this would silently drop the reminders
        of whoever was not standing in front of the camera."""
        moment = _now() if now is None else now
        rows = self._query(
            "SELECT * FROM reminders WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at",
            (moment,),
        )
        return [_reminder(r) for r in rows]

    def mark_fired(self, reminder_id: int) -> float | None:
        """Retire a reminder, or roll a repeating one forward.

        Returns the next due time for a repeating reminder, else None.
        """
        rows = self._query("SELECT * FROM reminders WHERE id=?", (reminder_id,))
        if not rows:
            return None
        reminder = _reminder(rows[0])

        if not reminder.repeat_seconds:
            self._execute("UPDATE reminders SET fired_at=? WHERE id=?", (_now(), reminder_id))
            return None

        # Skip any occurrences missed while the assistant was not running.
        next_due = reminder.due_at
        now = _now()
        while next_due <= now:
            next_due += reminder.repeat_seconds
        self._execute("UPDATE reminders SET due_at=? WHERE id=?", (next_due, reminder_id))
        return next_due

    def cancel_reminder(self, reminder_id: int, person: str = "") -> bool:
        """Cancel one. Somebody else's is simply not found."""
        return self._execute(
            f"DELETE FROM reminders WHERE id=? AND fired_at IS NULL AND {_MINE}",
            (reminder_id, person),
        ).rowcount > 0

    # ------------------------------------------------------------------ usage

    def record_usage(
        self,
        session_id: str,
        profile: str,
        provider: str,
        model: str,
        counts: dict[str, int],
        cost: float | None,
    ) -> None:
        self._execute(
            "INSERT INTO usage (session_id, profile, provider, model, input_tokens, "
            "output_tokens, cache_tokens, cost, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                session_id,
                profile,
                provider,
                model,
                counts.get("input", 0),
                counts.get("output", 0),
                counts.get("cache_read", 0) + counts.get("cache_write", 0),
                cost,
                _now(),
            ),
        )

    def usage_summary(self, since: float | None = None, group_by: str = "model") -> list[dict[str, Any]]:
        """Totals per model, provider or profile."""
        if group_by not in {"model", "provider", "profile", "session_id"}:
            group_by = "model"
        sql = (
            f"SELECT {group_by} AS key, COUNT(*) AS turns, SUM(input_tokens) AS input, "
            "SUM(output_tokens) AS output, SUM(cache_tokens) AS cached, SUM(cost) AS cost, "
            "COUNT(cost) AS priced FROM usage"
        )
        params: list[Any] = []
        if since is not None:
            sql += " WHERE created_at >= ?"
            params.append(since)
        sql += f" GROUP BY {group_by} ORDER BY (cost IS NULL), cost DESC, output DESC"

        return [
            {
                "key": row["key"] or "(unknown)",
                "turns": row["turns"],
                "input_tokens": row["input"] or 0,
                "output_tokens": row["output"] or 0,
                "cached_tokens": row["cached"] or 0,
                "cost": row["cost"],
                # Some turns in this group ran on a model with no known price.
                "partial": row["priced"] != row["turns"],
            }
            for row in self._query(sql, params)
        ]

    def spend_since(self, since: float) -> float:
        rows = self._query("SELECT SUM(cost) AS total FROM usage WHERE created_at >= ?", (since,))
        return float(rows[0]["total"] or 0.0) if rows else 0.0

    # ------------------------------------------------------------------ audit

    def record_access(
        self,
        tool: str,
        arguments: Any,
        outcome: str,
        reason: str = "",
        session_id: str = "",
    ) -> None:
        """Note that something reached for the machine, and what happened."""
        try:
            rendered = json.dumps(arguments, ensure_ascii=False, default=str)[:2000]
        except (TypeError, ValueError):
            rendered = str(arguments)[:2000]
        self._execute(
            "INSERT INTO audit (tool, arguments, outcome, reason, session_id, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (tool, rendered, outcome, reason[:500], session_id, _now()),
        )

    def access_log(self, limit: int = 50, outcome: str = "") -> list[dict[str, Any]]:
        sql = "SELECT * FROM audit"
        params: list[Any] = []
        if outcome:
            sql += " WHERE outcome=?"
            params.append(outcome)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [
            {
                "when": iso(row["created_at"]),
                "tool": row["tool"],
                "arguments": row["arguments"],
                "outcome": row["outcome"],
                "reason": row["reason"],
            }
            for row in self._query(sql, params)
        ]

    def access_summary(self, since: float | None = None) -> list[dict[str, Any]]:
        sql = "SELECT tool, outcome, COUNT(*) AS n FROM audit"
        params: list[Any] = []
        if since is not None:
            sql += " WHERE created_at >= ?"
            params.append(since)
        sql += " GROUP BY tool, outcome ORDER BY n DESC"
        return [
            {"tool": row["tool"], "outcome": row["outcome"], "count": row["n"]}
            for row in self._query(sql, params)
        ]

    # ----------------------------------------------------------------- drafts

    def save_draft(self, draft_id: str, row: dict[str, Any]) -> None:
        """Write a draft, replacing it if it already exists."""
        now = _now()
        columns = ("kind", "subject", "body", "recipients", "cc", "bcc", "reply_to",
                   "starts_at", "minutes", "location", "status", "note")
        values = [row.get(name) for name in columns]
        self._execute(
            f"INSERT INTO drafts (id, {', '.join(columns)}, created_at, updated_at) "
            f"VALUES ({', '.join(['?'] * (len(columns) + 3))}) "
            "ON CONFLICT(id) DO UPDATE SET "
            + ", ".join(f"{name}=excluded.{name}" for name in columns)
            + ", updated_at=excluded.updated_at",
            (draft_id, *values, now, now),
        )

    def draft(self, draft_id: str) -> Any:
        rows = self._query("SELECT * FROM drafts WHERE id=?", (draft_id,))
        return rows[0] if rows else None

    def drafts(self, status: str = "", limit: int = 50) -> list[Any]:
        sql = "SELECT * FROM drafts"
        params: list[Any] = []
        if status:
            sql += " WHERE status=?"
            params.append(status)
        else:
            # A discarded draft is finished business; it clutters the list.
            sql += " WHERE status != 'discarded'"
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return self._query(sql, params)

    def set_draft_status(self, draft_id: str, status: str) -> None:
        self._execute(
            "UPDATE drafts SET status=?, updated_at=? WHERE id=?",
            (status, _now(), draft_id),
        )

    # --------------------------------------------------------------- watchers

    def save_watcher(
        self, name: str, kind: str, target: str, action: str,
        instruction: str, options: str, every_seconds: float,
    ) -> None:
        """Add or replace a watcher, keeping what it has already seen.

        Keeping the state matters: editing the interval on a folder watcher
        should not make it re-announce every file in the folder.
        """
        self._execute(
            "INSERT INTO watchers (name, kind, target, action, instruction, options, "
            "every_seconds, created_at) VALUES (?,?,?,?,?,?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, target=excluded.target, "
            "action=excluded.action, instruction=excluded.instruction, "
            "options=excluded.options, every_seconds=excluded.every_seconds, "
            "enabled=1, failures=0, last_error=''",
            (name, kind, target, action, instruction, options, every_seconds, _now()),
        )

    def watcher(self, name: str) -> Any:
        rows = self._query("SELECT * FROM watchers WHERE name=?", (name,))
        return rows[0] if rows else None

    def watchers(self, enabled_only: bool = False) -> list[Any]:
        sql = "SELECT * FROM watchers"
        if enabled_only:
            sql += " WHERE enabled=1"
        return self._query(sql + " ORDER BY name", ())

    def record_watch(
        self, name: str, checked_at: float, state: str | None,
        failures: int = 0, error: str = "",
    ) -> None:
        """Note that a watcher ran. `state=None` leaves what it had seen alone,
        so a failed look does not wipe its memory."""
        if state is None:
            self._execute(
                "UPDATE watchers SET last_checked=?, failures=?, last_error=? WHERE name=?",
                (checked_at, failures, error[:500], name),
            )
        else:
            self._execute(
                "UPDATE watchers SET last_checked=?, state=?, failures=?, last_error=? "
                "WHERE name=?",
                (checked_at, state, failures, error[:500], name),
            )

    def enable_watcher(self, name: str, enabled: bool = True) -> None:
        self._execute(
            "UPDATE watchers SET enabled=? WHERE name=?", (1 if enabled else 0, name)
        )

    def delete_watcher(self, name: str) -> None:
        self._execute("DELETE FROM watchers WHERE name=?", (name,))

    # ------------------------------------------------------------------ plans

    def add_plan(self, title: str, steps: list[str], session_id: str = "") -> int:
        now = _now()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO plans (title, session_id, created_at, updated_at) VALUES (?,?,?,?)",
                (title, session_id, now, now),
            )
            plan_id = int(cur.lastrowid or 0)
            self._conn.executemany(
                "INSERT INTO plan_steps (plan_id, number, text, updated_at) VALUES (?,?,?,?)",
                [(plan_id, index, text, now) for index, text in enumerate(steps, start=1)],
            )
            self._conn.commit()
        return plan_id

    def plan(self, plan_id: int) -> Any:
        rows = self._query("SELECT * FROM plans WHERE id=?", (plan_id,))
        return rows[0] if rows else None

    def plans(self, state: str = "", limit: int = 20) -> list[Any]:
        sql = "SELECT * FROM plans"
        params: list[Any] = []
        if state:
            sql += " WHERE state=?"
            params.append(state)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return self._query(sql, params)

    def plan_steps(self, plan_id: int) -> list[Any]:
        return self._query(
            "SELECT * FROM plan_steps WHERE plan_id=? ORDER BY number", (plan_id,)
        )

    def add_plan_step(self, plan_id: int, text: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(number), 0) AS n FROM plan_steps WHERE plan_id=?",
                (plan_id,),
            ).fetchone()
            number = int(row["n"]) + 1
            self._conn.execute(
                "INSERT INTO plan_steps (plan_id, number, text, updated_at) VALUES (?,?,?,?)",
                (plan_id, number, text, _now()),
            )
            self._conn.commit()
        return number

    def set_step(self, plan_id: int, number: int, state: str, result: str = "") -> None:
        self._execute(
            "UPDATE plan_steps SET state=?, result=?, updated_at=? WHERE plan_id=? AND number=?",
            (state, result, _now(), plan_id, number),
        )
        self._execute("UPDATE plans SET updated_at=? WHERE id=?", (_now(), plan_id))

    def set_plan_state(self, plan_id: int, state: str) -> None:
        self._execute(
            "UPDATE plans SET state=?, updated_at=? WHERE id=?", (state, _now(), plan_id)
        )

    # ------------------------------------------------------------------- jobs

    def add_job(self, title: str, instruction: str, session_id: str = "") -> int:
        cur = self._execute(
            "INSERT INTO jobs (title, instruction, session_id, created_at) VALUES (?,?,?,?)",
            (title.strip(), instruction.strip(), session_id, _now()),
        )
        return int(cur.lastrowid or 0)

    def next_job(self) -> dict[str, Any] | None:
        """Claim the oldest queued job, marking it running in the same breath.

        Done under the lock so two runners cannot pick up the same job.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            self._conn.execute(
                "UPDATE jobs SET status='running', started_at=? WHERE id=?", (_now(), row["id"])
            )
            self._conn.commit()
            return _job_dict(row) | {"status": "running"}

    def finish_job(self, job_id: int, result: str, failed: bool = False) -> None:
        self._execute(
            "UPDATE jobs SET status=?, result=?, finished_at=? WHERE id=?",
            ("failed" if failed else "done", result[:20000], _now(), job_id),
        )

    def cancel_job(self, job_id: int) -> bool:
        return self._execute(
            "UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? "
            "AND status IN ('queued','running')",
            (_now(), job_id),
        ).rowcount > 0

    def jobs(self, limit: int = 20, status: str = "") -> list[dict[str, Any]]:
        sql = "SELECT * FROM jobs"
        params: list[Any] = []
        if status:
            sql += " WHERE status=?"
            params.append(status)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [_job_dict(row) for row in self._query(sql, params)]

    def job(self, job_id: int) -> dict[str, Any] | None:
        rows = self._query("SELECT * FROM jobs WHERE id=?", (job_id,))
        return _job_dict(rows[0]) if rows else None

    def unfinished_jobs(self) -> list[dict[str, Any]]:
        """Jobs left running when the process died, so they can be re-queued."""
        return [_job_dict(row) for row in self._query("SELECT * FROM jobs WHERE status='running'")]

    def requeue_job(self, job_id: int) -> None:
        self._execute("UPDATE jobs SET status='queued', started_at=NULL WHERE id=?", (job_id,))

    # -------------------------------------------------------------- schedules

    def save_schedule(self, name: str, routine: str, spec: str, next_run: float | None) -> None:
        self._execute(
            "INSERT INTO schedules (name, routine, spec, next_run, created_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET routine=excluded.routine, spec=excluded.spec, "
            "next_run=excluded.next_run, enabled=1",
            (name.strip().lower(), routine, spec, next_run, _now()),
        )

    def list_schedules(self, only_enabled: bool = False) -> list[dict[str, Any]]:
        sql = "SELECT * FROM schedules"
        if only_enabled:
            sql += " WHERE enabled=1"
        sql += " ORDER BY next_run IS NULL, next_run"
        return [_schedule_dict(row) for row in self._query(sql)]

    def due_schedules(self, now: float | None = None) -> list[dict[str, Any]]:
        moment = _now() if now is None else now
        rows = self._query(
            "SELECT * FROM schedules WHERE enabled=1 AND next_run IS NOT NULL "
            "AND next_run <= ? ORDER BY next_run",
            (moment,),
        )
        return [_schedule_dict(row) for row in rows]

    def mark_scheduled_run(self, name: str, next_run: float | None) -> None:
        self._execute(
            "UPDATE schedules SET last_run=?, next_run=? WHERE name=?",
            (_now(), next_run, name.strip().lower()),
        )

    def cancel_schedule(self, name: str) -> bool:
        return self._execute(
            "DELETE FROM schedules WHERE name=?", (name.strip().lower(),)
        ).rowcount > 0

    # --------------------------------------------------------------- routines

    def save_routine(self, name: str, instruction: str) -> None:
        self._execute(
            "INSERT INTO routines (name, instruction, created_at) VALUES (?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET instruction=excluded.instruction",
            (name.strip().lower(), instruction, _now()),
        )

    def get_routine(self, name: str) -> dict[str, Any] | None:
        rows = self._query("SELECT * FROM routines WHERE name=?", (name.strip().lower(),))
        return _routine_dict(rows[0]) if rows else None

    def list_routines(self) -> list[dict[str, Any]]:
        return [_routine_dict(r) for r in self._query("SELECT * FROM routines ORDER BY name")]

    def touch_routine(self, name: str) -> None:
        """Record that a routine was run."""
        self._execute(
            "UPDATE routines SET used_at=?, uses=uses+1 WHERE name=?",
            (_now(), name.strip().lower()),
        )

    def delete_routine(self, name: str) -> bool:
        return self._execute(
            "DELETE FROM routines WHERE name=?", (name.strip().lower(),)
        ).rowcount > 0


def plain_text(content: Any) -> str:
    """The readable text inside a message, whatever shape it arrived in."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text" and block.get("text"):
            parts.append(str(block["text"]))
        elif kind == "tool_use":
            parts.append(f"[used {block.get('name', 'a tool')}]")
        elif kind == "tool_result":
            inner = block.get("content")
            if isinstance(inner, str):
                parts.append(inner)
            elif isinstance(inner, list):
                parts.append(plain_text(inner))
    return "\n".join(part for part in parts if part).strip()


def _fts_query(query: str) -> str:
    """Quote user text so FTS5 treats it as terms, not as its own syntax.

    Without the quoting, a query containing `*`, `NEAR(` or a stray quote is
    parsed as FTS5 syntax and raises instead of searching.
    """
    words = [word.replace('"', "") for word in query.split() if word.strip()]
    return " ".join(f'"{word}"' for word in words) or '""'


def _hit(row: sqlite3.Row) -> dict[str, Any]:
    text = row["plain"]
    return {
        "session": row["session_id"],
        "who": "you" if row["role"] == "user" else "me",
        "when": iso(row["created_at"]),
        "text": text if len(text) <= 400 else text[:400] + "...",
    }


def _note_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"],
        "tags": row["tags"],
        "updated_at": iso(row["updated_at"]),
    }


def _job_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "instruction": row["instruction"],
        "status": row["status"],
        "result": row["result"],
        "created_at": iso(row["created_at"]),
        "finished_at": iso(row["finished_at"]) if row["finished_at"] else None,
    }


def _schedule_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "name": row["name"],
        "routine": row["routine"],
        "spec": row["spec"],
        "next_run": row["next_run"],
        "next_run_at": iso(row["next_run"]) if row["next_run"] else None,
        "last_run_at": iso(row["last_run"]) if row["last_run"] else None,
        "enabled": bool(row["enabled"]),
    }


def _routine_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "name": row["name"],
        "instruction": row["instruction"],
        "uses": row["uses"],
        "last_used": iso(row["used_at"]) if row["used_at"] else None,
    }


def _reminder(row: sqlite3.Row) -> Reminder:
    keys = row.keys()
    return Reminder(
        id=row["id"],
        text=row["text"],
        due_at=row["due_at"],
        created_at=row["created_at"],
        fired_at=row["fired_at"],
        repeat_seconds=row["repeat_seconds"] if "repeat_seconds" in keys else None,
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
