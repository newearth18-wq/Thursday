"""Who may talk to Thursday.

This is the actual security boundary: a shared access token, checked before
any request reaches the assistant. Face and voice recognition (identity.py)
sit *on top* of this and answer a different question - "which person is this"
- because a photograph or a recording defeats them, and nothing that can be
held up to a camera should be what protects an API key.

By default a browser on this machine is trusted and anything else must present
the token, so local use stays frictionless while an exposed port does not hand
the assistant to the network.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
import time
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

COOKIE = "thursday_session"
#: Requests from these hosts are treated as coming from this machine.
LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost", "testclient"})

#: off - anyone who can reach the port; remote - the token is needed from
#: anywhere but this machine; always - the token is needed even locally.
MODES = ("off", "remote", "always")

MAX_FAILURES = 8
LOCKOUT_SECONDS = 300


def is_loopback(host: str | None) -> bool:
    return (host or "") in LOOPBACK


def generate_token() -> str:
    """A token short enough to type off a screen, long enough to be a secret."""
    return secrets.token_urlsafe(24)


@dataclass
class Gate:
    """Decides whether a request may proceed, and remembers who is let in."""

    token: str = ""
    mode: str = "remote"
    #: Session ids handed out after a successful login.
    sessions: set[str] = field(default_factory=set)
    #: Failed attempts per client, for the lockout.
    failures: dict[str, list[float]] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Gate":
        mode = os.environ.get("THURSDAY_AUTH", "remote").strip().lower()
        return cls(
            token=os.environ.get("THURSDAY_ACCESS_TOKEN", "").strip(),
            mode=mode if mode in MODES else "remote",
        )

    # ----------------------------------------------------------------- state

    @property
    def enabled(self) -> bool:
        return self.mode != "off" and bool(self.token)

    def needs_token(self, host: str | None) -> bool:
        """Whether this client has to present the token at all."""
        if self.mode == "off" or not self.token:
            return False
        if self.mode == "always":
            return True
        return not is_loopback(host)

    # ---------------------------------------------------------------- checks

    def allows(self, host: str | None, session: str | None) -> bool:
        if not self.needs_token(host):
            return True
        return bool(session) and session in self.sessions

    def locked_out(self, host: str | None, now: float | None = None) -> bool:
        """Too many wrong guesses from this client, too recently."""
        moment = time.time() if now is None else now
        recent = [
            stamp for stamp in self.failures.get(host or "", []) if moment - stamp < LOCKOUT_SECONDS
        ]
        self.failures[host or ""] = recent
        return len(recent) >= MAX_FAILURES

    def login(self, offered: str, host: str | None = None, now: float | None = None) -> str | None:
        """Exchange the access token for a session id, or None if it is wrong."""
        if self.locked_out(host, now):
            return None
        # Constant time, so a wrong token cannot be found one character at a time.
        if not self.token or not hmac.compare_digest(offered or "", self.token):
            self.failures.setdefault(host or "", []).append(time.time() if now is None else now)
            return None

        self.failures.pop(host or "", None)
        session = secrets.token_urlsafe(24)
        self.sessions.add(session)
        return session

    def logout(self, session: str | None) -> None:
        self.sessions.discard(session or "")


def ensure_token(existing: str = "") -> tuple[str, bool]:
    """Return a token to use, and whether one had to be made up.

    A generated token is saved so it survives a restart - an assistant that
    demanded a new password every launch would just get its auth turned off.
    """
    if existing.strip():
        return existing.strip(), False

    token = generate_token()
    try:
        from .settings_store import update

        update({"THURSDAY_ACCESS_TOKEN": token})
    except Exception:  # storage trouble must not stop the server booting
        log.warning("could not save the generated access token", exc_info=True)
    return token, True
