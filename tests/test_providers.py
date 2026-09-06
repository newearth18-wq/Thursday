"""Providers: translation, streaming, and a full turn over a real socket."""

from __future__ import annotations

import asyncio
import json

import pytest

from tests.fake_openai_server import FakeServer
from thursday.agent import Agent
from thursday.config import Settings
from thursday.events import Event
from thursday.memory import Memory
from thursday.providers import (
    ANTHROPIC,
    ProviderError,
    TurnRequest,
    build_provider,
    default_model_for,
    has_credentials,
    key_env_for,
    local_provider_names,
    provider_names,
)
from thursday.providers.openai_compat import (
    parse_arguments,
    to_openai_messages,
    to_openai_tools,
)
from thursday.tools import ToolRegistry, tool


# ------------------------------------------------------------------ registry


def test_every_provider_can_be_built():
    for name in provider_names():
        provider = build_provider(name, api_key="x", base_url="http://example.invalid/v1")
        assert provider.name


def test_local_providers_need_no_key():
    assert set(local_provider_names()) == {"ollama", "lmstudio", "llamacpp", "vllm"}
    for name in local_provider_names():
        assert has_credentials(name) is True


def test_hosted_providers_report_their_key_variable(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert key_env_for("openai") == "OPENAI_API_KEY"
    assert has_credentials("openai") is False

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    assert has_credentials("openai") is True


def test_unknown_provider_is_rejected_with_the_list():
    with pytest.raises(ProviderError, match="ollama"):
        build_provider("telepathy")


def test_a_custom_endpoint_needs_a_base_url():
    with pytest.raises(ProviderError, match="THURSDAY_BASE_URL"):
        build_provider("custom")

    provider = build_provider("custom", base_url="http://box.local:9000/v1")
    assert provider.base_url == "http://box.local:9000/v1"


def test_only_anthropic_offers_server_tools():
    assert build_provider(ANTHROPIC, api_key="x").supports_server_tools is True
    assert build_provider("ollama").supports_server_tools is False


def test_default_models():
    assert default_model_for(ANTHROPIC) == "claude-opus-5"
    assert default_model_for("ollama") == "llama3.2"


# --------------------------------------------------------------- translation


def test_tool_definitions_translate_and_server_tools_are_dropped():
    translated = to_openai_tools(
        [
            {"name": "add", "description": "Add.", "input_schema": {"type": "object"}},
            {"type": "web_search_20260209", "name": "web_search"},
        ]
    )
    assert translated == [
        {
            "type": "function",
            "function": {"name": "add", "description": "Add.", "parameters": {"type": "object"}},
        }
    ]


def test_assistant_tool_calls_translate():
    messages = to_openai_messages(
        "SYS",
        [
            {"role": "user", "content": "add them"},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "dropped - no equivalent"},
                    {"type": "text", "text": "on it"},
                    {"type": "tool_use", "id": "t1", "name": "add", "input": {"a": 1}},
                ],
            },
        ],
    )
    assistant = messages[-1]
    assert assistant["content"] == "on it"
    assert assistant["tool_calls"][0]["function"] == {"name": "add", "arguments": '{"a": 1}'}
    assert not any("thinking" in json.dumps(m) for m in messages)


def test_a_tool_call_with_no_text_sends_null_content():
    messages = to_openai_messages(
        "",
        [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "t1", "name": "x", "input": {}}],
            },
        ],
    )
    assert messages[-1]["content"] is None


def test_tool_results_become_tool_messages():
    messages = to_openai_messages(
        "",
        [
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "42"}],
            }
        ],
    )
    assert messages == [{"role": "tool", "tool_call_id": "t1", "content": "42"}]


def test_an_image_in_a_tool_result_survives_as_a_user_turn():
    """OpenAI tool messages are text-only, so the screenshot must not vanish."""
    messages = to_openai_messages(
        "",
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "t1",
                        "content": [
                            {"type": "text", "text": "Screenshot:"},
                            {"type": "image", "source": {"media_type": "image/png", "data": "AAA"}},
                        ],
                    }
                ],
            }
        ],
    )
    assert messages[0] == {"role": "tool", "tool_call_id": "t1", "content": "Screenshot:"}
    assert messages[1]["role"] == "user"
    assert messages[1]["content"][0]["image_url"]["url"] == "data:image/png;base64,AAA"


def test_images_are_dropped_with_a_note_for_a_text_only_model():
    messages = to_openai_messages(
        "",
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "what is this"},
                    {"type": "image", "source": {"media_type": "image/png", "data": "AAA"}},
                ],
            }
        ],
        supports_images=False,
    )
    assert "image(s) omitted" in messages[0]["content"]
    assert "AAA" not in json.dumps(messages)


def test_mid_conversation_context_becomes_a_system_turn():
    messages = to_openai_messages(
        "SYS", [{"role": "user", "content": "hi"}, {"role": "system", "content": "Current time: now"}]
    )
    assert messages[-1] == {"role": "system", "content": "Current time: now"}


def test_malformed_tool_arguments_do_not_crash_the_turn():
    assert parse_arguments('{"a": 1}') == {"a": 1}
    assert parse_arguments("") == {}
    assert parse_arguments("not json")["__raw_arguments"] == "not json"
    assert parse_arguments("[1, 2]") == {"value": [1, 2]}


# ------------------------------------------------------- live over a socket


def run(coro):
    return asyncio.run(coro)


def test_streaming_reassembles_split_tool_call_arguments():
    turn = {
        "text": "Adding those now.",
        "tool_calls": [{"id": "c1", "name": "add", "arguments": {"a": 1, "b": 2}}],
    }
    with FakeServer([turn]) as server:
        provider = build_provider("ollama", base_url=server.base_url)
        deltas: list[str] = []

        async def go():
            async def on_delta(kind, chunk):
                if kind == "text":
                    deltas.append(chunk)

            result = await provider.stream(
                TurnRequest(
                    model="llama3.2",
                    system="S",
                    messages=[{"role": "user", "content": "1+2"}],
                    tools=[{"name": "add", "description": "d", "input_schema": {"type": "object"}}],
                ),
                on_delta,
            )
            await provider.close()
            return result

        result = run(go())

    assert result.stop_reason == "tool_use"
    assert result.text().strip() == "Adding those now."
    # Arguments arrived in two fragments and must be one object again.
    assert result.tool_uses()[0]["input"] == {"a": 1, "b": 2}
    assert len(deltas) > 1  # it really streamed


def test_a_server_that_ignores_stream_is_still_understood():
    with FakeServer([{"text": "All done.", "no_stream": True}]) as server:
        provider = build_provider("llamacpp", base_url=server.base_url)

        async def go():
            async def on_delta(kind, chunk):
                return None

            result = await provider.stream(
                TurnRequest(model="local", system="S", messages=[{"role": "user", "content": "hi"}]),
                on_delta,
            )
            await provider.close()
            return result

        result = run(go())

    assert result.text() == "All done."
    assert result.stop_reason == "end_turn"


def test_reasoning_is_streamed_but_never_stored_as_a_block():
    with FakeServer([{"text": "Yes.", "reasoning": "let me think"}]) as server:
        provider = build_provider("deepseek", base_url=server.base_url, api_key="x")
        thoughts: list[str] = []

        async def go():
            async def on_delta(kind, chunk):
                if kind == "thinking":
                    thoughts.append(chunk)

            result = await provider.stream(
                TurnRequest(
                    model="deepseek-chat",
                    system="S",
                    messages=[{"role": "user", "content": "hi"}],
                    show_thinking=True,
                ),
                on_delta,
            )
            await provider.close()
            return result

        result = run(go())

    assert thoughts  # surfaced to the front end
    # ...but only Anthropic's thinking blocks are signed and replayable.
    assert all(block["type"] == "text" for block in result.content)


def test_an_http_error_becomes_a_readable_provider_error():
    with FakeServer([{"status": 401, "error": "bad key"}]) as server:
        provider = build_provider("openai", base_url=server.base_url, api_key="wrong")

        async def go():
            async def on_delta(kind, chunk):
                return None

            try:
                await provider.stream(
                    TurnRequest(model="gpt-4o", system="S", messages=[{"role": "user", "content": "hi"}]),
                    on_delta,
                )
            finally:
                await provider.close()

        with pytest.raises(ProviderError, match="401"):
            run(go())


def test_an_unreachable_server_says_where_it_tried():
    provider = build_provider("ollama", base_url="http://127.0.0.1:9/v1")

    async def go():
        ok, detail = await provider.available()
        await provider.close()
        return ok, detail

    ok, detail = run(go())
    assert ok is False
    assert "127.0.0.1:9" in detail
    assert "ollama serve" in detail  # the preset's setup hint


def test_the_api_key_is_sent_as_a_bearer_token():
    with FakeServer([{"text": "hi"}]) as server:
        provider = build_provider("groq", base_url=server.base_url, api_key="sk-secret")

        async def go():
            async def on_delta(kind, chunk):
                return None

            await provider.stream(
                TurnRequest(model="m", system="S", messages=[{"role": "user", "content": "hi"}]),
                on_delta,
            )
            await provider.close()

        run(go())

    assert server.headers_seen[0]["Authorization"] == "Bearer sk-secret"


def test_local_providers_send_no_authorization_header():
    with FakeServer([{"text": "hi"}]) as server:
        provider = build_provider("ollama", base_url=server.base_url)

        async def go():
            async def on_delta(kind, chunk):
                return None

            await provider.stream(
                TurnRequest(model="m", system="S", messages=[{"role": "user", "content": "hi"}]),
                on_delta,
            )
            await provider.close()

        run(go())

    assert "Authorization" not in server.headers_seen[0]


def test_openai_uses_max_completion_tokens():
    with FakeServer([{"text": "hi"}]) as server:
        provider = build_provider("openai", base_url=server.base_url, api_key="k")

        async def go():
            async def on_delta(kind, chunk):
                return None

            await provider.stream(
                TurnRequest(
                    model="gpt-4o",
                    system="S",
                    messages=[{"role": "user", "content": "hi"}],
                    max_tokens=1234,
                    effort="xhigh",
                ),
                on_delta,
            )
            await provider.close()

        run(go())

    payload = server.requests[0]
    assert payload["max_completion_tokens"] == 1234
    assert "max_tokens" not in payload
    # OpenAI only knows low/medium/high.
    assert payload["reasoning_effort"] == "high"


def test_local_servers_get_plain_max_tokens():
    with FakeServer([{"text": "hi"}]) as server:
        provider = build_provider("ollama", base_url=server.base_url)

        async def go():
            async def on_delta(kind, chunk):
                return None

            await provider.stream(
                TurnRequest(model="m", system="S", messages=[{"role": "user", "content": "hi"}], max_tokens=999),
                on_delta,
            )
            await provider.close()

        run(go())

    assert server.requests[0]["max_tokens"] == 999
    assert "reasoning_effort" not in server.requests[0]


# ------------------------------------------------- a whole turn, end to end


def test_a_full_tool_using_turn_runs_on_a_local_model(tmp_path):
    """The agent loop against a local OpenAI-compatible server, over HTTP."""
    registry = ToolRegistry()

    @tool(registry=registry)
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    turns = [
        {"tool_calls": [{"id": "c1", "name": "add", "arguments": {"a": 40, "b": 2}}]},
        {"text": "42, sir."},
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

            reply = await agent.run("what is 40 + 2", session_id="t", on_event=on_event)
            await agent.close()
            return reply

        reply = run(go())

    assert reply == "42, sir."
    assert [e.type for e in events if e.type.startswith("tool")] == ["tool_start", "tool_end"]

    chosen = next(e for e in events if e.type == "profile")
    assert chosen.data["provider"] == "ollama"

    # The second request must carry the tool result keyed to the call id.
    tool_message = next(m for m in server.requests[1]["messages"] if m["role"] == "tool")
    assert tool_message == {"role": "tool", "tool_call_id": "c1", "content": "42"}


def test_no_server_tools_are_offered_to_a_non_anthropic_provider(tmp_path):
    with FakeServer([{"text": "ok"}]) as server:
        settings = Settings(
            provider="ollama",
            base_url=server.base_url,
            workspace=tmp_path,
            data_dir=tmp_path / "data",
            plugin_dirs=(),
            enable_web_search=True,
        )
        registry = ToolRegistry()

        @tool(registry=registry)
        def ping() -> str:
            """Ping."""
            return "pong"

        agent = Agent(settings=settings, memory=Memory(":memory:"), registry=registry)

        async def go():
            await agent.run("hello", session_id="t")
            await agent.close()

        run(go())

    names = {t["function"]["name"] for t in server.requests[0].get("tools", [])}
    assert names == {"ping"}  # web_search has no meaning off Anthropic
