"""Thursday, as a server other apps can use.

Driven over a real stdio pipe against the real SDK rather than mocked, the
same way the client tests are - a protocol is exactly the thing worth not
pretending about.
"""

from __future__ import annotations

import asyncio
import json
import sys

import pytest

pytest.importorskip("mcp")

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402

from thursday.config import Settings  # noqa: E402
from thursday.memory import Memory  # noqa: E402
from thursday.mcp_server import build_server  # noqa: E402


# Everything must happen inside one event loop: an MCP session is bound to the
# loop that opened it, and calling from another deadlocks silently.
def with_server(tmp_path, work):
    """Start Thursday's MCP server as a subprocess and run `work` against it."""
    launcher = (
        "import os, sys;"
        f"os.environ['THURSDAY_DATA_DIR']={str(tmp_path / 'data')!r};"
        f"os.environ['THURSDAY_WORKSPACE']={str(tmp_path)!r};"
        "os.environ.setdefault('ANTHROPIC_API_KEY','sk-ant-test');"
        "from thursday.mcp_server import serve; serve()"
    )
    params = StdioServerParameters(command=sys.executable, args=["-c", launcher])

    async def main():
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await work(session)

    return asyncio.run(main())


def text_of(result):
    """The text an MCP tool result carries."""
    parts = []
    for block in result.content:
        if getattr(block, "type", "") == "text":
            parts.append(block.text)
    return "\n".join(parts)


@pytest.fixture()
def seeded(tmp_path):
    """A Thursday that already knows a few things."""
    memory = Memory(tmp_path / "data" / "thursday.db")
    memory.remember("home_city", "Bangkok")
    memory.remember("editor", "neovim")
    memory.add_note("ประชุมทีม", "คุยเรื่องงบประมาณ ปี 2027", "work")
    memory.add_reminder("โทรหาแม่", 4_000_000_000.0)
    memory.close()
    return tmp_path


# ---------------------------------------------------------------- the shape


def test_a_client_can_see_what_thursday_offers(tmp_path):
    async def work(session):
        return await session.list_tools()

    listed = with_server(tmp_path, work)
    names = {tool.name for tool in listed.tools}

    assert {"search_notes", "recall_facts", "search_documents", "whats_on"} <= names
    for tool in listed.tools:
        assert tool.description, f"{tool.name} has no description"


def test_the_hands_are_not_exposed(tmp_path):
    """This is Thursday's memory, not its hands. Nobody is here to approve
    anything an MCP client asks for."""
    async def work(session):
        return await session.list_tools()

    names = {tool.name for tool in with_server(tmp_path, work).tools}

    for forbidden in (
        "run_shell", "write_file", "read_file", "take_screenshot", "browse",
        "browser_act", "open_app", "lock_screen", "send_draft", "index_documents",
    ):
        assert forbidden not in names, f"{forbidden} must not be reachable over MCP"


def test_the_server_tells_a_client_what_it_is_for(tmp_path):
    async def work(session):
        return await session.initialize()

    # initialize() is called by the helper; call it again to read the result.
    result = with_server(tmp_path, work)

    assert result.instructions and "personal assistant" in result.instructions
    assert "no shell" in result.instructions.lower()


# --------------------------------------------------------------- what it knows


def test_facts_come_back_over_the_wire(seeded):
    async def work(session):
        return await session.call_tool("recall_facts", {})

    body = text_of(with_server(seeded, work))

    assert "Bangkok" in body
    assert "neovim" in body


def test_facts_can_be_narrowed(seeded):
    async def work(session):
        return await session.call_tool("recall_facts", {"about": "city"})

    body = text_of(with_server(seeded, work))

    assert "Bangkok" in body
    assert "neovim" not in body


def test_notes_are_searchable_in_thai(seeded):
    """Thai has no spaces between words, which is why the index is trigram."""
    async def work(session):
        return await session.call_tool("search_notes", {"query": "งบประมาณ"})

    body = text_of(with_server(seeded, work))

    assert "ประชุมทีม" in body


def test_a_client_can_file_something_it_learned(seeded):
    async def work(session):
        await session.call_tool("remember", {"key": "keyboard", "value": "HHKB"})
        return await session.call_tool("recall_facts", {"about": "keyboard"})

    assert "HHKB" in text_of(with_server(seeded, work))

    # And it really landed in Thursday's own memory, not somewhere temporary.
    memory = Memory(seeded / "data" / "thursday.db")
    assert memory.recall("keyboard") == "HHKB"
    memory.close()


def test_reminders_are_readable(seeded):
    async def work(session):
        return await session.call_tool("reminders", {})

    assert "โทรหาแม่" in text_of(with_server(seeded, work))


def test_an_unconfigured_calendar_says_so_rather_than_failing(tmp_path):
    async def work(session):
        return await session.call_tool("whats_on", {})

    result = with_server(tmp_path, work)

    assert not result.is_error
    assert "no calendars" in text_of(result)


def test_an_unconfigured_mailbox_says_so_rather_than_failing(tmp_path):
    async def work(session):
        return await session.call_tool("unread_mail", {})

    result = with_server(tmp_path, work)

    assert not result.is_error
    assert "no mailbox" in text_of(result)


# -------------------------------------------------------------- and drafting


def test_a_draft_written_over_mcp_is_not_sent(tmp_path):
    """The one thing that reaches other people, and it still cannot."""
    async def work(session):
        return await session.call_tool(
            "draft_email",
            {"to": "them@example.com", "subject": "Hello", "body": "hi there"},
        )

    body = text_of(with_server(tmp_path, work))
    payload = json.loads(body)

    assert payload["sent"] is False
    assert payload["status"] == "draft"
    assert "approve" in payload["next"].lower()

    # And it is waiting in Thursday, for a person.
    memory = Memory(tmp_path / "data" / "thursday.db")
    rows = memory.drafts()
    memory.close()
    assert len(rows) == 1
    assert rows[0]["status"] == "draft"


def test_a_bad_address_comes_back_as_a_message_not_a_crash(tmp_path):
    async def work(session):
        return await session.call_tool(
            "draft_email", {"to": "nonsense", "subject": "Hi", "body": "x"}
        )

    body = text_of(with_server(tmp_path, work))

    assert "email address" in body


# ------------------------------------------------------------------ plumbing


def test_the_server_builds_without_touching_the_database(tmp_path):
    """Importing or building must not create files; a client may only be
    listing what is available."""
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())

    build_server(settings)

    assert not (tmp_path / "data" / "thursday.db").exists()
