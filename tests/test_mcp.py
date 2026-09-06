"""The MCP client, against a real server started as a subprocess."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from thursday.mcp import (
    MCPManager,
    ServerSpec,
    load_config,
    result_to_text,
    sanitise,
    tool_name_for,
)
from thursday.tools import ToolContext, ToolError, ToolRegistry

SERVER = str(Path(__file__).parent / "mcp_test_server.py")


def spec_for(**overrides) -> ServerSpec:
    defaults = dict(name="probe", command=sys.executable, args=(SERVER,))
    return ServerSpec(**{**defaults, **overrides})


# ------------------------------------------------------------------- config


def test_config_reads_both_key_spellings(tmp_path):
    """Claude Desktop writes mcpServers; the docs say servers."""
    for key in ("servers", "mcpServers"):
        path = tmp_path / f"{key}.json"
        path.write_text(
            json.dumps({key: {"files": {"command": "npx", "args": ["-y", "server-filesystem"]}}}),
            encoding="utf-8",
        )
        specs = load_config([path])
        assert [s.name for s in specs] == ["files"]
        assert specs[0].args == ("-y", "server-filesystem")


def test_config_honours_enabled_and_tool_filters(tmp_path):
    path = tmp_path / "mcp.json"
    path.write_text(
        json.dumps(
            {
                "servers": {
                    "on": {"command": "x"},
                    "off": {"command": "y", "enabled": False},
                    "some": {"command": "z", "tools": ["only_this"]},
                }
            }
        ),
        encoding="utf-8",
    )
    specs = {spec.name: spec for spec in load_config([path])}

    assert specs["off"].enabled is False
    assert specs["some"].tools == ("only_this",)
    # A disabled server is parsed but never started.
    assert [s.name for s in MCPManager(specs.values()).specs] == ["on", "some"]


def test_a_broken_config_is_ignored(tmp_path):
    bad = tmp_path / "mcp.json"
    bad.write_text("{oops", encoding="utf-8")
    assert load_config([bad]) == []


def test_missing_config_is_not_an_error(tmp_path):
    assert load_config([tmp_path / "nope.json"]) == []


def test_names_are_prefixed_and_made_safe():
    assert tool_name_for("github", "create-issue") == "github_create_issue"
    assert sanitise("a b/c") == "a_b_c"


def test_a_server_that_cannot_start_is_reported_not_raised():
    spec = ServerSpec(name="x", command="definitely-not-a-real-binary-xyz")
    assert "not on PATH" in spec.missing_requirement()

    manager = MCPManager([spec])
    names = asyncio.run(manager.connect(ToolRegistry()))

    assert names == []
    assert "not on PATH" in manager.failures["x"]
    assert manager.status()[0]["connected"] is False


def test_no_servers_configured_is_a_no_op():
    manager = MCPManager([])
    assert asyncio.run(manager.connect(ToolRegistry())) == []
    assert manager.status() == []


# ------------------------------------------------------- against a real server


# ------------------------------------------------------- against a real server


def with_server(body, spec: ServerSpec | None = None):
    """Connect, run `body(manager, registry)`, then close - all in one loop.

    MCP sessions are bound to the event loop that opened them, so connecting
    inside one asyncio.run() and calling inside another deadlocks. Front ends
    do all of this in a single loop, and so must the tests.
    """
    pytest.importorskip("mcp")

    async def go():
        manager = MCPManager([spec or spec_for()])
        registry = ToolRegistry()
        await manager.connect(registry)
        try:
            return await body(manager, registry)
        finally:
            await manager.close()

    return asyncio.run(go())


def test_tools_are_discovered_and_registered():
    async def body(manager, registry):
        return set(registry.names()), registry.get("probe_echo").source, manager.status()[0]

    names, source, status = with_server(body)

    assert names == {"probe_echo", "probe_add", "probe_explode"}
    assert source == "mcp:probe"
    assert status == {
        "name": "probe",
        "kind": "stdio",
        "connected": True,
        "tools": 3,
        "problem": "",
    }


def test_the_servers_own_schema_is_passed_through():
    async def body(manager, registry):
        return registry.get("probe_echo").schema

    schema = with_server(body)

    assert schema["properties"]["text"]["type"] == "string"
    assert schema["properties"]["times"]["default"] == 1
    assert schema["required"] == ["text"]


def test_calling_a_remote_tool():
    async def body(manager, registry):
        return (
            await registry.call("probe_echo", {"text": "sir", "times": 3}, ToolContext()),
            await registry.call("probe_add", {"a": 40, "b": 2}, ToolContext()),
        )

    echoed, added = with_server(body)

    assert echoed == "sir sir sir"
    assert added == "42"


def test_a_failing_remote_tool_becomes_a_tool_error():
    """So the agent turns it into an is_error result instead of dying."""

    async def body(manager, registry):
        with pytest.raises(ToolError):
            await registry.call("probe_explode", {}, ToolContext())
        return True

    assert with_server(body) is True


def test_only_the_listed_tools_are_exposed():
    async def body(manager, registry):
        return registry.names()

    assert with_server(body, spec_for(tools=("add",))) == ["probe_add"]


def test_mcp_tools_join_the_agents_registry(tmp_path):
    """End to end: agent.start() connects and the model is offered the tools."""
    pytest.importorskip("mcp")

    from thursday.agent import Agent
    from thursday.config import Settings
    from thursday.memory import Memory

    config = tmp_path / "mcp.json"
    config.write_text(
        json.dumps({"servers": {"probe": {"command": sys.executable, "args": [SERVER]}}}),
        encoding="utf-8",
    )
    settings = Settings(workspace=tmp_path, data_dir=tmp_path / "data", plugin_dirs=())
    # Point the agent's config lookup at the temporary file.
    settings.__class__.mcp_paths = property(lambda self: (config,))

    try:

        async def go():
            agent = Agent(settings=settings, memory=Memory(":memory:"), registry=ToolRegistry())
            names = await agent.start()
            offered = {
                spec["name"]
                for spec in agent.tool_specs(
                    agent.profiles["default"], agent.provider_for("ollama")
                )
            }
            await agent.close()
            return names, offered

        names, offered = asyncio.run(go())
    finally:
        del settings.__class__.mcp_paths

    assert "probe_add" in names
    assert "probe_add" in offered

# ------------------------------------------------------------ result parsing


class _Block:
    def __init__(self, kind, **fields):
        self.type = kind
        for key, value in fields.items():
            setattr(self, key, value)


class _Result:
    def __init__(self, content, is_error=False):
        self.content = content
        self.is_error = is_error


def test_text_blocks_are_joined():
    result = _Result([_Block("text", text="one"), _Block("text", text="two")])
    assert result_to_text(result) == "one\ntwo"


def test_an_error_result_raises():
    with pytest.raises(ToolError, match="went wrong"):
        result_to_text(_Result([_Block("text", text="went wrong")], is_error=True))


def test_the_old_error_spelling_is_still_honoured():
    """SDK v1 called it isError."""

    class Old:
        content = [_Block("text", text="broken")]
        isError = True

    with pytest.raises(ToolError):
        result_to_text(Old())


def test_an_image_result_says_so_rather_than_vanishing():
    text = result_to_text(_Result([_Block("image", data="AAA")]))
    assert "image" in text


def test_an_empty_result_is_not_empty_text():
    assert result_to_text(_Result([])) == "done"
