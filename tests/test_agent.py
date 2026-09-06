"""The agent loop, driven by a stub client so no API calls are made."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

import pytest

from thursday.agent import Agent, server_tools, supports_mid_conversation_system
from thursday.config import Settings
from thursday.events import Event
from thursday.memory import Memory
from thursday.tools import ToolContext, ToolError, ToolRegistry, tool


# --------------------------------------------------------------- stub client


@dataclass
class Block:
    type: str
    text: str = ""
    id: str = ""
    name: str = ""
    input: dict[str, Any] = field(default_factory=dict)

    def model_dump(self) -> dict[str, Any]:
        return {"type": self.type, "text": self.text, "name": self.name, "input": self.input}


@dataclass
class Reply:
    content: list[Block]
    stop_reason: str = "end_turn"
    stop_details: Any = None


class StubStream:
    def __init__(self, reply: Reply) -> None:
        self._reply = reply

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        async def events():
            for block in self._reply.content:
                if block.type == "text":
                    yield type(
                        "E",
                        (),
                        {
                            "type": "content_block_delta",
                            "delta": type("D", (), {"type": "text_delta", "text": block.text})(),
                        },
                    )()

        return events()

    async def get_final_message(self):
        return self._reply


class StubClient:
    """Returns the queued replies in order and records every request."""

    def __init__(self, replies: list[Reply]) -> None:
        self._replies = list(replies)
        self.requests: list[dict[str, Any]] = []
        self.beta = type("Beta", (), {"messages": self})()

    def stream(self, **kwargs):
        self.requests.append(kwargs)
        return StubStream(self._replies.pop(0))


def build_agent(replies, tmp_path, registry=None, **overrides):
    settings = Settings(
        workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=(), **overrides
    )
    return Agent(
        settings=settings,
        memory=Memory(":memory:"),
        registry=registry if registry is not None else ToolRegistry(),
        client=StubClient(replies),
    )


def collect(agent, text, session="t", images=None):
    events: list[Event] = []

    async def on_event(event: Event) -> None:
        events.append(event)

    reply = asyncio.run(
        agent.run(text, session_id=session, on_event=on_event, images=images)
    )
    return reply, events


# --------------------------------------------------------------------- tests


def test_plain_reply_streams_text_and_finishes(tmp_path):
    agent = build_agent([Reply([Block("text", "Good evening, sir.")])], tmp_path)
    reply, events = collect(agent, "hello")

    assert reply == "Good evening, sir."
    assert [e.text for e in events if e.type == "text"] == ["Good evening, sir."]
    assert events[-1].type == "done"


def test_tool_use_is_executed_and_fed_back(tmp_path):
    registry = ToolRegistry()

    @tool(registry=registry)
    def add(a: int, b: int) -> int:
        """Add numbers."""
        return a + b

    agent = build_agent(
        [
            Reply([Block("tool_use", id="t1", name="add", input={"a": 2, "b": 40})], "tool_use"),
            Reply([Block("text", "42, sir.")]),
        ],
        tmp_path,
        registry=registry,
    )
    reply, events = collect(agent, "what is 2 + 40")

    assert reply == "42, sir."
    assert [e.type for e in events if e.type.startswith("tool")] == ["tool_start", "tool_end"]

    # The second request must carry the tool result keyed to the tool_use id.
    second = agent.client.requests[1]["messages"]
    results = [b for m in second if isinstance(m.get("content"), list) for b in m["content"]
               if isinstance(b, dict) and b.get("type") == "tool_result"]
    assert results[0]["tool_use_id"] == "t1"
    assert results[0]["content"] == "42"


def test_failing_tool_returns_an_error_result_instead_of_crashing(tmp_path):
    registry = ToolRegistry()

    @tool(registry=registry)
    def explode() -> str:
        """Always fails."""
        raise ToolError("the reactor is offline")

    agent = build_agent(
        [
            Reply([Block("tool_use", id="t1", name="explode", input={})], "tool_use"),
            Reply([Block("text", "That did not work.")]),
        ],
        tmp_path,
        registry=registry,
    )
    reply, events = collect(agent, "explode please")

    assert reply == "That did not work."
    assert any(e.type == "tool_error" for e in events)

    results = [b for m in agent.client.requests[1]["messages"]
               if isinstance(m.get("content"), list)
               for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]
    assert results[0]["is_error"] is True
    assert "reactor is offline" in results[0]["content"]


def test_pause_turn_resumes_the_same_conversation(tmp_path):
    agent = build_agent(
        [
            Reply([Block("text", "Searching. ")], "pause_turn"),
            Reply([Block("text", "Found it.")]),
        ],
        tmp_path,
    )
    reply, _ = collect(agent, "look something up")
    assert reply == "Searching. \nFound it."
    assert len(agent.client.requests) == 2


def test_refusal_is_surfaced_not_swallowed(tmp_path):
    details = type("D", (), {"type": "refusal", "category": "cyber", "explanation": "declined"})()
    agent = build_agent([Reply([], "refusal", details)], tmp_path)
    reply, events = collect(agent, "do something forbidden")

    assert reply == "declined"
    assert any(e.type == "error" for e in events)


def test_the_tool_loop_is_bounded(tmp_path):
    registry = ToolRegistry()

    @tool(registry=registry)
    def spin() -> str:
        """Loops forever."""
        return "again"

    replies = [
        Reply([Block("tool_use", id=f"t{i}", name="spin", input={})], "tool_use") for i in range(10)
    ]
    agent = build_agent(replies, tmp_path, registry=registry, max_tool_iterations=3)
    reply, _ = collect(agent, "spin")

    assert "too many tool steps" in reply
    assert len(agent.client.requests) == 3


def test_history_is_persisted_across_runs(tmp_path):
    agent = build_agent(
        [Reply([Block("text", "One.")]), Reply([Block("text", "Two.")])], tmp_path
    )
    collect(agent, "first")
    collect(agent, "second")

    # The second request should replay the first exchange.
    roles = [m["role"] for m in agent.client.requests[1]["messages"]]
    assert roles[:3] == ["user", "assistant", "user"]


def test_the_cached_prefix_holds_no_volatile_context(tmp_path):
    agent = build_agent([Reply([Block("text", "ok")])], tmp_path)
    collect(agent, "hello")
    request = agent.client.requests[0]

    system = request["system"][0]
    assert system["cache_control"] == {"type": "ephemeral"}
    assert "Current time" not in system["text"]  # would break the cache every turn

    # ...it rides in a mid-conversation system message instead.
    assert request["messages"][-1]["role"] == "system"
    assert "Current time" in request["messages"][-1]["content"]


def test_older_models_get_the_context_folded_into_the_user_turn(tmp_path):
    agent = build_agent([Reply([Block("text", "ok")])], tmp_path, model="claude-sonnet-5")
    collect(agent, "hello")

    messages = agent.client.requests[0]["messages"]
    assert all(m["role"] != "system" for m in messages)
    assert "<context>" in messages[-1]["content"][-1]["text"]


def test_request_carries_effort_thinking_and_fallbacks(tmp_path):
    agent = build_agent([Reply([Block("text", "ok")])], tmp_path, effort="low")
    collect(agent, "hello")
    request = agent.client.requests[0]

    assert request["model"] == "claude-opus-5"
    assert request["output_config"] == {"effort": "low"}
    assert request["thinking"]["type"] == "adaptive"
    assert request["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in request["betas"]


def test_web_tools_can_be_switched_off(tmp_path):
    assert [t["name"] for t in server_tools(Settings())] == ["web_search", "web_fetch"]
    assert server_tools(Settings(enable_web_search=False)) == []


@pytest.mark.parametrize(
    ("model", "supported"),
    [("claude-opus-5", True), ("claude-opus-4-8", True), ("claude-sonnet-5", False)],
)
def test_mid_conversation_system_support(model, supported):
    assert supports_mid_conversation_system(model) is supported


def test_confirmation_handler_reaches_the_tool_context(tmp_path):
    agent = build_agent([Reply([Block("text", "ok")])], tmp_path)

    async def approve(title, detail):
        return True

    agent.set_confirm_handler(approve)
    assert asyncio.run(agent.context.request_confirmation("x", "y")) is True


def test_images_are_attached_to_the_user_turn(tmp_path):
    agent = build_agent([Reply([Block("text", "A cat, sir.")])], tmp_path)
    reply, _ = collect(agent, "what is this?", images=[("image/png", "AAAA")])

    assert reply == "A cat, sir."
    content = agent.client.requests[0]["messages"][0]["content"]
    assert content[0] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
    }
    assert content[1] == {"type": "text", "text": "what is this?"}


def test_attached_images_are_not_written_to_history(tmp_path):
    agent = build_agent(
        [Reply([Block("text", "one")]), Reply([Block("text", "two")])], tmp_path
    )
    collect(agent, "look", images=[("image/png", "A" * 5000)])
    collect(agent, "and now?")

    replayed = json.dumps(agent.client.requests[1]["messages"])
    assert "AAAAA" not in replayed
    assert "[1 image(s) attached]" in replayed


def test_an_image_returning_tool_produces_image_blocks(tmp_path):
    from thursday.tools import ImageResult

    registry = ToolRegistry()

    @tool(registry=registry)
    def grab() -> ImageResult:
        """Grab a picture."""
        return ImageResult(text="Screenshot:", images=[("image/png", "AAAA")])

    agent = build_agent(
        [
            Reply([Block("tool_use", id="t1", name="grab", input={})], "tool_use"),
            Reply([Block("text", "I see a terminal.")]),
        ],
        tmp_path,
        registry=registry,
    )
    reply, events = collect(agent, "what's on my screen")

    assert reply == "I see a terminal."
    result = next(
        block
        for message in agent.client.requests[1]["messages"]
        if isinstance(message.get("content"), list)
        for block in message["content"]
        if isinstance(block, dict) and block.get("type") == "tool_result"
    )
    assert result["content"] == [
        {"type": "text", "text": "Screenshot:"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
    ]
    # The front end is told an image went out, without the base64.
    assert next(e for e in events if e.type == "tool_end").data == {"images": 1}


def test_image_tool_results_are_stored_without_their_payload(tmp_path):
    from thursday.tools import ImageResult

    registry = ToolRegistry()

    @tool(registry=registry)
    def grab() -> ImageResult:
        """Grab a picture."""
        return ImageResult(text="Screenshot:", images=[("image/png", "B" * 5000)])

    agent = build_agent(
        [
            Reply([Block("tool_use", id="t1", name="grab", input={})], "tool_use"),
            Reply([Block("text", "done")]),
            Reply([Block("text", "still here")]),
        ],
        tmp_path,
        registry=registry,
    )
    collect(agent, "look")
    collect(agent, "again")

    replayed = json.dumps(agent.client.requests[2]["messages"])
    assert "BBBBB" not in replayed
    assert "[image omitted from history]" in replayed
