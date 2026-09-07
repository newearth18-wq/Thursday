"""Noticing things, rather than waiting to be asked.

Everything proactive so far ran off the clock: a reminder at 18:00, a routine
every weekday at eight. That covers what you already knew would happen, and
none of what actually does - a file landing in Downloads, a reply from someone
you were waiting on, a meeting creeping up, a page changing.

A watcher is a thing to look at, a condition, and what to do when it happens.
It is checked on the same tick as everything else, so it costs no thread and
no daemon of its own.

Three rules, all learned the hard way from the scheduling code:

- **State is written before the action runs.** A watcher that fires and then
  crashes must not fire again on the next tick for the same event; the record
  of "I have seen this" goes in first.
- **The first check only learns.** Pointing a watcher at a folder that already
  holds four hundred files should not announce four hundred new files. The
  first look records what is there and says nothing.
- **A watcher that keeps failing gets switched off**, with the reason kept, so
  a mistyped path does not fill the log for ever.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: What can be watched.
KINDS = ("folder", "mail", "calendar", "page")

#: What to do when it fires: tell the user, or hand it to the assistant.
ACTIONS = ("tell", "run")

#: Consecutive failures before a watcher is switched off.
MAX_FAILURES = 5

#: A page or folder is not worth re-reading every 30 seconds.
DEFAULT_INTERVAL = {"folder": 60.0, "mail": 300.0, "calendar": 300.0, "page": 900.0}


class WatchError(Exception):
    """The watcher cannot be set up, or cannot run."""


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()[:16]


@dataclass
class Finding:
    """Something a watcher noticed."""

    watcher: str
    summary: str
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"watcher": self.watcher, "summary": self.summary, "detail": self.detail}


class Watcher:
    """One thing being watched.

    Subclasses answer one question: given the state from last time, what is
    new? They never announce and never act - `Watch.check` does both, so the
    "write state first" rule lives in exactly one place.
    """

    kind = "watcher"

    def __init__(self, name: str, target: str, options: dict[str, Any] | None = None) -> None:
        self.name = name
        self.target = target
        self.options = options or {}

    def look(self, state: dict[str, Any]) -> tuple[list[Finding], dict[str, Any]]:
        """Return what is new, and the state to remember. Never raises for a
        normal empty result - only for a watcher that cannot work at all."""
        raise NotImplementedError


class FolderWatcher(Watcher):
    """Files appearing in a directory."""

    kind = "folder"

    def look(self, state):
        root = Path(self.target).expanduser()
        if not root.is_dir():
            raise WatchError(f"{root} is not a folder I can look in")

        pattern = str(self.options.get("pattern") or "*")
        try:
            names = sorted(
                entry.name
                for entry in root.glob(pattern)
                if entry.is_file() and not entry.name.startswith(".")
            )
        except OSError as exc:
            raise WatchError(f"could not read {root}: {exc}") from exc

        seen = set(state.get("names") or [])
        fresh = {"names": names, "started": True}
        if not state.get("started"):
            # First look: learn what is already there and say nothing.
            return [], fresh

        added = [name for name in names if name not in seen]
        if not added:
            return [], fresh
        shown = ", ".join(added[:5]) + ("…" if len(added) > 5 else "")
        return (
            [
                Finding(
                    self.name,
                    f"{len(added)} new file(s) in {root.name}: {shown}",
                    "\n".join(str(root / name) for name in added[:20]),
                )
            ],
            fresh,
        )


class MailWatcher(Watcher):
    """Unread mail, optionally only from someone in particular."""

    kind = "mail"

    def look(self, state):
        from .tools.mail import Mailbox, decode, summarise
        import email
        import email.policy

        mailbox = Mailbox.from_env()
        if not mailbox.configured:
            raise WatchError("no mailbox is configured; set THURSDAY_IMAP_HOST and friends")

        connection = mailbox.connect()
        try:
            connection.select(mailbox.folder, readonly=True)   # never marks as read
            status, data = connection.search(None, "(UNSEEN)")
            if status != "OK":
                raise WatchError(f"the mail server refused that search: {status}")
            ids = (data[0] or b"").split()[-25:]

            messages = []
            for message_id in reversed(ids):
                status, fetched = connection.fetch(message_id, "(BODY.PEEK[HEADER])")
                if status != "OK" or not fetched or not isinstance(fetched[0], tuple):
                    continue
                parsed = email.message_from_bytes(fetched[0][1], policy=email.policy.default)
                summary = summarise(parsed)
                # Message-ID rather than the sequence number: those are
                # renumbered when the mailbox changes underneath us.
                summary["key"] = decode(parsed.get("Message-ID")) or _digest(
                    f"{summary['from']}{summary['subject']}{summary['date']}"
                )
                messages.append(summary)
        finally:
            try:
                connection.logout()
            except Exception:  # pragma: no cover - a socket already gone
                pass

        sender = str(self.options.get("from") or "").lower()
        if sender:
            messages = [m for m in messages if sender in m["from"].lower()]

        seen = set(state.get("keys") or [])
        fresh = {"keys": [m["key"] for m in messages], "started": True}
        if not state.get("started"):
            return [], fresh

        new = [m for m in messages if m["key"] not in seen]
        return (
            [
                Finding(
                    self.name,
                    f"{m['subject']} — from {m['from']}",
                    f"arrived {m['date']}",
                )
                for m in new
            ],
            fresh,
        )


class CalendarWatcher(Watcher):
    """A meeting coming up, announced once, a set time before it starts."""

    kind = "calendar"

    def look(self, state):
        from datetime import datetime, timedelta

        from .tools.calendar import load, parse_ics, sources, within

        minutes = float(self.options.get("minutes") or 15)
        feeds = [self.target] if self.target else sources()
        if not feeds:
            raise WatchError("no calendars are configured; set THURSDAY_CALENDARS")

        now = datetime.now().astimezone()
        events = []
        for feed in feeds:
            try:
                events.extend(parse_ics(load(feed)))
            except Exception as exc:
                raise WatchError(f"could not read {feed}: {exc}") from exc

        soon = within(events, now, now + timedelta(minutes=minutes))
        seen = set(state.get("keys") or [])
        keys = [_digest(f"{event.summary}{event.start}") for event in soon]
        fresh = {"keys": keys, "started": True}

        # No "first look only learns" here: a meeting inside the window when
        # the watcher is set up is exactly the one worth mentioning.
        findings = []
        for event, key in zip(soon, keys):
            if key in seen:
                continue
            when = event.start.strftime("%H:%M") if hasattr(event.start, "strftime") else ""
            findings.append(Finding(self.name, f"{event.summary} at {when}", event.location or ""))
        return findings, fresh


#: Tags that end a line of readable text. Without this, a page served as one
#: long line collapses to one line, and `contains` matches all of it or none.
_BLOCK_END = re.compile(
    r"</(?:p|div|li|tr|h[1-6]|section|article|header|footer|nav|td|th|blockquote|pre)\s*>"
    r"|<(?:br|hr)\s*/?>",
    re.IGNORECASE,
)
_DROP = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAGS = re.compile(r"<[^>]+>")


def readable_lines(raw: str) -> list[str]:
    """The visible text of a page, one line per block.

    Attributes go with the tags, which is what makes the comparison ignore a
    fresh csrf token or a reordered class list.
    """
    import html as html_module

    text = _TAGS.sub(" ", _BLOCK_END.sub("\n", _DROP.sub(" ", raw)))
    lines = []
    for line in html_module.unescape(text).splitlines():
        cleaned = re.sub(r"\s+", " ", line).strip()
        if cleaned:
            lines.append(cleaned)
    return lines


class PageWatcher(Watcher):
    """A web page changing.

    Compares the visible text rather than the bytes, so the markup churn that
    makes every fetch of a page different - reordered classes, a fresh csrf
    token in an attribute, inline analytics, whitespace - does not read as
    news. Visible text that rotates on its own, such as an advert or a "last
    updated" line, still counts as a change: nothing here can tell that from
    the content you actually care about. Narrowing with `contains` is the
    answer to that, and is why the option exists.
    """

    kind = "page"

    def look(self, state):
        try:
            import httpx
        except ImportError as exc:  # pragma: no cover - httpx is a dependency
            raise WatchError("httpx is not installed") from exc

        try:
            response = httpx.get(
                self.target, timeout=30.0, follow_redirects=True,
                headers={"User-Agent": "Thursday/0.1 (personal assistant)"},
            )
            response.raise_for_status()
        except Exception as exc:
            raise WatchError(f"could not fetch {self.target}: {exc}") from exc

        lines = readable_lines(response.text)
        if wanted := str(self.options.get("contains") or "").lower():
            lines = [line for line in lines if wanted in line.lower()]
            if not lines:
                # Nothing matched at all. Treating that as "the page changed"
                # would fire on every layout tweak, so say so once and stop.
                raise WatchError(
                    f"nothing on {self.target} contains {self.options['contains']!r}"
                )

        body = "\n".join(lines)
        fingerprint = _digest(body)
        fresh = {"fingerprint": fingerprint, "started": True}
        if not state.get("started"):
            return [], fresh
        if fingerprint == state.get("fingerprint"):
            return [], fresh
        return [Finding(self.name, f"{self.target} changed", body[:800])], fresh


BUILDERS = {
    "folder": FolderWatcher,
    "mail": MailWatcher,
    "calendar": CalendarWatcher,
    "page": PageWatcher,
}


def build(kind: str, name: str, target: str, options: dict[str, Any] | None = None) -> Watcher:
    if kind not in BUILDERS:
        raise WatchError(f"I can watch {', '.join(KINDS)} - not {kind!r}")
    return BUILDERS[kind](name, target, options)


class Watch:
    """The watchers, and the one place that decides what to do about them."""

    def __init__(self, memory: Any) -> None:
        self.memory = memory

    # ------------------------------------------------------------- managing

    def add(
        self,
        name: str,
        kind: str,
        target: str,
        action: str = "tell",
        instruction: str = "",
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if kind not in KINDS:
            raise WatchError(f"I can watch {', '.join(KINDS)} - not {kind!r}")
        if action not in ACTIONS:
            raise WatchError(f"an action is one of {', '.join(ACTIONS)}")
        if action == "run" and not instruction.strip():
            raise WatchError("tell me what to do when it fires")
        if not name.strip():
            raise WatchError("a watcher needs a name")

        # Fail here rather than every tick: a folder that does not exist is a
        # typo, and the person who can fix it is standing right there.
        probe = build(kind, name, target, options)
        probe.look({})

        self.memory.save_watcher(
            name.strip(), kind, target, action, instruction.strip(),
            json.dumps(options or {}, ensure_ascii=False),
            float(self.options_interval(kind, options)),
        )
        return self.get(name.strip())

    @staticmethod
    def options_interval(kind: str, options: dict[str, Any] | None) -> float:
        given = (options or {}).get("every_seconds")
        if given:
            return max(30.0, float(given))
        return DEFAULT_INTERVAL.get(kind, 300.0)

    def get(self, name: str) -> dict[str, Any]:
        row = self.memory.watcher(name)
        if row is None:
            raise WatchError(f"there is no watcher called {name!r}")
        return self._describe(row)

    def all(self, enabled_only: bool = False) -> list[dict[str, Any]]:
        return [self._describe(row) for row in self.memory.watchers(enabled_only)]

    def remove(self, name: str) -> None:
        if self.memory.watcher(name) is None:
            raise WatchError(f"there is no watcher called {name!r}")
        self.memory.delete_watcher(name)

    def _describe(self, row: Any) -> dict[str, Any]:
        return {
            "name": row["name"],
            "kind": row["kind"],
            "target": row["target"],
            "action": row["action"],
            "instruction": row["instruction"],
            "enabled": bool(row["enabled"]),
            "every_seconds": row["every_seconds"],
            "last_checked": row["last_checked"],
            "failures": row["failures"],
            "last_error": row["last_error"] or "",
        }

    # -------------------------------------------------------------- running

    def due(self, now: float | None = None) -> list[Any]:
        moment = time.time() if now is None else now
        return [
            row
            for row in self.memory.watchers(enabled_only=True)
            if (row["last_checked"] or 0) + (row["every_seconds"] or 300) <= moment
        ]

    def check(self, row: Any, now: float | None = None) -> list[Finding]:
        """Look once. State is written before anything is announced."""
        moment = time.time() if now is None else now
        try:
            options = json.loads(row["options"] or "{}")
        except json.JSONDecodeError:
            options = {}
        try:
            state = json.loads(row["state"] or "{}")
        except json.JSONDecodeError:
            state = {}

        watcher = build(row["kind"], row["name"], row["target"], options)
        try:
            findings, fresh = watcher.look(state)
        except WatchError as exc:
            failures = int(row["failures"] or 0) + 1
            self.memory.record_watch(
                row["name"], moment, state=None, failures=failures, error=str(exc)
            )
            if failures >= MAX_FAILURES:
                # Off, not deleted: the reason stays readable, and it can be
                # switched back on once whatever it was is fixed.
                self.memory.enable_watcher(row["name"], False)
                log.warning("switched off watcher %s after %s failures", row["name"], failures)
            return []

        # Written first, so a crash between here and the announcement costs a
        # missed message rather than an endless repeat of the same one.
        self.memory.record_watch(
            row["name"], moment, state=json.dumps(fresh, ensure_ascii=False),
            failures=0, error="",
        )
        return findings
