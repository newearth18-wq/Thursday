"""More than one person in the house.

Face and voice recognition already answered "who is this". Nothing was done
with the answer: everyone shared one memory, one set of reminders and one set
of permissions. So your partner's dentist appointment turned up in your
morning brief, and anyone the assistant recognised could run a shell command.

A person has a role, and the role decides three things:

- **What they can reach.** An owner has the machine; everyone else does not.
  This is enforced through the same Policy as everything else, so it is the
  same code path that already refuses to read your SSH key.
- **What they can remember.** Facts, notes and reminders are filed under whoever
  said them. Everyone sees their own and the shared ones; nobody reads someone
  else's through the assistant.
- **Which profile answers them.** A guest gets a restricted one.

The last rule is worth being honest about: this is not a security boundary
between people who share a machine. Anyone with a login can open the SQLite
file. What it prevents is the assistant disclosing things by accident - your
notes read out to whoever is standing in the kitchen, or a child's "delete
all my files" being carried out because the assistant does not distinguish
between the people it can hear.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: Who someone is to this machine.
ROLES = ("owner", "member", "guest")

#: What each role may not do. The owner's list is empty on purpose: it is
#: their machine, and the permissions policy already guards the dangerous
#: parts of it.
ROLE_DENIED: dict[str, tuple[str, ...]] = {
    "owner": (),
    "member": (
        "run_shell", "write_file", "open_app", "lock_screen",
        "browse", "browser_act", "browser_screenshot",
        "send_draft", "forget_fact", "delete_note", "forget_document",
    ),
    "guest": (
        "run_shell", "write_file", "read_file", "list_files", "search_files",
        "open_app", "lock_screen", "take_screenshot",
        "browse", "browser_act", "browser_screenshot",
        "send_draft", "draft_email", "draft_event",
        "remember_fact", "forget_fact", "add_note", "delete_note",
        "search_notes", "search_history", "search_documents", "list_documents",
        "index_documents", "forget_document", "check_mail", "read_mail",
        "watch_for", "stop_watching", "start_job", "cancel_job",
    ),
}

#: The profile each role's turns run under, when the profile exists.
ROLE_PROFILE = {"owner": "", "member": "", "guest": "guest"}

#: What the assistant is told about who it is speaking to.
ROLE_STYLE = {
    "owner": "",
    "member": (
        "You are speaking to {name}, who lives here but does not administer "
        "this machine. Help them freely with their own notes, reminders and "
        "questions. You cannot run commands or change files for them; say so "
        "plainly and suggest they ask {owner}."
    ),
    "guest": (
        "You are speaking to {name}, a guest. Be helpful and friendly about "
        "general questions, the time, the weather and the house. You have no "
        "access to {owner}'s files, mail, documents or notes, and you do not "
        "discuss what is in them. Say so plainly if asked."
    ),
}


def slug(name: str) -> str:
    """A stable key for a person, so "Nok" and "nok " are the same person."""
    return re.sub(r"\s+", " ", (name or "").strip()).lower()


@dataclass
class Person:
    """Someone this machine knows."""

    name: str
    role: str = "guest"
    #: Extra tools this person may not use, on top of the role's list.
    denied_tools: tuple[str, ...] = field(default_factory=tuple)
    #: Force a profile for their turns. Empty lets the role decide.
    profile: str = ""

    @property
    def key(self) -> str:
        return slug(self.name)

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"

    def denied(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys((*ROLE_DENIED.get(self.role, ()), *self.denied_tools)))

    def style(self, owner_name: str = "the owner") -> str:
        template = ROLE_STYLE.get(self.role, "")
        return template.format(name=self.name, owner=owner_name) if template else ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "role": self.role,
            "profile": self.profile or ROLE_PROFILE.get(self.role, ""),
            "denied": list(self.denied()),
        }


#: Nobody recognised. Treated as the owner, because an assistant that locks
#: its owner out whenever the camera is covered is worse than useless - the
#: access token is what actually keeps other people out, not this.
UNKNOWN = Person(name="", role="owner")


@dataclass
class Household:
    """Who lives here, and what each of them may do."""

    people: dict[str, Person] = field(default_factory=dict)
    path: Path | None = None

    # ------------------------------------------------------------- loading

    @classmethod
    def load(cls, path: Path | str | None = None) -> "Household":
        target = Path(path) if path else default_path()
        household = cls(path=target)
        if not target.is_file():
            return household
        try:
            raw = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("ignoring %s: %s", target, exc)
            return household

        for name, entry in (raw.get("people") or {}).items():
            if not isinstance(entry, dict):
                continue
            role = str(entry.get("role") or "guest").lower()
            household.people[slug(name)] = Person(
                name=str(entry.get("name") or name),
                role=role if role in ROLES else "guest",
                denied_tools=tuple(entry.get("denied_tools") or ()),
                profile=str(entry.get("profile") or ""),
            )
        return household

    def save(self) -> None:
        if self.path is None:
            raise RuntimeError("this household has nowhere to be saved")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "people": {
                person.key: {
                    "name": person.name,
                    "role": person.role,
                    "denied_tools": list(person.denied_tools),
                    "profile": person.profile,
                }
                for person in self.people.values()
            }
        }
        self.path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        try:
            self.path.chmod(0o600)
        except OSError:  # pragma: no cover - a filesystem without permissions
            log.debug("could not restrict permissions on %s", self.path)

    # -------------------------------------------------------------- reading

    def get(self, name: str) -> Person:
        """Who this is, and what that means here.

        Two ways of ending up as the owner, both deliberate. Nobody
        recognised, because an assistant that locks its owner out whenever the
        camera is covered is worse than useless - the access token is the real
        gate. And nobody listed at all: until roles have been set up they are
        not in force, so a household of one, or a file that failed to parse,
        behaves exactly as it did before any of this existed.
        """
        if not name or not self.anyone:
            return UNKNOWN if not name else Person(name=name, role="owner")
        found = self.people.get(slug(name))
        if found is not None:
            return found
        # Roles are in force and this person has none. Someone the camera
        # knows but the household does not is still a stranger: guest.
        return Person(name=name, role="guest")

    def owner_name(self) -> str:
        for person in self.people.values():
            if person.is_owner:
                return person.name
        return "the owner"

    def set(self, name: str, role: str, denied_tools: tuple[str, ...] = ()) -> Person:
        if role not in ROLES:
            raise ValueError(f"a role is one of {', '.join(ROLES)}")
        person = Person(name=name.strip(), role=role, denied_tools=tuple(denied_tools))
        self.people[person.key] = person
        return person

    def remove(self, name: str) -> bool:
        return self.people.pop(slug(name), None) is not None

    def summary(self) -> list[dict[str, Any]]:
        return [person.as_dict() for person in sorted(
            self.people.values(), key=lambda p: (ROLES.index(p.role), p.key)
        )]

    @property
    def anyone(self) -> bool:
        """Whether roles have been set up at all.

        With nobody listed, everything behaves exactly as it did before there
        were people: one memory, one set of permissions.
        """
        return bool(self.people)


def default_path() -> Path:
    override = os.environ.get("THURSDAY_HOUSEHOLD")
    if override:
        return Path(override).expanduser()
    data_dir = os.environ.get("THURSDAY_DATA_DIR")
    root = Path(data_dir).expanduser() if data_dir else Path.cwd() / "data"
    return root / "household.json"
