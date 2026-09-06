"""Profiles: which brain Thursday uses for which kind of job.

A profile bundles a provider, a model, how hard to think, which tools are on
the table, and a line of style guidance. Swapping profile swaps all of it at
once, so "answer this quickly on the local model with no internet access" is
one word rather than five settings.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Profile:
    """One named way of working."""

    name: str
    description: str = ""
    # Empty means "whatever THURSDAY_PROVIDER says", so switching every profile
    # to a local model is one environment variable. A profile that names a
    # provider (like `private`) always uses that one.
    provider: str = ""
    # Empty means "the provider's default model". A model named here is used
    # when the profile pins its provider, or when the resolved provider is
    # Anthropic - a Claude model id means nothing to a local runner.
    model: str = ""
    # Empty inherits THURSDAY_EFFORT, so --effort still reaches any profile
    # that has no opinion of its own.
    effort: str = ""
    thinking: bool = True
    # Zero inherits THURSDAY_MAX_TOKENS.
    max_tokens: int = 0
    # Empty allow list means every registered tool.
    tools: tuple[str, ...] = ()
    deny_tools: tuple[str, ...] = ()
    web_search: bool = True
    # Appended to the system prompt when this profile is active.
    style: str = ""
    # Words that make the automatic router pick this profile.
    triggers: tuple[str, ...] = ()

    def allows(self, tool_name: str) -> bool:
        if tool_name in self.deny_tools:
            return False
        return not self.tools or tool_name in self.tools

    def filter_tools(self, names: Iterable[str]) -> list[str]:
        return [name for name in names if self.allows(name)]

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


# Tool groups, so profiles read as intent rather than as long name lists.
MEMORY_TOOLS = (
    "remember_fact", "recall_facts", "forget_fact",
    "add_note", "search_notes", "delete_note",
)
TIME_TOOLS = (
    "current_time", "set_timer", "set_reminder", "list_reminders", "cancel_reminder",
)
ROUTINE_TOOLS = ("save_routine", "run_routine", "list_routines", "delete_routine")
FILE_TOOLS = ("read_file", "write_file", "list_files", "search_files")
SYSTEM_TOOLS = ("system_status", "list_processes", "open_app", "which", "run_shell")
DESKTOP_TOOLS = (
    "read_clipboard", "write_clipboard", "set_volume", "media_control",
    "show_notification", "lock_screen",
)
VISION_TOOLS = ("take_screenshot", "look_at_image")
NETWORK_TOOLS = ("get_weather", "fetch_url")


BUILTIN_PROFILES: tuple[Profile, ...] = (
    Profile(
        name="default",
        description="Everyday assistant work: questions, small tasks, conversation.",
        triggers=(),
    ),
    Profile(
        name="quick",
        description=(
            "Short factual answers where speed matters more than depth - the time, "
            "a unit conversion, a reminder, a one-line lookup."
        ),
        model="claude-haiku-4-5",
        effort="low",
        max_tokens=2000,
        thinking=False,
        tools=TIME_TOOLS + MEMORY_TOOLS + ROUTINE_TOOLS + ("system_status",),
        web_search=False,
        style="Answer in one sentence where you can. No preamble.",
        triggers=("what time", "กี่โมง", "remind me", "เตือน", "timer", "จับเวลา"),
    ),
    Profile(
        name="deep",
        description=(
            "Research and hard reasoning: comparisons, planning, anything needing "
            "several sources or careful thought."
        ),
        model="claude-opus-5",
        effort="xhigh",
        max_tokens=32000,
        style="Take the time to be thorough. Say what you are unsure of.",
        triggers=("research", "compare", "วิเคราะห์", "ค้นคว้า", "explain why", "plan"),
    ),
    Profile(
        name="coder",
        description="Reading, writing and running code on this machine.",
        model="claude-opus-5",
        effort="high",
        max_tokens=32000,
        tools=FILE_TOOLS + SYSTEM_TOOLS + VISION_TOOLS + MEMORY_TOOLS,
        style="Be precise about paths and commands. Show code, not descriptions of code.",
        triggers=("code", "โค้ด", "bug", "refactor", "test", "compile", "repo", "git"),
    ),
    Profile(
        name="chat",
        description="Messages arriving from a phone, over LINE or Telegram.",
        max_tokens=4000,
        # Nothing that would need a confirmation: there is nobody at the
        # keyboard to answer one, so the request would simply hang until it
        # timed out - and a bus is not where you approve `rm`.
        deny_tools=(
            "run_shell", "write_file", "take_screenshot", "browse", "browser_act",
            "browser_screenshot", "open_app", "lock_screen", "send_draft",
        ),
        style=(
            "You are being read on a phone, in a chat app. Keep it to a few "
            "lines. No markdown tables or code blocks. Nobody is at the keyboard "
            "to approve anything, so if a request needs the shell, a file "
            "written, or a draft sent, say what you would do and leave it for "
            "when they are back at the machine."
        ),
    ),
    Profile(
        name="private",
        description=(
            "Anything the user does not want leaving this machine. Runs on a local "
            "model with no network tools at all."
        ),
        provider="ollama",
        model="",
        effort="medium",
        thinking=False,
        deny_tools=NETWORK_TOOLS + ("run_shell",),
        web_search=False,
        style=(
            "You are running locally and nothing here leaves this machine. "
            "You have no internet access - say so rather than guessing at "
            "anything that would need it."
        ),
        triggers=("private", "ส่วนตัว", "ห้ามส่งออก", "offline", "local only", "confidential"),
    ),
)


def builtin_map() -> dict[str, Profile]:
    return {profile.name: profile for profile in BUILTIN_PROFILES}


def _coerce(raw: dict[str, Any], name: str, base: Profile | None = None) -> Profile:
    """Build a profile from JSON, inheriting from a built-in of the same name."""
    fields = {f for f in Profile.__dataclass_fields__}
    values = {key: value for key, value in raw.items() if key in fields}
    for tuple_field in ("tools", "deny_tools", "triggers"):
        if tuple_field in values:
            values[tuple_field] = tuple(values[tuple_field] or ())
    values["name"] = name
    if base is not None:
        return replace(base, **{k: v for k, v in values.items() if k != "name"})
    return Profile(**values)


def load_profiles(paths: Iterable[Path] = ()) -> dict[str, Profile]:
    """Built-in profiles, overridden and extended by any profiles.json found.

    The file is a plain object of name -> settings. A name that matches a
    built-in patches it; anything else defines a new profile.
    """
    profiles = builtin_map()
    for path in paths:
        path = Path(path)
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("ignoring %s: %s", path, exc)
            continue
        if not isinstance(raw, dict):
            log.warning("ignoring %s: expected an object of profile definitions", path)
            continue
        for name, definition in raw.items():
            if not isinstance(definition, dict):
                continue
            try:
                profiles[name] = _coerce(definition, name, profiles.get(name))
            except (TypeError, ValueError) as exc:
                log.warning("ignoring profile %s in %s: %s", name, path, exc)
    return profiles


def describe(profiles: dict[str, Profile]) -> str:
    """A compact catalogue, used as the router's prompt."""
    return "\n".join(
        f"- {profile.name}: {profile.description}"
        for profile in profiles.values()
        if profile.description
    )
