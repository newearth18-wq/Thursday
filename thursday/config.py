"""Runtime configuration for Thursday.

Everything is read from environment variables (optionally seeded from a `.env`
file next to the project root) so the same settings drive the CLI, the voice
loop and the web server.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path | None = None) -> None:
    """Populate os.environ from a .env file without overriding real env vars."""
    env_path = path or PROJECT_ROOT / ".env"
    try:
        raw = env_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


def wake_words_for(assistant_name: str) -> tuple[str, ...]:
    """What the assistant answers to: its name, plus any configured aliases.

    The name always counts, so renaming the assistant renames the wake word.
    THURSDAY_WAKE_WORDS adds alternatives - useful because speech recognition
    spells a foreign name several ways.
    """
    name = assistant_name.strip().lower()
    raw = os.environ.get("THURSDAY_WAKE_WORDS")
    if raw is None:
        # Only the stock name gets the stock Thai spellings; a renamed
        # assistant would not answer to them.
        aliases: tuple[str, ...] = THAI_ALIASES if name == "thursday" else ()
    else:
        aliases = tuple(word.strip().lower() for word in raw.split(",") if word.strip())
    seen: list[str] = []
    for word in (name, *aliases):
        if word and word not in seen:
            seen.append(word)
    return tuple(seen)


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw).expanduser() if raw else default


#: Thai spellings of "Thursday" that speech recognition tends to produce.
THAI_ALIASES = ("เธิร์สเดย์", "เทิร์สเดย์", "เธิสเดย์")


@dataclass
class VoiceSettings:
    """Wake word, speech-to-text and text-to-speech settings."""

    # Filled in from the assistant's name by Settings.from_env, so renaming
    # the assistant renames what it answers to.
    wake_words: tuple[str, ...] = ()
    # Skip the wake word entirely and treat every utterance as a command.
    always_listening: bool = False
    # Seconds of silence that end an utterance.
    silence_timeout: float = 1.2
    # Maximum length of a single utterance, in seconds.
    max_utterance: float = 20.0
    # RMS threshold (0..1) above which audio counts as speech.
    vad_threshold: float = 0.02
    sample_rate: int = 16000

    stt_backend: str = "faster-whisper"  # faster-whisper | vosk | none
    stt_model: str = "base"
    stt_language: str | None = None  # None = autodetect

    tts_backend: str = "auto"  # auto | piper | say | espeak | pyttsx3 | none
    tts_voice: str = ""
    tts_rate: int = 175

    @classmethod
    def from_env(cls, assistant_name: str = "Thursday") -> "VoiceSettings":
        return cls(
            wake_words=wake_words_for(assistant_name),
            always_listening=_env_bool("THURSDAY_ALWAYS_LISTENING", False),
            silence_timeout=_env_float("THURSDAY_SILENCE_TIMEOUT", 1.2),
            max_utterance=_env_float("THURSDAY_MAX_UTTERANCE", 20.0),
            vad_threshold=_env_float("THURSDAY_VAD_THRESHOLD", 0.02),
            sample_rate=_env_int("THURSDAY_SAMPLE_RATE", 16000),
            stt_backend=os.environ.get("THURSDAY_STT_BACKEND", "faster-whisper"),
            stt_model=os.environ.get("THURSDAY_STT_MODEL", "base"),
            stt_language=os.environ.get("THURSDAY_STT_LANGUAGE") or None,
            tts_backend=os.environ.get("THURSDAY_TTS_BACKEND", "auto"),
            tts_voice=os.environ.get("THURSDAY_TTS_VOICE", ""),
            tts_rate=_env_int("THURSDAY_TTS_RATE", 175),
        )


@dataclass
class Settings:
    """Top-level settings shared by every front end."""

    # Which backend serves the default profile: "anthropic", a preset such as
    # "openai" / "gemini" / "ollama" / "lmstudio", or "custom" with a base_url.
    provider: str = "anthropic"
    # Overrides the provider's own key environment variable when set.
    api_key: str = ""
    # Points a provider at a different endpoint - a proxy, a second machine.
    base_url: str = ""

    # Which profile handles a turn when nothing else decides.
    profile: str = "default"
    # off | keyword | llm
    routing: str = "keyword"
    classifier_provider: str = "anthropic"
    classifier_model: str = "claude-haiku-4-5"

    # Empty means "whatever the resolved provider defaults to"; setting it
    # pins the model for every profile that does not pin one itself.
    model: str = ""
    max_tokens: int = 16000
    # low | medium | high | xhigh | max - medium keeps a conversational
    # assistant responsive; raise it for research-heavy work.
    effort: str = "medium"
    thinking: bool = True
    # Stream a summary of Claude's reasoning to the front end.
    show_thinking: bool = False

    assistant_name: str = "Thursday"
    user_name: str = "sir"
    language_hint: str = "Match the language the user speaks (Thai or English)."

    data_dir: Path = field(default_factory=lambda: PROJECT_ROOT / "data")
    plugin_dirs: tuple[Path, ...] = field(default_factory=lambda: (PROJECT_ROOT / "plugins",))

    # Filesystem tools may not escape this root.
    workspace: Path = field(default_factory=lambda: PROJECT_ROOT)
    # Shell/file-write tools ask the front end for confirmation first.
    require_confirmation: bool = True
    allow_shell: bool = True
    enable_web_search: bool = True

    # Stop before starting a turn once today's spend passes this many US
    # dollars. Zero means no limit. Only counts models with a known price.
    daily_budget: float = 0.0
    # Show what each turn cost as it finishes.
    show_cost: bool = False

    max_tool_iterations: int = 12
    history_turns: int = 40

    host: str = "127.0.0.1"
    port: int = 8765

    voice: VoiceSettings = field(default_factory=VoiceSettings)

    def __post_init__(self) -> None:
        # Derive the wake words here rather than only in from_env, so a
        # Settings built in code still answers to its own name.
        if not self.voice.wake_words:
            self.voice.wake_words = wake_words_for(self.assistant_name)

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        assistant_name = os.environ.get("THURSDAY_NAME", "Thursday")
        plugin_raw = os.environ.get("THURSDAY_PLUGIN_DIRS", "")
        plugin_dirs = tuple(
            Path(p).expanduser() for p in plugin_raw.split(os.pathsep) if p.strip()
        ) or (PROJECT_ROOT / "plugins",)
        provider = os.environ.get("THURSDAY_PROVIDER", "anthropic").strip().lower()
        return cls(
            provider=provider,
            api_key=os.environ.get("THURSDAY_API_KEY", ""),
            base_url=os.environ.get("THURSDAY_BASE_URL", ""),
            profile=os.environ.get("THURSDAY_PROFILE", "default"),
            routing=os.environ.get("THURSDAY_ROUTING", "keyword"),
            classifier_provider=os.environ.get("THURSDAY_CLASSIFIER_PROVIDER", "anthropic"),
            classifier_model=os.environ.get("THURSDAY_CLASSIFIER_MODEL", "claude-haiku-4-5"),
            model=os.environ.get("THURSDAY_MODEL", ""),
            max_tokens=_env_int("THURSDAY_MAX_TOKENS", 16000),
            effort=os.environ.get("THURSDAY_EFFORT", "medium"),
            thinking=_env_bool("THURSDAY_THINKING", True),
            show_thinking=_env_bool("THURSDAY_SHOW_THINKING", False),
            assistant_name=assistant_name,
            user_name=os.environ.get("THURSDAY_USER_NAME", "sir"),
            language_hint=os.environ.get(
                "THURSDAY_LANGUAGE_HINT",
                "Match the language the user speaks (Thai or English).",
            ),
            data_dir=_env_path("THURSDAY_DATA_DIR", PROJECT_ROOT / "data"),
            plugin_dirs=plugin_dirs,
            workspace=_env_path("THURSDAY_WORKSPACE", PROJECT_ROOT),
            require_confirmation=_env_bool("THURSDAY_REQUIRE_CONFIRMATION", True),
            allow_shell=_env_bool("THURSDAY_ALLOW_SHELL", True),
            enable_web_search=_env_bool("THURSDAY_ENABLE_WEB_SEARCH", True),
            daily_budget=_env_float("THURSDAY_DAILY_BUDGET", 0.0),
            show_cost=_env_bool("THURSDAY_SHOW_COST", False),
            max_tool_iterations=_env_int("THURSDAY_MAX_TOOL_ITERATIONS", 12),
            history_turns=_env_int("THURSDAY_HISTORY_TURNS", 40),
            host=os.environ.get("THURSDAY_HOST", "127.0.0.1"),
            port=_env_int("THURSDAY_PORT", 8765),
            voice=VoiceSettings.from_env(assistant_name),
        )

    @property
    def db_path(self) -> Path:
        return self.data_dir / "thursday.db"

    @property
    def mcp_paths(self) -> tuple[Path, ...]:
        """Where MCP server definitions may live; the first hit wins."""
        override = os.environ.get("THURSDAY_MCP_CONFIG")
        if override:
            return (Path(override).expanduser(),)
        return (PROJECT_ROOT / "mcp.json", self.data_dir / "mcp.json")

    @property
    def pricing_paths(self) -> tuple[Path, ...]:
        """Where a user-supplied price table may live."""
        override = os.environ.get("THURSDAY_PRICING")
        if override:
            return (Path(override).expanduser(),)
        return (PROJECT_ROOT / "pricing.json", self.data_dir / "pricing.json")

    @property
    def profile_paths(self) -> tuple[Path, ...]:
        """Where profiles.json may live, later files winning."""
        override = os.environ.get("THURSDAY_PROFILES")
        if override:
            return (Path(override).expanduser(),)
        return (PROJECT_ROOT / "profiles.json", self.data_dir / "profiles.json")

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
