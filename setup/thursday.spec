# -*- mode: python ; coding: utf-8 -*-
"""How Thursday.exe is put together.

A spec file rather than a wall of pyinstaller flags, because most of what is
here is a note about why a package needs collecting, and a command line has
nowhere to put one.

The rule throughout: nothing is downloaded at runtime, so anything that would
have been downloaded has to be found now. The two things that break that rule
do so for a reason and are named where they happen.

The other rule is subtler and cost a build to learn. There are two ways to
collect a package and they are not interchangeable:

    collect_data_files      reads the filesystem. Safe on anything.
    collect_submodules      imports every submodule to find out what is
                            there, in this interpreter, right now.

So collecting submodules from a package that ships a command-line tool runs
that tool's imports - and `mcp.cli` calls sys.exit() when typer is missing,
which does not raise an exception PyInstaller can catch. It takes the whole
analysis down with it. (collect_all's filter_submodules does not help: the
filter is applied to the list after the child process has already imported
everything to build it.)

Hence the split below. Submodules are walked only where something really is
imported by name at runtime and static analysis would miss it.
"""

import os

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

ROOT = os.path.dirname(SPECPATH)  # noqa: F821 - SPECPATH is injected by PyInstaller

datas = []
binaries = []
hiddenimports = []

# Packages whose own files are part of them, and whose code is reached by
# ordinary imports that analysis can follow on its own.
#
#   certifi          the CA bundle every https call needs; without it,
#                    nothing talks to anything
#   playwright       carries a Node driver it runs as a subprocess
#   sounddevice      wraps a PortAudio DLL that ships beside it
#   faster_whisper   carries the voice-activity model as an .onnx file
#   mcp, anthropic   no data worth mentioning, but harmless to ask, and
#                    listing them says they were considered
#   tzdata           the IANA timezone database, which Windows does not ship
#                    and a calendar's TZID is written in
for package in ("certifi", "playwright", "sounddevice", "faster_whisper",
                "mcp", "anthropic", "PIL", "tzdata"):
    datas += collect_data_files(package)
    binaries += collect_dynamic_libs(package)

# The only two packages walked for submodules, which is to say imported one
# by one. uvicorn chooses its http and websocket implementations at startup
# and static analysis finds none of them; Thursday reaches for most of itself
# lazily, and while PyInstaller does follow a function-level import there is
# no reason to depend on it having followed every one. Both were checked by
# doing the walk by hand first.
for package in ("uvicorn", "thursday"):
    hiddenimports += collect_submodules(package, on_error="warn")

# Everything else reached by name is named here instead of walked, because
# walking is not free of consequence. It imports a package's own test
# modules too, and a test module that skips itself raises
# _pytest.outcomes.Skipped - which, like sys.exit, inherits from
# BaseException rather than Exception, so PyInstaller's error handling never
# sees it and the analysis process simply dies. qrcode is the one that does
# that; nothing here needs its image backends anyway, since a QR code for a
# terminal is drawn out of half-block characters.
hiddenimports += [
    # uvicorn[standard], picked by name at startup. uvloop is deliberately
    # absent: it does not build on Windows, and uvicorn falls back to asyncio.
    "h11", "httptools", "websockets", "watchfiles", "dotenv",
    # The speech driver for this platform. pyttsx3 picks one by name.
    "pyttsx3.drivers", "pyttsx3.drivers.sapi5",
    # Both halves of MCP, each imported inside the function that needs it.
    "mcp.server", "mcp.server.stdio", "mcp.client", "mcp.client.stdio",
    # Drafting an email builds these by hand.
    "email.mime.text", "email.mime.multipart", "email.mime.base",
]

# The page, and the example files that get copied into the person's own
# folder on first run so there is something to edit.
datas += [
    (os.path.join(ROOT, "thursday", "web", "index.html"), os.path.join("thursday", "web")),
    (os.path.join(ROOT, ".env.example"), "."),
    (os.path.join(ROOT, "permissions.example.json"), "."),
    (os.path.join(ROOT, "mcp.example.json"), "."),
    (os.path.join(ROOT, "profiles.example.json"), "."),
]

# tkinter would add a Tcl runtime for a program with no window; the test
# tooling has no business in a shipped binary; dlib and torch are the two
# things deliberately left out, and excluding them keeps a stray transitive
# import from quietly pulling in a gigabyte.
excludes = ["tkinter", "pytest", "_pytest", "pyflakes", "dlib", "face_recognition", "torch"]

analysis = Analysis(                                      # noqa: F821
    [os.path.join(ROOT, "setup", "app.py")],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)

pyz = PYZ(analysis.pure)                                  # noqa: F821

exe = EXE(                                                # noqa: F821
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="Thursday",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX on a bundle this size buys a slower start and a much better chance
    # of an antivirus deciding it is packed malware.
    upx=False,
    console=True,
    icon=os.path.join(ROOT, "setup", "thursday.ico"),
    version=os.path.join(ROOT, "setup", "app_version_info.txt"),
)
