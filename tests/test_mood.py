"""What Thursday reports it is doing, and how it feels about it."""

from __future__ import annotations

import re
from pathlib import Path

from thursday.events import Event
from thursday.mood import ACTIVITIES, MOODS, MoodTracker, State, describe_tool

PAGE = Path(__file__).parent.parent / "thursday" / "web" / "index.html"


# --------------------------------------------------------------- activities


def test_known_tools_read_as_plain_english():
    assert describe_tool("take_screenshot") == "looking at your screen"
    assert describe_tool("search_history") == "searching our history"


def test_an_mcp_tool_names_its_server():
    assert describe_tool("github_create_issue") == "using create issue on github"


def test_an_unknown_bare_tool_still_says_something():
    assert describe_tool("frobnicate") == "using frobnicate"


def test_every_builtin_tool_has_a_phrase(tmp_path):
    """A tool with no phrase would show a bare identifier to the user."""
    from thursday.config import Settings
    from thursday.tools import build_registry

    registry = build_registry(Settings(workspace=tmp_path, plugin_dirs=()))
    missing = [name for name in registry.names() if name not in ACTIVITIES]
    assert missing == []


# -------------------------------------------------------------- transitions


def test_a_turn_walks_from_listening_to_pleased():
    tracker = MoodTracker()
    moods = [tracker.start_turn("hello").mood]

    for event in [
        Event("profile", data={"profile": "default", "provider": "anthropic", "model": "claude-opus-5"}),
        Event("tool_start", tool="get_weather"),
        Event("tool_end", tool="get_weather", result="sunny"),
        Event("text", text="It is sunny."),
        Event("done", text="It is sunny."),
    ]:
        state = tracker.update(event)
        if state is not None:
            moods.append(state.mood)

    assert moods == ["attentive", "thinking", "working", "thinking", "thinking", "pleased"]


def test_the_activity_says_what_the_tool_is_for():
    tracker = MoodTracker()
    state = tracker.update(Event("tool_start", tool="read_file"))

    assert state.mood == "working"
    assert state.activity == "reading a file"
    assert state.detail == "read_file"


def test_a_failure_reads_as_concern_and_survives_the_done():
    tracker = MoodTracker()
    tracker.update(Event("tool_error", tool="run_shell", result="boom"))
    final = tracker.update(Event("done", text=""))

    # Finishing after a failure must not look like success.
    assert final.mood == "concerned"


def test_cancelling_is_apologetic_not_alarmed():
    tracker = MoodTracker()
    state = tracker.update(Event("cancelled", text="half a sentence"))

    assert state.mood == "apologetic"
    assert "stopped" in state.activity


def test_an_error_carries_its_own_message():
    tracker = MoodTracker()
    state = tracker.update(Event("error", text="the API rejected that request"))

    assert state.mood == "concerned"
    assert "rejected" in state.activity


def test_unchanged_states_are_not_reemitted():
    tracker = MoodTracker()
    first = tracker.update(Event("tool_start", tool="read_file"))
    again = tracker.update(Event("tool_start", tool="read_file"))

    assert first is not None
    assert again is None  # nothing changed, so the front end is not nudged


def test_streaming_text_only_changes_state_once():
    tracker = MoodTracker()
    tracker.start_turn()
    first = tracker.update(Event("text", text="Well"))
    second = tracker.update(Event("text", text=", sir"))

    assert first.activity == "answering"
    assert second is None


def test_metering_is_not_a_mood():
    tracker = MoodTracker()
    assert tracker.update(Event("usage", data={"input": 10, "output": 2})) is None


def test_it_settles_back_to_calm():
    tracker = MoodTracker()
    tracker.update(Event("done", text="there"))
    assert tracker.state.mood == "pleased"

    assert tracker.idle().mood == "calm"
    assert tracker.idle() is None  # already calm


def test_state_serialises_for_the_socket():
    payload = State(mood="working", activity="reading a file", detail="read_file").as_dict()
    assert payload == {
        "type": "state",
        "mood": "working",
        "activity": "reading a file",
        "detail": "read_file",
    }


# ------------------------------------------------------ the page agrees


def test_the_page_draws_every_mood_the_backend_can_send():
    """A mood with no face in the page would render as a blank robot."""
    page = PAGE.read_text(encoding="utf-8")
    block = re.search(r"const MOODS = \{(.*?)\n\};", page, re.S)
    assert block, "the page should define a MOODS table"

    drawn = set(re.findall(r"^\s*(\w+):\s*\{", block.group(1), re.M))
    assert set(MOODS) == drawn


def test_the_page_has_both_views_and_the_state_handler():
    page = PAGE.read_text(encoding="utf-8")

    assert 'class="hud"' in page and 'class="stage"' in page
    assert 'case "state":' in page          # it listens for the backend's state
    assert "applyState" in page
    assert "avatar-mode" in page


def test_the_page_is_self_contained():
    """No CDN, so the HUD works on a machine with no internet."""
    page = PAGE.read_text(encoding="utf-8")

    external = re.findall(r'(?:src|href)="(https?://[^"]+)"', page)
    assert external == []
