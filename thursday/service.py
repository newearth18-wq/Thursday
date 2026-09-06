"""Running Thursday all the time, so it is there before you ask.

Writes the unit file for the platform's own service manager - systemd on
Linux, launchd on macOS - rather than inventing a supervisor. Nothing is
installed without being shown first.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

SYSTEMD_UNIT = """\
[Unit]
Description={name} personal assistant
After=network-online.target

[Service]
Type=simple
ExecStart={python} -m thursday serve
WorkingDirectory={workdir}
Environment=PYTHONUNBUFFERED=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"""

LAUNCHD_PLIST = """\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{python}</string><string>-m</string><string>thursday</string><string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>{workdir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{logdir}/thursday.log</string>
  <key>StandardErrorPath</key><string>{logdir}/thursday.err</string>
</dict>
</plist>
"""


def unit_path() -> Path:
    """Where this platform expects a user service to live."""
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "LaunchAgents" / "com.thursday.assistant.plist"
    return Path.home() / ".config" / "systemd" / "user" / "thursday.service"


def unit_text(name: str = "Thursday", workdir: Path | None = None) -> str:
    """The service definition for this platform."""
    directory = str(workdir or Path.cwd())
    if platform.system() == "Darwin":
        return LAUNCHD_PLIST.format(
            label="com.thursday.assistant",
            python=sys.executable,
            workdir=directory,
            logdir=str(Path.home() / "Library" / "Logs"),
        )
    return SYSTEMD_UNIT.format(name=name, python=sys.executable, workdir=directory)


def enable_commands() -> list[list[str]]:
    """What to run so the service starts now and at login."""
    if platform.system() == "Darwin":
        return [["launchctl", "load", "-w", str(unit_path())]]
    return [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "thursday.service"],
        # Without lingering, a user service stops when you log out.
        ["loginctl", "enable-linger", os.environ.get("USER", "")],
    ]


def supported() -> tuple[bool, str]:
    system = platform.system()
    if system == "Darwin":
        return (shutil.which("launchctl") is not None, "launchctl was not found")
    if system == "Linux":
        return (shutil.which("systemctl") is not None, "systemctl was not found")
    return (False, f"no service manager is wired up for {system} yet")


def install(name: str = "Thursday", workdir: Path | None = None, apply: bool = False) -> str:
    """Write the unit file, and optionally enable it. Returns what happened."""
    ok, why = supported()
    if not ok:
        return f"cannot install a service here: {why}"

    target = unit_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(unit_text(name, workdir), encoding="utf-8")
    lines = [f"wrote {target}"]

    if not apply:
        lines.append("run with --apply to enable it, or enable it yourself with:")
        lines += ["  " + " ".join(command) for command in enable_commands()]
        return "\n".join(lines)

    for command in enable_commands():
        if not command[-1]:
            continue
        result = subprocess.run(command, capture_output=True, text=True)
        state = "ok" if result.returncode == 0 else (result.stderr.strip() or "failed")
        lines.append(f"  {' '.join(command)} — {state}")
    return "\n".join(lines)


def uninstall() -> str:
    target = unit_path()
    if not target.exists():
        return "no service is installed"
    if platform.system() == "Darwin":
        subprocess.run(["launchctl", "unload", "-w", str(target)], capture_output=True)
    else:
        subprocess.run(["systemctl", "--user", "disable", "--now", "thursday.service"],
                       capture_output=True)
    target.unlink()
    return f"removed {target}"
