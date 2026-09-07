"""Putting Thursday on a phone in one scan.

The web UI is already a phone app - a manifest, an icon, a layout that
respects the notch. What stood between someone and using it was the boring
part: find the machine's address on the network, type it into a phone
browser, then type in a 32-character token.

So: `thursday pair` prints a QR code carrying both. Scan it, the browser
opens, the token goes in from the URL, and "Add to Home Screen" makes it an
app. No store, no build, no APK.

Two things this is honest about.

**The token is in the QR code.** That is the point - it is what makes it one
scan rather than two steps - but it means the QR code is a key, and one that
does not expire. Anyone who photographs your screen has your assistant. It is
printed to be scanned and then let scroll away, not to be put on a wiki, and
the way to revoke it is to change the token. The page takes it out of the
address bar the moment it is used, so it does not sit in the phone's history.

**Android runs the client, not the assistant.** Thursday needs a real Python,
a filesystem and long-running processes; a phone gives none of those
comfortably. The phone talks to the machine, which is also why the reminders
and the shell keep working when the phone is in a pocket.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote


class PairingError(Exception):
    """The phone cannot be pointed at anything useful."""


def local_addresses() -> list[str]:
    """This machine's addresses on the network, best guess first.

    A phone cannot reach 127.0.0.1, so the loopback address the server prints
    at startup is exactly the one that does not work here.
    """
    found: list[str] = []

    # Asking the routing table which address would be used to reach the
    # outside world. No packet is sent - UDP connect only picks a route - and
    # it answers correctly on a machine with several interfaces, which
    # gethostbyname does not.
    for probe in ("8.8.8.8", "1.1.1.1"):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect((probe, 80))
            found.append(sock.getsockname()[0])
            break
        except OSError:
            continue
        finally:
            sock.close()

    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except socket.gaierror:
        pass

    seen: list[str] = []
    for address in found:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if parsed.is_loopback or parsed.is_link_local:
            continue
        if address not in seen:
            seen.append(address)
    return seen


@dataclass
class Pairing:
    """Where a phone should point, and what to say when it gets there."""

    url: str
    token: str = ""
    addresses: tuple[str, ...] = ()

    @property
    def link(self) -> str:
        """The URL with the token in it, which is what goes in the QR code."""
        # safe="" because this is a query value, not a path: quote() leaves
        # "/" alone by default, and a token someone chose themselves can
        # contain anything at all.
        return (
            f"{self.url}/?t={quote(self.token, safe='')}" if self.token else f"{self.url}/"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "link": self.link,
            "addresses": list(self.addresses),
            "has_token": bool(self.token),
        }


def build(host: str = "", port: int = 8765, token: str = "") -> Pairing:
    """Work out what a phone on the same network should open."""
    addresses = local_addresses()
    chosen = host or (addresses[0] if addresses else "")
    if not chosen:
        raise PairingError(
            "this machine has no network address a phone could reach. "
            "Connect it to the same wifi as the phone and try again."
        )
    return Pairing(url=f"http://{chosen}:{port}", token=token, addresses=tuple(addresses))


def qr_lines(text: str) -> list[str]:
    """The QR code as lines of text, or an empty list if it cannot be drawn.

    Half-block characters, so a code that would be 41 rows tall fits in 21 -
    which is the difference between a terminal you can scan and one you have
    to scroll.
    """
    try:
        import qrcode
    except ImportError:
        return []

    code = qrcode.QRCode(border=1)
    code.add_data(text)
    code.make(fit=True)
    grid = code.get_matrix()

    lines = []
    for top in range(0, len(grid), 2):
        upper = grid[top]
        lower = grid[top + 1] if top + 1 < len(grid) else [False] * len(upper)
        row = ""
        for left, right in zip(upper, lower):
            # Dark modules are drawn as background, because a phone camera
            # wants dark-on-light and a terminal is usually the other way
            # round. Inverting here is what makes it scan at all.
            if left and right:
                row += " "
            elif left:
                row += "▄"      # lower half
            elif right:
                row += "▀"      # upper half
            else:
                row += "█"      # full
        lines.append(row)
    return lines


def instructions(pairing: Pairing, has_qr: bool) -> list[str]:
    """What to tell the person, in the order they need it."""
    lines = []
    if has_qr:
        lines.append("Scan this with your phone's camera.")
    else:
        lines.append("Open this on your phone:")
        lines.append(f"    {pairing.link}")
        lines.append("")
        lines.append("(For a QR code instead: pip install qrcode)")
    lines += [
        "",
        "Then: Share -> Add to Home Screen. It becomes an app.",
        "",
        f"The phone must be on the same wifi as this machine ({pairing.addresses[0]})."
        if pairing.addresses else "",
    ]
    if pairing.token:
        lines += [
            "",
            "This code carries your access token, so treat it as a key:",
            "scan it and let it scroll away rather than leaving it on screen.",
        ]
    return [line for line in lines if line or lines.index(line) != len(lines) - 1]
