"""Model backends. Anthropic is native; everything else speaks OpenAI's shape."""

from __future__ import annotations

import os
from typing import Any

from .base import (
    DeltaHandler,
    Provider,
    ProviderError,
    TurnRequest,
    TurnResult,
)
from .openai_compat import PRESETS, OpenAICompatProvider, Preset, preset_for

ANTHROPIC = "anthropic"


def provider_names() -> list[str]:
    return [ANTHROPIC, *sorted(PRESETS)]


def local_provider_names() -> list[str]:
    return sorted(name for name, preset in PRESETS.items() if preset.local)


def default_model_for(provider: str) -> str:
    if provider == ANTHROPIC:
        return "claude-opus-5"
    return preset_for(provider).default_model


def build_provider(
    name: str = ANTHROPIC,
    api_key: str | None = None,
    base_url: str | None = None,
    client: Any = None,
) -> Provider:
    """Build a provider by name.

    `base_url` overrides the preset's endpoint, which is how an unlisted
    OpenAI-compatible server (a company proxy, a second Ollama on another
    machine) gets used without adding a preset for it.
    """
    key = (name or ANTHROPIC).strip().lower()

    if key == ANTHROPIC:
        from .anthropic_provider import AnthropicProvider

        return AnthropicProvider(client=client, api_key=api_key, base_url=base_url)

    if key in {"openai-compatible", "custom", "openai_compat"}:
        if not base_url:
            raise ProviderError(
                "a custom OpenAI-compatible provider needs THURSDAY_BASE_URL"
            )
        preset = Preset(name="custom", base_url=base_url, key_env="THURSDAY_API_KEY")
        return OpenAICompatProvider(preset, api_key=api_key, base_url=base_url)

    return OpenAICompatProvider(preset_for(key), api_key=api_key, base_url=base_url)


def key_env_for(provider: str) -> str:
    """The environment variable a provider reads its key from."""
    if provider == ANTHROPIC:
        return "ANTHROPIC_API_KEY"
    try:
        return preset_for(provider).key_env
    except ProviderError:
        return ""


def has_credentials(provider: str) -> bool:
    """Whether a key is present, for providers that need one."""
    if provider == ANTHROPIC:
        return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    preset = preset_for(provider)
    if not preset.requires_key:
        return True
    return bool(os.environ.get(preset.key_env))


__all__ = [
    "ANTHROPIC",
    "DeltaHandler",
    "PRESETS",
    "OpenAICompatProvider",
    "Preset",
    "Provider",
    "ProviderError",
    "TurnRequest",
    "TurnResult",
    "build_provider",
    "default_model_for",
    "has_credentials",
    "key_env_for",
    "local_provider_names",
    "preset_for",
    "provider_names",
]
