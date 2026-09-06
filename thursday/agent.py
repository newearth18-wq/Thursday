"""The agent loop: a profile picks the brain, the registry supplies the hands.

The loop is written by hand rather than handed to an SDK helper because
Thursday needs to stream tokens into speech as they arrive, run a tool
registry that plugins mutate at runtime, route confirmation prompts back to
whichever front end is attached - and, since this file learned about
providers, run the same conversation against a local model or another vendor
without the rest of the code noticing.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from .config import Settings
from .events import Event, EventHandler
from .memory import Memory
from .persona import situational_context, system_prompt
from .profiles import Profile, load_profiles
from .providers import (
    ANTHROPIC,
    Provider,
    ProviderError,
    TurnRequest,
    build_provider,
    default_model_for,
)
from .providers.anthropic_provider import supports_mid_conversation_system
from .router import Router, Routing
from .tools import ImageResult, ToolContext, ToolError, ToolRegistry, build_registry

log = logging.getLogger(__name__)


def server_tools(settings: Settings, profile: Profile | None = None) -> list[dict[str, Any]]:
    """Anthropic-hosted tools. They run server-side - nothing to execute here."""
    if not settings.enable_web_search:
        return []
    if profile is not None and not profile.web_search:
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
        profiles: dict[str, Profile] | None = None,
        router: Router | None = None,
    ) -> None:
        self.settings = settings or Settings.from_env()
        self.settings.ensure_dirs()
        self.memory = memory if memory is not None else Memory(self.settings.db_path)
        self.registry = registry if registry is not None else build_registry(self.settings)
        self.voice = voice
        self.base_system = system_prompt(self.settings, voice=voice)
        self.context = ToolContext(settings=self.settings, memory=self.memory)

        # An injected client (tests, a pre-configured SDK client) belongs to the
        # Anthropic provider.
        self.client = client

        self.profiles = profiles if profiles is not None else load_profiles(self.settings.profile_paths)
        self.router = router or Router(
            self.profiles,
            mode=self.settings.routing,
            default=self.settings.profile,
            classifier_model=self.settings.classifier_model,
        )
        self._providers: dict[str, Provider] = {}

    # ------------------------------------------------------------------ setup

    def set_confirm_handler(self, handler) -> None:
        """Install the callback tools use to ask the user for approval."""
        self.context.confirm = handler

    @property
    def system(self) -> str:
        return self.base_system

    @system.setter
    def system(self, value: str) -> None:
        self.base_system = value

    def provider_for(self, name: str) -> Provider:
        """Build (and cache) a provider by name."""
        key = (name or ANTHROPIC).lower()
        if key not in self._providers:
            self._providers[key] = build_provider(
                key,
                api_key=self.settings.api_key or None,
                base_url=self.settings.base_url or None,
                client=self.client if key == ANTHROPIC else None,
            )
        return self._providers[key]

    def provider_name_for(self, profile: Profile) -> str:
        """A profile's own provider, else the configured one."""
        return (profile.provider or self.settings.provider or ANTHROPIC).lower()

    def model_for(self, profile: Profile) -> str:
        """Resolve the model, honouring what was pinned where.

        A profile's model counts when the profile also pins its provider, or
        when the resolved provider is Anthropic - a Claude model id is
        meaningless to Ollama. Otherwise an explicit THURSDAY_MODEL wins, and
        failing that the provider's own default.
        """
        provider = self.provider_name_for(profile)
        if profile.model and (profile.provider or provider == ANTHROPIC):
            return profile.model
        if self.settings.model and provider == (self.settings.provider or ANTHROPIC).lower():
            return self.settings.model
        return default_model_for(provider)

    def tool_specs(self, profile: Profile, provider: Provider) -> list[dict[str, Any]]:
        """The tools this turn may use, after the profile's filter."""
        local = [spec for spec in self.registry.to_api() if profile.allows(spec["name"])]
        if provider.supports_server_tools:
            local += server_tools(self.settings, profile)
        return local

    def system_for(self, profile: Profile) -> str:
        """The system prompt for a profile - stable, so the cache keeps hitting."""
        if not profile.style:
            return self.base_system
        return f"{self.base_system}\n{profile.style}\n"

    def _with_context(
        self, messages: list[dict[str, Any]], profile: Profile, provider: Provider
    ) -> list[dict[str, Any]]:
        """Append the volatile context (time, memories) after the cached prefix."""
        context = situational_context(self.settings, self.memory)
        if not context:
            return messages

        model = self.model_for(profile)
        accepts_system = (
            supports_mid_conversation_system(model)
            if self.provider_name_for(profile) == ANTHROPIC
            else provider.supports_mid_conversation_system
        )
        if accepts_system:
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

    async def route(self, text: str, override: str | None = None) -> Routing:
        """Decide which profile handles this turn."""
        classifier: Provider | None = None
        if self.router.mode == "llm":
            try:
                classifier = self.provider_for(self.settings.classifier_provider)
            except ProviderError as exc:
                log.debug("no classifier provider: %s", exc)
        return await self.router.route(text, classifier, override=override)

    async def run(
        self,
        user_input: str,
        session_id: str = "default",
        on_event: EventHandler | None = None,
        images: list[tuple[str, str]] | None = None,
        profile: str | None = None,
    ) -> str:
        """Handle one user turn. Returns the final reply text.

        `images` are (media_type, base64) pairs to show the model alongside the
        text; `profile` forces a profile instead of letting the router choose.
        """

        async def emit(event: Event) -> None:
            if on_event is not None:
                await on_event(event)

        routing = await self.route(user_input, override=profile)
        active = routing.profile
        provider_name = self.provider_name_for(active)
        provider = self.provider_for(provider_name)
        model = self.model_for(active)
        await emit(
            Event(
                "profile",
                text=active.name,
                data={
                    "profile": active.name,
                    "provider": provider_name,
                    "model": model,
                    "reason": routing.reason,
                },
            )
        )

        if images and not provider.supports_images:
            await emit(
                Event("error", text=f"{provider_name} cannot see images; sending the text only")
            )
            images = None

        messages = self.memory.load_history(session_id, self.settings.history_turns)
        if images:
            # Images lead, then the question - the model reads them in order.
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

        request_system = self.system_for(active)
        tools = self.tool_specs(active, provider)
        reply_parts: list[str] = []

        async def on_delta(kind: str, chunk: str) -> None:
            await emit(Event("text" if kind == "text" else "thinking", text=chunk))

        for _ in range(self.settings.max_tool_iterations):
            request = TurnRequest(
                model=model,
                system=request_system,
                messages=self._with_context(messages, active, provider),
                tools=tools,
                max_tokens=active.max_tokens or self.settings.max_tokens,
                effort=active.effort or self.settings.effort,
                thinking=active.thinking and self.settings.thinking,
                show_thinking=self.settings.show_thinking,
            )

            try:
                result = await provider.stream(request, on_delta)
            except ProviderError as exc:
                message = str(exc)
                await emit(Event("error", text=message))
                return message

            text = result.text()
            if text:
                reply_parts.append(text)

            messages.append({"role": "assistant", "content": result.content})
            self.memory.append_message(session_id, "assistant", result.content)
            await emit(Event("turn_end", data={"stop_reason": result.stop_reason}))

            if result.stop_reason == "refusal":
                reason = result.refusal_text or "the request was declined"
                await emit(Event("error", text=reason))
                return reason

            # A server-side tool ran long and the turn was paused; resending the
            # conversation as-is resumes it.
            if result.stop_reason == "pause_turn":
                continue

            if result.stop_reason != "tool_use":
                break

            tool_results = await self._run_tools(result.content, active, emit)
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

    async def _run_tools(
        self, content: Iterable[dict[str, Any]], profile: Profile, emit
    ) -> list[dict[str, Any]]:
        """Execute every client-side tool_use block in one assistant turn."""
        results: list[dict[str, Any]] = []
        for block in content:
            if block.get("type") != "tool_use":
                continue  # server tools already ran on the vendor's side
            name = block.get("name", "")
            block_id = block.get("id", "")
            arguments = dict(block.get("input") or {})
            await emit(Event("tool_start", tool=name, arguments=arguments))

            # A model may name a tool the active profile withholds.
            if not profile.allows(name):
                message = (
                    f"the {profile.name!r} profile does not allow {name}; "
                    "tell the user which profile would"
                )
                await emit(Event("tool_error", tool=name, result=message))
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block_id,
                        "content": f"error: {message}",
                        "is_error": True,
                    }
                )
                continue

            try:
                output = await self.registry.call(name, arguments, self.context)
                if isinstance(output, ImageResult):
                    await emit(
                        Event(
                            "tool_end",
                            tool=name,
                            result=output.summary(),
                            data={"images": len(output.images)},
                        )
                    )
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block_id,
                            "content": output.to_blocks(),
                        }
                    )
                else:
                    await emit(Event("tool_end", tool=name, result=output))
                    results.append(
                        {"type": "tool_result", "tool_use_id": block_id, "content": output}
                    )
            except ToolError as exc:
                await emit(Event("tool_error", tool=name, result=str(exc)))
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block_id,
                        "content": f"error: {exc}",
                        "is_error": True,
                    }
                )
            except Exception as exc:  # a broken tool must not kill the turn
                log.exception("tool %s failed", name)
                await emit(Event("tool_error", tool=name, result=str(exc)))
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block_id,
                        "content": f"error: {type(exc).__name__}: {exc}",
                        "is_error": True,
                    }
                )
        return results

    async def close(self) -> None:
        for provider in self._providers.values():
            await provider.close()
        self._providers.clear()
