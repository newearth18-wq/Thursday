"""Vision, desktop control, routines and repeating reminders."""

from __future__ import annotations

import asyncio
import base64
import time
from pathlib import Path

import pytest

from thursday.agent import strip_images
from thursday.config import Settings
from thursday.memory import Memory
from thursday.server import parse_attachments
from thursday.tools import ImageResult, ToolContext, ToolError, ToolRegistry, build_registry, tool
from thursday.tools.timekeeping import REPEAT_SECONDS
from thursday.tools.vision import MEDIA_TYPES, media_type_for


@pytest.fixture()
def context(tmp_path):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    return ToolContext(settings=settings, memory=Memory(":memory:"))


@pytest.fixture()
def registry(context):
    return build_registry(context.settings)


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


# ------------------------------------------------------------------ images


def test_image_result_builds_text_and_image_blocks():
    result = ImageResult(text="Here it is:", images=[("image/png", "AAAA")])
    blocks = result.to_blocks()

    assert blocks[0] == {"type": "text", "text": "Here it is:"}
    assert blocks[1] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
    }
    assert "1 image" in result.summary()


def test_image_result_is_never_empty():
    assert ImageResult().to_blocks() == [{"type": "text", "text": "(no content)"}]


def test_a_tool_can_return_an_image():
    registry = ToolRegistry()

    @tool(registry=registry)
    def snapshot() -> ImageResult:
        """Return an image."""
        return ImageResult(text="look", images=[("image/png", "AAAA")])

    result = asyncio.run(registry.call("snapshot", {}, ToolContext()))
    # It must survive as an ImageResult - stringifying it would lose the image.
    assert isinstance(result, ImageResult)
    assert result.images == [("image/png", "AAAA")]


def test_strip_images_replaces_payloads_before_storage():
    results = [
        {
            "type": "tool_result",
            "tool_use_id": "t1",
            "content": [
                {"type": "text", "text": "Screenshot:"},
                {"type": "image", "source": {"type": "base64", "data": "x" * 100_000}},
            ],
        }
    ]
    stripped = strip_images(results)

    assert stripped[0]["content"] == [
        {"type": "text", "text": "Screenshot:"},
        {"type": "text", "text": "[image omitted from history]"},
    ]
    # The original is untouched - the live turn still needs the real pixels.
    assert results[0]["content"][1]["type"] == "image"


def test_strip_images_leaves_plain_text_results_alone():
    results = [{"type": "tool_result", "tool_use_id": "t1", "content": "42"}]
    assert strip_images(results) == results


def test_media_type_detection_and_rejection():
    assert media_type_for(Path("shot.PNG")) == "image/png"
    assert media_type_for(Path("photo.jpeg")) == "image/jpeg"
    assert set(MEDIA_TYPES.values()) >= {"image/png", "image/jpeg"}

    with pytest.raises(ToolError):
        media_type_for(Path("notes.txt"))


def test_look_at_image_rejects_a_non_image(registry, context, tmp_path):
    (tmp_path / "notes.txt").write_text("not an image", encoding="utf-8")
    with pytest.raises(ToolError):
        call(registry, "look_at_image", {"path": "notes.txt"}, context)


def test_look_at_image_reads_a_real_png(registry, context, tmp_path):
    # A 1x1 PNG, small enough that it needs no resizing.
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    (tmp_path / "dot.png").write_bytes(png)

    result = asyncio.run(registry.call("look_at_image", {"path": "dot.png"}, context))
    assert isinstance(result, ImageResult)
    assert len(result.images) == 1
    media_type, data = result.images[0]
    assert media_type in {"image/png", "image/jpeg"}
    assert base64.b64decode(data)  # round-trips as valid base64


def test_screenshot_requires_approval(registry, context):
    async def deny(title, detail):
        return False

    context.confirm = deny
    with pytest.raises(ToolError, match="declined"):
        call(registry, "take_screenshot", {}, context)


# --------------------------------------------------------------- web input


def test_attachments_are_validated_not_trusted():
    good = {"media_type": "image/png", "data": "AAAA"}

    assert parse_attachments([good]) == [("image/png", "AAAA")]
    assert parse_attachments([{"media_type": "application/pdf", "data": "AAAA"}]) == []
    assert parse_attachments([{"media_type": "image/png", "data": "x" * 8_000_000}]) == []
    assert parse_attachments([{"media_type": "image/png"}]) == []
    assert parse_attachments("not a list") == []
    assert len(parse_attachments([good] * 10)) == 4  # capped


# --------------------------------------------------------------- reminders


def test_repeating_reminder_rolls_forward_instead_of_retiring():
    memory = Memory(":memory:")
    reminder = memory.add_reminder("standup", time.time() - 5, repeat_seconds=3600)

    next_due = memory.mark_fired(reminder.id)

    assert next_due is not None and next_due > time.time()
    assert memory.due_reminders() == []          # not due again yet
    assert len(memory.pending_reminders()) == 1  # but still scheduled


def test_a_repeating_reminder_skips_missed_occurrences():
    memory = Memory(":memory:")
    # Due three hours ago on an hourly repeat: it should land in the future,
    # not fire three times in a row to catch up.
    reminder = memory.add_reminder("hydrate", time.time() - 3 * 3600, repeat_seconds=3600)

    next_due = memory.mark_fired(reminder.id)
    assert next_due > time.time()
    assert next_due - time.time() <= 3600


def test_one_shot_reminders_still_retire():
    memory = Memory(":memory:")
    reminder = memory.add_reminder("dentist", time.time() - 5)

    assert memory.mark_fired(reminder.id) is None
    assert memory.pending_reminders() == []


def test_set_reminder_accepts_a_repeat(registry, context):
    result = call(
        registry, "set_reminder", {"text": "standup", "when": "09:00", "repeat": "daily"}, context
    )
    assert '"repeat": "daily"' in result
    assert context.memory.pending_reminders()[0].repeat_seconds == REPEAT_SECONDS["daily"]


def test_set_reminder_rejects_an_unknown_repeat(registry, context):
    with pytest.raises(ToolError):
        call(registry, "set_reminder", {"text": "x", "when": "09:00", "repeat": "fortnightly"}, context)


def test_an_old_database_gains_the_repeat_column(tmp_path):
    """A database written before repeats existed must still open."""
    import sqlite3

    db = tmp_path / "old.db"
    connection = sqlite3.connect(db)
    connection.executescript(
        "CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,"
        " due_at REAL NOT NULL, created_at REAL NOT NULL, fired_at REAL);"
        "INSERT INTO reminders (text, due_at, created_at) VALUES ('legacy', 0, 0);"
    )
    connection.commit()
    connection.close()

    memory = Memory(db)
    pending = memory.pending_reminders()

    assert [r.text for r in pending] == ["legacy"]
    assert pending[0].repeat_seconds is None
    assert memory.add_reminder("new", time.time() + 60, 3600).repeat_seconds == 3600


# ---------------------------------------------------------------- routines


def test_routines_round_trip(registry, context):
    call(
        registry,
        "save_routine",
        {"name": "Morning", "instruction": "Read the weather, then my reminders."},
        context,
    )

    listed = call(registry, "list_routines", {}, context)
    assert "morning" in listed  # names are normalised to lower case

    expanded = call(registry, "run_routine", {"name": "MORNING"}, context)
    assert "Read the weather" in expanded
    assert context.memory.get_routine("morning")["uses"] == 1


def test_saving_a_routine_twice_overwrites_it(registry, context):
    call(registry, "save_routine", {"name": "x", "instruction": "first"}, context)
    call(registry, "save_routine", {"name": "x", "instruction": "second"}, context)

    assert len(context.memory.list_routines()) == 1
    assert context.memory.get_routine("x")["instruction"] == "second"


def test_running_an_unknown_routine_lists_what_exists(registry, context):
    call(registry, "save_routine", {"name": "evening", "instruction": "wind down"}, context)

    with pytest.raises(ToolError, match="evening"):
        call(registry, "run_routine", {"name": "brunch"}, context)


def test_an_empty_routine_is_refused(registry, context):
    with pytest.raises(ToolError):
        call(registry, "save_routine", {"name": "x", "instruction": "   "}, context)


def test_delete_routine(registry, context):
    call(registry, "save_routine", {"name": "x", "instruction": "do a thing"}, context)

    assert call(registry, "delete_routine", {"name": "x"}, context) == "deleted"
    assert call(registry, "delete_routine", {"name": "x"}, context) == "no such routine"


# ----------------------------------------------------------------- desktop


def test_desktop_tools_report_missing_backends_instead_of_crashing(registry, context, monkeypatch):
    import thursday.tools.desktop as desktop

    monkeypatch.setattr(desktop, "_clipboard_commands", lambda: None)

    with pytest.raises(ToolError, match="clipboard"):
        call(registry, "read_clipboard", {}, context)


def test_show_notification_reports_when_there_is_no_notifier(registry, context, monkeypatch):
    import thursday.tools.desktop as desktop

    monkeypatch.setattr(desktop, "notify_desktop", lambda *args, **kwargs: False)
    result = call(registry, "show_notification", {"title": "t", "message": "m"}, context)
    assert "no desktop notifier" in result


def test_notify_desktop_never_raises(monkeypatch):
    import thursday.notify as notify

    def explode(*args, **kwargs):
        raise OSError("no such binary")

    monkeypatch.setattr(notify.subprocess, "run", explode)
    assert notify.notify_desktop("title", "message") is False


def test_applescript_quoting_escapes_quotes():
    from thursday.notify import _applescript

    assert _applescript('say "hi"') == '"say \\"hi\\""'


def test_large_images_are_downscaled_before_sending(tmp_path):
    """Anything past 1568px on the long edge is wasted bandwidth."""
    Image = pytest.importorskip("PIL.Image")
    from thursday.tools.vision import MAX_EDGE, shrink

    source = tmp_path / "wallpaper.png"
    Image.new("RGB", (4000, 3000), "navy").save(source)

    media_type, raw = shrink(source)
    import io

    with Image.open(io.BytesIO(raw)) as shrunk:
        assert max(shrunk.size) == MAX_EDGE
    assert media_type == "image/jpeg"
    assert len(raw) < source.stat().st_size


def test_an_oversized_image_is_refused_without_pillow(tmp_path, monkeypatch):
    """No resizer available and the file is too big: say so, don't send 20 MB."""
    import builtins

    from thursday.tools.vision import shrink

    huge = tmp_path / "huge.png"
    huge.write_bytes(b"\x89PNG" + b"x" * 4_000_000)

    real_import = builtins.__import__

    def no_pillow(name, *args, **kwargs):
        if name.startswith("PIL"):
            raise ImportError("no PIL")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_pillow)

    with pytest.raises(ToolError, match="Pillow"):
        shrink(huge)
