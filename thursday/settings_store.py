"""Settings you can change from the Thursday page, without editing files.

The field list below is the single source of truth: the API serves it, the web
UI builds its form from it, and validation happens against it. Adding a
setting means adding one entry here.

Values are written to `data/settings.json` and applied as environment
variables, which is how the rest of Thursday already reads its configuration -
so a change made in the browser reaches providers, profiles and tools by the
same path as a variable exported in a shell. The overlay is applied last, so
what you set in the UI wins over `.env` and over the environment.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

#: Anything whose value must never be sent back to the browser.
SECRET_SUFFIXES = ("_API_KEY", "_AUTH_TOKEN", "_TOKEN")


@dataclass(frozen=True)
class Field:
    """One editable setting."""

    key: str                      # the environment variable it sets
    label: str
    group: str
    kind: str = "text"            # text | password | number | bool | choice | path
    choices: tuple[str, ...] = ()
    placeholder: str = ""
    help: str = ""
    #: Dotted path to the matching attribute on Settings, so the form can show
    #: the real default instead of guessing. Without it a bool would render as
    #: off and a choice as its first option - and saving would then quietly
    #: write that wrong value back.
    attr: str = ""

    @property
    def secret(self) -> bool:
        return self.kind == "password" or self.key.endswith(SECRET_SUFFIXES)

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["choices"] = list(self.choices)
        payload["secret"] = self.secret
        return payload


PROVIDERS = (
    "anthropic", "openai", "gemini", "groq", "openrouter", "deepseek",
    "mistral", "xai", "together", "ollama", "lmstudio", "llamacpp", "vllm", "custom",
)
EFFORTS = ("low", "medium", "high", "xhigh", "max")

FIELDS: tuple[Field, ...] = (
    # ---- who it is -------------------------------------------------------
    Field("THURSDAY_NAME", "Name", "Identity", placeholder="Thursday",
          help="Also becomes the wake word.", attr="assistant_name"),
    Field("THURSDAY_USER_NAME", "Call me", "Identity", placeholder="sir", attr="user_name"),
    Field("THURSDAY_LANGUAGE_HINT", "Language", "Identity",
          placeholder="Match the language the user speaks (Thai or English).", attr="language_hint"),

    # ---- the brain -------------------------------------------------------
    Field("THURSDAY_PROVIDER", "Provider", "Model", kind="choice", choices=PROVIDERS,
          help="Local runners (ollama, lmstudio, llamacpp, vllm) need no key.", attr="provider"),
    Field("THURSDAY_MODEL", "Model", "Model", placeholder="provider default",
          help="Empty means the provider's own default.", attr="model"),
    Field("THURSDAY_BASE_URL", "Base URL", "Model", placeholder="http://localhost:11434/v1",
          help="For `custom`, or to point a provider at another host.", attr="base_url"),
    Field("THURSDAY_EFFORT", "Effort", "Model", kind="choice", choices=EFFORTS, attr="effort"),
    Field("THURSDAY_MAX_TOKENS", "Max tokens", "Model", kind="number", placeholder="16000", attr="max_tokens"),
    Field("THURSDAY_THINKING", "Thinking", "Model", kind="bool", attr="thinking"),
    Field("THURSDAY_SHOW_THINKING", "Show reasoning", "Model", kind="bool", attr="show_thinking"),

    # ---- keys ------------------------------------------------------------
    Field("ANTHROPIC_API_KEY", "Anthropic", "API keys", kind="password", placeholder="sk-ant-…"),
    Field("OPENAI_API_KEY", "OpenAI", "API keys", kind="password"),
    Field("GEMINI_API_KEY", "Gemini", "API keys", kind="password"),
    Field("GROQ_API_KEY", "Groq", "API keys", kind="password"),
    Field("OPENROUTER_API_KEY", "OpenRouter", "API keys", kind="password"),
    Field("DEEPSEEK_API_KEY", "DeepSeek", "API keys", kind="password"),
    Field("MISTRAL_API_KEY", "Mistral", "API keys", kind="password"),
    Field("XAI_API_KEY", "xAI", "API keys", kind="password"),
    Field("TOGETHER_API_KEY", "Together", "API keys", kind="password"),

    # ---- which agent for which job --------------------------------------
    Field("THURSDAY_PROFILE", "Default profile", "Agents", placeholder="default", attr="profile"),
    Field("THURSDAY_ROUTING", "Routing", "Agents", kind="choice",
          choices=("off", "keyword", "llm"), attr="routing",
          help="How a profile is chosen per turn."),
    Field("THURSDAY_CLASSIFIER_PROVIDER", "Router provider", "Agents", kind="choice", choices=PROVIDERS, attr="classifier_provider"),
    Field("THURSDAY_CLASSIFIER_MODEL", "Router model", "Agents", placeholder="claude-haiku-4-5", attr="classifier_model"),
    Field("THURSDAY_HISTORY_TURNS", "History window", "Agents", kind="number", placeholder="40", attr="history_turns"),
    Field("THURSDAY_REFLECT_HOURS", "Learn about me every", "Agents", kind="number",
          placeholder="0", attr="reflect_hours",
          help="Hours between reviewing recent conversation for things worth remembering. 0 is off."),
    Field("THURSDAY_MAX_TOOL_ITERATIONS", "Tool steps per turn", "Agents", kind="number", placeholder="12", attr="max_tool_iterations"),

    # ---- documents -------------------------------------------------------
    Field("THURSDAY_EMBED_PROVIDER", "Embeddings", "Documents", kind="choice",
          choices=("ollama", "lmstudio", "llamacpp", "openai", "gemini", "together"),
          help="Local by default, so your documents never leave the machine."),
    Field("THURSDAY_EMBED_MODEL", "Embedding model", "Documents", placeholder="nomic-embed-text"),
    Field("THURSDAY_EMBED_BASE_URL", "Embedding endpoint", "Documents",
          placeholder="http://localhost:11434/v1"),
    Field("THURSDAY_EMBED_API_KEY", "Embedding key", "Documents", kind="password",
          help="Only for a hosted embedding provider."),

    # ---- calendar and mail ------------------------------------------------
    Field("THURSDAY_CALENDARS", "Calendar feeds", "Connected",
          placeholder="https://…/basic.ics, ~/cal.ics",
          help="One or more .ics URLs or files, comma separated. Every calendar app publishes one."),
    Field("THURSDAY_IMAP_HOST", "Mail server", "Connected", placeholder="imap.gmail.com"),
    Field("THURSDAY_IMAP_USER", "Mail user", "Connected", placeholder="you@example.com"),
    Field("THURSDAY_IMAP_PASSWORD", "Mail password", "Connected", kind="password",
          help="Gmail and Outlook need an app password, not your account password."),
    Field("THURSDAY_IMAP_FOLDER", "Mail folder", "Connected", placeholder="INBOX"),
    Field("THURSDAY_SMTP_HOST", "Outgoing mail", "Connected", placeholder="smtp.gmail.com",
          help="Needed only to send approved drafts. Leave empty and Thursday still writes them."),
    Field("THURSDAY_SMTP_PORT", "Outgoing port", "Connected", kind="number", placeholder="587"),
    Field("THURSDAY_SMTP_USER", "Outgoing user", "Connected",
          placeholder="same as the mail user"),
    Field("THURSDAY_SMTP_PASSWORD", "Outgoing password", "Connected", kind="password",
          help="Leave empty to reuse the mail password."),
    Field("THURSDAY_SMTP_FROM", "Send as", "Connected", placeholder="you@example.com"),
    Field("THURSDAY_SMTP_FROM_NAME", "Your name", "Connected", placeholder="Supakit"),

    # ---- from a phone ----------------------------------------------------
    Field("THURSDAY_LINE_TOKEN", "LINE channel token", "Chat", kind="password",
          help="From the LINE Developers console. Webhook URL: https://your-host/hooks/line"),
    Field("THURSDAY_LINE_SECRET", "LINE channel secret", "Chat", kind="password",
          help="Used to check each delivery really came from LINE."),
    Field("THURSDAY_LINE_ALLOW", "LINE ids allowed", "Chat", placeholder="U1234…",
          help="Your own user id. Empty means nobody — an open bot is an open shell."),
    Field("THURSDAY_TELEGRAM_TOKEN", "Telegram bot token", "Chat", kind="password",
          help="From @BotFather. Webhook URL: https://your-host/hooks/telegram"),
    Field("THURSDAY_TELEGRAM_SECRET", "Telegram hook secret", "Chat", kind="password",
          help="The secret_token you passed to setWebhook."),
    Field("THURSDAY_TELEGRAM_ALLOW", "Telegram ids allowed", "Chat", placeholder="123456789"),
    Field("THURSDAY_CHAT_PROFILE", "Chat profile", "Chat", placeholder="chat",
          help="Which profile phone messages run under. `chat` has no shell and no file writing."),

    # ---- who may use it --------------------------------------------------
    Field("THURSDAY_AUTH", "Require token", "Access", kind="choice",
          choices=("off", "remote", "always"), attr="auth",
          help="remote: a browser on this machine is trusted, anything else needs the token."),
    Field("THURSDAY_ACCESS_TOKEN", "Access token", "Access", kind="password",
          help="Generated on first use if empty. This is what actually keeps others out."),
    Field("THURSDAY_IDENTITY", "Recognise me by", "Access", kind="choice",
          choices=("off", "face", "voice", "either", "both"), attr="identity",
          help="Identification, not security: a photo or a recording can pass it."),

    # ---- what it may do --------------------------------------------------
    Field("THURSDAY_WORKSPACE", "Workspace", "Safety", kind="path",
          help="File tools cannot leave this directory.", attr="workspace"),
    Field("THURSDAY_REQUIRE_CONFIRMATION", "Ask before risky tools", "Safety", kind="bool", attr="require_confirmation"),
    Field("THURSDAY_ALLOW_SHELL", "Allow shell", "Safety", kind="bool", attr="allow_shell"),
    Field("THURSDAY_ENABLE_WEB_SEARCH", "Web search", "Safety", kind="bool", attr="enable_web_search"),
    Field("THURSDAY_BROWSER_VISIBLE", "Show the browser", "Safety", kind="bool",
          attr="browser_visible", help="Watch what it does rather than letting it work unseen."),
    Field("THURSDAY_BROWSER_BINARY", "Browser binary", "Safety", kind="path",
          help="Leave empty for Playwright's own Chromium; set it to use a system Chrome."),
    Field("THURSDAY_PERMISSIONS", "Permissions file", "Safety", kind="path",
          placeholder="./permissions.json",
          help="Which paths are off limits and which tools may run. See permissions.example.json."),

    # ---- money -----------------------------------------------------------
    Field("THURSDAY_DAILY_BUDGET", "Daily budget (USD)", "Spending", kind="number",
          placeholder="0", help="0 means no limit.", attr="daily_budget"),
    Field("THURSDAY_SHOW_COST", "Show cost per turn", "Spending", kind="bool", attr="show_cost"),

    # ---- voice -----------------------------------------------------------
    Field("THURSDAY_WAKE_WORDS", "Extra wake words", "Voice",
          placeholder="เธิร์สเดย์,เทิร์สเดย์", help="Added to the name, comma separated."),
    Field("THURSDAY_ALWAYS_LISTENING", "No wake word needed", "Voice", kind="bool", attr="voice.always_listening"),
    Field("THURSDAY_STT_BACKEND", "Speech in", "Voice", kind="choice",
          choices=("faster-whisper", "vosk", "whisper.cpp", "none"), attr="voice.stt_backend"),
    Field("THURSDAY_STT_MODEL", "Speech model", "Voice", placeholder="base", attr="voice.stt_model"),
    Field("THURSDAY_STT_LANGUAGE", "Speech language", "Voice", placeholder="auto-detect", attr="voice.stt_language"),
    Field("THURSDAY_TTS_BACKEND", "Speech out", "Voice", kind="choice",
          choices=("auto", "piper", "say", "espeak", "pyttsx3", "none"), attr="voice.tts_backend"),
    Field("THURSDAY_TTS_VOICE", "Voice", "Voice", attr="voice.tts_voice"),
    Field("THURSDAY_TTS_RATE", "Speech rate", "Voice", kind="number", placeholder="175", attr="voice.tts_rate"),
)

FIELDS_BY_KEY = {entry.key: entry for entry in FIELDS}
GROUPS = tuple(dict.fromkeys(entry.group for entry in FIELDS))

#: Written back masked, never in the clear.
MASK = "••••••••"


def _default_settings() -> Any:
    """A Settings built from its own defaults, with no environment involved."""
    from .config import Settings

    saved = {key: os.environ.pop(key) for key in list(FIELDS_BY_KEY) if key in os.environ}
    try:
        return Settings()
    finally:
        os.environ.update(saved)


def default_for(entry: Field, defaults: Any = None) -> str:
    """The value a setting has when nothing is configured, as text."""
    if not entry.attr:
        return ""
    target = defaults if defaults is not None else _default_settings()
    for part in entry.attr.split("."):
        target = getattr(target, part, None)
        if target is None:
            return ""
    if isinstance(target, bool):
        return "1" if target else "0"
    if isinstance(target, (tuple, list)):
        return ",".join(str(item) for item in target)
    return str(target)


def overlay_path() -> Path:
    """Where the editable settings live.

    Resolved from the environment alone, because it has to be known before
    the settings themselves are built.
    """
    override = os.environ.get("THURSDAY_SETTINGS")
    if override:
        return Path(override).expanduser()
    data_dir = os.environ.get("THURSDAY_DATA_DIR")
    root = Path(data_dir).expanduser() if data_dir else PROJECT_ROOT / "data"
    return root / "settings.json"


def load_overlay(path: Path | None = None) -> dict[str, str]:
    """Read the saved settings. A broken file is ignored, not fatal."""
    target = path or overlay_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): str(value)
        for key, value in raw.items()
        if key in FIELDS_BY_KEY and value is not None
    }


def save_overlay(values: dict[str, str], path: Path | None = None) -> Path:
    """Persist settings, readable only by this user - it holds API keys."""
    target = path or overlay_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    cleaned = {
        key: str(value)
        for key, value in values.items()
        if key in FIELDS_BY_KEY and value is not None and str(value) != ""
    }
    target.write_text(json.dumps(cleaned, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        target.chmod(0o600)
    except OSError:  # a filesystem without permissions; not worth failing over
        log.debug("could not restrict permissions on %s", target)
    return target


def apply_overlay(path: Path | None = None) -> dict[str, str]:
    """Push saved settings into the environment, where everything reads them.

    Applied after `.env`, so a change made in the UI wins - the alternative is
    a setting that visibly does nothing because a stale variable outranks it.
    """
    values = load_overlay(path)
    for key, value in values.items():
        os.environ[key] = value
    return values


def update(changes: dict[str, Any], path: Path | None = None) -> dict[str, str]:
    """Merge changes into the saved settings and apply them.

    An empty string clears a setting, so a key can be removed from the UI.
    """
    values = load_overlay(path)
    for key, value in changes.items():
        if key not in FIELDS_BY_KEY:
            continue
        text = "" if value is None else str(value)
        if text == MASK:
            continue  # the page echoed back a masked secret; leave it alone
        if text == "":
            values.pop(key, None)
            os.environ.pop(key, None)
        else:
            values[key] = text
    save_overlay(values, path)
    apply_overlay(path)
    return values


def validate(changes: dict[str, Any]) -> list[str]:
    """Reasons the given changes cannot be saved."""
    problems: list[str] = []
    for key, value in changes.items():
        entry = FIELDS_BY_KEY.get(key)
        if entry is None:
            problems.append(f"unknown setting: {key}")
            continue
        text = "" if value is None else str(value).strip()
        if not text:
            continue
        if entry.kind == "number":
            try:
                float(text)
            except ValueError:
                problems.append(f"{entry.label} must be a number")
        elif entry.kind == "choice" and text not in entry.choices:
            problems.append(f"{entry.label} must be one of: {', '.join(entry.choices)}")
        elif entry.kind == "bool" and text.lower() not in {"0", "1", "true", "false", "yes", "no", "on", "off"}:
            problems.append(f"{entry.label} must be true or false")
    return problems


def describe(fields: Iterable[Field] | None = None) -> dict[str, Any]:
    """The form the UI draws, with current values and secrets masked."""
    saved = load_overlay()
    entries = list(fields or FIELDS)
    defaults = _default_settings()
    payload = []
    for entry in entries:
        configured = os.environ.get(entry.key, "")
        fallback = default_for(entry, defaults)
        # Show what is actually in force. Without the fallback the form would
        # render a bool as off and a choice as its first option, and saving
        # would write that back as if the user had chosen it.
        effective = configured or fallback
        payload.append(
            {
                **entry.as_dict(),
                # A secret is reported as set or not, never echoed back.
                "value": (MASK if configured else "") if entry.secret else effective,
                "default": "" if entry.secret else fallback,
                "set": bool(configured),
                # Whether this value came from the UI or from the environment,
                # so the page can say where a setting is coming from.
                "source": "settings" if entry.key in saved else ("env" if configured else "default"),
            }
        )
    return {"groups": list(dict.fromkeys(entry.group for entry in entries)), "fields": payload}
