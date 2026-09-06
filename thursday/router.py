"""Picking the right profile for the job.

Three modes, in increasing order of cost:

  off      - always the default profile
  keyword  - match the profiles' own trigger words (free, instant)
  llm      - keyword first, then ask a small model when nothing matched

The keyword pass runs in every mode but `off`, so the common cases never pay
for a classification call.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from .profiles import Profile, describe
from .providers import Provider, ProviderError, TurnRequest

log = logging.getLogger(__name__)

CLASSIFIER_SYSTEM = """\
You route a user's request to the assistant profile that suits it best.

Profiles:
{catalogue}

Reply with the profile name alone - one word, nothing else. If none clearly \
fits, reply "default".
"""

# "use the private profile", "โหมด private", "/profile deep"
_EXPLICIT = re.compile(
    r"(?:^|\b)(?:/profile|use(?:\s+the)?\s+|switch\s+to\s+|โหมด|ใช้โหมด)\s*"
    r"(?P<name>[a-z][a-z0-9_-]{1,30})\s*(?:profile|mode)?\b",
    re.IGNORECASE,
)


@dataclass
class Routing:
    """Which profile was chosen and why - front ends show this."""

    profile: Profile
    reason: str = "default"

    @property
    def name(self) -> str:
        return self.profile.name


class Router:
    def __init__(
        self,
        profiles: dict[str, Profile],
        mode: str = "keyword",
        default: str = "default",
        classifier_model: str = "claude-haiku-4-5",
    ) -> None:
        self.profiles = profiles
        self.mode = (mode or "keyword").lower()
        self.default_name = default if default in profiles else next(iter(profiles))
        self.classifier_model = classifier_model
        # Set by the user; overrides routing until cleared.
        self.pinned: str | None = None

    # ------------------------------------------------------------------ state

    @property
    def default(self) -> Profile:
        return self.profiles[self.default_name]

    def pin(self, name: str | None) -> Profile:
        """Force a profile for every following turn, or clear with None."""
        if name is None:
            self.pinned = None
            return self.default
        key = name.strip().lower()
        if key not in self.profiles:
            raise KeyError(key)
        self.pinned = key
        return self.profiles[key]

    # ---------------------------------------------------------------- picking

    def explicit(self, text: str) -> Profile | None:
        """A profile the user named in the message itself."""
        for match in _EXPLICIT.finditer(text):
            candidate = match.group("name").lower()
            if candidate in self.profiles:
                return self.profiles[candidate]
        return None

    def by_keyword(self, text: str) -> Profile | None:
        lowered = text.lower()
        best: tuple[int, Profile] | None = None
        for profile in self.profiles.values():
            hits = sum(1 for trigger in profile.triggers if trigger.lower() in lowered)
            if hits and (best is None or hits > best[0]):
                best = (hits, profile)
        return best[1] if best else None

    async def classify(self, text: str, provider: Provider) -> Profile | None:
        """Ask a small model which profile fits. Never fatal."""
        request = TurnRequest(
            model=self.classifier_model,
            system=CLASSIFIER_SYSTEM.format(catalogue=describe(self.profiles)),
            messages=[{"role": "user", "content": text[:2000]}],
            tools=[],
            max_tokens=16,
            effort="low",
            thinking=False,
        )

        async def ignore(kind: str, chunk: str) -> None:
            return None

        try:
            result = await provider.stream(request, ignore)
        except (ProviderError, Exception) as exc:  # a router must never break a turn
            log.debug("profile classification failed: %s", exc)
            return None

        answer = result.text().strip().lower().strip(".\"'")
        return self.profiles.get(answer)

    async def route(
        self, text: str, provider: Provider | None = None, override: str | None = None
    ) -> Routing:
        """Choose the profile for this turn."""
        if override:
            key = override.strip().lower()
            if key in self.profiles:
                return Routing(self.profiles[key], "requested")

        if self.pinned:
            return Routing(self.profiles[self.pinned], "pinned")

        named = self.explicit(text)
        if named is not None:
            return Routing(named, "named in the message")

        if self.mode == "off":
            return Routing(self.default, "routing off")

        matched = self.by_keyword(text)
        if matched is not None:
            return Routing(matched, "keyword match")

        if self.mode == "llm" and provider is not None:
            classified = await self.classify(text, provider)
            if classified is not None:
                return Routing(classified, "classified")

        return Routing(self.default, "default")
