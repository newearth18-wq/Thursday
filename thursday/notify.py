"""Desktop notifications, so a reminder lands even when the terminal is hidden."""

from __future__ import annotations

import logging
import platform
import shutil
import subprocess

log = logging.getLogger(__name__)


def notify_desktop(title: str, message: str, sound: bool = False) -> bool:
    """Show an OS notification. Returns False when the platform has no way to.

    Never raises: a missing notifier must not take down a reminder.
    """
    system = platform.system()
    try:
        if system == "Darwin":
            script = (
                f'display notification {_applescript(message)} '
                f'with title {_applescript(title)}'
            )
            if sound:
                script += ' sound name "Glass"'
            return _run(["osascript", "-e", script])

        if system == "Windows":  # pragma: no cover - not exercised on Linux CI
            script = (
                "[reflection.assembly]::LoadWithPartialName('System.Windows.Forms') > $null; "
                "$n = New-Object System.Windows.Forms.NotifyIcon; "
                "$n.Icon = [System.Drawing.SystemIcons]::Information; "
                "$n.Visible = $true; "
                f"$n.ShowBalloonTip(5000, '{title}', '{message}', 'Info')"
            )
            return _run(["powershell", "-NoProfile", "-Command", script])

        notifier = shutil.which("notify-send")
        if notifier:
            return _run([notifier, "--app-name=Thursday", title, message])
        terminal_notifier = shutil.which("terminal-notifier")
        if terminal_notifier:
            return _run([terminal_notifier, "-title", title, "-message", message])
    except Exception:  # pragma: no cover - defensive
        log.debug("desktop notification failed", exc_info=True)
    return False


def _run(command: list[str]) -> bool:
    result = subprocess.run(
        command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10
    )
    return result.returncode == 0


def _applescript(text: str) -> str:
    """Quote a string for AppleScript."""
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
