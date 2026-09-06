"""Shell access, gated behind an explicit user confirmation."""

from __future__ import annotations

import asyncio
import shlex
from typing import Any

from . import ToolContext, tool

# Commands that are never worth running through an assistant, even with a
# confirmation prompt - a typo here is unrecoverable.
BLOCKED = (
    "rm -rf /",
    "mkfs",
    ":(){",
    "dd if=/dev/zero",
    "shutdown",
    "reboot",
    "> /dev/sda",
)


def is_blocked(command: str) -> bool:
    lowered = " ".join(command.lower().split())
    return any(pattern in lowered for pattern in BLOCKED)


@tool(dangerous=True)
async def run_shell(command: str, timeout: int = 30, ctx: ToolContext = None) -> dict[str, Any]:
    """Run a shell command in the workspace. The user has to approve it first.

    Prefer the dedicated tools (files, system status) when they fit; use this
    for one-off commands the other tools do not cover.

    Args:
        command: The command line to run.
        timeout: Seconds before the command is killed.
    """
    if is_blocked(command):
        return {"error": "refused: this command is destructive", "command": command}

    approved = await ctx.request_confirmation("Run shell command", command)
    if not approved:
        return {"error": "the user declined to run this command", "command": command}

    cwd = getattr(ctx.settings, "workspace", None) if ctx.settings else None
    process = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(cwd) if cwd else None,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=max(1, timeout))
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        return {"error": f"timed out after {timeout}s", "command": command}

    def decode(raw: bytes) -> str:
        text = raw.decode("utf-8", errors="replace")
        return text if len(text) <= 20_000 else text[:20_000] + "\n...(truncated)"

    return {
        "command": command,
        "exit_code": process.returncode,
        "stdout": decode(stdout),
        "stderr": decode(stderr),
    }


@tool
def which(program: str) -> str:
    """Check whether a command line program is installed and where it lives.

    Args:
        program: The executable name, e.g. "ffmpeg".
    """
    import shutil

    path = shutil.which(shlex.split(program)[0] if program.strip() else "")
    return path or f"{program} is not installed"
