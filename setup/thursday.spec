# -*- mode: python ; coding: utf-8 -*-
"""How Thursday.exe is put together.

A spec file rather than a wall of pyinstaller flags, because most of what is
here is a note about why a package needs collecting, and a command line has
nowhere to put one.

The rule throughout: nothing is downloaded at runtime, so anything that would
have been downloaded has to be found now. The two things that break that rule
do so for a reason and are named where they happen.
"""

import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = os.path.dirname(SPECPATH)  # noqa: F821 - SPECPATH is injected by PyInstaller

datas = []
binaries = []
hiddenimports = []

# Packages whose own files are part of them: certificates, a Node driver, a
# PortAudio DLL. PyInstaller follows imports, not data, so these say so.
#
#   anthropic     the Claude client, which imports its models by name
#   certifi       the CA bundle every https call needs; without it, nothing
#                 talks to anything
#   uvicorn       picks its http and websocket implementations by string at
#                 startup, so static analysis finds none of them
#   playwright    carries a Node driver it runs as a subprocess
#   sounddevice   is a wrapper around a PortAudio DLL that ships beside it
#   mcp, qrcode   small, and both are imported lazily from inside functions
for package in ("anthropic", "certifi", "uvicorn", "playwright",
                "sounddevice", "mcp", "qrcode"):
    found_datas, found_binaries, found_hidden = collect_all(package)
    datas += found_datas
    binaries += found_binaries
    hiddenimports += found_hidden

# Thursday reaches for most of itself lazily - `from .vault import Vault`
# inside the function that needs it - which PyInstaller does follow, but
# there is no reason to depend on it having followed every one.
hiddenimports += collect_submodules("thursday")

# What uvicorn[standard] installs and then imports by name. uvloop is
# deliberately absent: it does not build on Windows, and uvicorn falls back
# to asyncio on its own.
hiddenimports += [
    "h11", "httptools", "websockets", "websockets.legacy",
    "watchfiles", "dotenv", "multipart",
    "email.mime.text", "email.mime.multipart", "email.mime.base",
]

# Speech, which is optional at runtime and imported inside the functions that
# use it, so nothing here is reachable by analysis. Missing on a machine
# where the wheel would not install, which is not an error - Thursday says so
# and carries on, exactly as it does from a source install.
for package in ("faster_whisper", "pyttsx3", "comtypes"):
    try:
        found_datas, found_binaries, found_hidden = collect_all(package)
    except Exception:                                     # noqa: BLE001
        continue
    datas += found_datas
    binaries += found_binaries
    hiddenimports += found_hidden

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
