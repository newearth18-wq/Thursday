"""Events an agent run emits, so every front end can render the same run."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

EventType = Literal[
    "text",         # a chunk of the spoken/written reply
    "thinking",     # a chunk of summarised reasoning
    "tool_start",   # a tool is about to run
    "tool_end",     # a tool finished
    "tool_error",   # a tool raised
    "profile",      # which profile/model is handling this turn
    "turn_end",     # one model turn completed (more may follow)
    "usage",        # tokens and cost for a model turn
    "cancelled",    # the user stopped the turn part way
    "done",         # the whole run is complete
    "error",        # the run failed
]


@dataclass
class Event:
    type: EventType
    text: str = ""
    tool: str = ""
    arguments: dict[str, Any] = field(default_factory=dict)
    result: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"type": self.type}
        if self.text:
            payload["text"] = self.text
        if self.tool:
            payload["tool"] = self.tool
        if self.arguments:
            payload["arguments"] = self.arguments
        if self.result:
            payload["result"] = self.result
        if self.data:
            payload["data"] = self.data
        return payload


EventHandler = Callable[[Event], Awaitable[None]]


async def noop_handler(event: Event) -> None:  # pragma: no cover - trivial
    return None
