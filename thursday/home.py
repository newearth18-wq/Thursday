"""Where Thursday keeps its things.

Run from a source tree, that is the source tree: the database in `data/`,
plugins in `plugins/`, keys in `.env`, all beside the code where you can see
them. Nothing here changes that.

Run from `Thursday.exe` there is no source tree. PyInstaller unpacks the
program into a temporary folder and deletes it on the way out, so a database
written beside the code would be gone by morning and a plugin dropped next to
it would never be seen again. Frozen, then, the two things are pulled apart:

    bundled()   what was shipped    the code, the page, the example files
    home()      what you own        .env, settings, the database, plugins

`home()` is `%LOCALAPPDATA%\\Thursday`, which survives replacing the exe with
a newer one - which is the whole point, because replacing the exe is how a
frozen app is updated.

THURSDAY_HOME overrides it either way, which is how the tests get at it and
how someone runs two Thursdays side by side.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

#: The files that are worth having in front of you even before you need them.
#: Copied on first run rather than read from the bundle, so editing one is
#: possible at all - nothing inside a frozen exe can be edited.
EXAMPLES = (
    ".env.example",
    "permissions.example.json",
    "mcp.example.json",
    "profiles.example.json",
)

PLUGIN_NOTE = """\
Python files dropped in this folder become tools Thursday can use.

    from thursday.tools import tool

    @tool("what the weather is doing")
    async def weather(city: str) -> str:
        ...

They are read as source when Thursday starts, so this works in the packaged
Thursday.exe too. The one limit there: a plugin can import anything Thursday
already carries, but not a library you would have had to pip install - the
exe has no pip. If you need one, use the other installer, which puts Thursday
on a real Python.

See plugins/example_smart_home.py in the repository for a longer one.
"""


def frozen() -> bool:
    """Whether this is running from a packaged executable."""
    return bool(getattr(sys, "frozen", False))


def bundled() -> Path:
    """The read-only root: what was shipped, code and all.

    PyInstaller sets sys._MEIPASS to wherever it unpacked itself. Outside a
    bundle there is nothing to unpack and the source tree is already it.
    """
    packed = getattr(sys, "_MEIPASS", "")
    if packed:
        return Path(packed)
    return Path(__file__).resolve().parent.parent


def home() -> Path:
    """The writable root: everything the person owns.

    Deliberately not `bundled()` when frozen. They are the same directory in
    a source checkout and must never be the same one in an exe.
    """
    override = os.environ.get("THURSDAY_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    if frozen():
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME")
        return (Path(base) if base else Path.home()) / "Thursday"
    return bundled()


def prepare(root: Path | None = None, source: Path | None = None) -> list[str]:
    """Make sure the home has the shape Thursday expects, and say what was new.

    Safe to run every start: an existing file is never overwritten, so this
    cannot lose a key someone pasted into .env or a plugin they wrote.
    """
    root = root or home()
    source = source or bundled()
    made: list[str] = []

    for folder in (root, root / "data", root / "plugins"):
        if not folder.exists():
            folder.mkdir(parents=True, exist_ok=True)
            made.append(str(folder))

    note = root / "plugins" / "README.txt"
    if not note.exists():
        note.write_text(PLUGIN_NOTE, encoding="utf-8")
        made.append(str(note))

    for name in EXAMPLES:
        target, original = root / name, source / name
        if target.exists() or not original.is_file():
            continue
        try:
            shutil.copy2(original, target)
        except OSError:
            continue
        made.append(str(target))

    # The .env is the one file people are told to edit, so it should be there
    # to edit rather than something they have to know to create. Settings set
    # in the web UI go to data/settings.json and work without it either way.
    env_file, example = root / ".env", root / ".env.example"
    if not env_file.exists() and example.is_file():
        try:
            shutil.copy2(example, env_file)
            made.append(str(env_file))
        except OSError:
            pass

    return made
