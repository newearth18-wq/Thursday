"""The Anthropic provider - Thursday's native, first-class backend.

Everything the internal format can express survives here: thinking blocks,
server-side tools, prompt caching, mid-conversation system messages and
server-side refusal fallbacks.
"""

from __future__ import annotations

import logging
from typing import Any

import anthropic

from .base import DeltaHandler, Provider, ProviderError, TurnRequest, TurnResult

log = logging.getLogger(__name__)

# Models that accept `{"role": "system"}` entries inside `messages`.
MID_CONVERSATION_SYSTEM = (
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-mythos-5",
)

FALLBACK_BETA = "server-side-fallback-2026-07-01"


def supports_mid_conversation_system(model: str) -> bool:
    return model.startswith(MID_CONVERSATION_SYSTEM)


class AnthropicProvider(Provider):
    name = "anthropic"
    supports_server_tools = True
    supports_images = True

    def __init__(self, client: Any = None, api_key: str | None = None, base_url: str | None = None):
        if client is not None:
            self.client = client
        else:
            options: dict[str, Any] = {}
            if api_key:
                options["api_key"] = api_key
            if base_url:
                options["base_url"] = base_url
            self.client = anthropic.AsyncAnthropic(**options)

    @property
    def supports_mid_conversation_system(self) -> bool:  # type: ignore[override]
        # Model-dependent; the agent asks per request via `accepts_system_message`.
        return True

    def accepts_system_message(self, model: str) -> bool:
        return supports_mid_conversation_system(model)

    def build_kwargs(self, request: TurnRequest) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            # A stable prefix: persona and tools do not change mid-session, so
            # the cache keeps hitting and only the tail is re-read.
            "system": [
                {
                    "type": "text",
                    "text": request.system,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "messages": request.messages,
            "tools": request.tools,
            "output_config": {"effort": request.effort},
            # Claude may decline a request outright; let the server pick a
            # fallback model instead of handing the user an empty reply.
            "betas": [FALLBACK_BETA],
            "fallbacks": "default",
        }
        if request.thinking:
            kwargs["thinking"] = {
                "type": "adaptive",
                "display": "summarized" if request.show_thinking else "omitted",
            }
        return kwargs

    async def stream(self, request: TurnRequest, on_delta: DeltaHandler) -> TurnResult:
        try:
            async with self.client.beta.messages.stream(**self.build_kwargs(request)) as stream:
                async for event in stream:
                    if event.type != "content_block_delta":
                        continue
                    delta = event.delta
                    if delta.type == "text_delta" and delta.text:
                        await on_delta("text", delta.text)
                    elif delta.type == "thinking_delta" and getattr(delta, "thinking", ""):
                        await on_delta("thinking", delta.thinking)
                message = await stream.get_final_message()
        except anthropic.APIStatusError as exc:
            raise ProviderError(f"the API rejected that request ({exc.status_code}): {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError(f"could not reach the Anthropic API: {exc}") from exc

        details = getattr(message, "stop_details", None)
        return TurnResult(
            # Plain dicts, so history, other providers and the agent all speak
            # one format. exclude_none keeps the payload the API's own shape.
            content=[block.model_dump(exclude_none=True) for block in message.content],
            stop_reason=message.stop_reason or "end_turn",
            refusal_text=getattr(details, "explanation", "") or "",
            usage=message.usage.model_dump(exclude_none=True) if message.usage else {},
            model=getattr(message, "model", request.model),
        )

    async def available(self) -> tuple[bool, str]:
        import os

        if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
            return True, ""
        # The SDK also resolves `ant auth login` profiles, so absence of the
        # variables is not proof there are no credentials.
        return True, "no ANTHROPIC_API_KEY set; relying on an SDK-resolved profile"

    async def list_models(self) -> list[str]:
        try:
            page = await self.client.models.list(limit=50)
            return [model.id for model in page.data]
        except Exception as exc:  # network or auth trouble is not fatal here
            log.debug("could not list Anthropic models: %s", exc)
            return []

    async def close(self) -> None:
        close = getattr(self.client, "close", None)
        if close is not None:
            await close()
