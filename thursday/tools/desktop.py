"""Desktop control: clipboard, volume, media playback, notifications."""

from __future__ import annotations

import platform
import shutil
import subprocess
from typing import Any, Literal

from ..notify import notify_desktop
from . import ToolError, tool

MAX_CLIPBOARD = 20_000


def _run(command: list[str], text_input: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        input=text_input,
        capture_output=True,
        text=True,
        timeout=15,
    )


def _clipboard_commands() -> tuple[list[str], list[str]] | None:
    """Return (read, write) commands for this desktop, or None."""
    system = platform.system()
    if system == "Darwin":
        return (["pbpaste"], ["pbcopy"])
    if system == "Windows":  # pragma: no cover - not exercised on Linux CI
        return (
            ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
            ["clip"],
        )
    if shutil.which("wl-paste") and shutil.which("wl-copy"):  # Wayland
        return (["wl-paste", "--no-newline"], ["wl-copy"])
    if shutil.which("xclip"):
        return (
            ["xclip", "-selection", "clipboard", "-o"],
            ["xclip", "-selection", "clipboard", "-i"],
        )
    if shutil.which("xsel"):
        return (["xsel", "--clipboard", "--output"], ["xsel", "--clipboard", "--input"])
    return None


@tool
def read_clipboard() -> str:
    """Read what the user currently has copied.

    Useful when they say "what does this mean" or "summarise this" without
    pasting anything.
    """
    commands = _clipboard_commands()
    if commands is None:
        raise ToolError(
            "no clipboard tool available (install xclip, xsel or wl-clipboard)"
        )
    result = _run(commands[0])
    if result.returncode != 0:
        raise ToolError(f"could not read the clipboard: {result.stderr.strip()}")
    text = result.stdout
    if not text.strip():
        return "the clipboard is empty"
    return text[:MAX_CLIPBOARD] + ("\n...(truncated)" if len(text) > MAX_CLIPBOARD else "")


@tool
def write_clipboard(text: str) -> str:
    """Copy text to the user's clipboard so they can paste it anywhere.

    Args:
        text: What to put on the clipboard.
    """
    commands = _clipboard_commands()
    if commands is None:
        raise ToolError("no clipboard tool available (install xclip, xsel or wl-clipboard)")
    result = _run(commands[1], text_input=text)
    if result.returncode != 0:
        raise ToolError(f"could not write to the clipboard: {result.stderr.strip()}")
    return f"copied {len(text)} characters to the clipboard"


@tool
def set_volume(level: int) -> str:
    """Set the system output volume.

    Args:
        level: Volume from 0 to 100.
    """
    level = max(0, min(100, level))
    system = platform.system()

    if system == "Darwin":
        result = _run(["osascript", "-e", f"set volume output volume {level}"])
    elif shutil.which("pactl"):
        result = _run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{level}%"])
    elif shutil.which("amixer"):
        result = _run(["amixer", "-q", "sset", "Master", f"{level}%"])
    elif system == "Windows":  # pragma: no cover
        raise ToolError("volume control on Windows needs a helper like nircmd")
    else:
        raise ToolError("no volume control available (install pulseaudio-utils or alsa-utils)")

    if result.returncode != 0:
        raise ToolError(f"could not set the volume: {result.stderr.strip()}")
    return f"volume set to {level}%"


@tool
def media_control(action: Literal["play", "pause", "playpause", "next", "previous", "stop"]) -> str:
    """Control whatever is playing music or video.

    Args:
        action: What to do with the current playback.
    """
    system = platform.system()

    if system == "Darwin":
        # Works for Music.app; Spotify and browsers respond to the same key.
        script = {
            "play": 'tell application "Music" to play',
            "pause": 'tell application "Music" to pause',
            "playpause": 'tell application "Music" to playpause',
            "next": 'tell application "Music" to next track',
            "previous": 'tell application "Music" to previous track',
            "stop": 'tell application "Music" to stop',
        }[action]
        result = _run(["osascript", "-e", script])
    elif shutil.which("playerctl"):
        command = {
            "play": "play",
            "pause": "pause",
            "playpause": "play-pause",
            "next": "next",
            "previous": "previous",
            "stop": "stop",
        }[action]
        result = _run(["playerctl", command])
    else:
        raise ToolError("no media player control available (install playerctl)")

    if result.returncode != 0:
        raise ToolError(f"media control failed: {result.stderr.strip() or 'no player responded'}")
    return f"{action} sent to the media player"


@tool
def show_notification(title: str, message: str) -> str:
    """Put a notification on the user's desktop.

    Use it for something they should see even if they are not looking at this
    window - a finished job, a warning.

    Args:
        title: The notification's heading.
        message: The body text.
    """
    if notify_desktop(title, message):
        return "notification shown"
    return "this system has no desktop notifier; nothing was shown"


@tool
def lock_screen() -> str:
    """Lock the screen."""
    system = platform.system()
    if system == "Darwin":
        command: list[str] = [
            "osascript",
            "-e",
            'tell application "System Events" to keystroke "q" using {command down, control down}',
        ]
    elif shutil.which("loginctl"):
        command = ["loginctl", "lock-session"]
    elif shutil.which("xdg-screensaver"):
        command = ["xdg-screensaver", "lock"]
    elif system == "Windows":  # pragma: no cover
        command = ["rundll32.exe", "user32.dll,LockWorkStation"]
    else:
        raise ToolError("no screen lock command available on this system")

    result = _run(command)
    if result.returncode != 0:
        raise ToolError(f"could not lock the screen: {result.stderr.strip()}")
    return "screen locked"


def desktop_capabilities() -> dict[str, Any]:
    """What of the above actually works here - handy for diagnostics."""
    return {
        "clipboard": _clipboard_commands() is not None,
        "volume": platform.system() == "Darwin"
        or bool(shutil.which("pactl") or shutil.which("amixer")),
        "media": platform.system() == "Darwin" or bool(shutil.which("playerctl")),
        "notifications": platform.system() in {"Darwin", "Windows"}
        or bool(shutil.which("notify-send")),
    }
