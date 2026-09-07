"""What Thursday is allowed to do to this machine.

The workspace sandbox answers "where", but not "what": inside the workspace
there are files that should never be read no matter who asks - the .env, the
SSH keys, and Thursday's own settings file, which holds every API key it has.
Reading its own credentials and then being asked to post them somewhere is a
short trip, and Thursday now reads documents, web pages and email, any of
which can carry an instruction it did not get from you.

So: a deny list that is checked on the resolved path and cannot be argued
with, an allow list for anything outside the workspace, a per-tool policy of
allow / confirm / deny, and a record of every decision.
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger(__name__)

#: Files that are secrets by convention. Matched against the resolved path,
#: so a symlink or a `..` cannot dodge them.
SECRET_PATTERNS: tuple[str, ...] = (
    "**/.env", "**/.env.*",
    "**/.ssh/**", "**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*", "**/*.pem",
    "**/.aws/credentials", "**/.aws/config",
    "**/.git-credentials", "**/.netrc", "**/_netrc",
    "**/.gnupg/**", "**/.password-store/**",
    "**/.kube/config", "**/.docker/config.json",
    "**/.npmrc", "**/.pypirc", "**/.config/gh/**",
    "**/Library/Keychains/**", "**/.local/share/keyrings/**",
    "**/credentials.json", "**/service-account*.json",
)

#: Commands that are refused outright, however they are phrased.
DANGEROUS_COMMANDS: tuple[str, ...] = (
    "rm -rf /", "mkfs", ":(){", "dd if=/dev/zero", "shutdown", "reboot",
    "> /dev/sd", "chmod -r 777 /", "history -c",
)

#: allow - just run it. confirm - ask first. deny - never.
DECISIONS = ("allow", "confirm", "deny")

#: Tools that touch the machine or the outside world in a way worth naming.
#: Anything not listed inherits the tool's own `dangerous` flag.
DEFAULT_TOOL_RULES: dict[str, str] = {
    "run_shell": "confirm",
    "write_file": "confirm",
    "take_screenshot": "confirm",
    "browse": "confirm",
    "browser_act": "confirm",
    "browser_screenshot": "confirm",
    "open_app": "confirm",
    "lock_screen": "confirm",
}


@dataclass
class Decision:
    """Whether a tool call may proceed."""

    outcome: str = "allow"
    reason: str = ""

    @property
    def allowed(self) -> bool:
        return self.outcome == "allow"

    @property
    def refused(self) -> bool:
        return self.outcome == "deny"

    @property
    def needs_asking(self) -> bool:
        return self.outcome == "confirm"


@dataclass
class Policy:
    """The rules, and the decisions they produce."""

    #: Paths that may never be read or written, whatever else is configured.
    deny_paths: tuple[str, ...] = SECRET_PATTERNS
    #: Directories readable in addition to the workspace. Empty means the
    #: workspace only.
    read_paths: tuple[str, ...] = ()
    #: Directories writable in addition to the workspace.
    write_paths: tuple[str, ...] = ()
    #: Per-tool allow / confirm / deny.
    tool_rules: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_TOOL_RULES))
    #: Extra command substrings to refuse, on top of the built-in ones.
    denied_commands: tuple[str, ...] = ()
    #: Tools that are switched off entirely.
    denied_tools: tuple[str, ...] = ()
    #: What the configuration itself denies, before anyone's role is applied.
    #: Kept apart so switching from a guest back to the owner restores exactly
    #: the configured list rather than whatever the last person left behind.
    base_denied_tools: tuple[str, ...] = ()
    #: Turn off every confirmation. Off by default for a reason.
    trust_everything: bool = False
    #: Where a relative path in a command or argument resolves to.
    workspace: Path = field(default_factory=Path.cwd)

    # --------------------------------------------------------------- loading

    @classmethod
    def from_settings(cls, settings: Any) -> "Policy":
        """Build the policy, then protect Thursday's own files with it.

        The database holds every conversation, the settings file holds every
        API key and the enrolment file holds face embeddings. None of them are
        the assistant's business to read back as text.
        """
        policy = cls.load(getattr(settings, "permission_paths", ()))

        own: list[str] = []
        for attribute in ("data_dir", "db_path", "settings_path", "enrolment_path"):
            value = getattr(settings, attribute, None)
            if value is None:
                continue
            path = Path(value)
            own.append(str(path))
            if attribute == "data_dir":
                own.append(str(path / "**"))

        policy.deny_paths = tuple(dict.fromkeys((*policy.deny_paths, *own)))
        workspace = getattr(settings, "workspace", None)
        if workspace is not None:
            policy.workspace = Path(workspace)
        if not getattr(settings, "require_confirmation", True):
            policy.trust_everything = True
        if not getattr(settings, "allow_shell", True):
            policy.denied_tools = tuple({*policy.denied_tools, "run_shell"})
        policy.base_denied_tools = policy.denied_tools
        return policy

    def deny_always(self, names: Iterable[str]) -> None:
        """Switch tools off for good, whatever happens to this policy later.

        Added to the configured list as well as the working one, because
        speaking_to() rebuilds denied_tools from base_denied_tools every time
        it is told who is here - so anything added only to the working list
        would be handed back at the next turn.
        """
        wanted = tuple(names)
        self.base_denied_tools = tuple(dict.fromkeys((*self.base_denied_tools, *wanted)))
        self.denied_tools = tuple(dict.fromkeys((*self.denied_tools, *wanted)))

    @classmethod
    def load(cls, paths: Iterable[Path] = ()) -> "Policy":
        """Read permissions.json, if there is one."""
        policy = cls()
        for path in paths:
            path = Path(path)
            if not path.is_file():
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                log.warning("ignoring %s: %s", path, exc)
                continue
            if not isinstance(raw, dict):
                continue

            # The built-in secret patterns are added to, never replaced: a
            # typo in a config file should not quietly expose your SSH keys.
            policy.deny_paths = tuple(
                dict.fromkeys((*SECRET_PATTERNS, *(raw.get("deny_paths") or ())))
            )
            policy.read_paths = tuple(raw.get("read_paths") or ())
            policy.write_paths = tuple(raw.get("write_paths") or ())
            policy.denied_commands = tuple(raw.get("denied_commands") or ())
            policy.denied_tools = tuple(raw.get("denied_tools") or ())
            policy.base_denied_tools = policy.denied_tools
            rules = raw.get("tools")
            if isinstance(rules, dict):
                merged = dict(DEFAULT_TOOL_RULES)
                merged.update(
                    {
                        str(name): str(value)
                        for name, value in rules.items()
                        if str(value) in DECISIONS
                    }
                )
                policy.tool_rules = merged
        return policy

    # ----------------------------------------------------------------- paths

    def resolve(self, path: Path | str) -> Path:
        """Where a path points, with `~` and relative names sorted out.

        A relative name is taken against the workspace, because that is where
        the shell and the file tools operate - so `cat .env` and
        `read_file(".env")` are the same act and get the same answer.
        """
        candidate = Path(os.path.expanduser(str(path)))
        if not candidate.is_absolute():
            candidate = Path(self.workspace) / candidate
        try:
            return candidate.resolve()
        except OSError:  # pragma: no cover - a path that cannot be resolved
            return candidate

    def secret(self, path: Path | str) -> bool:
        """Whether this path is on the deny list."""
        target = str(self.resolve(path))
        for pattern in self.deny_paths:
            if fnmatch.fnmatch(target, pattern) or fnmatch.fnmatch(target, pattern.rstrip("/*") ):
                return True
            # `**/x` should also match a path that simply ends in /x.
            if pattern.startswith("**/") and fnmatch.fnmatch(target, f"*/{pattern[3:]}"):
                return True
        return False

    def may_read(self, path: Path | str) -> bool:
        return not self.secret(path)

    def may_write(self, path: Path | str) -> bool:
        return not self.secret(path)

    def extra_roots(self, writing: bool = False) -> tuple[Path, ...]:
        """Directories allowed beyond the workspace."""
        chosen = self.write_paths if writing else (*self.read_paths, *self.write_paths)
        return tuple(Path(entry).expanduser().resolve() for entry in chosen)

    # -------------------------------------------------------------- commands

    def command_refused(self, command: str) -> str:
        """Why a shell command is refused, or empty if it is not."""
        lowered = " ".join(command.lower().split())
        for pattern in (*DANGEROUS_COMMANDS, *self.denied_commands):
            if pattern.lower() in lowered:
                return f"that command matches a blocked pattern ({pattern})"
        # Reading a secret through the shell is the same act as reading it
        # through read_file, so it gets the same answer.
        for token in re.findall(r"[\w./~$-]+", command):
            if token in {".", "..", "-"} or token.startswith("-"):
                continue
            # Bare names count too: `cat .env` is the same act as reading it
            # by absolute path, and must get the same answer.
            if self.secret(token):
                return f"that command touches a protected path ({token})"
        return ""

    # ----------------------------------------------------------------- tools

    def decide(self, tool: str, arguments: dict[str, Any], dangerous: bool = False) -> Decision:
        """What to do about one tool call."""
        if tool in self.denied_tools:
            return Decision("deny", f"{tool} is switched off in your permissions")

        rule = self.tool_rules.get(tool, "confirm" if dangerous else "allow")
        if rule == "deny":
            return Decision("deny", f"{tool} is not allowed by your permissions")

        if tool == "run_shell":
            refused = self.command_refused(str(arguments.get("command", "")))
            if refused:
                return Decision("deny", refused)

        for key in ("path", "file", "target"):
            value = arguments.get(key)
            if isinstance(value, str) and value and self.secret(value):
                return Decision("deny", f"{value} is protected and cannot be read or written")

        if rule == "confirm" and self.trust_everything:
            return Decision("allow", "confirmations are switched off")
        return Decision(rule)

    def describe(self) -> dict[str, Any]:
        """What the rules currently are, for the CLI and the web UI."""
        return {
            "protected_paths": len(self.deny_paths),
            "extra_readable": list(self.read_paths),
            "extra_writable": list(self.write_paths),
            "tools": dict(sorted(self.tool_rules.items())),
            "denied_tools": list(self.denied_tools),
            "confirmations": not self.trust_everything,
        }
