"""Thursday, installed by double-clicking a file.

This is the source of `Thursday-Setup.exe`. It does the same job as
install.ps1 - find a Python, fetch the code, build a virtual environment,
write a .env, put shortcuts on the Start menu - with two differences that
matter to someone who just wants the thing installed.

**Nothing has to be typed.** No PowerShell window, no command to paste, no
execution policy to think about. Download, double-click, answer two
questions.

**It does not depend on PowerShell working.** The exe carries its own Python,
so every step here is plain Python: urllib fetches the code, zipfile unpacks
it, subprocess runs pip. PowerShell is used for exactly one thing - making a
.lnk, which has no other API - and a machine where that fails still ends up
with a working install, minus the Start menu entry.

The one honest catch is Windows SmartScreen. An executable downloaded from
the internet and not signed with a certificate gets "Windows protected your
PC", and getting past it means clicking "More info" and then "Run anyway".
Signing costs a few hundred dollars a year, so until someone pays for that,
this trades a line to paste for a warning to dismiss. install.ps1 is still
there for anyone who would rather paste the line.

Run with --check to exercise everything that does not touch the machine
(finding Python, resolving the branch) and exit. That is what CI runs against
the built exe, so a broken build is caught before anyone downloads it.
"""

from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

OWNER = "newearth18-wq"
NAME = "Thursday"
REPO = f"https://github.com/{OWNER}/{NAME}"

#: Where the code lives once this is merged; tried first so this file needs
#: no maintenance after that happens.
MAIN_BRANCH = "main"
#: And where it lives until then. Nobody installing should have to know.
WORK_BRANCH = "claude/jarvis-assistant-mhfwe6"

#: The newest Python we know has wheels for everything below. Newer than this
#: and pip starts building from source, which needs the C++ compiler this
#: installer exists to avoid.
KNOWN_GOOD = (3, 13)
OLDEST = (3, 10)

#: Pinned rather than "latest": a fixed URL installs the same interpreter
#: today and next year, and a floating one turns every install into a
#: different experiment. Only used when the machine has no usable Python.
PYTHON_VERSION = "3.12.10"
PYTHON_INSTALLERS = {
    "amd64": f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-amd64.exe",
    "arm64": f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-arm64.exe",
    "win32": f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}.exe",
}

#: web: the UI. documents: PDF and Word. browser: Playwright. Not identity
#: (dlib needs a compiler) and not voice unless asked (torch is ~2 GB).
EXTRAS = "web,documents,browser"
VOICE_EXTRAS = "web,documents,browser,voice"

USER_AGENT = "thursday-setup"


class Stop(Exception):
    """Something went wrong that the person needs to read, not a traceback."""


# --------------------------------------------------------------- talking


class Console:
    """Prints, and keeps a copy on disk.

    A console window that closes on failure takes the error with it, so
    everything said here is also appended to a log file the person can send
    on. It is the difference between "it didn't work" and a fixable report.
    """

    def __init__(self, log: Path | None = None) -> None:
        self.log = log
        self._file = None
        if log is not None:
            try:
                log.parent.mkdir(parents=True, exist_ok=True)
                self._file = log.open("a", encoding="utf-8")
                self._file.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
            except OSError:
                self._file = None

    def _write(self, text: str) -> None:
        # errors="replace" is not enough on a console still set to a legacy
        # code page: print itself raises. Falling back to ascii keeps the
        # install running on a machine that cannot draw the characters.
        try:
            print(text, flush=True)
        except UnicodeEncodeError:
            print(text.encode("ascii", "replace").decode("ascii"), flush=True)
        if self._file is not None:
            try:
                self._file.write(text + "\n")
                self._file.flush()
            except OSError:
                pass

    def step(self, text: str) -> None:
        self._write("\n" + text)

    def say(self, text: str) -> None:
        self._write("  " + text)

    def warn(self, text: str) -> None:
        self._write("  ! " + text)

    def banner(self) -> None:
        self._write("")
        self._write("   THURSDAY")
        self._write("   a personal assistant, on this machine")
        self._write("")


# ---------------------------------------------------------------- python


@dataclass(frozen=True, order=True)
class Interpreter:
    """A Python found on this machine."""

    version: tuple[int, int]
    exe: str

    def __str__(self) -> str:
        return f"Python {self.version[0]}.{self.version[1]} at {self.exe}"


# " -V:3.12 *        C:\Python312\python.exe", and the older
# " -3.12-64          C:\Python312\python.exe". The path is matched
# non-greedily so a line naming two paths yields the first.
_PY_LINE = re.compile(r"(\d+)\.(\d+).*?([A-Za-z]:\\[^\r\n]*?python\.exe)", re.IGNORECASE)


def parse_py_list(text: str) -> list[Interpreter]:
    """What `py -0p` found.

    The launcher knows about every install, including the ones not on PATH -
    which is the usual reason `python` fails on a machine that definitely has
    Python.
    """
    found = []
    for line in text.splitlines():
        match = _PY_LINE.search(line)
        if not match:
            continue
        found.append(Interpreter((int(match[1]), int(match[2])), match[3].strip()))
    return found


def usable(candidates: list[Interpreter]) -> list[Interpreter]:
    """The ones that are actually a Python we can build on.

    The Microsoft Store ships a stub under WindowsApps that prints nothing
    and opens the Store when you run it. It is not Python, and it is first on
    PATH on a fresh machine.
    """
    return [
        found for found in candidates
        if found.exe and "windowsapps" not in found.exe.lower() and found.version >= OLDEST
    ]


def pick(candidates: list[Interpreter]) -> Interpreter | None:
    """The best Python to build on, or None.

    The newest is often the wrong one: wheels lag a new release by months.
    So the newest that is not newer than KNOWN_GOOD, and only if there is no
    such thing, the oldest of what is left - which at least has had the most
    time for its wheels to appear.
    """
    fit = usable(candidates)
    if not fit:
        return None
    supported = sorted((f for f in fit if f.version <= KNOWN_GOOD), reverse=True)
    if supported:
        return supported[0]
    return sorted(fit)[0]


def _run(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    """subprocess.run, without a console window flashing up for each call."""
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(command, creationflags=flags, **kwargs)


def _ask_python(exe: str) -> Interpreter | None:
    """What version an interpreter is, by asking it rather than its path."""
    try:
        out = _run(
            [exe, "-c", "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    lines = out.stdout.strip().splitlines()
    if out.returncode != 0 or len(lines) < 2:
        return None
    try:
        major, minor = lines[0].split(".")
        return Interpreter((int(major), int(minor)), lines[1].strip())
    except ValueError:
        return None


def find_python() -> Interpreter | None:
    """Every Python this machine has, narrowed to the best one to use."""
    candidates: list[Interpreter] = []

    launcher = shutil.which("py")
    if launcher:
        try:
            out = _run([launcher, "-0p"], capture_output=True, text=True,
                       errors="replace", timeout=60)
            candidates += parse_py_list(out.stdout or "")
        except (OSError, subprocess.SubprocessError):
            pass

    plain = shutil.which("python")
    if plain:
        asked = _ask_python(plain)
        if asked:
            candidates.append(asked)

    return pick(candidates)


def python_installer_url(machine: str = "") -> str:
    """Which python.org build this machine wants."""
    machine = (machine or platform.machine()).lower()
    if machine in ("arm64", "aarch64"):
        return PYTHON_INSTALLERS["arm64"]
    if machine in ("x86", "i386", "i686"):
        return PYTHON_INSTALLERS["win32"]
    return PYTHON_INSTALLERS["amd64"]


def install_python(console: Console) -> Interpreter | None:
    """Put a Python on the machine, quietly and without administrator rights.

    winget first because it is a few seconds when it works, and the download
    from python.org second because winget is missing on plenty of Windows 10
    machines and this cannot be a dead end.
    """
    winget = shutil.which("winget")
    if winget:
        console.say("installing Python with winget")
        try:
            _run([winget, "install", "--id", "Python.Python.3.12", "--source", "winget",
                  "--accept-package-agreements", "--accept-source-agreements", "--silent"],
                 timeout=900)
            refresh_path()
            found = find_python()
            if found:
                return found
        except (OSError, subprocess.SubprocessError):
            pass
        console.warn("winget could not do it - downloading Python instead")

    url = python_installer_url()
    console.say(f"downloading Python {PYTHON_VERSION}")
    installer = Path(tempfile.gettempdir()) / f"python-{PYTHON_VERSION}.exe"
    try:
        download(url, installer)
    except OSError as error:
        console.warn(f"could not download Python: {error}")
        return None

    console.say("installing it - this takes a minute")
    try:
        # InstallAllUsers=0 keeps it out of Program Files, which is what lets
        # the whole install run without administrator rights.
        _run([str(installer), "/quiet", "InstallAllUsers=0", "PrependPath=1",
              "Include_launcher=1", "Include_test=0"], timeout=1800)
    except (OSError, subprocess.SubprocessError) as error:
        console.warn(f"the Python installer did not finish: {error}")
        return None
    finally:
        installer.unlink(missing_ok=True)

    refresh_path()
    return find_python()


def refresh_path() -> None:
    """Pick up a PATH that an installer just changed.

    Windows tells new processes about the new PATH, not this one, so without
    this the Python that was just installed cannot be found until the
    installer is run a second time.
    """
    if os.name != "nt":
        return
    try:
        import winreg
    except ImportError:
        return

    parts = []
    for root, key in (
        (winreg.HKEY_LOCAL_MACHINE,
         r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (winreg.HKEY_CURRENT_USER, "Environment"),
    ):
        try:
            with winreg.OpenKey(root, key) as handle:
                value, _ = winreg.QueryValueEx(handle, "Path")
                parts.append(os.path.expandvars(value))
        except OSError:
            continue
    if parts:
        os.environ["PATH"] = os.pathsep.join(parts + [os.environ.get("PATH", "")])


# ------------------------------------------------------------------ code


def download(url: str, target: Path) -> None:
    """Fetch a file, with a user agent GitHub will answer."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as out:
            shutil.copyfileobj(response, out)


def branch_has_code(branch: str) -> bool:
    """Whether a branch holds Thursday.

    A pyproject.toml is the same thing the install would check three steps
    later anyway, and asking for one file is cheaper than cloning to find out.
    """
    if not branch:
        return False
    url = f"https://raw.githubusercontent.com/{OWNER}/{NAME}/{branch}/pyproject.toml"
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def list_branches() -> list[str]:
    """What branches the repository has, if GitHub will say."""
    import json

    url = f"https://api.github.com/repos/{OWNER}/{NAME}/branches?per_page=100"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return [entry["name"] for entry in json.load(response)]
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        return []


def resolve_branch(has_code=branch_has_code, branches=list_branches) -> str | None:
    """Which branch to install from, worked out rather than asked for.

    main once this is merged, the working branch until then, and if someone
    has renamed things since, whatever branch GitHub lists that has the code.
    """
    for candidate in (MAIN_BRANCH, WORK_BRANCH):
        if has_code(candidate):
            return candidate
    for name in branches():
        if name in (MAIN_BRANCH, WORK_BRANCH):
            continue
        if has_code(name):
            return name
    return None


def zip_folder(branch: str) -> str:
    """What GitHub names the folder inside a branch zip.

    Every / becomes a -, so claude/jarvis-assistant unpacks as
    Thursday-claude-jarvis-assistant.
    """
    return f"{NAME}-{branch.replace('/', '-')}"


def fetch_code(path: Path, branch: str, console: Console) -> None:
    """Put the code in `path`, by zip rather than git.

    No git is normal on a fresh Windows machine, and installing git to fetch
    one zip is not a reasonable ask of someone who wanted an installer.
    """
    console.say(f"downloading {branch}")
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / "thursday.zip"
        try:
            download(f"{REPO}/archive/refs/heads/{branch}.zip", archive)
        except (urllib.error.URLError, OSError) as error:
            raise Stop(f"could not download branch '{branch}' from {REPO}: {error}")

        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(scratch)

        unpacked = Path(scratch) / zip_folder(branch)
        if not unpacked.is_dir():
            # A branch name with characters GitHub folds differently, or a
            # zip that is not shaped how it has been for a decade. Either
            # way, take the only directory in there rather than giving up.
            others = [entry for entry in Path(scratch).iterdir() if entry.is_dir()]
            if len(others) != 1:
                raise Stop(f"the download of '{branch}' did not unpack as expected")
            unpacked = others[0]

        path.mkdir(parents=True, exist_ok=True)
        for entry in unpacked.iterdir():
            target = path / entry.name
            if entry.is_dir():
                shutil.copytree(entry, target, dirs_exist_ok=True)
            else:
                shutil.copy2(entry, target)
    console.say(f"downloaded {branch} into {path}")


def default_path() -> Path:
    """Where an install goes when nobody says otherwise.

    The same place install.ps1 uses, so running one after the other updates
    an install rather than making a second one.
    """
    local = os.environ.get("LOCALAPPDATA")
    return Path(local) / NAME if local else Path.home() / NAME


# --------------------------------------------------------------- the venv


def build_venv(path: Path, python: Interpreter, extras: str, console: Console) -> Path:
    """A virtual environment beside the code, with Thursday installed in it."""
    venv = path / ".venv"
    vpython = venv / "Scripts" / "python.exe"
    if not vpython.exists():
        console.say("making a virtual environment")
        result = _run([python.exe, "-m", "venv", str(venv)])
        if result.returncode != 0:
            raise Stop("the virtual environment could not be created")
    if not vpython.exists():
        raise Stop("the virtual environment did not come out right")

    _run([str(vpython), "-m", "pip", "install", "--upgrade", "pip", "--quiet"])

    console.say(f"installing thursday[{extras}] - this takes a few minutes")
    # Not quiet, and not captured: pip is the slowest part of this by a wide
    # margin, and a progress bar is the difference between waiting and
    # wondering whether it has hung.
    result = _run([str(vpython), "-m", "pip", "install", "-e", f".[{extras}]"], cwd=str(path))
    if result.returncode != 0:
        raise Stop("the install failed. The log above says why, and a copy is in the log file.")
    console.say("installed")

    console.say("fetching a browser for Thursday to drive")
    _run([str(vpython), "-m", "playwright", "install", "chromium"],
         capture_output=True, text=True)
    return venv


# ------------------------------------------------------------------ .env


def env_additions(key: str = "", vault: str = "") -> list[str]:
    """What gets appended to .env for the answers given.

    Appended rather than edited in place: the example file is comments and
    defaults, and the last assignment of a name wins.
    """
    lines = []
    if key.strip():
        lines.append(f"ANTHROPIC_API_KEY={key.strip()}")
    if vault.strip():
        lines.append(f"THURSDAY_VAULT={vault.strip()}")
    return lines


def configure(path: Path, console: Console, ask=input) -> None:
    """Ask the two questions that cannot be guessed."""
    env_file = path / ".env"
    if env_file.exists():
        console.say("keeping the .env that is already there")
        return

    example = path / ".env.example"
    if example.exists():
        shutil.copy2(example, env_file)
    else:
        env_file.touch()

    console.say("")
    console.say("Paste your Anthropic API key (from console.anthropic.com),")
    console.say("or press Enter to skip and use a local model instead.")
    key = ask("  key: ")

    console.say("")
    console.say("Where is your Obsidian vault? (Enter to skip)")
    console.say("The folder with .obsidian in it - Thursday uses it as a second brain.")
    vault = ask("  path: ")

    if vault.strip() and not Path(vault.strip()).is_dir():
        console.warn(f"{vault.strip()} is not a folder - set THURSDAY_VAULT in .env later")
        vault = ""

    lines = env_additions(key, vault)
    if lines:
        with env_file.open("a", encoding="utf-8") as handle:
            handle.write("\n" + "\n".join(lines) + "\n")
        console.say("saved to .env")
    if not key.strip():
        console.warn("no key set. Install Ollama and run: thursday --local")


# ------------------------------------------------------------- shortcuts


def shortcut_script(link: Path, target: Path, arguments: str, working: Path,
                    description: str) -> str:
    """PowerShell that makes one .lnk.

    A shortcut is a COM object with no command-line equivalent, so this is
    the one place PowerShell is unavoidable. Paths go in single-quoted
    strings, which PowerShell does not expand anything inside - a folder
    named `$env` or with a backtick in it would otherwise rewrite the script.
    """
    def quoted(value) -> str:
        return "'" + str(value).replace("'", "''") + "'"

    return (
        "$shell = New-Object -ComObject WScript.Shell; "
        f"$link = $shell.CreateShortcut({quoted(link)}); "
        f"$link.TargetPath = {quoted(target)}; "
        f"$link.Arguments = {quoted(arguments)}; "
        f"$link.WorkingDirectory = {quoted(working)}; "
        f"$link.Description = {quoted(description)}; "
        "$link.Save()"
    )


def make_shortcuts(path: Path, venv: Path, console: Console) -> None:
    """Thursday on the Start menu, both ways of running it.

    Not fatal if it fails: an install without a Start menu entry still works
    from the folder, and losing the whole install to a locked-down
    PowerShell would be a poor trade.
    """
    appdata = os.environ.get("APPDATA")
    if not appdata:
        console.warn("no APPDATA, so no Start menu shortcuts")
        return
    folder = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        console.warn(f"could not write to the Start menu: {error}")
        return

    wanted = [
        (folder / "Thursday.lnk", venv / "Scripts" / "pythonw.exe",
         "-m thursday serve", "Thursday, a personal assistant"),
        (folder / "Thursday (terminal).lnk", venv / "Scripts" / "thursday.exe",
         "", "Thursday in a console window"),
    ]

    made = 0
    for link, target, arguments, description in wanted:
        script = shortcut_script(link, target, arguments, path, description)
        try:
            result = _run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                           "-Command", script], capture_output=True, text=True, timeout=60)
            made += result.returncode == 0
        except (OSError, subprocess.SubprocessError):
            pass

    if made == len(wanted):
        console.say("on the Start menu")
    else:
        console.warn("could not add the Start menu shortcuts - "
                     f"run Thursday from {venv / 'Scripts' / 'thursday.exe'}")


# ------------------------------------------------------------------ done


def closing_words(path: Path) -> str:
    """What to say once it is installed."""
    scripts = path / ".venv" / "Scripts"
    return f"""
  Ready.

    Start menu    Thursday                the web UI at http://127.0.0.1:8765
                  Thursday (terminal)     chat in a console window

    From here     {scripts / 'thursday.exe'}
                  {scripts / 'thursday.exe'} serve      the web UI
                  {scripts / 'thursday.exe'} pair       put it on your phone

  Voice in and out needs one more step:
    {scripts / 'pip.exe'} install -e ".[voice]"
  Face recognition needs a C++ compiler, so it is left out:
    winget install Microsoft.VisualStudio.2022.BuildTools
    {scripts / 'pip.exe'} install -e ".[identity]"
"""


def check(console: Console) -> int:
    """Everything that decides something without changing anything.

    CI runs this against the exe it has just built, so a build that cannot
    start, cannot see the machine's Python or cannot reach the repository
    fails there rather than on someone's desktop.
    """
    console.step("Checking this build")
    console.say(f"running on {platform.platform()}")
    console.say(f"would install to {default_path()}")
    console.say(f"would fetch Python from {python_installer_url()}")

    found = find_python()
    console.say(f"found {found}" if found else "no usable Python on this machine")

    branch = resolve_branch()
    if not branch:
        console.warn("no branch of the repository holds Thursday")
        return 1
    console.say(f"would install from {branch}")
    console.say(f"which unpacks as {zip_folder(branch)}")
    return 0


def install(args, console: Console) -> int:
    console.banner()

    console.step("Looking for Python")
    python = find_python()
    if python and python.version > KNOWN_GOOD:
        console.warn(f"the only Python here is {python.version[0]}.{python.version[1]}, "
                     "which is ahead of the wheels")
        console.say("fetching Python 3.12 as well, so nothing has to be compiled")
        better = install_python(console)
        if better and better.version <= KNOWN_GOOD:
            python = better
    elif not python:
        console.warn("no Python 3.10 or newer found - installing it")
        python = install_python(console)
    if not python:
        raise Stop("could not install Python. Get it from https://python.org/downloads, "
                   "then run this again.")
    console.say(f"using {python}")

    console.step("Getting Thursday")
    path = Path(args.path).expanduser() if args.path else default_path()
    if (path / "pyproject.toml").exists():
        # Already here - a second run, or a clone. Nothing to fetch, and no
        # reason to ask the network which branch to fetch it from. Notably
        # this is also what keeps a re-run from overwriting anyone's data.
        console.say(f"using the copy already in {path}")
    else:
        branch = args.branch or resolve_branch()
        if not branch:
            raise Stop(f"could not find a branch of {REPO} holding Thursday. "
                       "Check the network, or pass --branch if you know which one.")
        fetch_code(path, branch, console)

    if not (path / "pyproject.toml").exists():
        raise Stop(f"there is no Thursday in {path}")

    console.step("Setting up")
    venv = build_venv(path, python, VOICE_EXTRAS if args.with_voice else EXTRAS, console)

    console.step("Configuring")
    configure(path, console)

    console.step("Adding shortcuts")
    make_shortcuts(path, venv, console)

    console.step(closing_words(path))

    if args.start:
        console.say("starting the web UI")
        subprocess.Popen([str(venv / "Scripts" / "thursday.exe"), "serve"], cwd=str(path))
        time.sleep(3)
        os.startfile("http://127.0.0.1:8765")  # noqa: S606 - Windows only, fixed URL
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install Thursday on this machine.")
    parser.add_argument("--path", default="", help="where to install it")
    parser.add_argument("--branch", default="", help="which branch to install from")
    parser.add_argument("--with-voice", action="store_true",
                        help="install the voice extras too (large: pulls in torch)")
    parser.add_argument("--start", action="store_true", help="run it when the install finishes")
    parser.add_argument("--check", action="store_true",
                        help="check this build without touching the machine")
    parser.add_argument("--no-pause", action="store_true",
                        help="do not wait for a keypress at the end")
    args = parser.parse_args(argv)

    # No log in --check: it is run on a CI machine to prove the exe starts,
    # and a check that leaves a folder behind is not a check.
    console = Console(None if args.check else default_path() / "install.log")
    code = 1
    try:
        code = check(console) if args.check else install(args, console)
    except Stop as error:
        console.step(f"  x {error}")
    except KeyboardInterrupt:
        console.step("  stopped")
    except Exception as error:  # noqa: BLE001 - the last thing before the window closes
        console.step(f"  x something went wrong: {error!r}")
        if console.log:
            console.say(f"the whole story is in {console.log}")

    if not args.no_pause and not args.check:
        # Without this, a double-clicked installer that fails closes its own
        # window and takes the reason with it.
        try:
            input("\n  Press Enter to close. ")
        except (EOFError, KeyboardInterrupt):
            pass
    return code


if __name__ == "__main__":
    sys.exit(main())
