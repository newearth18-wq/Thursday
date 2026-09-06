"""Tool registry for Thursday.

A tool is a plain Python function decorated with `@tool`. Its JSON schema is
derived from the signature and the Google-style docstring, so adding a new
capability is a matter of writing a function:

    @tool
    def flip_coin(times: int = 1) -> str:
        '''Flip a coin.

        Args:
            times: How many flips.
        '''
        ...

Functions may declare a first parameter annotated `ToolContext` to receive
settings, memory and the front end's confirmation callback; that parameter is
hidden from the schema Claude sees.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import importlib.util
import inspect
import json
import logging
import re
import sys
import types
import typing
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Literal, get_args, get_origin

log = logging.getLogger(__name__)

ConfirmFn = Callable[[str, str], Awaitable[bool]]


@dataclasses.dataclass
class ToolContext:
    """Everything a tool may need from the running assistant."""

    settings: Any = None
    memory: Any = None
    # Ask the user to approve a dangerous action. Front ends supply this.
    confirm: ConfirmFn | None = None
    # Free-form scratch space shared between tools within one process.
    state: dict[str, Any] = dataclasses.field(default_factory=dict)

    async def request_confirmation(self, title: str, detail: str) -> bool:
        if self.settings is not None and not getattr(
            self.settings, "require_confirmation", True
        ):
            return True
        if self.confirm is None:
            return False
        return await self.confirm(title, detail)


class ToolError(Exception):
    """Raised by a tool when it fails in a way Claude should see."""


@dataclasses.dataclass
class ImageResult:
    """A tool result that carries images for Claude to look at.

    The agent turns this into a `tool_result` whose content is a list of text
    and image blocks. Images are dropped before the turn is written to the
    history database - replaying base64 screenshots forever would bloat it.
    """

    text: str = ""
    # (media_type, base64 data), e.g. ("image/png", "iVBORw0...")
    images: list[tuple[str, str]] = dataclasses.field(default_factory=list)

    def to_blocks(self) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        if self.text:
            blocks.append({"type": "text", "text": self.text})
        for media_type, data in self.images:
            blocks.append(
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": data},
                }
            )
        return blocks or [{"type": "text", "text": "(no content)"}]

    def summary(self) -> str:
        """What gets shown in a front end and stored in history."""
        count = len(self.images)
        noun = "image" if count == 1 else "images"
        return f"{self.text} [{count} {noun} sent to Claude]".strip()


@dataclasses.dataclass
class Tool:
    name: str
    description: str
    schema: dict[str, Any]
    func: Callable[..., Any]
    dangerous: bool = False
    wants_context: bool = False
    source: str = "builtin"

    def to_api(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.schema,
        }

    async def invoke(self, arguments: dict[str, Any], ctx: ToolContext) -> "str | ImageResult":
        kwargs = dict(arguments)
        if self.wants_context:
            kwargs["ctx"] = ctx
        if inspect.iscoroutinefunction(self.func):
            result = await self.func(**kwargs)
        else:
            result = await asyncio.to_thread(lambda: self.func(**kwargs))
        # An ImageResult passes through untouched so the agent can build the
        # image blocks; everything else becomes text.
        return result if isinstance(result, ImageResult) else stringify(result)


def stringify(result: Any) -> str:
    if isinstance(result, str):
        return result
    if result is None:
        return "done"
    try:
        return json.dumps(result, ensure_ascii=False, indent=2, default=str)
    except TypeError:
        return str(result)


_DOC_ARG_RE = re.compile(r"^\s{0,8}(\*{0,2}\w+)\s*(?:\([^)]*\))?\s*:\s*(.+)$")


def parse_docstring(doc: str | None) -> tuple[str, dict[str, str]]:
    """Split a Google-style docstring into a summary and per-argument help."""
    if not doc:
        return "", {}
    lines = inspect.cleandoc(doc).splitlines()
    summary: list[str] = []
    args: dict[str, str] = {}
    section = "summary"
    current: str | None = None
    for line in lines:
        stripped = line.strip()
        lowered = stripped.lower().rstrip(":")
        if lowered in {"args", "arguments", "parameters"} and stripped.endswith(":"):
            section = "args"
            current = None
            continue
        if lowered in {"returns", "return", "raises", "yields", "examples", "example", "notes", "note"} and stripped.endswith(":"):
            section = "other"
            current = None
            continue
        if section == "summary":
            summary.append(line)
        elif section == "args":
            match = _DOC_ARG_RE.match(line)
            if match:
                current = match.group(1).lstrip("*")
                args[current] = match.group(2).strip()
            elif current and stripped:
                args[current] = f"{args[current]} {stripped}".strip()
    return "\n".join(summary).strip(), args


def _schema_for_annotation(annotation: Any) -> dict[str, Any]:
    """Map a type hint onto a JSON schema fragment."""
    if annotation is inspect.Parameter.empty or annotation is Any:
        return {"type": "string"}

    origin = get_origin(annotation)

    # Optional[X] / X | None -> schema of X (nullability is expressed by
    # leaving the property out of `required`).
    if origin in (typing.Union, types.UnionType):
        args = [a for a in get_args(annotation) if a is not type(None)]
        if len(args) == 1:
            return _schema_for_annotation(args[0])
        return {"anyOf": [_schema_for_annotation(a) for a in args]}

    if origin is Literal:
        options = list(get_args(annotation))
        kind = "string"
        if options and all(isinstance(o, bool) for o in options):
            kind = "boolean"
        elif options and all(isinstance(o, int) for o in options):
            kind = "integer"
        return {"type": kind, "enum": options}

    if origin in (list, set, tuple):
        args = get_args(annotation)
        item = _schema_for_annotation(args[0]) if args else {"type": "string"}
        return {"type": "array", "items": item}

    if origin is dict:
        return {"type": "object"}

    simple = {
        str: {"type": "string"},
        int: {"type": "integer"},
        float: {"type": "number"},
        bool: {"type": "boolean"},
        dict: {"type": "object"},
        list: {"type": "array", "items": {"type": "string"}},
    }
    return simple.get(annotation, {"type": "string"})


def build_schema(func: Callable[..., Any]) -> tuple[dict[str, Any], bool]:
    """Derive an input schema from a function signature and docstring."""
    signature = inspect.signature(func)
    try:
        hints = typing.get_type_hints(func)
    except Exception:  # unresolvable forward refs shouldn't break registration
        hints = {}
    _, arg_docs = parse_docstring(func.__doc__)

    properties: dict[str, Any] = {}
    required: list[str] = []
    wants_context = False

    for name, param in signature.parameters.items():
        annotation = hints.get(name, param.annotation)
        if annotation is ToolContext or name == "ctx":
            wants_context = True
            continue
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        prop = _schema_for_annotation(annotation)
        if name in arg_docs:
            prop["description"] = arg_docs[name]
        if param.default is not inspect.Parameter.empty and param.default is not None:
            prop["default"] = param.default
        properties[name] = prop
        if param.default is inspect.Parameter.empty:
            required.append(name)

    schema = {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }
    return schema, wants_context


class ToolRegistry:
    """Holds the tools available to the assistant."""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def __contains__(self, name: object) -> bool:
        return name in self._tools

    def __len__(self) -> int:
        return len(self._tools)

    def __bool__(self) -> bool:
        # An empty registry is still a registry; without this, __len__ would
        # make it falsy and `registry or fallback` would silently swap it out.
        return True

    def __iter__(self):
        return iter(self._tools.values())

    def add(self, tool_obj: Tool, *, replace: bool = True) -> Tool:
        if tool_obj.name in self._tools and not replace:
            raise ValueError(f"tool {tool_obj.name!r} is already registered")
        self._tools[tool_obj.name] = tool_obj
        return tool_obj

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return sorted(self._tools)

    def to_api(self) -> list[dict[str, Any]]:
        return [t.to_api() for t in sorted(self._tools.values(), key=lambda t: t.name)]

    def extend(self, tools: Iterable[Tool]) -> None:
        for t in tools:
            self.add(t)

    async def call(
        self, name: str, arguments: dict[str, Any], ctx: ToolContext
    ) -> "str | ImageResult":
        tool_obj = self.get(name)
        if tool_obj is None:
            raise ToolError(f"unknown tool: {name}")
        return await tool_obj.invoke(arguments, ctx)


# Tools declared with @tool land here; `build_registry` copies them out.
REGISTRY = ToolRegistry()

# While a plugin is being imported this points at the registry being built, so
# a plugin's bare `@tool` lands in the right place instead of the global one.
_ACTIVE: ToolRegistry | None = None


@contextlib.contextmanager
def registering_into(target: ToolRegistry):
    """Route bare `@tool` registrations to `target` for the duration."""
    global _ACTIVE
    previous, _ACTIVE = _ACTIVE, target
    try:
        yield target
    finally:
        _ACTIVE = previous


def tool(
    func: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
    dangerous: bool = False,
    registry: ToolRegistry | None = None,
) -> Any:
    """Register a function as a tool.

    Usage: `@tool` or `@tool(dangerous=True)`.
    """

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        summary, _ = parse_docstring(fn.__doc__)
        schema, wants_context = build_schema(fn)
        target = registry if registry is not None else (REGISTRY if _ACTIVE is None else _ACTIVE)
        target.add(
            Tool(
                name=name or fn.__name__,
                description=description or summary or fn.__name__,
                schema=schema,
                func=fn,
                dangerous=dangerous,
                wants_context=wants_context,
                source=getattr(fn, "__module__", "builtin"),
            )
        )
        return fn

    if func is not None:
        return decorate(func)
    return decorate


def load_plugins(dirs: Iterable[Path], registry: ToolRegistry | None = None) -> list[str]:
    """Import every `*.py` file in the given directories so their tools register.

    Returns the names of the modules that loaded successfully.
    """
    target = registry if registry is not None else REGISTRY
    loaded: list[str] = []
    for directory in dirs:
        directory = Path(directory)
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.py")):
            if path.name.startswith("_"):
                continue
            module_name = f"thursday_plugin_{path.stem}"
            spec = importlib.util.spec_from_file_location(module_name, path)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            before = set(target.names())
            try:
                with registering_into(target):
                    spec.loader.exec_module(module)
            except Exception:
                log.exception("failed to load plugin %s", path)
                sys.modules.pop(module_name, None)
                continue
            for new_name in set(target.names()) - before:
                found = target.get(new_name)
                if found is not None:
                    found.source = f"plugin:{path.stem}"
            loaded.append(path.stem)
    return loaded


def build_registry(settings: Any = None) -> ToolRegistry:
    """Import the built-in tool modules, load plugins, and return the registry."""
    from . import desktop, files, knowledge, routines, system, timekeeping, vision, web  # noqa: F401
    from . import shell  # noqa: F401

    registry = ToolRegistry()
    registry.extend(list(REGISTRY))

    if settings is not None:
        if not getattr(settings, "allow_shell", True):
            registry._tools.pop("run_shell", None)
        load_plugins(getattr(settings, "plugin_dirs", ()), registry)
    return registry


__all__ = [
    "REGISTRY",
    "ConfirmFn",
    "ImageResult",
    "Tool",
    "ToolContext",
    "ToolError",
    "ToolRegistry",
    "build_registry",
    "build_schema",
    "load_plugins",
    "registering_into",
    "parse_docstring",
    "stringify",
    "tool",
]
