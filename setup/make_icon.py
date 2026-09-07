"""The installer's icon, drawn rather than committed.

An .ico is a handful of bitmaps in a container, and both are simple enough to
write with nothing but struct - which is worth more than the forty lines it
costs. A generated icon can be read, reviewed and changed in a diff; a
committed binary can only be replaced.

What it draws is the reactor core from Thursday's own interface: a bright
ring with a filled centre. So the thing on the taskbar is the thing on the
screen, which is the only reason an icon is worth having.
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

#: The cyan the HUD is built around, and the darker ink behind the core.
RING = (0x4F, 0xD8, 0xFF)
CORE = (0xBF, 0xEF, 0xFF)

#: 256 would have to be stored as PNG to keep the file small, and Windows
#: scales these up perfectly well for the few places that want one.
SIZES = (16, 24, 32, 48, 64, 128)

#: Sampled this many times across each axis. Three is the difference between
#: a ring with stairs in it and one that looks drawn.
SUPERSAMPLE = 3


def coverage(size: int, x: int, y: int, inner: float, outer: float) -> float:
    """How much of one pixel falls inside a ring, from 0 to 1."""
    hits = 0
    for sub_y in range(SUPERSAMPLE):
        for sub_x in range(SUPERSAMPLE):
            point_x = x + (sub_x + 0.5) / SUPERSAMPLE - size / 2
            point_y = y + (sub_y + 0.5) / SUPERSAMPLE - size / 2
            distance = (point_x * point_x + point_y * point_y) ** 0.5
            hits += inner <= distance <= outer
    return hits / (SUPERSAMPLE * SUPERSAMPLE)


def pixels(size: int) -> list[tuple[int, int, int, int]]:
    """The icon at one size, as RGBA rows from the top down."""
    out = []
    for y in range(size):
        for x in range(size):
            ring = coverage(size, x, y, size * 0.30, size * 0.45)
            core = coverage(size, x, y, 0.0, size * 0.16)
            if core > 0:
                red, green, blue = CORE
                alpha = core
            else:
                red, green, blue = RING
                alpha = ring
            out.append((red, green, blue, round(alpha * 255)))
    return out


def bitmap(size: int) -> bytes:
    """One image, in the upside-down BGRA form an .ico stores.

    The header claims twice the real height because the format expects the
    colour image and a 1-bit transparency mask stacked together. The mask is
    left empty - a 32-bit image carries its own alpha, and every Windows
    since XP prefers it - but the space still has to be there.
    """
    rows = pixels(size)
    header = struct.pack(
        "<IiiHHIIiiII",
        40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0,
    )

    body = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            red, green, blue, alpha = rows[y * size + x]
            body += bytes((blue, green, red, alpha))

    # 1 bit per pixel, each row padded out to a multiple of four bytes.
    mask_row = ((size + 31) // 32) * 4
    mask = bytes(mask_row * size)
    return header + bytes(body) + mask


def build(sizes=SIZES) -> bytes:
    """The whole .ico file."""
    images = [bitmap(size) for size in sizes]
    offset = 6 + 16 * len(images)

    directory = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    for size, image in zip(sizes, images):
        directory += struct.pack(
            "<BBBBHHII",
            # 0 means 256 in a byte-wide field, which is the whole reason
            # anything larger has to be stored differently.
            size % 256, size % 256, 0, 0, 1, 32, len(image), offset,
        )
        offset += len(image)

    return bytes(directory) + b"".join(images)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out", nargs="?", default="thursday.ico")
    args = parser.parse_args(argv)

    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(build())
    print(f"wrote {target} ({target.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
