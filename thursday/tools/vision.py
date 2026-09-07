"""Vision: let Thursday look at the screen or at an image file."""

from __future__ import annotations

import base64
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import ImageResult, ToolContext, ToolError, tool
from .files import resolve

# Claude resizes anything larger, so sending more pixels only costs bandwidth.
MAX_EDGE = 1568
# Hard API limit is 5 MB per image; stay under it with room for base64 overhead.
MAX_BYTES = 3_500_000

MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def media_type_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix not in MEDIA_TYPES:
        raise ToolError(
            f"{path.name} is not an image Claude can read "
            f"(supported: {', '.join(sorted(MEDIA_TYPES))})"
        )
    return MEDIA_TYPES[suffix]


def shrink(path: Path) -> tuple[str, bytes]:
    """Downscale an image to something worth sending. Needs Pillow."""
    try:
        from PIL import Image
    except ImportError:
        raw = path.read_bytes()
        if len(raw) > MAX_BYTES:
            raise ToolError(
                f"{path.name} is {len(raw) // 1_000_000} MB, too large to send. "
                "Install Pillow (pip install 'thursday[vision]') so I can resize it."
            ) from None
        return media_type_for(path), raw

    with Image.open(path) as image:
        image = image.convert("RGB")
        if max(image.size) > MAX_EDGE:
            scale = MAX_EDGE / max(image.size)
            image = image.resize(
                (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                Image.LANCZOS,
            )
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "image.jpg"
            image.save(out, "JPEG", quality=85, optimize=True)
            return "image/jpeg", out.read_bytes()


def encode(path: Path) -> tuple[str, str]:
    media_type, raw = shrink(path)
    return media_type, base64.standard_b64encode(raw).decode("ascii")


def screenshot_command(target: Path, full_screen: bool) -> list[str] | None:
    """The best available screenshot command for this desktop."""
    system = platform.system()
    if system == "Darwin":
        # -x silences the shutter; -i lets the user pick a region.
        return ["screencapture", "-x"] + ([] if full_screen else ["-i"]) + [str(target)]
    if system == "Windows":  # pragma: no cover - handled via Pillow below
        return None

    if shutil.which("grim"):  # Wayland
        return ["grim", str(target)]
    if shutil.which("spectacle"):  # KDE
        return ["spectacle", "-b", "-n", "-o", str(target)]
    if shutil.which("gnome-screenshot"):
        return ["gnome-screenshot", "-f", str(target)]
    if shutil.which("scrot"):
        return ["scrot", str(target)]
    if shutil.which("import"):  # ImageMagick
        return ["import", "-window", "root", str(target)]
    return None


def capture(target: Path, full_screen: bool) -> None:
    command = screenshot_command(target, full_screen)
    if command is None:
        try:  # Windows, or a Linux box with Pillow but no screenshot tool
            from PIL import ImageGrab

            ImageGrab.grab().save(target)
            return
        except Exception as exc:
            raise ToolError(
                "no screenshot tool available - install grim, gnome-screenshot, "
                "scrot or Pillow"
            ) from exc

    result = subprocess.run(command, capture_output=True, timeout=60)
    if result.returncode != 0 or not target.exists():
        raise ToolError(
            f"screenshot failed: {result.stderr.decode('utf-8', 'replace').strip() or 'no output'}"
        )


@tool(dangerous=True)
async def take_screenshot(select_region: bool = False, ctx: ToolContext = None) -> ImageResult:
    """Take a screenshot and look at it.

    Use this when the user asks about something on their screen - an error
    dialog, a chart, "what does this say". Asks permission first, because it
    captures whatever happens to be visible.

    Args:
        select_region: On macOS, let the user drag a region instead of grabbing
            the whole screen.
    """
    approved = await ctx.request_confirmation(
        "Take a screenshot", "Everything currently on screen will be sent to Claude."
    )
    if not approved:
        raise ToolError("the user declined the screenshot")

    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "screen.png"
        capture(target, full_screen=not select_region)
        media_type, data = encode(target)

    return ImageResult(text="Screenshot of the user's display:", images=[(media_type, data)])


@tool
def look_at_image(path: str, ctx: ToolContext = None) -> ImageResult:
    """Look at an image file in the workspace.

    Args:
        path: Path to a .png, .jpg, .gif or .webp file.
    """
    target = resolve(ctx, path)
    if not target.is_file():
        raise ToolError(f"{target} is not a file")
    media_type_for(target)  # reject non-images before reading the bytes
    media_type, data = encode(target)
    return ImageResult(text=f"Image at {target.name}:", images=[(media_type, data)])
