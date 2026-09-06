"""What a turn cost.

Token counts come from the provider and are always exact. Prices do not: they
change, and Thursday talks to a dozen backends. So the table below covers the
Anthropic models it ships with, `pricing.json` lets you add your own, and
anything unpriced reports tokens with a cost of None rather than a guess.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Price:
    """US dollars per million tokens."""

    input: float
    output: float
    cache_write: float = 0.0
    cache_read: float = 0.0


#: Anthropic list prices, as published on 2026-06-24. Verify before you bill
#: anyone against them.
PRICES: dict[str, Price] = {
    "claude-fable-5-1": Price(10.0, 50.0),
    "claude-fable-5": Price(10.0, 50.0),
    "claude-mythos-5-1": Price(10.0, 50.0),
    "claude-opus-5": Price(5.0, 25.0, cache_write=6.25, cache_read=0.5),
    "claude-opus-4-8": Price(5.0, 25.0),
    "claude-opus-4-7": Price(5.0, 25.0),
    "claude-opus-4-6": Price(5.0, 25.0),
    "claude-sonnet-5": Price(2.0, 10.0),
    "claude-sonnet-4-6": Price(3.0, 15.0),
    "claude-haiku-4-5": Price(1.0, 5.0),
}

#: Models that run on the user's own hardware cost nothing per token.
FREE_PROVIDERS = frozenset({"ollama", "lmstudio", "llamacpp", "vllm"})


def load_prices(paths: Iterable[Path] = ()) -> dict[str, Price]:
    """The built-in table, extended by any pricing.json found.

    The file maps a model id to {"input": <per MTok>, "output": <per MTok>}.
    """
    prices = dict(PRICES)
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("ignoring %s: %s", path, exc)
            continue
        for model, entry in (raw or {}).items():
            if not isinstance(entry, dict) or model.startswith("_"):
                continue
            try:
                prices[model] = Price(
                    input=float(entry["input"]),
                    output=float(entry["output"]),
                    cache_write=float(entry.get("cache_write", 0.0)),
                    cache_read=float(entry.get("cache_read", 0.0)),
                )
            except (KeyError, TypeError, ValueError) as exc:
                log.warning("ignoring price for %s in %s: %s", model, path, exc)
    return prices


def normalise_usage(usage: dict[str, Any] | None) -> dict[str, int]:
    """Flatten the vendors' different usage shapes into one."""
    usage = usage or {}
    return {
        # Anthropic                          # OpenAI-compatible
        "input": int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0),
        "output": int(usage.get("output_tokens") or usage.get("completion_tokens") or 0),
        "cache_write": int(usage.get("cache_creation_input_tokens") or 0),
        "cache_read": int(usage.get("cache_read_input_tokens") or 0),
    }


def estimate_cost(
    model: str,
    usage: dict[str, Any] | None,
    provider: str = "",
    prices: dict[str, Price] | None = None,
) -> float | None:
    """Dollars for one turn, or None when the model's price is unknown."""
    if provider in FREE_PROVIDERS:
        return 0.0

    table = prices if prices is not None else PRICES
    price = table.get(model)
    if price is None:
        # Tolerate a dated or vendor-prefixed id, e.g. "anthropic/claude-opus-5".
        bare = model.split("/")[-1]
        price = table.get(bare)
    if price is None:
        return None

    counts = normalise_usage(usage)
    total = (
        counts["input"] * price.input
        + counts["output"] * price.output
        + counts["cache_write"] * (price.cache_write or price.input)
        + counts["cache_read"] * (price.cache_read or price.input)
    )
    return total / 1_000_000


def format_cost(cost: float | None) -> str:
    """A dollar figure short enough to sit at the end of a line."""
    if cost is None:
        return "cost unknown"
    if cost == 0:
        return "free"
    if cost < 0.01:
        return f"${cost:.4f}"
    return f"${cost:.2f}"
