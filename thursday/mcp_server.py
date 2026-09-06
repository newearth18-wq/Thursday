"""Thursday, as an MCP server other apps can use.

Thursday has been an MCP *client* since the beginning - it can plug in
anyone's server. This is the other direction: Claude Code, Claude Desktop or
any other MCP client can reach what Thursday knows about you, without
duplicating your notes into a second place.

What is exposed is deliberately narrower than what Thursday can do. This is
Thursday's memory, not its hands: notes, facts, documents, calendar, inbox
summaries, reminders and drafts. No shell, no file writing, no browser, no
desktop control. An MCP client is another program on the far end of a pipe -
possibly one taking instructions from a web page - and there is nobody here
to approve anything it asks for.

Two things it can write, both of which are safe because of where they land:
`remember` files a fact in Thursday's memory, which you can read back and
delete; `draft_email` writes a draft, which still needs your approval in
Thursday itself before it goes anywhere.

Run it with `thursday mcp`, and point a client at that command over stdio.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from .config import Settings
from .memory import Memory

log = logging.getLogger(__name__)

INSTRUCTIONS = """\
This is Thursday, a personal assistant, exposing what it knows about its
owner. Use it to look things up rather than asking the user to repeat them:
their notes, saved facts, indexed documents, calendar, inbox and reminders.

You can file a new fact with `remember`, and write an email draft - but the
draft is not sent. Thursday's owner approves it there.

There is no shell, file writing or browser here by design.
"""


def build_server(settings: Settings | None = None) -> Any:
    """Assemble the server. Imported lazily so `mcp` stays an optional extra."""
    try:
        from mcp.server import MCPServer
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise RuntimeError(
            "the mcp package is not installed; run: pip install 'thursday[mcp]'"
        ) from exc

    config = settings or Settings.from_env()
    server = MCPServer(
        name=config.assistant_name,
        version="0.1.0",
        instructions=INSTRUCTIONS,
    )

    # One connection, one memory handle. The client holds the process open for
    # the length of the session, so opening per call would be wasteful and
    # opening at import time would create the database just by importing.
    store: dict[str, Memory] = {}

    def memory() -> Memory:
        if "memory" not in store:
            store["memory"] = Memory(config.db_path)
        return store["memory"]

    # ----------------------------------------------------------- what I know

    @server.tool()
    def search_notes(query: str, limit: int = 10) -> list[dict[str, Any]]:
        """Search the user's notes in Thursday.

        Args:
            query: Words to look for, in any language.
            limit: How many notes to return.
        """
        return memory().search_notes(query, limit)

    @server.tool()
    def recall_facts(about: str = "") -> dict[str, str]:
        """What Thursday knows about its owner: preferences, names, routines.

        Call this before asking the user something they may have already told
        Thursday.

        Args:
            about: Narrow to keys containing this. Empty returns everything.
        """
        facts = memory().all_facts()
        wanted = about.strip().lower()
        return {k: v for k, v in facts.items() if not wanted or wanted in k}

    @server.tool()
    def remember(key: str, value: str) -> str:
        """File something durable about the user in Thursday's memory.

        For preferences and standing facts, not for a passing detail. The user
        can read these back and delete them.

        Args:
            key: A short stable name, e.g. "editor" or "home_city".
            value: What to remember.
        """
        memory().remember(key, value)
        return f"remembered {key}"

    @server.tool()
    def search_history(query: str, limit: int = 10) -> list[dict[str, Any]]:
        """Search everything the user has said to Thursday.

        Useful for "what did I decide about…" and "did I already ask this".

        Args:
            query: Words to look for.
            limit: How many messages to return.
        """
        return memory().search_messages(query, limit)

    @server.tool()
    def search_documents(query: str, limit: int = 5) -> dict[str, Any]:
        """Search the user's indexed documents by meaning.

        Their PDFs, Word files, Markdown and code, if they have indexed any.

        Args:
            query: What you are looking for, in words.
            limit: How many passages to return.
        """
        from .documents import Library
        from .embeddings import Embedder
        from .permissions import Policy

        # The same policy the assistant runs under, so a document that should
        # never have been indexed cannot be reached from here either.
        library = Library(memory(), Embedder.from_env(), Policy.from_settings(config))
        hits = library.search(query, limit)
        return {"count": len(hits), "passages": [hit.as_dict() for hit in hits]}

    # -------------------------------------------------------------- my day

    @server.tool()
    def whats_on(days: int = 1) -> dict[str, Any]:
        """The user's calendar for the next day or few.

        Args:
            days: How far ahead to look.
        """
        from datetime import datetime, timedelta

        from .tools.calendar import load, parse_ics, sources, within

        feeds = sources()
        if not feeds:
            return {"configured": False, "detail": "no calendars are set up in Thursday"}
        now = datetime.now().astimezone()
        events: list[Any] = []
        for feed in feeds:
            try:
                events.extend(parse_ics(load(feed)))
            except Exception as exc:
                log.warning("could not read %s: %s", feed, exc)
        upcoming = within(events, now, now + timedelta(days=max(1, days)))
        return {
            "configured": True,
            "count": len(upcoming),
            "events": [
                {
                    "summary": event.summary,
                    "starts": str(event.start),
                    "location": event.location,
                }
                for event in upcoming
            ],
        }

    @server.tool()
    def unread_mail(limit: int = 10) -> dict[str, Any]:
        """Subjects and senders of the user's unread email.

        Read-only, and it never marks anything as read.

        Args:
            limit: How many to list.
        """
        import email
        import email.policy

        from .tools.mail import Mailbox, summarise

        mailbox = Mailbox.from_env()
        if not mailbox.configured:
            return {"configured": False, "detail": "no mailbox is set up in Thursday"}

        connection = mailbox.connect()
        try:
            connection.select(mailbox.folder, readonly=True)
            status, data = connection.search(None, "(UNSEEN)")
            ids = (data[0] or b"").split()[-max(1, limit):] if status == "OK" else []
            messages = []
            for message_id in reversed(ids):
                status, fetched = connection.fetch(message_id, "(BODY.PEEK[HEADER])")
                if status != "OK" or not fetched or not isinstance(fetched[0], tuple):
                    continue
                messages.append(
                    summarise(
                        email.message_from_bytes(fetched[0][1], policy=email.policy.default)
                    )
                )
        finally:
            try:
                connection.logout()
            except Exception:  # pragma: no cover - a socket already gone
                pass
        return {"configured": True, "count": len(messages), "messages": messages}

    @server.tool()
    def reminders() -> list[dict[str, Any]]:
        """The user's pending reminders."""
        return [reminder.as_dict() for reminder in memory().pending_reminders()]

    @server.tool()
    def current_plan() -> dict[str, Any]:
        """The long piece of work Thursday is in the middle of, if any.

        Worth checking before starting something: the user may already have
        this under way somewhere else.
        """
        from .planner import Planner

        plan = Planner(memory()).current()
        return plan.as_dict() if plan else {"open": False}

    # ------------------------------------------------------------- drafting

    @server.tool()
    def draft_email(to: str, subject: str, body: str) -> dict[str, Any]:
        """Write an email into Thursday's outbox. It is NOT sent.

        The user approves and sends it in Thursday. Nothing here can send it,
        and you cannot approve it on their behalf.

        Args:
            to: Recipients, comma separated.
            subject: The subject line.
            body: The whole message.
        """
        from .drafts import Draft, DraftError, Outbox

        outbox = Outbox(memory(), out_dir=config.data_dir / "invites")
        try:
            draft = outbox.prepare(
                Draft(
                    kind="email",
                    to=[part.strip() for part in to.replace(";", ",").split(",") if part.strip()],
                    subject=subject,
                    body=body,
                )
            )
        except DraftError as exc:
            return {"error": str(exc)}
        payload = draft.as_dict()
        payload["sent"] = False
        payload["next"] = "Waiting for the user to approve it in Thursday."
        return payload

    return server


def serve(settings: Settings | None = None) -> None:
    """Run the server over stdio, which is how MCP clients start one."""
    # The client owns stdout: anything printed there is framed as a protocol
    # message and breaks the session. Logging goes to stderr.
    logging.basicConfig(level=os.environ.get("THURSDAY_LOG", "WARNING").upper())
    build_server(settings).run("stdio")
