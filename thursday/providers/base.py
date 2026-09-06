"""The provider interface.

Thursday speaks Anthropic's message shape internally - content blocks, with
`tool_use` / `tool_result` / `image` types. It is the richest of the formats on
offer, so using it as the internal one means the Anthropic path stays lossless
and every other provider translates at its own edge instead of the core losing
information up front.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

# (kind, text) where kind is "text" or "thinking"
DeltaHandler = Callable[[str, str], Awaitable[None]]


class ProviderError(RuntimeError):
    """A provider could not complete the turn."""


@dataclass
class TurnRequest:
    """One model turn, in the internal (Anthropic-shaped) format."""

    model: str
    system: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] = field(default_factory=list)
    max_tokens: int = 16000
    # low | medium | high | xhigh | max - providers that have no equivalent
    # ignore it.
    effort: str = "medium"
    thinking: bool = True
    show_thinking: bool = False
    temperature: float | None = None


@dataclass
class TurnResult:
    """What came back, normalised to the internal format."""

    content: list[dict[str, Any]]
    # end_turn | tool_use | pause_turn | refusal | max_tokens
    stop_reason: str = "end_turn"
    refusal_text: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    model: str = ""

    def text(self) -> str:
        return "".join(
            block.get("text", "") for block in self.content if block.get("type") == "text"
        )

    def tool_uses(self) -> list[dict[str, Any]]:
        return [block for block in self.content if block.get("type") == "tool_use"]


class Provider(abc.ABC):
    """A backend that can run a turn."""

    #: Short identifier used in settings and profiles, e.g. "anthropic".
    name: str = "provider"

    #: Whether `{"role": "system"}` entries inside `messages` are accepted.
    supports_mid_conversation_system: bool = False

    #: Whether Anthropic-hosted tools (web_search, web_fetch) can be passed through.
    supports_server_tools: bool = False

    #: Whether images may be sent.
    supports_images: bool = True

    @abc.abstractmethod
    async def stream(self, request: TurnRequest, on_delta: DeltaHandler) -> TurnResult:
        """Run one turn, calling `on_delta` as text arrives."""

    async def available(self) -> tuple[bool, str]:
        """Whether this provider is usable right now, and why not if it isn't."""
        return True, ""

    async def list_models(self) -> list[str]:
        """Model ids this provider can serve, best effort."""
        return []

    async def close(self) -> None:
        """Release any connections."""


def text_block(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def tool_use_block(block_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {"type": "tool_use", "id": block_id, "name": name, "input": arguments}
