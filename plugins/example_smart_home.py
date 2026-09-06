"""Example plugin: drop a file like this into plugins/ and Thursday picks it up.

Every function decorated with @tool becomes a capability at the next start.
This one fakes a few smart-home devices; swap the bodies for real calls to
Home Assistant, Hue, MQTT or whatever you run.
"""

from __future__ import annotations

from typing import Literal

from thursday.tools import ToolError, tool

# Stand-in for real hardware.
_DEVICES: dict[str, dict[str, object]] = {
    "living room light": {"on": False, "brightness": 80},
    "bedroom light": {"on": False, "brightness": 40},
    "air conditioner": {"on": False, "temperature": 25},
}


@tool
def list_devices() -> dict[str, dict[str, object]]:
    """List the smart-home devices and their current state."""
    return _DEVICES


@tool
def set_device(
    device: str,
    state: Literal["on", "off"],
    brightness: int | None = None,
) -> str:
    """Turn a smart-home device on or off.

    Args:
        device: The device name, e.g. "living room light".
        state: Whether to turn it on or off.
        brightness: Optional brightness for lights, 0-100.
    """
    key = device.strip().lower()
    if key not in _DEVICES:
        raise ToolError(f"no device called {device!r}; known devices: {', '.join(_DEVICES)}")
    _DEVICES[key]["on"] = state == "on"
    if brightness is not None and "brightness" in _DEVICES[key]:
        _DEVICES[key]["brightness"] = max(0, min(100, brightness))
    return f"{device} is now {state}"
