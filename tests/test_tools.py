"""Built-in tools: sandboxing, confirmations and parsing."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

import pytest

from thursday.config import Settings
from thursday.memory import Memory
from thursday.tools import ToolContext, ToolError, build_registry
from thursday.tools.files import resolve
from thursday.tools.shell import is_blocked
from thursday.tools.timekeeping import parse_duration, parse_when
from thursday.tools.web import html_to_text


@pytest.fixture()
def context(tmp_path):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    return ToolContext(settings=settings, memory=Memory(":memory:"))


@pytest.fixture()
def registry(context):
    return build_registry(context.settings)


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


# ------------------------------------------------------------------- files


def test_paths_outside_the_workspace_are_refused(context):
    with pytest.raises(ToolError):
        resolve(context, "/etc/passwd")
    with pytest.raises(ToolError):
        resolve(context, "../../secrets.txt")


def test_read_and_list_inside_the_workspace(registry, context, tmp_path):
    (tmp_path / "note.txt").write_text("hello sir", encoding="utf-8")

    assert "hello sir" in call(registry, "read_file", {"path": "note.txt"}, context)
    assert "note.txt" in call(registry, "list_files", {"path": "."}, context)


def test_read_file_truncates(registry, context, tmp_path):
    (tmp_path / "big.txt").write_text("x" * 5000, encoding="utf-8")
    result = call(registry, "read_file", {"path": "big.txt", "max_bytes": 100}, context)
    assert result.endswith("...(truncated)")
    assert len(result) < 200


def test_search_files_finds_matches(registry, context, tmp_path):
    (tmp_path / "a.py").write_text("import os\nsecret = 42\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("secret elsewhere\n", encoding="utf-8")

    matches = call(registry, "search_files", {"query": "secret", "pattern": "*.py"}, context)
    assert '"a.py"' in matches and "b.txt" not in matches


# ----------------------------------------------------------- confirmations


def test_write_file_requires_approval(registry, context, tmp_path):
    async def deny(title, detail):
        return False

    context.confirm = deny
    result = call(registry, "write_file", {"path": "new.txt", "content": "hi"}, context)

    assert "declined" in result
    assert not (tmp_path / "new.txt").exists()


def test_write_file_proceeds_once_approved(registry, context, tmp_path):
    asked: list[str] = []

    async def approve(title, detail):
        asked.append(title)
        return True

    context.confirm = approve
    call(registry, "write_file", {"path": "new.txt", "content": "hi"}, context)

    assert asked and (tmp_path / "new.txt").read_text(encoding="utf-8") == "hi"


def test_shell_is_refused_before_it_ever_asks(registry, context):
    async def approve(title, detail):
        raise AssertionError("a destructive command must never reach the user")

    context.confirm = approve
    result = call(registry, "run_shell", {"command": "sudo rm -rf / --no-preserve-root"}, context)
    assert "refused" in result


def test_shell_runs_after_approval(registry, context):
    async def approve(title, detail):
        return True

    context.confirm = approve
    result = call(registry, "run_shell", {"command": "echo at your service"}, context)
    assert "at your service" in result


def test_blocklist_matches_regardless_of_spacing():
    assert is_blocked("rm  -rf   /") is True
    assert is_blocked("mkfs.ext4 /dev/sdb") is True
    assert is_blocked("ls -la") is False


def test_shell_tool_is_absent_when_disabled(tmp_path):
    settings = Settings(workspace=tmp_path, allow_shell=False, plugin_dirs=())
    assert "run_shell" not in build_registry(settings)


# ----------------------------------------------------------------- timing


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        ("5 minutes", 300),
        ("1h30m", 5400),
        ("90s", 90),
        ("2 days", 172800),
        ("10 นาที", 600),
        ("2 ชั่วโมง", 7200),
        ("30 วินาที", 30),
    ],
)
def test_parse_duration(text, seconds):
    assert parse_duration(text) == seconds


def test_parse_duration_rejects_nonsense():
    assert parse_duration("whenever") is None
    assert parse_duration("5 mangoes") is None


def test_parse_when_handles_durations_and_clock_times():
    now = datetime(2026, 3, 1, 12, 0).astimezone()

    assert parse_when("in 15 minutes", now) == now + timedelta(minutes=15)
    assert parse_when("18:30", now) == now.replace(hour=18, minute=30, second=0, microsecond=0)
    # A time that has already passed today means tomorrow.
    assert parse_when("09:00", now) == now.replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=1)
    assert parse_when("sometime soon", now) is None


def test_set_reminder_persists(registry, context):
    result = call(registry, "set_reminder", {"text": "call mum", "when": "in 5 minutes"}, context)
    assert "call mum" in result
    assert [r.text for r in context.memory.pending_reminders()] == ["call mum"]


def test_set_reminder_rejects_an_unparseable_time(registry, context):
    with pytest.raises(ToolError):
        call(registry, "set_reminder", {"text": "x", "when": "at some point"}, context)


def test_current_time_reports_the_requested_zone(registry, context):
    result = call(registry, "current_time", {"timezone_name": "Asia/Bangkok"}, context)
    assert "Asia/Bangkok" in result


# ------------------------------------------------------------- knowledge


def test_facts_round_trip_through_the_tools(registry, context):
    call(registry, "remember_fact", {"key": "coffee", "value": "flat white"}, context)
    assert "flat white" in call(registry, "recall_facts", {"key": "coffee"}, context)
    assert "forgotten" in call(registry, "forget_fact", {"key": "coffee"}, context)


def test_notes_round_trip_through_the_tools(registry, context):
    call(registry, "add_note", {"title": "ideas", "body": "build a suit"}, context)
    assert "build a suit" in call(registry, "search_notes", {"query": "suit"}, context)


# ------------------------------------------------------------------- web


def test_html_to_text_drops_markup_and_scripts():
    html = "<html><head><style>b{}</style></head><body><script>x=1</script><p>Hello &amp; welcome</p></body></html>"
    assert html_to_text(html) == "Hello & welcome"
