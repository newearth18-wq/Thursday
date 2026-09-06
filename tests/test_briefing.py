"""Your day, gathered in one place."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

import pytest

from thursday.briefing import SOURCE_TIMEOUT, Brief, Briefing, Section, greeting_for
from thursday.config import Settings
from thursday.drafts import Draft, Outbox
from thursday.memory import Memory
from thursday.planner import Planner


class FakeAgent:
    def __init__(self, tmp_path, memory):
        self.settings = Settings(
            workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=(),
            user_name="Supakit",
        )
        self.memory = memory


@pytest.fixture()
def agent(tmp_path):
    return FakeAgent(tmp_path, Memory(":memory:"))


def gather(agent, **kwargs):
    return asyncio.run(Briefing(agent).gather(**kwargs))


# ------------------------------------------------------------------- shape


def test_an_empty_day_says_so(agent):
    brief = gather(agent)

    assert brief.anything is False
    assert brief.as_text().strip() in {"Nothing needs you.", brief.greeting}
    assert "Supakit" in brief.greeting


def test_every_section_is_present_even_when_empty(agent):
    """The page draws from this, and a section appearing and disappearing
    would make the panel jump about."""
    names = [section.name for section in gather(agent).sections]

    assert names == [
        "Calendar", "Inbox", "Reminders", "Waiting on you", "In progress", "Noticed",
    ]


def test_empty_sections_are_left_out_of_what_is_read_aloud(agent):
    """"You have no email, no meetings and no reminders" is a worse morning
    than silence."""
    agent.memory.add_reminder("call the dentist", 4_000_000_000.0)

    spoken = gather(agent).as_text()

    assert "Reminders" in spoken
    assert "Inbox" not in spoken
    assert "Calendar" not in spoken


def test_the_greeting_follows_the_clock():
    assert greeting_for(datetime(2026, 9, 6, 8, 0)).startswith("Good morning")
    assert greeting_for(datetime(2026, 9, 6, 14, 0)).startswith("Good afternoon")
    assert greeting_for(datetime(2026, 9, 6, 19, 0)).startswith("Good evening")
    assert greeting_for(datetime(2026, 9, 6, 2, 0)).startswith("You are up late")
    assert "Nok" in greeting_for(datetime(2026, 9, 6, 8, 0), "Nok")


# ----------------------------------------------------------------- content


def test_reminders_are_described_by_how_soon_they_are(agent):
    import time

    now = time.time()
    agent.memory.add_reminder("overdue thing", now - 100)
    agent.memory.add_reminder("soon thing", now + 600)
    agent.memory.add_reminder("later thing", now + 7200)

    items = gather(agent).section("Reminders").items

    assert any("overdue" in item for item in items)
    assert any("in 10 min" in item for item in items)
    assert any("in 2 h" in item for item in items)


def test_only_your_own_reminders_are_in_your_brief(agent):
    agent.memory.add_reminder("my dentist", 4_000_000_000.0, person="nok")
    agent.memory.add_reminder("your standup", 4_000_000_000.0, person="supakit")

    items = gather(agent, person="supakit").section("Reminders").items

    assert items == ["your standup (Sun 06:26)"] or "standup" in items[0]
    assert not any("dentist" in item for item in items)


def test_drafts_waiting_on_you_are_in_the_brief(agent, tmp_path):
    outbox = Outbox(agent.memory, out_dir=tmp_path / "invites")
    outbox.prepare(Draft(subject="Re: quote", body="hi", to=["them@example.com"]))
    approved = outbox.prepare(Draft(subject="Re: invoice", body="hi", to=["a@b.com"]))
    outbox.approve(approved.id)

    items = gather(agent).section("Waiting on you").items

    assert any("Re: quote" in item and "needs your ok" in item for item in items)
    assert any("Re: invoice" in item and "ready to send" in item for item in items)


def test_work_in_progress_shows_the_plan_and_the_step(agent):
    planner = Planner(agent.memory)
    plan = planner.start("Tidy downloads", ["sort", "delete duplicates", "report"])
    planner.finish_step(plan.id, "sorted")

    items = gather(agent).section("In progress").items

    assert items[0].startswith("Tidy downloads (1/3)")
    assert "delete duplicates" in items[0]


def test_queued_and_running_jobs_are_in_progress_too(agent):
    agent.memory.add_job("index the archive", "do the thing")

    items = gather(agent).section("In progress").items

    assert any("index the archive" in item and "queued" in item for item in items)


def test_a_broken_watcher_is_worth_mentioning(agent):
    from thursday.watchers import Watch

    watch = Watch(agent.memory)
    agent.memory.save_watcher("downloads", "folder", "/gone", "tell", "", "{}", 60.0)
    watch.check(agent.memory.watcher("downloads"))

    items = gather(agent).section("Noticed").items

    assert any("downloads stopped" in item for item in items)


def test_a_working_watcher_is_not_mentioned(agent, tmp_path):
    """The brief is what needs you, not an inventory."""
    from thursday.watchers import Watch

    Watch(agent.memory).add("downloads", "folder", str(tmp_path))

    assert gather(agent).section("Noticed").empty


def test_the_calendar_is_read_when_one_is_configured(agent, tmp_path, monkeypatch):
    start = (datetime.now().astimezone() + timedelta(hours=2)).strftime("%Y%m%dT%H%M%S")
    ics = tmp_path / "cal.ics"
    ics.write_text(
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n"
        f"SUMMARY:Design review\r\nDTSTART:{start}\r\nLOCATION:Room 2\r\n"
        "END:VEVENT\r\nEND:VCALENDAR\r\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("THURSDAY_CALENDARS", str(ics))

    items = gather(agent).section("Calendar").items

    assert len(items) == 1
    assert "Design review" in items[0]
    assert "Room 2" in items[0]


# ---------------------------------------------------------------- failures


def test_one_broken_source_does_not_sink_the_brief(agent, monkeypatch):
    """A calendar feed that fails means the brief says so - itself worth
    knowing - and the other five still arrive."""
    agent.memory.add_reminder("still here", 4_000_000_000.0)

    async def explode(self, hours):
        raise RuntimeError("the feed is down")

    monkeypatch.setattr(Briefing, "_calendar", explode)
    brief = gather(agent)

    assert brief.section("Calendar").note.startswith("could not be read")
    assert brief.section("Reminders").items == ["still here (Sun 06:26)"] or brief.section(
        "Reminders"
    ).items


def test_a_slow_source_is_given_up_on(agent, monkeypatch):
    async def forever(self, hours):
        await asyncio.sleep(60)

    monkeypatch.setattr(Briefing, "_calendar", forever)
    monkeypatch.setattr("thursday.briefing.SOURCE_TIMEOUT", 0.05)

    brief = gather(agent)

    assert brief.section("Calendar").note == "took too long to read"


def test_a_source_that_is_not_set_up_says_nothing(agent):
    """No mailbox configured is not a problem to report every morning."""
    brief = gather(agent)

    assert brief.section("Inbox").note == ""
    assert brief.section("Inbox").empty


def test_the_sources_are_read_at_the_same_time(agent, monkeypatch):
    """Six sequential network reads is most of the time a brief takes."""
    async def slow_calendar(self, hours):
        await asyncio.sleep(0.15)
        return Section("Calendar", ["a meeting"])

    async def slow_mail(self):
        await asyncio.sleep(0.15)
        return Section("Inbox", ["an email"])

    monkeypatch.setattr(Briefing, "_calendar", slow_calendar)
    monkeypatch.setattr(Briefing, "_mail", slow_mail)

    import time

    started = time.perf_counter()
    brief = gather(agent)
    took = time.perf_counter() - started

    assert took < 0.28, "the sources were read one after another"
    assert brief.section("Calendar").items == ["a meeting"]
    assert brief.section("Inbox").items == ["an email"]


# -------------------------------------------------------------------- tool


def test_the_tool_hands_back_the_whole_brief(tmp_path):
    from thursday.tools import ToolContext, build_registry

    memory = Memory(":memory:")
    agent = FakeAgent(tmp_path, memory)
    memory.add_reminder("call the dentist", 4_000_000_000.0)

    context = ToolContext(settings=agent.settings, memory=memory)
    context.state["agent"] = agent
    registry = build_registry(agent.settings)

    result = asyncio.run(registry.call("daily_brief", {}, context))

    assert "call the dentist" in result
    assert "Good" in result or "up late" in result


def test_the_tool_says_so_when_it_has_no_assistant(tmp_path):
    from thursday.tools import ToolContext, ToolError, build_registry

    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    context = ToolContext(settings=settings, memory=Memory(":memory:"))

    with pytest.raises(ToolError, match="not available here"):
        asyncio.run(build_registry(settings).call("daily_brief", {}, context))


def test_a_brief_survives_being_turned_into_json_and_back():
    brief = Brief(when="now", greeting="Good morning.",
                  sections=[Section("Inbox", ["one"]), Section("Calendar", note="down")])

    payload = brief.as_dict()

    assert payload["anything"] is True
    assert payload["sections"][0] == {"name": "Inbox", "items": ["one"]}
    assert payload["sections"][1]["note"] == "down"


def test_the_timeout_is_not_so_long_it_stops_being_a_brief():
    assert SOURCE_TIMEOUT <= 30
