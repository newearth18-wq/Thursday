"""Cancellation, metering, budgets, wake words and history search."""

from __future__ import annotations

import asyncio
import json

import pytest

from thursday.agent import Agent
from thursday.config import Settings, wake_words_for
from thursday.events import Event
from thursday.memory import Memory, plain_text
from thursday.pricing import Price, estimate_cost, format_cost, load_prices, normalise_usage
from thursday.providers.base import Provider, TurnRequest, TurnResult
from thursday.tools import ToolContext, ToolRegistry, build_registry


# ----------------------------------------------------------------- pricing


def test_cost_is_computed_from_the_table():
    usage = {"input_tokens": 1_000_000, "output_tokens": 1_000_000}
    assert estimate_cost("claude-opus-5", usage) == pytest.approx(30.0)
    assert estimate_cost("claude-haiku-4-5", usage) == pytest.approx(6.0)


def test_local_models_are_free_whatever_they_are_called():
    usage = {"prompt_tokens": 5000, "completion_tokens": 500}
    assert estimate_cost("qwen2.5:14b", usage, provider="ollama") == 0.0
    assert estimate_cost("anything", usage, provider="lmstudio") == 0.0


def test_an_unknown_model_reports_no_cost_rather_than_a_guess():
    assert estimate_cost("gpt-4o", {"prompt_tokens": 100}, provider="openai") is None
    assert format_cost(None) == "cost unknown"


def test_a_vendor_prefixed_id_still_matches():
    """OpenRouter names models like anthropic/claude-opus-5."""
    usage = {"input_tokens": 1_000_000, "output_tokens": 0}
    assert estimate_cost("anthropic/claude-opus-5", usage) == pytest.approx(5.0)


def test_both_usage_shapes_are_understood():
    assert normalise_usage({"input_tokens": 10, "output_tokens": 2})["input"] == 10
    assert normalise_usage({"prompt_tokens": 10, "completion_tokens": 2})["input"] == 10
    assert normalise_usage(None) == {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}


def test_a_pricing_file_adds_models(tmp_path):
    path = tmp_path / "pricing.json"
    path.write_text(json.dumps({"gpt-4o": {"input": 2.5, "output": 10.0}}), encoding="utf-8")

    prices = load_prices([path])
    assert prices["gpt-4o"] == Price(2.5, 10.0)
    assert "claude-opus-5" in prices  # built-ins survive

    cost = estimate_cost("gpt-4o", {"prompt_tokens": 1_000_000}, prices=prices)
    assert cost == pytest.approx(2.5)


def test_a_broken_pricing_file_is_ignored(tmp_path):
    path = tmp_path / "pricing.json"
    path.write_text('{"gpt-4o": {"input": "free"}}', encoding="utf-8")
    assert "gpt-4o" not in load_prices([path])


def test_format_cost_reads_at_a_glance():
    assert format_cost(0) == "free"
    assert format_cost(0.0004) == "$0.0004"
    assert format_cost(1.5) == "$1.50"


# ------------------------------------------------------------- fake backend


class ScriptedProvider(Provider):
    """A provider that answers from a script, slowly if asked."""

    name = "scripted"
    supports_server_tools = False
    supports_mid_conversation_system = True

    def __init__(self, text: str = "ok", usage: dict | None = None, delay: float = 0.0) -> None:
        self.text = text
        self.usage = usage or {}
        self.delay = delay
        self.calls = 0

    async def stream(self, request: TurnRequest, on_delta) -> TurnResult:
        self.calls += 1
        for word in self.text.split(" "):
            if self.delay:
                await asyncio.sleep(self.delay)
            await on_delta("text", word + " ")
        return TurnResult(
            content=[{"type": "text", "text": self.text}],
            stop_reason="end_turn",
            usage=self.usage,
            model=request.model,
        )


def agent_with(provider: ScriptedProvider, tmp_path, **overrides) -> Agent:
    settings = Settings(
        provider="ollama",  # anything non-Anthropic; the provider is injected
        workspace=tmp_path,
        data_dir=tmp_path / "data",
        plugin_dirs=(),
        **overrides,
    )
    agent = Agent(settings=settings, memory=Memory(":memory:"), registry=ToolRegistry())
    agent._providers["ollama"] = provider
    return agent


# ----------------------------------------------------------------- metering


def test_a_turn_records_its_tokens(tmp_path):
    provider = ScriptedProvider(usage={"prompt_tokens": 1200, "completion_tokens": 300})
    agent = agent_with(provider, tmp_path)

    events: list[Event] = []

    async def go():
        async def on_event(event: Event) -> None:
            events.append(event)

        await agent.run("hello", on_event=on_event)

    asyncio.run(go())

    metered = next(e for e in events if e.type == "usage")
    assert metered.data["input"] == 1200
    assert metered.data["output"] == 300
    assert metered.data["cost"] == 0.0  # a local model

    rows = agent.memory.usage_summary()
    assert rows[0]["input_tokens"] == 1200
    assert rows[0]["turns"] == 1


def test_a_provider_that_reports_nothing_records_nothing(tmp_path):
    agent = agent_with(ScriptedProvider(), tmp_path)

    asyncio.run(agent.run("hello"))

    assert agent.memory.usage_summary() == []


def test_usage_is_grouped_by_profile(tmp_path):
    agent = agent_with(ScriptedProvider(usage={"prompt_tokens": 10, "completion_tokens": 5}), tmp_path)

    async def go():
        await agent.run("hello", profile="default")
        await agent.run("what time is it", profile="quick")

    asyncio.run(go())

    by_profile = {row["key"]: row for row in agent.memory.usage_summary(group_by="profile")}
    assert set(by_profile) == {"default", "quick"}


# ------------------------------------------------------------------ budget


def test_a_turn_is_refused_once_the_daily_budget_is_spent(tmp_path):
    provider = ScriptedProvider()
    agent = agent_with(provider, tmp_path, daily_budget=1.0)
    agent.memory.record_usage("s", "default", "anthropic", "claude-opus-5", {"input": 1}, 1.50)

    reply = asyncio.run(agent.run("hello"))

    assert "budget" in reply
    assert provider.calls == 0  # the model was never called


def test_spending_under_the_budget_is_fine(tmp_path):
    provider = ScriptedProvider(text="all clear")
    agent = agent_with(provider, tmp_path, daily_budget=10.0)
    agent.memory.record_usage("s", "default", "anthropic", "claude-opus-5", {"input": 1}, 0.25)

    assert asyncio.run(agent.run("hello")) == "all clear"
    assert provider.calls == 1


def test_no_budget_means_no_ceiling(tmp_path):
    agent = agent_with(ScriptedProvider(), tmp_path, daily_budget=0.0)
    agent.memory.record_usage("s", "default", "anthropic", "claude-opus-5", {"input": 1}, 999.0)

    assert agent.over_budget() is False


# ------------------------------------------------------------ cancellation


def test_a_turn_can_be_stopped_mid_stream(tmp_path):
    agent = agent_with(ScriptedProvider(text="one two three four five", delay=0.05), tmp_path)
    events: list[Event] = []

    async def go():
        async def on_event(event: Event) -> None:
            events.append(event)
            if event.type == "text" and "two" in event.text:
                agent.cancel()

        return await agent.run("count", on_event=on_event)

    reply = asyncio.run(go())

    assert any(e.type == "cancelled" for e in events)
    # What had been said is handed back rather than thrown away.
    assert reply.startswith("one")
    assert "five" not in reply
    assert not any(e.type == "done" for e in events)


def test_cancelling_when_idle_reports_that_there_was_nothing_to_stop(tmp_path):
    agent = agent_with(ScriptedProvider(), tmp_path)
    assert agent.busy is False
    assert agent.cancel() is False


def test_a_completed_turn_is_unaffected(tmp_path):
    agent = agent_with(ScriptedProvider(text="done here"), tmp_path)
    assert asyncio.run(agent.run("hi")) == "done here"
    assert agent.cancel() is False


# ------------------------------------------------------------- wake words


def test_the_wake_word_follows_the_assistants_name(monkeypatch):
    monkeypatch.delenv("THURSDAY_WAKE_WORDS", raising=False)

    assert wake_words_for("Thursday")[0] == "thursday"
    # The stock Thai spellings only apply to the stock name.
    assert len(wake_words_for("Thursday")) > 1
    assert wake_words_for("Jarvis") == ("jarvis",)


def test_aliases_add_to_the_name_rather_than_replacing_it(monkeypatch):
    monkeypatch.setenv("THURSDAY_WAKE_WORDS", "จาวิส, JERVIS")
    assert wake_words_for("Jarvis") == ("jarvis", "จาวิส", "jervis")


def test_duplicate_wake_words_are_collapsed(monkeypatch):
    monkeypatch.setenv("THURSDAY_WAKE_WORDS", "thursday,Thursday")
    assert wake_words_for("Thursday") == ("thursday",)


def test_settings_wire_the_name_to_the_voice_loop(monkeypatch):
    monkeypatch.setenv("THURSDAY_NAME", "Athena")
    monkeypatch.delenv("THURSDAY_WAKE_WORDS", raising=False)

    settings = Settings.from_env()
    assert settings.assistant_name == "Athena"
    assert settings.voice.wake_words == ("athena",)


# ---------------------------------------------------------- history search


def test_search_finds_older_conversations():
    memory = Memory(":memory:")
    memory.append_message("old", "user", "we decided to use pgbouncer for pooling")
    memory.append_message("old", "assistant", [{"type": "text", "text": "Noted, sir."}])
    memory.append_message("new", "user", "something else entirely")

    hits = memory.search_messages("pgbouncer")
    assert len(hits) == 1
    assert hits[0]["session"] == "old"
    assert hits[0]["who"] == "you"


def test_search_can_be_scoped_to_one_conversation():
    memory = Memory(":memory:")
    memory.append_message("a", "user", "the blue folder")
    memory.append_message("b", "user", "the blue folder")

    assert len(memory.search_messages("blue")) == 2
    assert len(memory.search_messages("blue", session_id="a")) == 1


def test_search_handles_thai():
    """Thai has no spaces, so a word tokenizer would index the whole sentence."""
    memory = Memory(":memory:")
    memory.append_message("s", "user", "ร้านอาหารที่ชอบคือร้านส้มตำแถวอารีย์")

    assert memory.search_messages("ส้มตำ")
    assert memory.search_messages("อารีย์")


def test_search_matches_inside_words_and_ignores_case():
    memory = Memory(":memory:")
    memory.append_message("s", "user", "we chose PgBouncer for pooling")

    assert memory.search_messages("bouncer")
    assert memory.search_messages("POOLING")


def test_a_very_short_query_still_works():
    """Trigram indexes cannot answer these, so LIKE has to."""
    memory = Memory(":memory:")
    memory.append_message("s", "user", "the answer is 42")

    assert memory.search_messages("42")


def test_search_syntax_in_the_query_cannot_break_it():
    memory = Memory(":memory:")
    memory.append_message("s", "user", "harmless text")

    # FTS5 would choke on these if they were not quoted as literal words.
    for query in ['" OR 1=1 --', "NEAR(", "*", "AND OR NOT"]:
        assert isinstance(memory.search_messages(query), list)


def test_an_empty_query_returns_nothing():
    memory = Memory(":memory:")
    memory.append_message("s", "user", "anything")
    assert memory.search_messages("  ") == []


def test_tool_calls_are_searchable_but_base64_is_not():
    memory = Memory(":memory:")
    memory.append_message(
        "s",
        "assistant",
        [{"type": "tool_use", "id": "t1", "name": "take_screenshot", "input": {}}],
    )
    memory.append_message(
        "s",
        "user",
        [
            {
                "type": "tool_result",
                "tool_use_id": "t1",
                "content": [{"type": "image", "source": {"data": "QUFB" * 100}}],
            }
        ],
    )

    assert memory.search_messages("take_screenshot")
    assert memory.search_messages("QUFB") == []


def test_plain_text_flattens_every_block_shape():
    assert plain_text("just a string") == "just a string"
    assert plain_text([{"type": "text", "text": "hello"}]) == "hello"
    assert "read_file" in plain_text([{"type": "tool_use", "name": "read_file"}])
    assert plain_text([{"type": "image", "source": {"data": "x"}}]) == ""


def test_the_search_tool_is_registered(tmp_path):
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    registry = build_registry(settings)
    memory = Memory(":memory:")
    memory.append_message("s", "user", "the wifi password is in the drawer")

    context = ToolContext(settings=settings, memory=memory, state={"session_id": "s"})
    result = asyncio.run(registry.call("search_history", {"query": "wifi"}, context))

    assert "drawer" in result


def test_history_search_survives_a_database_without_fts(tmp_path, monkeypatch):
    """SQLite can be built without FTS5; search must degrade, not disappear."""
    memory = Memory(tmp_path / "m.db")
    memory.append_message("s", "user", "the fallback path works")
    memory.search_available = False

    hits = memory.search_messages("fallback")
    assert hits and "fallback" in hits[0]["text"]
