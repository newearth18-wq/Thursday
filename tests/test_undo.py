"""Saying what would happen, and putting things back."""

from __future__ import annotations

import asyncio

import pytest

from thursday.config import Settings
from thursday.memory import Memory
from thursday.tools import ToolContext, ToolError, build_registry
from thursday.undo import KEEP_MOST_RECENT, Journal, UndoError


@pytest.fixture()
def journal(tmp_path):
    return Journal(Memory(":memory:"), tmp_path / "undo")


@pytest.fixture()
def context(tmp_path, journal):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=journal.memory)
    context.state["journal"] = journal

    async def approve(title, detail):
        return True

    context.confirm = approve
    return context


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


@pytest.fixture()
def registry(context):
    return build_registry(context.settings)


# ------------------------------------------------------------------- undo


def test_an_overwritten_file_can_be_put_back(tmp_path, registry, context, journal):
    note = tmp_path / "note.md"
    note.write_text("the original", encoding="utf-8")

    call(registry, "write_file", {"path": "note.md", "content": "the new one"}, context)
    assert note.read_text(encoding="utf-8") == "the new one"

    journal.undo()

    assert note.read_text(encoding="utf-8") == "the original"


def test_a_deleted_file_comes_back(tmp_path, registry, context, journal):
    note = tmp_path / "note.md"
    note.write_text("do not lose me", encoding="utf-8")

    call(registry, "delete_file", {"path": "note.md"}, context)
    assert not note.exists()

    journal.undo()

    assert note.read_text(encoding="utf-8") == "do not lose me"


def test_undoing_a_creation_removes_it(tmp_path, registry, context, journal):
    """There was nothing there before, so putting it back means taking it away."""
    call(registry, "write_file", {"path": "new.md", "content": "hello"}, context)
    assert (tmp_path / "new.md").exists()

    journal.undo()

    assert not (tmp_path / "new.md").exists()


def test_an_append_is_undone_to_what_was_there(tmp_path, registry, context, journal):
    note = tmp_path / "log.md"
    note.write_text("line one\n", encoding="utf-8")

    call(registry, "write_file",
         {"path": "log.md", "content": "line two\n", "append": True}, context)
    assert "line two" in note.read_text(encoding="utf-8")

    journal.undo()

    assert note.read_text(encoding="utf-8") == "line one\n"


def test_undoing_the_same_change_twice_is_refused(tmp_path, registry, context, journal):
    (tmp_path / "note.md").write_text("original", encoding="utf-8")
    call(registry, "write_file", {"path": "note.md", "content": "new"}, context)
    change_id = journal.recent()[0].id
    journal.undo(change_id)

    with pytest.raises(UndoError, match="already been put back"):
        journal.undo(change_id)

    # And with no id, an already-undone change is simply not offered again.
    with pytest.raises(UndoError, match="nothing to put back"):
        journal.undo()


def test_the_most_recent_undoable_change_is_the_default(tmp_path, registry, context, journal):
    (tmp_path / "a.md").write_text("A", encoding="utf-8")
    (tmp_path / "b.md").write_text("B", encoding="utf-8")
    call(registry, "write_file", {"path": "a.md", "content": "a2"}, context)
    call(registry, "write_file", {"path": "b.md", "content": "b2"}, context)

    journal.undo()

    assert (tmp_path / "b.md").read_text(encoding="utf-8") == "B"
    assert (tmp_path / "a.md").read_text(encoding="utf-8") == "a2"   # untouched


def test_nothing_to_undo_says_so(journal):
    with pytest.raises(UndoError, match="nothing to put back"):
        journal.undo()


def test_a_missing_backup_is_reported_not_guessed(tmp_path, registry, context, journal):
    (tmp_path / "note.md").write_text("original", encoding="utf-8")
    call(registry, "write_file", {"path": "note.md", "content": "new"}, context)
    for kept in journal.store.iterdir():
        kept.unlink()

    with pytest.raises(UndoError, match="aged out"):
        journal.undo()


def test_a_file_too_big_to_keep_is_recorded_as_not_undoable(tmp_path, journal, monkeypatch):
    """The change still happens - it just says it cannot be taken back."""
    monkeypatch.setattr("thursday.undo.MAX_KEPT_BYTES", 10)
    big = tmp_path / "big.bin"
    big.write_bytes(b"x" * 100)

    change_id = journal.before(big, "write")
    change = journal.get(change_id)

    assert change.undoable is False
    assert "too big" in change.reason
    with pytest.raises(UndoError, match="too big"):
        journal.undo(change_id)


# ------------------------------------------------------------------ dry run


def test_a_dry_run_write_changes_nothing(tmp_path, registry, context):
    note = tmp_path / "note.md"
    note.write_text("untouched", encoding="utf-8")
    context.state["dry_run"] = True

    said = call(registry, "write_file", {"path": "note.md", "content": "new"}, context)

    assert note.read_text(encoding="utf-8") == "untouched"
    assert "would overwrite" in said
    assert "Nothing was changed" in said


def test_a_dry_run_says_create_when_there_is_no_file(tmp_path, registry, context):
    context.state["dry_run"] = True

    said = call(registry, "write_file", {"path": "fresh.md", "content": "hi"}, context)

    assert "would create" in said
    assert not (tmp_path / "fresh.md").exists()


def test_a_dry_run_delete_leaves_the_file(tmp_path, registry, context):
    note = tmp_path / "note.md"
    note.write_text("still here", encoding="utf-8")
    context.state["dry_run"] = True

    said = call(registry, "delete_file", {"path": "note.md"}, context)

    assert note.exists()
    assert "would delete" in said


def test_a_dry_run_shell_command_does_not_run(tmp_path, registry, context):
    context.state["dry_run"] = True
    marker = tmp_path / "ran.txt"

    result = call(registry, "run_shell", {"command": f"touch {marker}"}, context)

    assert not marker.exists()
    assert '"ran": false' in result.lower()
    assert "would_run" in result


def test_a_dry_run_browser_action_stops_rather_than_carrying_on(context):
    """Reporting that it would not have acted, and then acting, is the one
    thing dry-run must never do - so this raises."""
    from thursday.tools.browser import Rehearsing, _approve

    context.state["dry_run"] = True

    with pytest.raises(Rehearsing, match="Nothing was done"):
        asyncio.run(_approve(context, "Open a browser page", "https://example.com"))


def test_dry_run_is_not_something_the_model_can_switch_off(registry):
    """A model that could turn off "show me what you would do first" would
    make the whole idea pointless."""
    names = {tool.name for tool in registry}

    assert "set_dry_run" not in names
    assert "dry_run" not in names


def test_nothing_is_journalled_during_a_dry_run(tmp_path, registry, context, journal):
    (tmp_path / "note.md").write_text("x", encoding="utf-8")
    context.state["dry_run"] = True

    call(registry, "write_file", {"path": "note.md", "content": "y"}, context)

    assert journal.recent() == []


# ------------------------------------------------------------------- tools


def test_the_tools_list_and_undo_a_change(tmp_path, registry, context):
    note = tmp_path / "note.md"
    note.write_text("original", encoding="utf-8")
    call(registry, "write_file", {"path": "note.md", "content": "new"}, context)

    listed = call(registry, "show_changes", {}, context)
    assert "note.md" in listed
    assert '"undoable": 1' in listed

    call(registry, "undo_change", {}, context)

    assert note.read_text(encoding="utf-8") == "original"


def test_undoing_asks_first_because_the_file_may_have_moved_on(tmp_path, registry, context):
    note = tmp_path / "note.md"
    note.write_text("original", encoding="utf-8")
    call(registry, "write_file", {"path": "note.md", "content": "new"}, context)
    note.write_text("edited by hand since", encoding="utf-8")

    asked = []

    async def decline(title, detail):
        asked.append(title)
        return False

    context.confirm = decline
    said = call(registry, "undo_change", {}, context)

    assert asked and "Undo" in asked[0]
    assert said == "the user declined to undo it"
    assert note.read_text(encoding="utf-8") == "edited by hand since"


def test_undoing_something_that_does_not_exist_says_so(registry, context):
    with pytest.raises(ToolError, match="no change 999"):
        call(registry, "undo_change", {"change_id": 999}, context)


# ------------------------------------------------------------- housekeeping


def test_old_copies_are_dropped_but_the_recent_ones_are_kept(tmp_path, journal):
    note = tmp_path / "note.md"
    note.write_text("x", encoding="utf-8")
    for _ in range(3):
        journal.before(note, "write")

    kept_before = len(list(journal.store.iterdir()))
    # Far in the future, so everything is old - but the most recent survive.
    removed = journal.tidy(now=9e9)

    assert kept_before == 3
    assert removed == 0            # all three are within KEEP_MOST_RECENT
    assert len(journal.recent()) == 3

    journal.memory._execute(
        "UPDATE changes SET created_at = 0 WHERE id IN (SELECT id FROM changes)"
    )
    assert journal.tidy(now=9e9, ) == 0    # still protected by the recent cap
    assert KEEP_MOST_RECENT > 3


def test_a_change_that_ages_out_takes_its_copy_with_it(tmp_path, journal, monkeypatch):
    monkeypatch.setattr("thursday.undo.KEEP_MOST_RECENT", 1)
    note = tmp_path / "note.md"
    note.write_text("x", encoding="utf-8")
    journal.before(note, "write")
    journal.before(note, "write")
    journal.memory._execute("UPDATE changes SET created_at = 0")

    removed = journal.tidy(now=9e9)

    assert removed == 1
    assert len(list(journal.store.iterdir())) == 1
    assert len(journal.recent()) == 1
