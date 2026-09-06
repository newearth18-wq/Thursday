"""Any OpenAI-compatible chat API - hosted or local.

One implementation covers a lot of ground, because the OpenAI chat-completions
shape has become the lingua franca: OpenAI itself, Google Gemini's
compatibility endpoint, Groq, OpenRouter, DeepSeek, Mistral, xAI - and every
local runner worth using (Ollama, LM Studio, llama.cpp's server, vLLM).

Translation happens here so the rest of Thursday never sees a second message
format. What cannot be represented is dropped explicitly rather than silently:
thinking blocks, Anthropic's server-side tools and prompt caching have no
equivalent, and this file says so.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any

from .base import DeltaHandler, Provider, ProviderError, TurnRequest, TurnResult

log = logging.getLogger(__name__)

try:
    import httpx
except ImportError:  # pragma: no cover - httpx is a core dependency
    httpx = None  # type: ignore[assignment]


@dataclass
class Preset:
    """A known OpenAI-compatible endpoint."""

    name: str
    base_url: str
    key_env: str = ""
    default_model: str = ""
    local: bool = False
    # Newer OpenAI models reject `max_tokens`; most other servers require it.
    max_tokens_field: str = "max_tokens"
    supports_reasoning_effort: bool = False
    supports_images: bool = True
    note: str = ""

    @property
    def requires_key(self) -> bool:
        return bool(self.key_env) and not self.local


PRESETS: dict[str, Preset] = {
    "openai": Preset(
        name="openai",
        base_url="https://api.openai.com/v1",
        key_env="OPENAI_API_KEY",
        default_model="gpt-4o",
        max_tokens_field="max_completion_tokens",
        supports_reasoning_effort=True,
    ),
    "gemini": Preset(
        name="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        key_env="GEMINI_API_KEY",
        default_model="gemini-2.0-flash",
        note="Google's OpenAI-compatibility endpoint; a few options are ignored.",
    ),
    "groq": Preset(
        name="groq",
        base_url="https://api.groq.com/openai/v1",
        key_env="GROQ_API_KEY",
        default_model="llama-3.3-70b-versatile",
    ),
    "openrouter": Preset(
        name="openrouter",
        base_url="https://openrouter.ai/api/v1",
        key_env="OPENROUTER_API_KEY",
        default_model="anthropic/claude-sonnet-4.5",
        supports_reasoning_effort=True,
    ),
    "deepseek": Preset(
        name="deepseek",
        base_url="https://api.deepseek.com/v1",
        key_env="DEEPSEEK_API_KEY",
        default_model="deepseek-chat",
        supports_images=False,
    ),
    "mistral": Preset(
        name="mistral",
        base_url="https://api.mistral.ai/v1",
        key_env="MISTRAL_API_KEY",
        default_model="mistral-large-latest",
    ),
    "xai": Preset(
        name="xai",
        base_url="https://api.x.ai/v1",
        key_env="XAI_API_KEY",
        default_model="grok-2-latest",
    ),
    "together": Preset(
        name="together",
        base_url="https://api.together.xyz/v1",
        key_env="TOGETHER_API_KEY",
        default_model="meta-llama/Llama-3.3-70B-Instruct-Turbo",
    ),
    # ---- local runners: no key, nothing leaves the machine -----------------
    "ollama": Preset(
        name="ollama",
        base_url="http://localhost:11434/v1",
        default_model="llama3.2",
        local=True,
        note="Start with `ollama serve`, then `ollama pull llama3.2`.",
    ),
    "lmstudio": Preset(
        name="lmstudio",
        base_url="http://localhost:1234/v1",
        default_model="local-model",
        local=True,
        note="Enable the local server in LM Studio's Developer tab.",
    ),
    "llamacpp": Preset(
        name="llamacpp",
        base_url="http://localhost:8080/v1",
        default_model="local-model",
        local=True,
        note="Run llama-server with --port 8080.",
    ),
    "vllm": Preset(
        name="vllm",
        base_url="http://localhost:8000/v1",
        default_model="local-model",
        local=True,
        note="vllm serve <model> --port 8000",
    ),
}


def preset_for(name: str) -> Preset:
    key = name.strip().lower()
    if key not in PRESETS:
        raise ProviderError(
            f"unknown provider {name!r}; known: anthropic, {', '.join(sorted(PRESETS))}, "
            "or set THURSDAY_BASE_URL for any other OpenAI-compatible server"
        )
    return PRESETS[key]


# --------------------------------------------------------------- translation


def blocks_to_text(content: Any) -> str:
    """Flatten internal content into plain text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content)
    return "\n".join(
        block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


def _data_url(source: dict[str, Any]) -> str:
    return f"data:{source.get('media_type', 'image/png')};base64,{source.get('data', '')}"


def to_openai_messages(
    system: str, messages: list[dict[str, Any]], supports_images: bool = True
) -> list[dict[str, Any]]:
    """Translate internal messages into the OpenAI chat format."""
    out: list[dict[str, Any]] = []
    if system:
        out.append({"role": "system", "content": system})

    for message in messages:
        role = message.get("role")
        content = message.get("content")

        if role == "system":
            # Thursday's mid-conversation context; a plain system turn here.
            out.append({"role": "system", "content": blocks_to_text(content)})
            continue

        if role == "assistant":
            text_parts: list[str] = []
            tool_calls: list[dict[str, Any]] = []
            for block in content if isinstance(content, list) else [{"type": "text", "text": content}]:
                if not isinstance(block, dict):
                    continue
                kind = block.get("type")
                if kind == "text":
                    text_parts.append(block.get("text", ""))
                elif kind == "tool_use":
                    tool_calls.append(
                        {
                            "id": block.get("id", ""),
                            "type": "function",
                            "function": {
                                "name": block.get("name", ""),
                                "arguments": json.dumps(block.get("input") or {}),
                            },
                        }
                    )
                # thinking / redacted_thinking have no equivalent and are dropped.
            assistant: dict[str, Any] = {"role": "assistant"}
            joined = "".join(text_parts)
            assistant["content"] = joined or (None if tool_calls else "")
            if tool_calls:
                assistant["tool_calls"] = tool_calls
            out.append(assistant)
            continue

        # ---- user turns, which may carry tool results and images -----------
        if isinstance(content, str):
            out.append({"role": "user", "content": content})
            continue

        parts: list[dict[str, Any]] = []
        # Images that arrived inside a tool result: OpenAI tool messages are
        # text-only, so they are re-sent as a following user turn instead of
        # being thrown away.
        orphaned_images: list[dict[str, Any]] = []

        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "tool_result":
                inner = block.get("content")
                text = blocks_to_text(inner) or "(no output)"
                if isinstance(inner, list):
                    orphaned_images += [b for b in inner if isinstance(b, dict) and b.get("type") == "image"]
                out.append(
                    {
                        "role": "tool",
                        "tool_call_id": block.get("tool_use_id", ""),
                        "content": text,
                    }
                )
            elif kind == "text":
                parts.append({"type": "text", "text": block.get("text", "")})
            elif kind == "image":
                parts.append({"type": "image_url", "image_url": {"url": _data_url(block.get("source", {}))}})

        for image in orphaned_images:
            parts.append({"type": "image_url", "image_url": {"url": _data_url(image.get("source", {}))}})

        if not supports_images:
            dropped = sum(1 for part in parts if part["type"] == "image_url")
            parts = [part for part in parts if part["type"] != "image_url"]
            if dropped:
                parts.append(
                    {"type": "text", "text": f"[{dropped} image(s) omitted - this model cannot see images]"}
                )

        if parts:
            only_text = all(part["type"] == "text" for part in parts)
            out.append(
                {
                    "role": "user",
                    # A bare string is what small local servers handle best.
                    "content": "\n".join(p["text"] for p in parts) if only_text else parts,
                }
            )

    return out


def to_openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate tool definitions, skipping Anthropic-hosted server tools."""
    translated = []
    for spec in tools:
        if "input_schema" not in spec:
            continue  # a server tool - it only exists on Anthropic's side
        translated.append(
            {
                "type": "function",
                "function": {
                    "name": spec["name"],
                    "description": spec.get("description", ""),
                    "parameters": spec["input_schema"],
                },
            }
        )
    return translated


FINISH_REASONS = {
    "stop": "end_turn",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "length": "max_tokens",
    "content_filter": "refusal",
}


def parse_arguments(raw: str) -> dict[str, Any]:
    """Tool arguments arrive as a JSON string, sometimes a malformed one."""
    if not raw or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("tool arguments were not valid JSON: %r", raw[:200])
        return {"__raw_arguments": raw}
    return parsed if isinstance(parsed, dict) else {"value": parsed}


# ------------------------------------------------------------------ provider


class OpenAICompatProvider(Provider):
    """Talks to any server that speaks OpenAI chat completions."""

    supports_server_tools = False
    supports_mid_conversation_system = True  # a plain system turn works fine

    def __init__(
        self,
        preset: Preset,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 300.0,
    ) -> None:
        if httpx is None:  # pragma: no cover
            raise ProviderError("httpx is not installed; run: pip install httpx")
        self.preset = preset
        self.name = preset.name
        self.base_url = (base_url or preset.base_url).rstrip("/")
        self.api_key = api_key or (os.environ.get(preset.key_env) if preset.key_env else "")
        self.supports_images = preset.supports_images
        self._timeout = timeout
        self._client: Any = None

    # -------------------------------------------------------------- plumbing

    def client(self) -> Any:
        if self._client is None:
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            self._client = httpx.AsyncClient(
                base_url=self.base_url, headers=headers, timeout=self._timeout
            )
        return self._client

    def build_payload(self, request: TurnRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": request.model,
            "messages": to_openai_messages(request.system, request.messages, self.supports_images),
            "stream": True,
        }
        payload[self.preset.max_tokens_field] = request.max_tokens

        tools = to_openai_tools(request.tools)
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if self.preset.supports_reasoning_effort and request.effort:
            # OpenAI accepts low/medium/high only.
            payload["reasoning_effort"] = {
                "xhigh": "high",
                "max": "high",
            }.get(request.effort, request.effort)
        return payload

    async def stream(self, request: TurnRequest, on_delta: DeltaHandler) -> TurnResult:
        payload = self.build_payload(request)
        text = ""
        thinking = ""
        # Tool calls stream in fragments keyed by index.
        calls: dict[int, dict[str, Any]] = {}
        finish_reason = "stop"

        try:
            async with self.client().stream("POST", "/chat/completions", json=payload) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", "replace")
                    raise ProviderError(
                        f"{self.name} returned {response.status_code}: {body[:400]}"
                    )

                # Some local servers ignore `stream` and answer in one shot.
                if "text/event-stream" not in response.headers.get("content-type", ""):
                    body = json.loads((await response.aread()).decode("utf-8", "replace"))
                    return await self._from_complete_response(body, on_delta, request)

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    choice = choices[0]
                    delta = choice.get("delta") or {}

                    piece = delta.get("content")
                    if piece:
                        text += piece
                        await on_delta("text", piece)

                    # DeepSeek and several proxies stream reasoning separately.
                    reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                    if reasoning and isinstance(reasoning, str):
                        thinking += reasoning
                        if request.show_thinking:
                            await on_delta("thinking", reasoning)

                    for fragment in delta.get("tool_calls") or []:
                        index = fragment.get("index", 0)
                        call = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                        if fragment.get("id"):
                            call["id"] = fragment["id"]
                        function = fragment.get("function") or {}
                        if function.get("name"):
                            call["name"] = function["name"]
                        if function.get("arguments"):
                            call["arguments"] += function["arguments"]

                    if choice.get("finish_reason"):
                        finish_reason = choice["finish_reason"]

        except ProviderError:
            raise
        except Exception as exc:  # httpx transport errors, JSON errors
            raise ProviderError(f"could not reach {self.name} at {self.base_url}: {exc}") from exc

        # Reasoning text was streamed to the front end above; it is not kept
        # as a block, because only Anthropic's thinking blocks are signed
        # and replayable and fabricating one would lie to the next turn.
        return self._build_result(text, calls, finish_reason, request)

    async def _from_complete_response(
        self, body: dict[str, Any], on_delta: DeltaHandler, request: TurnRequest
    ) -> TurnResult:
        """Handle a server that answered in one piece instead of streaming."""
        choice = (body.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        text = message.get("content") or ""
        if text:
            await on_delta("text", text)

        calls = {
            index: {
                "id": call.get("id", ""),
                "name": (call.get("function") or {}).get("name", ""),
                "arguments": (call.get("function") or {}).get("arguments", ""),
            }
            for index, call in enumerate(message.get("tool_calls") or [])
        }
        return self._build_result(text, calls, choice.get("finish_reason", "stop"), request)

    def _build_result(
        self,
        text: str,
        calls: dict[int, dict[str, Any]],
        finish_reason: str,
        request: TurnRequest,
    ) -> TurnResult:
        content: list[dict[str, Any]] = []
        if text:
            content.append({"type": "text", "text": text})
        for index, call in sorted(calls.items()):
            content.append(
                {
                    "type": "tool_use",
                    "id": call["id"] or f"call_{index}",
                    "name": call["name"],
                    "input": parse_arguments(call["arguments"]),
                }
            )

        stop_reason = FINISH_REASONS.get(finish_reason, "end_turn")
        if calls:
            stop_reason = "tool_use"
        if not content:
            content = [{"type": "text", "text": ""}]
        return TurnResult(content=content, stop_reason=stop_reason, model=request.model)

    # ------------------------------------------------------------ diagnostics

    async def available(self) -> tuple[bool, str]:
        if self.preset.requires_key and not self.api_key:
            return False, f"{self.preset.key_env} is not set"
        try:
            response = await self.client().get("/models")
        except Exception as exc:
            hint = f" ({self.preset.note})" if self.preset.note else ""
            return False, f"cannot reach {self.base_url}: {exc}{hint}"
        if response.status_code >= 400:
            return False, f"{self.base_url} returned {response.status_code}"
        return True, ""

    async def list_models(self) -> list[str]:
        try:
            response = await self.client().get("/models")
            response.raise_for_status()
            data = response.json().get("data") or []
            return sorted(entry["id"] for entry in data if isinstance(entry, dict) and "id" in entry)
        except Exception as exc:
            log.debug("could not list models for %s: %s", self.name, exc)
            return []

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
