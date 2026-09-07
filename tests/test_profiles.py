"""Profiles and routing: the right brain for the job."""

from __future__ import annotations

import asyncio
import json

import pytest

from tests.fake_openai_server import FakeServer
from thursday.agent import Agent
from thursday.config import Settings
from thursday.events import Event
from thursday.memory import Memory
from thursday.profiles import Profile, builtin_map, describe, load_profiles
from thursday.router import Router
from thursday.tools import ToolRegistry, build_registry, tool


def agent_for(tmp_path, **overrides):
    settings = Settings(
        workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=(), **overrides
    )
    return Agent(settings=settings, memory=Memory(":memory:"), registry=build_registry(settings))


# ---------------------------------------------------------------- profiles


def test_builtin_profiles_are_coherent():
    profiles = builtin_map()
    assert {"default", "quick", "deep", "coder", "private"} <= set(profiles)
    for profile in profiles.values():
        assert profile.description, f"{profile.name} needs a description for the router"
        assert profile.effort in {"", "low", "medium", "high", "xhigh", "max"}


def test_an_allow_list_limits_the_tools():
    profile = Profile(name="p", tools=("current_time", "system_status"))
    assert profile.allows("current_time") is True
    assert profile.allows("run_shell") is False
    assert profile.filter_tools(["current_time", "run_shell"]) == ["current_time"]


def test_a_deny_list_subtracts_from_everything_else():
    profile = Profile(name="p", deny_tools=("run_shell",))
    assert profile.allows("read_file") is True
    assert profile.allows("run_shell") is False


def test_the_private_profile_cannot_reach_the_network():
    private = builtin_map()["private"]
    assert private.provider == "ollama"      # pinned local, whatever else is configured
    assert private.web_search is False
    for blocked in ("fetch_url", "get_weather", "run_shell"):
        assert private.allows(blocked) is False


def test_profiles_json_patches_a_builtin_and_adds_new_ones(tmp_path):
    path = tmp_path / "profiles.json"
    path.write_text(
        json.dumps(
            {
                "quick": {"model": "claude-haiku-4-5", "effort": "low", "max_tokens": 500},
                "translator": {
                    "description": "Translate between Thai and English.",
                    "provider": "groq",
                    "model": "llama-3.3-70b-versatile",
                    "triggers": ["translate", "แปล"],
                },
            }
        ),
        encoding="utf-8",
    )
    profiles = load_profiles([path])

    assert profiles["quick"].max_tokens == 500
    assert profiles["quick"].description  # inherited from the built-in
    assert profiles["translator"].provider == "groq"
    assert profiles["translator"].triggers == ("translate", "แปล")


def test_a_broken_profiles_file_is_ignored_not_fatal(tmp_path):
    bad = tmp_path / "profiles.json"
    bad.write_text("{not json", encoding="utf-8")

    assert set(load_profiles([bad])) == set(builtin_map())


def test_describe_lists_profiles_for_the_router():
    text = describe(builtin_map())
    assert "quick:" in text and "private:" in text


# ------------------------------------------------------------------ routing


def route(router, text, **kwargs):
    return asyncio.run(router.route(text, **kwargs))


def test_keyword_routing_picks_by_trigger():
    router = Router(load_profiles(), mode="keyword")

    assert route(router, "what time is it?").name == "quick"
    assert route(router, "help me refactor this code").name == "coder"
    assert route(router, "compare these two and explain why").name == "deep"
    assert route(router, "tell me a story").name == "default"


def test_thai_triggers_route_too():
    router = Router(load_profiles(), mode="keyword")

    assert route(router, "ตอนนี้กี่โมงแล้ว").name == "quick"
    assert route(router, "อันนี้ส่วนตัวนะ").name == "private"


def test_a_profile_named_in_the_message_wins():
    router = Router(load_profiles(), mode="keyword")

    routing = route(router, "/profile deep what time is it")
    assert routing.name == "deep"  # beats the "what time" keyword
    assert routing.reason == "named in the message"
    assert route(router, "ใช้โหมด private ที").name == "private"


def test_pinning_overrides_every_heuristic():
    router = Router(load_profiles(), mode="keyword")
    router.pin("coder")

    assert route(router, "what time is it?").name == "coder"
    assert route(router, "anything at all").reason == "pinned"

    router.pin(None)
    assert route(router, "what time is it?").name == "quick"


def test_pinning_an_unknown_profile_raises():
    router = Router(load_profiles(), mode="keyword")
    with pytest.raises(KeyError):
        router.pin("nonexistent")


def test_routing_off_always_uses_the_default():
    router = Router(load_profiles(), mode="off")
    assert route(router, "what time is it?").name == "default"
    # An explicit request still works - "off" means no guessing, not no control.
    assert route(router, "hello", override="deep").name == "deep"


def test_an_explicit_override_beats_everything():
    router = Router(load_profiles(), mode="keyword")
    router.pin("coder")
    assert route(router, "what time is it?", override="deep").name == "deep"


def test_llm_routing_asks_a_model_when_keywords_miss():
    router = Router(load_profiles(), mode="llm")

    with FakeServer([{"text": "deep"}]) as server:
        from thursday.providers import build_provider

        provider = build_provider("ollama", base_url=server.base_url)
        routing = asyncio.run(router.route("ponder the nature of clouds", provider))
        asyncio.run(provider.close())

    assert routing.name == "deep"
    assert routing.reason == "classified"


def test_a_failing_classifier_falls_back_to_the_default():
    router = Router(load_profiles(), mode="llm")
    from thursday.providers import build_provider

    provider = build_provider("ollama", base_url="http://127.0.0.1:9/v1")
    routing = asyncio.run(router.route("something unclassifiable", provider))

    assert routing.name == "default"


def test_an_unrecognised_classification_is_ignored():
    router = Router(load_profiles(), mode="llm")

    with FakeServer([{"text": "banana"}]) as server:
        from thursday.providers import build_provider

        provider = build_provider("ollama", base_url=server.base_url)
        routing = asyncio.run(router.route("hmm", provider))
        asyncio.run(provider.close())

    assert routing.name == "default"


# ------------------------------------------------------- profiles in action


def test_the_profile_decides_which_tools_are_offered(tmp_path):
    agent = agent_for(tmp_path)
    quick = agent.profiles["quick"]
    provider = agent.provider_for("anthropic")

    offered = {spec["name"] for spec in agent.tool_specs(quick, provider)}
    assert "current_time" in offered
    assert "run_shell" not in offered
    assert "web_search" not in offered  # quick has web_search off


def test_the_private_profile_offers_no_network_tools(tmp_path):
    agent = agent_for(tmp_path)
    private = agent.profiles["private"]
    provider = agent.provider_for(agent.provider_name_for(private))

    offered = {spec["name"] for spec in agent.tool_specs(private, provider)}
    assert not ({"fetch_url", "get_weather", "web_search", "run_shell"} & offered)
    assert "read_file" in offered


def test_a_withheld_tool_is_refused_at_execution_too(tmp_path):
    """A model may still name a blocked tool; the loop must not run it."""
    registry = ToolRegistry()
    ran = []

    @tool(registry=registry)
    def fetch_url(url: str) -> str:
        """Fetch a page."""
        ran.append(url)
        return "content"

    turns = [
        {"tool_calls": [{"id": "c1", "name": "fetch_url", "arguments": {"url": "http://x"}}]},
        {"text": "I cannot reach the network in this profile."},
    ]
    with FakeServer(turns) as server:
        settings = Settings(
            provider="ollama",
            base_url=server.base_url,
            workspace=tmp_path,
            data_dir=tmp_path / "data",
            plugin_dirs=(),
        )
        agent = Agent(settings=settings, memory=Memory(":memory:"), registry=registry)
        events: list[Event] = []

        async def go():
            async def on_event(event: Event) -> None:
                events.append(event)

            reply = await agent.run("อันนี้ส่วนตัว fetch this", on_event=on_event)
            await agent.close()
            return reply

        reply = asyncio.run(go())

    assert ran == []  # the tool never executed
    assert any(e.type == "tool_error" and "private" in e.result for e in events)
    assert reply


def test_the_chosen_profile_is_announced(tmp_path):
    with FakeServer([{"text": "ok"}]) as server:
        settings = Settings(
            provider="ollama",
            base_url=server.base_url,
            workspace=tmp_path,
            data_dir=tmp_path / "data",
            plugin_dirs=(),
        )
        agent = Agent(settings=settings, memory=Memory(":memory:"), registry=ToolRegistry())
        events: list[Event] = []

        async def go():
            async def on_event(event: Event) -> None:
                events.append(event)

            await agent.run("hello", on_event=on_event)
            await agent.close()

        asyncio.run(go())

    announced = next(e for e in events if e.type == "profile")
    assert announced.data == {
        "profile": "default",
        "provider": "ollama",
        "model": "llama3.2",
        "reason": "default",
    }


def test_each_profile_gets_its_own_stable_system_prompt(tmp_path):
    agent = agent_for(tmp_path)

    default_system = agent.system_for(agent.profiles["default"])
    private_system = agent.system_for(agent.profiles["private"])

    assert "nothing here leaves this machine" in private_system
    assert private_system != default_system
    # Stable across calls, or prompt caching would never hit.
    assert agent.system_for(agent.profiles["private"]) == private_system
