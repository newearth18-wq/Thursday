"""Thursday as one file.

`Thursday.exe` is this, frozen with everything it needs inside it: the
interpreter, the web server, the page, the Claude client, the document
readers, the browser driver. Nothing is downloaded, nothing is installed,
there is no Python on the machine to be the wrong version. Double-click it
and the assistant is running.

What that costs, honestly:

**It is large**, because the alternative to installing things is carrying
them.

**Updating means replacing the file.** There is no pip inside a frozen app,
so nothing can be added to it later either - which is why everything that
could be wanted is in there from the start. The two exceptions are face
recognition, which needs dlib compiled against a C++ toolchain, and the
speech models, which are hundreds of megabytes each and are fetched on first
use into your own folder.

**Your things live somewhere else.** PyInstaller unpacks the program into a
temporary folder and deletes it on the way out, so anything written beside
the code would not survive the afternoon. Settings, the database, .env and
your plugins go to `%LOCALAPPDATA%\\Thursday` instead - see thursday/home.py -
which also means replacing the exe with a newer one keeps all of it.

Plugins still work: they are read as source, so a .py file dropped in that
folder becomes a tool, as long as it only imports what Thursday already
carries.
"""

from __future__ import annotations

import multiprocessing
import socket
import sys
import threading
import time
import webbrowser

#: Modes that own stdout and must not have anything printed over them.
QUIET = ("mcp",)

#: What this build claims to carry, and the import that proves it. Required
#: ones are the difference between a Thursday and a 200 MB file that opens a
#: window and closes it; the rest are features that can be absent, and are
#: absent in exactly the same way they would be from a source install.
REQUIRED = (
    ("the assistant", "thursday.agent"),
    ("the web UI", "thursday.server"),
    ("the web server", "uvicorn"),
    ("Claude", "anthropic"),
    ("certificates", "certifi"),
)
OPTIONAL = (
    ("PDF", "pypdf"),
    ("Word", "docx"),
    # mcp.server, not mcp: the top-level package imports on its own, and the
    # part Thursday serves other apps from is a submodule, which is exactly
    # the piece a bundle can be missing while `import mcp` still works.
    ("MCP", "mcp.server"),
    ("browser control", "playwright.sync_api"),
    ("images", "PIL.Image"),
    ("QR codes", "qrcode"),
    ("microphone", "sounddevice"),
    ("speech recognition", "faster_whisper"),
    ("speaking", "pyttsx3"),
)

#: How long to keep checking whether the server has come up before giving up
#: on opening a browser. The first start is the slow one: a frozen app has to
#: unpack itself first.
BROWSER_TIMEOUT = 90.0


def selftest() -> int:
    """Import everything this build claims to carry and say what is here.

    A frozen app cannot install anything later, so what is in the bundle is
    the whole answer to what it can do - and finding that out should not
    require discovering it one failed request at a time. CI runs this against
    the exe before publishing it, which is what stops a build that unpacks
    fine and then cannot answer a question.
    """
    import importlib

    from thursday import home

    print(f"\n  Thursday, packaged\n  your things: {home.home()}\n"
          f"  the program: {home.bundled()}\n")

    missing = []
    for label, module in REQUIRED + OPTIONAL:
        try:
            importlib.import_module(module)
            print(f"  yes  {label}")
        except Exception as error:                        # noqa: BLE001
            print(f"  NO   {label}  ({module}: {error})")
            if (label, module) in REQUIRED:
                missing.append(label)

    # Asked of the server itself rather than rebuilt from sys._MEIPASS: what
    # matters is whether the path the server will actually use resolves
    # inside the bundle, which is a different question.
    from thursday.server import WEB_DIR

    page = WEB_DIR / "index.html"
    if page.is_file():
        print(f"  yes  the page ({page.stat().st_size:,} bytes)")
    else:
        print(f"  NO   the page - {page} is not there")
        missing.append("the page")

    print("\n  not here, on purpose: face recognition (needs a C++ compiler),")
    print("  and the speech models, which are fetched on first use.\n")

    if missing:
        print(f"  x this build is broken: {', '.join(missing)}\n")
        return 1
    return 0


def wanted(argv: list[str]) -> tuple[list[str], bool]:
    """What was asked for, and whether to open a browser.

    A double-click passes no arguments, and the thing a person who
    double-clicked an assistant wants is the assistant, on screen. From a
    terminal, `Thursday.exe chat` and the rest behave exactly as `thursday`
    does.
    """
    if not argv:
        return ["serve"], True
    return list(argv), False


def wait_for(host: str, port: int, timeout: float = BROWSER_TIMEOUT) -> bool:
    """Whether the server started, by trying the door rather than guessing.

    A fixed sleep is either too short on the first run, when the exe is still
    unpacking itself, or a wasted wait on every run after.
    """
    deadline = time.monotonic() + timeout
    reachable = host if host not in ("0.0.0.0", "::") else "127.0.0.1"
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((reachable, port), timeout=1.0):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def open_when_ready(host: str, port: int) -> None:
    reachable = host if host not in ("0.0.0.0", "::") else "127.0.0.1"
    if wait_for(host, port):
        webbrowser.open(f"http://{reachable}:{port}/")


def main(argv: list[str] | None = None) -> int:
    # First, and before anything imports a worker: on Windows a frozen
    # process re-executes itself to make one, and without this it would
    # re-run the installer's own startup instead of the worker.
    multiprocessing.freeze_support()

    from thursday import home

    if home.frozen():
        home.prepare()

    given = list(sys.argv[1:] if argv is None else argv)
    if given and given[0] == "selftest":
        return selftest()

    args, show = wanted(given)
    quiet = bool(args) and args[0] in QUIET

    from thursday.__main__ import build_parser
    from thursday.config import Settings

    if show:
        parsed = build_parser().parse_args(args)
        settings = Settings.from_env()
        host = parsed.host or settings.host
        port = parsed.port or settings.port
        print(f"\n  THURSDAY\n\n  http://{host}:{port}\n"
              f"  your things are in {home.home()}\n\n"
              "  Close this window to stop it.\n")
        threading.Thread(target=open_when_ready, args=(host, port), daemon=True).start()

    from thursday.__main__ import main as run

    code = 1
    try:
        code = run(args)
    except KeyboardInterrupt:
        code = 0
        if not quiet:
            print("\n  Standing by.")
    except Exception as error:  # noqa: BLE001 - the last thing before the window shuts
        if not quiet:
            print(f"\n  x {error!r}")
            print(f"  Thursday's folder is {home.home()}")

    # A window that closes on failure takes the reason with it, and a
    # double-clicked program has no terminal to leave it in.
    if show and not quiet:
        try:
            input("\n  Press Enter to close. ")
        except (EOFError, KeyboardInterrupt):
            pass
    return code


if __name__ == "__main__":
    sys.exit(main())
