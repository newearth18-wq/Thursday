"""Persistence: history windows, notes, facts and reminders."""

from __future__ import annotations

import time

from thursday.memory import Memory


def test_history_round_trips_structured_content():
    memory = Memory(":memory:")
    memory.append_message("s", "user", "hello")
    memory.append_message("s", "assistant", [{"type": "text", "text": "hi"}])

    history = memory.load_history("s")
    assert history == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
    ]


def test_history_window_never_starts_on_a_tool_result():
    memory = Memory(":memory:")
    memory.append_message("s", "assistant", [{"type": "tool_use", "id": "t1", "name": "x", "input": {}}])
    memory.append_message("s", "user", [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}])
    memory.append_message("s", "assistant", [{"type": "text", "text": "done"}])

    # A window that would begin with the orphaned tool_result must drop it,
    # otherwise the API rejects the request.
    history = memory.load_history("s", limit=2)
    assert history[0]["content"] == [{"type": "text", "text": "done"}]


def test_sessions_are_isolated_and_clearable():
    memory = Memory(":memory:")
    memory.append_message("a", "user", "one")
    memory.append_message("b", "user", "two")

    assert len(memory.load_history("a")) == 1
    assert {s["session_id"] for s in memory.sessions()} == {"a", "b"}
    assert memory.clear_session("a") == 1
    assert memory.load_history("a") == []
    assert len(memory.load_history("b")) == 1


def test_facts_are_upserted_case_insensitively():
    memory = Memory(":memory:")
    memory.remember("Home_City", "Bangkok")
    memory.remember("home_city", "Chiang Mai")

    assert memory.recall("HOME_CITY") == "Chiang Mai"
    assert memory.all_facts() == {"home_city": "Chiang Mai"}
    assert memory.forget("home_city") is True
    assert memory.forget("home_city") is False


def test_notes_search_matches_title_body_and_tags():
    memory = Memory(":memory:")
    note_id = memory.add_note("Groceries", "milk and eggs", "home,errand")

    assert len(memory.search_notes("milk")) == 1
    assert len(memory.search_notes("errand")) == 1
    assert memory.search_notes("plutonium") == []
    assert memory.delete_note(note_id) is True


def test_reminders_fire_once():
    memory = Memory(":memory:")
    past = memory.add_reminder("standup", time.time() - 5)
    memory.add_reminder("later", time.time() + 3600)

    assert [r.id for r in memory.due_reminders()] == [past.id]
    assert len(memory.pending_reminders()) == 2

    memory.mark_fired(past.id)
    assert memory.due_reminders() == []
    assert [r.text for r in memory.pending_reminders()] == ["later"]


def test_cancel_reminder():
    memory = Memory(":memory:")
    reminder = memory.add_reminder("dentist", time.time() + 60)
    assert memory.cancel_reminder(reminder.id) is True
    assert memory.cancel_reminder(reminder.id) is False


def test_history_window_never_ends_on_an_unanswered_tool_use():
    memory = Memory(":memory:")
    memory.append_message("s", "user", "run something")
    # A run that died between calling a tool and writing its result.
    memory.append_message("s", "assistant", [{"type": "tool_use", "id": "t1", "name": "x", "input": {}}])

    history = memory.load_history("s")
    assert [m["role"] for m in history] == ["user"]


def test_complete_tool_exchanges_survive_the_trim():
    memory = Memory(":memory:")
    memory.append_message("s", "user", "run something")
    memory.append_message("s", "assistant", [{"type": "tool_use", "id": "t1", "name": "x", "input": {}}])
    memory.append_message("s", "user", [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}])
    memory.append_message("s", "assistant", [{"type": "text", "text": "done"}])

    assert len(memory.load_history("s")) == 4
