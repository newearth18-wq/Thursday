"""Running Thursday all the time, so it is there before you ask.

Writes the unit file for the platform's own service manager - systemd on
Linux, launchd on macOS, Task Scheduler on Windows - rather than inventing a
supervisor. Nothing is installed without being shown first.
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


#: Windows has no systemd. The nearest equivalent a normal user can reach
#: without administrator rights is a Task Scheduler entry that runs at logon -
#: which is also what most Windows startup programs actually are.
#:
#: XML rather than the shorter `schtasks /create` form because that one cannot
#: express "restart if it stops" or "run even on battery", and a laptop
#: assistant that dies when the power is unplugged is not much of one.
WINDOWS_TASK = """\
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{name}, a personal assistant</Description>
    <URI>\\{name}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT20S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{python}</Command>
      <Arguments>-m thursday serve</Arguments>
      <WorkingDirectory>{workdir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""

#: The task's name in Task Scheduler, which is also how it is deleted.
WINDOWS_TASK_NAME = "Thursday"


def unit_path() -> Path:
    """Where this platform expects a user service to live."""
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "LaunchAgents" / "com.thursday.assistant.plist"
    if platform.system() == "Windows":
        # Task Scheduler keeps the real definition itself; this is the file
        # handed to schtasks, kept somewhere the user can read it back.
        return Path(
            os.environ.get("LOCALAPPDATA", str(Path.home()))
        ) / "Thursday" / "thursday-task.xml"
    return Path.home() / ".config" / "systemd" / "user" / "thursday.service"


def unit_text(name: str = "Thursday", workdir: Path | None = None) -> str:
    """The service definition for this platform."""
    directory = str(workdir or Path.cwd())
    if platform.system() == "Windows":
        # pythonw.exe runs it without a console window, which is what anyone
        # expects of something that starts with their machine.
        runner = sys.executable
        windowless = Path(runner).with_name("pythonw.exe")
        return WINDOWS_TASK.format(
            name=name,
            python=str(windowless if windowless.exists() else runner),
            workdir=directory,
        )
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
    if platform.system() == "Windows":
        return [
            ["schtasks", "/Create", "/TN", WINDOWS_TASK_NAME,
             "/XML", str(unit_path()), "/F"],
            ["schtasks", "/Run", "/TN", WINDOWS_TASK_NAME],
        ]
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
    if system == "Windows":
        return (shutil.which("schtasks") is not None, "schtasks was not found")
    return (False, f"no service manager is wired up for {system} yet")


def install(name: str = "Thursday", workdir: Path | None = None, apply: bool = False) -> str:
    """Write the unit file, and optionally enable it. Returns what happened."""
    ok, why = supported()
    if not ok:
        return f"cannot install a service here: {why}"

    target = unit_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    # Task Scheduler will not read a task file in anything but UTF-16, and
    # says so with an error that names neither the file nor the encoding.
    encoding = "utf-16" if platform.system() == "Windows" else "utf-8"
    target.write_text(unit_text(name, workdir), encoding=encoding)
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
    if platform.system() == "Windows":
        subprocess.run(
            ["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], capture_output=True
        )
    elif platform.system() == "Darwin":
        subprocess.run(["launchctl", "unload", "-w", str(target)], capture_output=True)
    else:
        subprocess.run(["systemctl", "--user", "disable", "--now", "thursday.service"],
                       capture_output=True)
    target.unlink()
    return f"removed {target}"
