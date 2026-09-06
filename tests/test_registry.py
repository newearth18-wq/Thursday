"""The tool registry: schema generation, dispatch, plugin loading."""

from __future__ import annotations

import asyncio
from typing import Literal

import pytest

from thursday.tools import (
    ToolContext,
    ToolError,
    ToolRegistry,
    build_schema,
    load_plugins,
    parse_docstring,
    registering_into,
    stringify,
    tool,
)


def test_parse_docstring_splits_summary_and_args():
    summary, args = parse_docstring(
        """Do a thing.

        Args:
            first: The first argument.
            second: A second one
                that wraps onto another line.

        Returns:
            Nothing useful.
        """
    )
    assert summary == "Do a thing."
    assert args["first"] == "The first argument."
    assert args["second"] == "A second one that wraps onto another line."
    assert "Returns" not in args


def test_build_schema_from_signature():
    def sample(city: str, count: int = 3, unit: Literal["c", "f"] = "c", tags: list[str] | None = None):
        """Sample.

        Args:
            city: Where.
            count: How many.
        """

    schema, wants_context = build_schema(sample)
    assert wants_context is False
    assert schema["required"] == ["city"]
    assert schema["properties"]["city"] == {"type": "string", "description": "Where."}
    assert schema["properties"]["count"]["type"] == "integer"
    assert schema["properties"]["unit"]["enum"] == ["c", "f"]
    assert schema["properties"]["tags"] == {"type": "array", "items": {"type": "string"}}
    assert schema["additionalProperties"] is False


def test_context_parameter_is_hidden_from_the_schema():
    def sample(value: str, ctx: ToolContext = None):
        """Sample."""

    schema, wants_context = build_schema(sample)
    assert wants_context is True
    assert "ctx" not in schema["properties"]


def test_registry_dispatch_sync_and_async():
    registry = ToolRegistry()

    @tool(registry=registry)
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    @tool(registry=registry)
    async def greet(name: str) -> str:
        """Greet someone."""
        return f"hello {name}"

    assert registry.names() == ["add", "greet"]
    assert asyncio.run(registry.call("add", {"a": 2, "b": 3}, ToolContext())) == "5"
    assert asyncio.run(registry.call("greet", {"name": "sir"}, ToolContext())) == "hello sir"


def test_unknown_tool_raises():
    registry = ToolRegistry()
    with pytest.raises(ToolError):
        asyncio.run(registry.call("nope", {}, ToolContext()))


def test_registering_into_routes_bare_decorator():
    registry = ToolRegistry()
    with registering_into(registry):

        @tool
        def scoped() -> str:
            """Scoped tool."""
            return "ok"

    assert "scoped" in registry


def test_load_plugins_picks_up_new_tools(tmp_path):
    (tmp_path / "demo_plugin.py").write_text(
        "from thursday.tools import tool\n"
        "\n"
        "@tool\n"
        "def double(value: int) -> int:\n"
        '    """Double a number."""\n'
        "    return value * 2\n",
        encoding="utf-8",
    )
    (tmp_path / "_ignored.py").write_text("raise RuntimeError('should not run')", encoding="utf-8")
    (tmp_path / "broken.py").write_text("import nonexistent_module_xyz", encoding="utf-8")

    registry = ToolRegistry()
    loaded = load_plugins([tmp_path], registry)

    assert loaded == ["demo_plugin"]  # the broken and underscored files are skipped
    assert registry.get("double").source == "plugin:demo_plugin"
    assert asyncio.run(registry.call("double", {"value": 21}, ToolContext())) == "42"


def test_confirmation_defaults_to_denial_without_a_handler():
    context = ToolContext()
    assert asyncio.run(context.request_confirmation("Do it", "")) is False


def test_confirmation_can_be_disabled_by_settings():
    class Settings:
        require_confirmation = False

    context = ToolContext(settings=Settings())
    assert asyncio.run(context.request_confirmation("Do it", "")) is True


def test_stringify_handles_non_strings():
    assert stringify("plain") == "plain"
    assert stringify(None) == "done"
    assert '"a": 1' in stringify({"a": 1})
