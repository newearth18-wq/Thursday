"""System status tools: the machine Thursday is running on."""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
import time
from typing import Any

from . import tool

try:  # psutil is a hard dependency, but keep the module importable without it
    import psutil
except ImportError:  # pragma: no cover - exercised only on bare installs
    psutil = None  # type: ignore[assignment]


@tool
def system_status() -> dict[str, Any]:
    """Report CPU load, memory, disk and battery for this machine.

    Use for questions like "how is the machine doing" or "how much RAM is free".
    """
    info: dict[str, Any] = {
        "host": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
    }

    if psutil is None:
        info["note"] = "psutil is not installed; only basic information is available"
        usage = shutil.disk_usage(os.path.expanduser("~"))
        info["disk"] = {
            "total_gb": round(usage.total / 1e9, 1),
            "free_gb": round(usage.free / 1e9, 1),
            "percent_used": round(100 * (usage.total - usage.free) / usage.total, 1),
        }
        return info

    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    info["cpu"] = {
        "percent": psutil.cpu_percent(interval=0.3),
        "cores": psutil.cpu_count(logical=True),
        "load_avg": [round(x, 2) for x in os.getloadavg()] if hasattr(os, "getloadavg") else None,
    }
    info["memory"] = {
        "total_gb": round(memory.total / 1e9, 1),
        "available_gb": round(memory.available / 1e9, 1),
        "percent_used": memory.percent,
    }
    info["disk"] = {
        "total_gb": round(disk.total / 1e9, 1),
        "free_gb": round(disk.free / 1e9, 1),
        "percent_used": disk.percent,
    }
    info["uptime_hours"] = round((time.time() - psutil.boot_time()) / 3600, 1)

    battery_fn = getattr(psutil, "sensors_battery", None)
    battery = battery_fn() if battery_fn else None
    if battery is not None:
        info["battery"] = {
            "percent": round(battery.percent),
            "plugged_in": battery.power_plugged,
            "minutes_left": (
                round(battery.secsleft / 60)
                if battery.secsleft not in (None, -1, -2)
                else None
            ),
        }
    return info


@tool
def list_processes(sort_by: str = "cpu", limit: int = 10) -> list[dict[str, Any]]:
    """List the heaviest running processes.

    Args:
        sort_by: Either "cpu" or "memory".
        limit: How many processes to return.
    """
    if psutil is None:
        return [{"error": "psutil is not installed"}]

    key = "cpu_percent" if sort_by.lower().startswith("cpu") else "memory_percent"
    procs: list[dict[str, Any]] = []
    for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent"]):
        try:
            procs.append(
                {
                    "pid": proc.info["pid"],
                    "name": proc.info["name"],
                    "cpu_percent": round(proc.info.get("cpu_percent") or 0.0, 1),
                    "memory_percent": round(proc.info.get("memory_percent") or 0.0, 1),
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda p: p[key], reverse=True)
    return procs[: max(1, min(limit, 50))]


@tool
def open_app(target: str) -> str:
    """Open an application, file, folder or URL with the desktop's default handler.

    Args:
        target: An application name, path or URL, e.g. "https://anthropic.com".
    """
    system = platform.system()
    if system == "Darwin":
        command = ["open", target]
    elif system == "Windows":  # pragma: no cover - not exercised on Linux CI
        command = ["cmd", "/c", "start", "", target]
    else:
        opener = shutil.which("xdg-open") or shutil.which("gio")
        if opener is None:
            return "no desktop opener found (install xdg-utils)"
        command = [opener, "open", target] if opener.endswith("gio") else [opener, target]

    try:
        subprocess.Popen(  # noqa: S603 - the target comes from the user's own request
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        return f"could not open {target}: {exc}"
    return f"opened {target}"
