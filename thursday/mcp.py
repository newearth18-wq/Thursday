"""MCP client: borrow other people's tools.

An MCP server is a process (or an HTTP endpoint) that publishes tools. Wiring
them into Thursday's registry means the whole ecosystem - GitHub, Slack,
Google Drive, Postgres, Puppeteer and the rest - becomes usable without
writing a tool for each. Servers are declared in `mcp.json`:

    {
      "servers": {
        "github":     {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]},
        "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/docs"]},
        "notes":      {"url": "https://example.com/mcp"}
      }
    }

Their tools appear as `<server>_<tool>`, so a name collision with a built-in
is impossible and it stays obvious where a capability came from.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import shutil
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .tools import Tool, ToolError, ToolRegistry, stringify

log = logging.getLogger(__name__)

#: Tool names are prefixed with this and the server name.
SEPARATOR = "_"


@dataclass
class ServerSpec:
    """One MCP server, either a subprocess or a remote endpoint."""

    name: str
    command: str = ""
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    url: str = ""
    enabled: bool = True
    # Tools to expose; empty means all of them.
    tools: tuple[str, ...] = ()

    @property
    def is_remote(self) -> bool:
        return bool(self.url)

    def missing_requirement(self) -> str:
        """Why this server cannot start, if it cannot."""
        if self.is_remote:
            return ""
        if not self.command:
            return "no command and no url"
        if shutil.which(self.command) is None:
            return f"{self.command} is not on PATH"
        return ""


def load_config(paths: Iterable[Path]) -> list[ServerSpec]:
    """Read server definitions from the first mcp.json that exists."""
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("ignoring %s: %s", path, exc)
            continue

        # Accept both {"servers": {...}} and Claude Desktop's "mcpServers".
        servers = raw.get("servers") or raw.get("mcpServers") or {}
        specs: list[ServerSpec] = []
        for name, entry in servers.items():
            if not isinstance(entry, dict) or name.startswith("_"):
                continue
            specs.append(
                ServerSpec(
                    name=name,
                    command=entry.get("command", ""),
                    args=tuple(entry.get("args") or ()),
                    env={str(k): str(v) for k, v in (entry.get("env") or {}).items()},
                    url=entry.get("url", ""),
                    enabled=entry.get("enabled", True),
                    tools=tuple(entry.get("tools") or ()),
                )
            )
        return specs
    return []


def sanitise(name: str) -> str:
    """Make a name safe for a tool identifier."""
    return "".join(char if char.isalnum() or char == "_" else "_" for char in name)


def tool_name_for(server: str, tool: str) -> str:
    return f"{sanitise(server)}{SEPARATOR}{sanitise(tool)}"


def tool_schema(descriptor: Any) -> dict[str, Any] | None:
    """The tool's input schema, whichever spelling this SDK version uses."""
    return getattr(descriptor, "input_schema", None) or getattr(descriptor, "inputSchema", None)


def failed(result: Any) -> bool:
    """Whether a call reported an error, across SDK spellings."""
    flag = getattr(result, "is_error", None)
    if flag is None:
        flag = getattr(result, "isError", False)
    return bool(flag)


def result_to_text(result: Any) -> str:
    """Flatten an MCP call result into something Claude can read."""
    content = getattr(result, "content", None)
    if content is None:
        return stringify(result)

    parts: list[str] = []
    for block in content:
        kind = getattr(block, "type", None)
        if kind == "text":
            parts.append(getattr(block, "text", ""))
        elif kind == "resource":
            resource = getattr(block, "resource", None)
            text = getattr(resource, "text", None)
            parts.append(text if text else f"[resource {getattr(resource, 'uri', '')}]")
        elif kind == "image":
            # Images would need the ImageResult path; say so rather than
            # dropping it silently.
            parts.append("[the server returned an image, which is not forwarded yet]")
        else:
            parts.append(stringify(block))

    text = "\n".join(part for part in parts if part).strip()
    if failed(result):
        raise ToolError(text or "the MCP server reported an error")
    return text or "done"


class MCPManager:
    """Owns the connections and the tools they contribute."""

    def __init__(self, specs: Iterable[ServerSpec] | None = None) -> None:
        self.specs = [spec for spec in (specs or ()) if spec.enabled]
        self.sessions: dict[str, Any] = {}
        self.failures: dict[str, str] = {}
        self.tool_names: list[str] = []
        self._stack: AsyncExitStack | None = None

    @classmethod
    def from_settings(cls, settings: Any) -> "MCPManager":
        return cls(load_config(getattr(settings, "mcp_paths", ())))

    @staticmethod
    def available() -> bool:
        """Whether the `mcp` package is installed."""
        return importlib.util.find_spec("mcp") is not None

    async def connect(self, registry: ToolRegistry) -> list[str]:
        """Start every configured server and register its tools.

        A server that will not start is recorded and skipped - one broken
        entry in mcp.json must not stop the assistant from running.
        """
        if not self.specs:
            return []
        if not self.available():
            for spec in self.specs:
                self.failures[spec.name] = "the `mcp` package is not installed"
            log.warning("mcp.json lists servers but the mcp package is missing")
            return []

        self._stack = AsyncExitStack()
        for spec in self.specs:
            problem = spec.missing_requirement()
            if problem:
                self.failures[spec.name] = problem
                continue
            try:
                await self._connect_one(spec, registry)
            except Exception as exc:
                self.failures[spec.name] = str(exc)
                log.warning("MCP server %s did not start: %s", spec.name, exc)
        return self.tool_names

    async def _connect_one(self, spec: ServerSpec, registry: ToolRegistry) -> None:
        from mcp import Client, StdioServerParameters

        assert self._stack is not None
        # Client takes a URL string or stdio parameters and owns the transport.
        target: Any = spec.url
        if not spec.is_remote:
            target = StdioServerParameters(
                command=spec.command,
                args=list(spec.args),
                env={**os.environ, **spec.env} if spec.env else None,
            )

        client = await self._stack.enter_async_context(Client(target))
        self.sessions[spec.name] = client

        listing = await client.list_tools()
        for descriptor in listing.tools:
            if spec.tools and descriptor.name not in spec.tools:
                continue
            registry.add(self._wrap(spec, client, descriptor))
            self.tool_names.append(tool_name_for(spec.name, descriptor.name))

    def _wrap(self, spec: ServerSpec, client: Any, descriptor: Any) -> Tool:
        """Turn an MCP tool descriptor into one of Thursday's tools."""
        remote_name = descriptor.name

        async def call(**arguments: Any) -> str:
            result = await client.call_tool(remote_name, arguments)
            return result_to_text(result)

        schema = tool_schema(descriptor) or {"type": "object", "properties": {}}
        return Tool(
            name=tool_name_for(spec.name, remote_name),
            description=(descriptor.description or remote_name).strip(),
            schema=schema,
            func=call,
            source=f"mcp:{spec.name}",
        )

    async def close(self) -> None:
        if self._stack is not None:
            try:
                await self._stack.aclose()
            except Exception:  # a server that dies during shutdown is not news
                log.debug("error closing MCP sessions", exc_info=True)
            self._stack = None
        self.sessions.clear()

    def status(self) -> list[dict[str, Any]]:
        """What connected, what did not, and why."""
        rows = []
        for spec in self.specs:
            tools = [name for name in self.tool_names if name.startswith(sanitise(spec.name) + SEPARATOR)]
            rows.append(
                {
                    "name": spec.name,
                    "kind": "remote" if spec.is_remote else "stdio",
                    "connected": spec.name in self.sessions,
                    "tools": len(tools),
                    "problem": self.failures.get(spec.name, ""),
                }
            )
        return rows
