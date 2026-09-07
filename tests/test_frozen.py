"""Thursday packaged into one file.

The dangerous thing about freezing an app is that it keeps working right up
until it matters: PyInstaller unpacks the program into a temporary folder and
deletes it on exit, so a database written beside the code is fine all
afternoon and gone in the morning. Most of what is here is about that one
distinction - what was shipped, and what the person owns - and about the two
never being the same directory when it counts.

The bundle itself is checked on a real Windows runner by `Thursday.exe
selftest` and by serving the page, because whether a package survived being
frozen is not a question that can be answered from here.
"""

from __future__ import annotations

import importlib.util
import socket
import sys
from pathlib import Path

import pytest

from thursday import home

ROOT = Path(__file__).resolve().parent.parent


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "setup" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


app = load("app")


@pytest.fixture()
def as_frozen(monkeypatch, tmp_path):
    """Pretend to be a packaged build, unpacked into tmp_path/bundle."""
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.delenv("THURSDAY_HOME", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData"))
    return bundle


# ------------------------------------------------------------------ where


def test_from_a_source_tree_nothing_moves():
    """The whole point of the source install is that everything is beside
    the code where you can see it."""
    assert home.frozen() is False
    assert home.home() == home.bundled() == ROOT


def test_the_settings_and_the_database_follow_it():
    from thursday import config, settings_store

    assert config.PROJECT_ROOT == home.home()
    assert settings_store.PROJECT_ROOT == home.home()


def test_frozen_what_you_own_is_never_where_the_program_was_unpacked(as_frozen):
    """This is the bug the whole module exists to prevent: PyInstaller
    deletes its unpack folder on exit, so a database written there is gone
    the moment Thursday is closed."""
    assert home.frozen() is True
    assert home.bundled() == as_frozen
    assert home.home() != home.bundled()


def test_frozen_your_things_go_beside_your_other_programs_things(as_frozen, tmp_path):
    assert home.home() == tmp_path / "AppData" / "Thursday"


def test_frozen_with_nowhere_obvious_to_put_them_they_go_under_your_own_folder(
    as_frozen, monkeypatch,
):
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)

    assert home.home() == Path.home() / "Thursday"


def test_saying_where_overrides_both(monkeypatch, tmp_path):
    """Which is how two Thursdays run side by side, and how the tests get at
    a home that is not the repository."""
    monkeypatch.setenv("THURSDAY_HOME", str(tmp_path / "elsewhere"))

    assert home.home() == tmp_path / "elsewhere"


# ------------------------------------------------------------- first start


def test_a_fresh_home_gets_the_shape_thursday_expects(tmp_path):
    source = tmp_path / "bundle"
    source.mkdir()
    (source / ".env.example").write_text("# paste your key here\n")
    root = tmp_path / "home"

    home.prepare(root, source)

    assert (root / "data").is_dir()
    assert (root / "plugins").is_dir()
    assert (root / ".env.example").read_text() == "# paste your key here\n"
    assert (root / ".env").read_text() == "# paste your key here\n"


def test_the_plugins_folder_says_what_it_is_for(tmp_path):
    """Otherwise it is an empty folder with a suggestive name."""
    home.prepare(tmp_path / "home", tmp_path)

    note = (tmp_path / "home" / "plugins" / "README.txt").read_text()
    assert "@tool" in note
    assert "no pip" in note


def test_starting_again_never_overwrites_what_you_changed(tmp_path):
    """It runs on every start, so this is the difference between a
    convenience and a way to lose the key you just pasted in."""
    source = tmp_path / "bundle"
    source.mkdir()
    (source / ".env.example").write_text("# blank\n")
    root = tmp_path / "home"

    home.prepare(root, source)
    (root / ".env").write_text("ANTHROPIC_API_KEY=mine\n")
    made = home.prepare(root, source)

    assert (root / ".env").read_text() == "ANTHROPIC_API_KEY=mine\n"
    assert made == []


def test_it_reports_only_what_it_actually_made(tmp_path):
    made = home.prepare(tmp_path / "home", tmp_path)

    assert str(tmp_path / "home") in made
    assert str(tmp_path / "home" / "data") in made


def test_an_example_the_bundle_does_not_carry_is_not_an_error(tmp_path):
    home.prepare(tmp_path / "home", tmp_path / "nothing-here")

    assert (tmp_path / "home" / "data").is_dir()
    assert not (tmp_path / "home" / ".env").exists()


# ------------------------------------------------------------ double-click


def test_double_clicking_it_opens_the_assistant():
    """No arguments is what a double-click passes, and what someone who
    double-clicked an assistant wants is the assistant, on screen."""
    args, browser = app.wanted([])

    assert args == ["serve"]
    assert browser is True


def test_from_a_terminal_it_is_the_ordinary_command():
    args, browser = app.wanted(["chat", "--local"])

    assert args == ["chat", "--local"]
    assert browser is False


def test_no_browser_is_opened_for_something_that_is_not_a_page():
    assert app.wanted(["pair"])[1] is False
    assert app.wanted(["mcp"])[1] is False


def test_the_protocol_modes_are_never_printed_over():
    """`mcp` speaks a protocol on stdout; a banner in the middle of it is a
    parse error at the other end."""
    assert "mcp" in app.QUIET


def test_the_browser_waits_for_the_door_to_open_rather_than_guessing():
    """A fixed sleep is too short on the first run, when a frozen app is
    still unpacking itself, and wasted on every run after."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    try:
        assert app.wait_for("127.0.0.1", port, timeout=2.0) is True
    finally:
        listener.close()

    assert app.wait_for("127.0.0.1", port, timeout=0.4) is False


def test_binding_everywhere_is_opened_somewhere_reachable():
    """http://0.0.0.0/ is not an address a browser can go to."""
    assert app.wait_for("0.0.0.0", 1, timeout=0.2) is False


# --------------------------------------------------------------- selftest


def test_the_selftest_covers_everything_the_release_notes_promise():
    carried = {module for _, module in app.REQUIRED + app.OPTIONAL}

    for module in ("anthropic", "uvicorn", "pypdf", "docx", "mcp", "playwright",
                   "qrcode", "sounddevice", "faster_whisper"):
        assert module in carried


def test_a_missing_optional_package_is_not_a_broken_build():
    """It is a feature that is absent, exactly as it would be absent from a
    source install that skipped an extra."""
    assert not set(app.REQUIRED) & set(app.OPTIONAL)
    assert ("Claude", "anthropic") in app.REQUIRED
    assert all(label != "speech recognition" for label, _ in app.REQUIRED)


def test_the_selftest_passes_here(capsys):
    """The required packages are the ones the tests already need, so this
    running red means the bundle would have been broken too."""
    assert app.main(["selftest"]) == 0
    assert "the page" in capsys.readouterr().out


# ------------------------------------------------------------- the bundle


def read_spec() -> str:
    return (ROOT / "setup" / "thursday.spec").read_text()


def test_the_packages_that_carry_their_own_files_are_collected():
    """PyInstaller follows imports, not data. Each of these would import
    cleanly and then fail to find something at runtime."""
    spec = read_spec()

    for package in ("anthropic", "certifi", "uvicorn", "playwright", "sounddevice"):
        assert f'"{package}"' in spec


def test_the_page_is_in_the_bundle():
    """Thursday.exe with no page is a web server that serves a stack trace."""
    spec = read_spec()

    assert '"index.html"' in spec
    assert (ROOT / "thursday" / "web" / "index.html").is_file()


def test_the_things_that_cannot_be_built_are_kept_out():
    spec = read_spec()

    assert "dlib" in spec and "face_recognition" in spec
    assert "excludes" in spec


def test_the_bundle_is_named_what_the_workflow_publishes():
    spec = read_spec()
    workflow = (ROOT / ".github" / "workflows" / "installer.yml").read_text()

    assert 'name="Thursday"' in spec
    assert "dist/Thursday.exe" in workflow
    assert "downloads/Thursday.exe" in workflow


def test_the_exe_says_what_it_is_in_its_properties():
    resource = (ROOT / "setup" / "app_version_info.txt").read_text()

    assert "StringStruct('OriginalFilename', 'Thursday.exe')" in resource
    assert "StringStruct('FileDescription', 'Thursday')" in resource


def test_nothing_is_published_that_has_not_been_started_and_asked(tmp_path):
    workflow = (ROOT / ".github" / "workflows" / "installer.yml").read_text()

    assert workflow.index("selftest") < workflow.index("gh release create")
    assert workflow.index("the server never answered") < workflow.index("gh release create")
    # And the release job cannot run before either build has finished.
    assert "needs: [app, setup]" in workflow


def test_windows_gets_a_voice_it_can_actually_use():
    """Every other tts backend is a Linux or macOS binary, so without this
    the packaged Thursday would have no way to speak at all."""
    pyproject = (ROOT / "pyproject.toml").read_text()

    assert "pyttsx3" in pyproject
    assert "sys_platform == 'win32'" in pyproject
