"""The agent loop: Claude plus Thursday's tools.

A manual loop rather than the SDK's tool runner, because Thursday needs to
stream tokens to speech as they arrive, run a registry that plugins mutate at
runtime, and route confirmation prompts back to whichever front end is
attached.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

import anthropic

from .config import Settings
from .events import Event, EventHandler
from .memory import Memory
from .persona import situational_context, system_prompt
from .tools import ImageResult, ToolContext, ToolError, ToolRegistry, build_registry

log = logging.getLogger(__name__)

# Models that accept `{"role": "system"}` entries inside `messages`.
MID_CONVERSATION_SYSTEM = ("claude-opus-5", "claude-opus-4-8", "claude-fable-5", "claude-mythos-5")

FALLBACK_BETA = "server-side-fallback-2026-07-01"


def supports_mid_conversation_system(model: str) -> bool:
    return model.startswith(MID_CONVERSATION_SYSTEM)


def server_tools(settings: Settings) -> list[dict[str, Any]]:
    """Anthropic-hosted tools. They run server-side - nothing to execute here."""
    if not settings.enable_web_search:
        return []
    return [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": 6},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 6},
    ]


def strip_images(tool_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Replace image blocks with a placeholder before writing to history.

    Claude sees the real image during the turn that produced it; storing the
    base64 would grow the database without bound and replay stale pixels.
    """
    stripped: list[dict[str, Any]] = []
    for result in tool_results:
        content = result.get("content")
        if isinstance(content, list):
            content = [
                {"type": "text", "text": "[image omitted from history]"}
                if block.get("type") == "image"
                else block
                for block in content
            ]
            result = {**result, "content": content}
        stripped.append(result)
    return stripped


class Agent:
    """Runs one conversation. Front ends own the presentation, this owns the loop."""

    def __init__(
        self,
        settings: Settings | None = None,
        memory: Memory | None = None,
        registry: ToolRegistry | None = None,
        client: Any = None,
        voice: bool = False,
    ) -> None:
        self.settings = settings or Settings.from_env()
        self.settings.ensure_dirs()
        self.memory = memory if memory is not None else Memory(self.settings.db_path)
        self.registry = registry if registry is not None else build_registry(self.settings)
        self.client = client if client is not None else anthropic.AsyncAnthropic()
        self.voice = voice
        self.system = system_prompt(self.settings, voice=voice)
        self.context = ToolContext(settings=self.settings, memory=self.memory)

    # ------------------------------------------------------------------ setup

    def set_confirm_handler(self, handler) -> None:
        """Install the callback tools use to ask the user for approval."""
        self.context.confirm = handler

    def tool_specs(self) -> list[dict[str, Any]]:
        return [*self.registry.to_api(), *server_tools(self.settings)]

    def _request_kwargs(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": self.settings.model,
            "max_tokens": self.settings.max_tokens,
            # A stable prefix: persona and tools never change mid-session, so
            # the cache keeps hitting and only the tail is re-read.
            "system": [
                {
                    "type": "text",
                    "text": self.system,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "messages": messages,
            "tools": self.tool_specs(),
            "output_config": {"effort": self.settings.effort},
            # Claude Opus 5 may decline a request outright; let the server pick
            # a fallback model instead of handing the user an empty reply.
            "betas": [FALLBACK_BETA],
            "fallbacks": "default",
        }
        if self.settings.thinking:
            kwargs["thinking"] = {
                "type": "adaptive",
                "display": "summarized" if self.settings.show_thinking else "omitted",
            }
        return kwargs

    def _with_context(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Append the volatile context (time, memories) after the cached prefix."""
        context = situational_context(self.settings, self.memory)
        if not context:
            return messages
        if supports_mid_conversation_system(self.settings.model):
            return [*messages, {"role": "system", "content": context}]
        # Older models: fold it into the last user turn instead.
        patched = list(messages)
        for index in range(len(patched) - 1, -1, -1):
            if patched[index]["role"] == "user":
                content = patched[index]["content"]
                blocks = [{"type": "text", "text": content}] if isinstance(content, str) else list(content)
                patched[index] = {
                    "role": "user",
                    "content": [*blocks, {"type": "text", "text": f"<context>\n{context}\n</context>"}],
                }
                break
        return patched

    # -------------------------------------------------------------------- run

    async def run(
        self,
        user_input: str,
        session_id: str = "default",
        on_event: EventHandler | None = None,
        images: list[tuple[str, str]] | None = None,
    ) -> str:
        """Handle one user turn. Returns the final reply text.

        `images` are (media_type, base64) pairs to show Claude alongside the
        text - a pasted screenshot, a photo from the phone.
        """

        async def emit(event: Event) -> None:
            if on_event is not None:
                await on_event(event)

        messages = self.memory.load_history(session_id, self.settings.history_turns)
        if images:
            # Images lead, then the question - Claude reads them in order.
            turn: Any = [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": data},
                }
                for media_type, data in images
            ]
            turn.append({"type": "text", "text": user_input})
            messages.append({"role": "user", "content": turn})
            # Only the text is kept in history; the base64 would bloat the DB.
            self.memory.append_message(
                session_id, "user", f"{user_input}\n[{len(images)} image(s) attached]"
            )
        else:
            messages.append({"role": "user", "content": user_input})
            self.memory.append_message(session_id, "user", user_input)

        reply_parts: list[str] = []

        for _ in range(self.settings.max_tool_iterations):
            try:
                response = await self._stream_turn(self._with_context(messages), emit)
            except anthropic.APIStatusError as exc:
                message = f"the API rejected that request ({exc.status_code}): {exc.message}"
                await emit(Event("error", text=message))
                return message
            except anthropic.APIConnectionError as exc:
                message = f"I could not reach the API: {exc}"
                await emit(Event("error", text=message))
                return message

            text = "".join(b.text for b in response.content if b.type == "text")
            if text:
                reply_parts.append(text)

            messages.append({"role": "assistant", "content": response.content})
            self.memory.append_message(
                session_id, "assistant", [b.model_dump() for b in response.content]
            )
            await emit(Event("turn_end", data={"stop_reason": response.stop_reason or ""}))

            if response.stop_reason == "refusal":
                detail = getattr(response, "stop_details", None)
                reason = getattr(detail, "explanation", "") or "the request was declined"
                await emit(Event("error", text=reason))
                return reason

            # A server-side tool ran long and the turn was paused; resending the
            # conversation as-is resumes it.
            if response.stop_reason == "pause_turn":
                continue

            if response.stop_reason != "tool_use":
                break

            tool_results = await self._run_tools(response.content, emit)
            if not tool_results:
                break
            messages.append({"role": "user", "content": tool_results})
            self.memory.append_message(session_id, "user", strip_images(tool_results))
        else:
            note = "I stopped after too many tool steps. Ask me to narrow it down?"
            await emit(Event("error", text=note))
            reply_parts.append(note)

        final = "\n".join(part for part in reply_parts if part).strip()
        await emit(Event("done", text=final))
        return final

    async def _stream_turn(self, messages: list[dict[str, Any]], emit) -> Any:
        """Stream one model turn, emitting deltas as they arrive."""
        kwargs = self._request_kwargs(messages)
        async with self.client.beta.messages.stream(**kwargs) as stream:
            async for event in stream:
                if event.type != "content_block_delta":
                    continue
                delta = event.delta
                if delta.type == "text_delta" and delta.text:
                    await emit(Event("text", text=delta.text))
                elif delta.type == "thinking_delta" and getattr(delta, "thinking", ""):
                    await emit(Event("thinking", text=delta.thinking))
            return await stream.get_final_message()

    async def _run_tools(self, content: Iterable[Any], emit) -> list[dict[str, Any]]:
        """Execute every client-side tool_use block in one assistant turn."""
        results: list[dict[str, Any]] = []
        for block in content:
            if block.type != "tool_use":
                continue  # server tools already ran on Anthropic's side
            arguments = dict(block.input or {})
            await emit(Event("tool_start", tool=block.name, arguments=arguments))
            try:
                output = await self.registry.call(block.name, arguments, self.context)
                if isinstance(output, ImageResult):
                    await emit(
                        Event(
                            "tool_end",
                            tool=block.name,
                            result=output.summary(),
                            data={"images": len(output.images)},
                        )
                    )
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": output.to_blocks(),
                        }
                    )
                else:
                    await emit(Event("tool_end", tool=block.name, result=output))
                    results.append(
                        {"type": "tool_result", "tool_use_id": block.id, "content": output}
                    )
            except ToolError as exc:
                await emit(Event("tool_error", tool=block.name, result=str(exc)))
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"error: {exc}",
                        "is_error": True,
                    }
                )
            except Exception as exc:  # a broken tool must not kill the turn
                log.exception("tool %s failed", block.name)
                await emit(Event("tool_error", tool=block.name, result=str(exc)))
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"error: {type(exc).__name__}: {exc}",
                        "is_error": True,
                    }
                )
        return results
