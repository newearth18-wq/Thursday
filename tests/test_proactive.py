"""Thursday acting on its own: schedules, reminders, learning, and the service."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta

import pytest

from thursday.config import Settings
from thursday.memory import Memory
from thursday.proactive import Proactive
from thursday.schedule import Schedule, parse
from thursday.service import enable_commands, unit_path, unit_text
from thursday.tools import ToolContext, ToolError, build_registry

SUNDAY = datetime(2026, 9, 6, 7, 30).astimezone()


# ---------------------------------------------------------------- parsing


@pytest.mark.parametrize(
    ("text", "kind", "described"),
    [
        ("08:00", "clock", "every day at 08:00"),
        ("weekdays 09:15", "clock", "weekdays at 09:15"),
        ("weekends 10:00", "clock", "weekends at 10:00"),
        ("mon,thu 20:00", "clock", "mon, thu at 20:00"),
        ("every 30m", "interval", "every 30 minutes"),
        ("every 2 hours", "interval", "every 2 hours"),
    ],
)
def test_people_can_say_when_in_plain_words(text, kind, described):
    schedule = parse(text)
    assert schedule.kind == kind
    assert schedule.describe() == described


def test_something_unparseable_is_not_silently_accepted():
    assert parse("sometime soon").kind == "never"
    assert parse("").kind == "never"


def test_a_clock_time_later_today_fires_today():
    assert parse("08:00").next_after(SUNDAY) == SUNDAY.replace(hour=8, minute=0, second=0, microsecond=0)


def test_a_clock_time_already_past_waits_for_tomorrow():
    assert parse("07:00").next_after(SUNDAY).day == SUNDAY.day + 1


def test_weekday_schedules_skip_the_weekend():
    """Sunday plus 'weekdays 09:15' has to land on Monday."""
    when = parse("weekdays 09:15").next_after(SUNDAY)
    assert when.weekday() == 0
    assert (when.hour, when.minute) == (9, 15)


def test_intervals_just_add_time():
    assert parse("every 45m").next_after(SUNDAY) == SUNDAY + timedelta(minutes=45)


def test_a_schedule_that_never_fires_has_no_next_time():
    assert Schedule().next_after(SUNDAY) is None


# ----------------------------------------------------------------- storage


@pytest.fixture()
def context(tmp_path):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path, plugin_dirs=())
    return ToolContext(settings=settings, memory=Memory(":memory:"))


@pytest.fixture()
def registry(context):
    return build_registry(context.settings)


def call(registry, name, arguments, context):
    return asyncio.run(registry.call(name, arguments, context))


def test_scheduling_a_saved_routine(registry, context):
    context.memory.save_routine("morning", "Give the weather, then my reminders")

    result = call(registry, "schedule_routine", {"name": "morning", "when": "weekdays 08:00"}, context)

    assert "weekdays at 08:00" in result
    saved = context.memory.list_schedules()[0]
    assert saved["routine"] == "__routine__:morning"
    assert saved["next_run"] is not None


def test_scheduling_a_one_off_instruction(registry, context):
    call(
        registry,
        "schedule_routine",
        {"name": "hydrate", "when": "every 2 hours", "instruction": "Tell me to drink water"},
        context,
    )
    assert context.memory.list_schedules()[0]["routine"] == "Tell me to drink water"


def test_scheduling_something_with_no_routine_and_no_instruction_is_refused(registry, context):
    with pytest.raises(ToolError, match="no routine"):
        call(registry, "schedule_routine", {"name": "ghost", "when": "08:00"}, context)


def test_a_vague_time_is_refused(registry, context):
    context.memory.save_routine("morning", "do the thing")
    with pytest.raises(ToolError, match="could not understand"):
        call(registry, "schedule_routine", {"name": "morning", "when": "sometime"}, context)


def test_cancelling(registry, context):
    context.memory.save_routine("morning", "do the thing")
    call(registry, "schedule_routine", {"name": "morning", "when": "08:00"}, context)

    assert call(registry, "cancel_schedule", {"name": "morning"}, context) == "cancelled"
    assert call(registry, "cancel_schedule", {"name": "morning"}, context) == "no such schedule"


# ------------------------------------------------------------------ firing


class FakeAgent:
    """An agent that records what it was asked and answers predictably."""

    def __init__(self, memory: Memory, reflect_hours: float = 0.0, fails: bool = False) -> None:
        self.memory = memory
        self.settings = Settings(plugin_dirs=(), reflect_hours=reflect_hours)
        self.prompts: list[str] = []
        self.fails = fails

    async def run(self, text, session_id="s", on_event=None, profile=None, images=None):
        self.prompts.append(text)
        if self.fails:
            raise RuntimeError("the model is on fire")
        return "Done, sir."


def test_a_due_reminder_fires_once():
    memory = Memory(":memory:")
    memory.add_reminder("stand up", time.time() - 5)
    agent = FakeAgent(memory)
    said = []

    async def announce(kind, text):
        said.append((kind, text))

    runner = Proactive(agent, announce=announce)
    assert asyncio.run(runner.fire_reminders()) == ["stand up"]
    assert ("reminder", "stand up") in said
    assert asyncio.run(runner.fire_reminders()) == []      # not twice


def test_a_due_schedule_runs_its_routine():
    memory = Memory(":memory:")
    memory.save_routine("morning", "Give the weather")
    memory.save_schedule("morning", "__routine__:morning", "08:00", time.time() - 5)
    agent = FakeAgent(memory)

    ran = asyncio.run(Proactive(agent).run_schedules())

    assert ran == ["morning"]
    assert "Give the weather" in agent.prompts[0]


def test_a_schedule_is_moved_on_before_it_runs():
    """Otherwise a failure would fire it again every tick, forever."""
    memory = Memory(":memory:")
    memory.save_schedule("hydrate", "Drink water", "every 30m", time.time() - 5)
    agent = FakeAgent(memory, fails=True)

    asyncio.run(Proactive(agent).run_schedules())

    assert memory.due_schedules() == []
    assert memory.list_schedules()[0]["next_run"] > time.time()


def test_a_failing_scheduled_run_is_reported_not_swallowed():
    memory = Memory(":memory:")
    memory.save_schedule("hydrate", "Drink water", "every 30m", time.time() - 5)
    said = []

    async def announce(kind, text):
        said.append((kind, text))

    asyncio.run(Proactive(FakeAgent(memory, fails=True), announce=announce).run_schedules())

    assert any("failed" in text for _, text in said)


def test_a_schedule_pointing_at_a_deleted_routine_is_skipped():
    memory = Memory(":memory:")
    memory.save_schedule("morning", "__routine__:gone", "08:00", time.time() - 5)
    agent = FakeAgent(memory)

    asyncio.run(Proactive(agent).run_schedules())

    assert agent.prompts == []                       # nothing was asked
    assert memory.list_schedules()[0]["next_run"] > time.time()   # still rescheduled


def test_nothing_due_means_nothing_happens():
    memory = Memory(":memory:")
    memory.save_schedule("morning", "later", "08:00", time.time() + 3600)
    agent = FakeAgent(memory)

    asyncio.run(Proactive(agent).tick_once())
    assert agent.prompts == []


# ---------------------------------------------------------------- learning


def _fill(memory: Memory, lines: int = 12) -> None:
    for index in range(lines):
        memory.append_message(
            "cli", "user", f"I always drink a flat white before work, note {index}, padding text"
        )


def test_reflection_is_off_by_default():
    memory = Memory(":memory:")
    _fill(memory)
    agent = FakeAgent(memory)          # reflect_hours = 0

    assert asyncio.run(Proactive(agent).reflect()) == []
    assert agent.prompts == []


def test_reflection_reads_back_what_was_said():
    memory = Memory(":memory:")
    _fill(memory)
    agent = FakeAgent(memory, reflect_hours=6)

    asyncio.run(Proactive(agent).reflect())

    assert "flat white" in agent.prompts[0]
    assert "Already known" in agent.prompts[0]


def test_reflection_does_not_run_again_straight_away():
    memory = Memory(":memory:")
    _fill(memory)
    agent = FakeAgent(memory, reflect_hours=6)
    runner = Proactive(agent)

    asyncio.run(runner.reflect())
    asyncio.run(runner.reflect())

    assert len(agent.prompts) == 1


def test_reflection_skips_a_quiet_period():
    """Two lines of chat are not worth a model call."""
    memory = Memory(":memory:")
    memory.append_message("cli", "user", "hi")
    agent = FakeAgent(memory, reflect_hours=6)

    assert asyncio.run(Proactive(agent).reflect()) == []
    assert agent.prompts == []


def test_a_failed_reflection_does_not_retry_every_tick():
    memory = Memory(":memory:")
    _fill(memory)
    agent = FakeAgent(memory, reflect_hours=6, fails=True)
    runner = Proactive(agent)

    asyncio.run(runner.reflect())
    asyncio.run(runner.reflect())

    assert len(agent.prompts) == 1


def test_reflection_does_not_read_its_own_transcripts():
    memory = Memory(":memory:")
    _fill(memory)
    memory.append_message("reflection", "user", "Read this recent conversation and note anything")
    agent = FakeAgent(memory, reflect_hours=6)

    asyncio.run(Proactive(agent).reflect())

    assert "Read this recent conversation" not in agent.prompts[0].split("Conversation:")[1]


# ----------------------------------------------------------------- service


def test_the_unit_file_runs_this_interpreter():
    import sys

    text = unit_text("Thursday")
    assert sys.executable in text
    assert "thursday serve" in text


def test_the_unit_restarts_and_starts_at_login():
    import platform

    text = unit_text()
    if platform.system() == "Darwin":
        assert "RunAtLoad" in text and "KeepAlive" in text
    else:
        assert "Restart=on-failure" in text
        assert "WantedBy=default.target" in text
        # Without lingering a user service dies at logout.
        assert any("enable-linger" in " ".join(command) for command in enable_commands())


def test_the_unit_goes_where_the_platform_expects():
    import platform

    path = unit_path()
    if platform.system() == "Darwin":
        assert path.name.endswith(".plist")
    else:
        assert path.parts[-3:] == ("systemd", "user", "thursday.service")


# --------------------------------------------------------------- installable


def test_the_page_can_be_installed_on_a_phone():
    pytest.importorskip("fastapi.testclient")
    from fastapi.testclient import TestClient

    from thursday.server import create_app

    client = TestClient(create_app(Settings(plugin_dirs=())))

    manifest = client.get("/manifest.webmanifest").json()
    assert manifest["display"] == "standalone"
    assert manifest["icons"][0]["src"] == "/icon.svg"

    assert client.get("/icon.svg").status_code == 200
    assert client.get("/sw.js").status_code == 200


def test_the_service_worker_caches_nothing():
    """A cached shell would serve a stale assistant."""
    from thursday.server import SERVICE_WORKER

    assert "caches" not in SERVICE_WORKER
    assert "skipWaiting" in SERVICE_WORKER


def test_the_page_adapts_to_a_phone():
    from pathlib import Path

    page = (Path(__file__).parent.parent / "thursday" / "web" / "index.html").read_text(
        encoding="utf-8"
    )
    assert "max-width: 700px" in page
    assert "env(safe-area-inset-top)" in page      # notch
    assert "font-size: 16px" in page               # iOS zooms below 16px
    assert 'rel="manifest"' in page
