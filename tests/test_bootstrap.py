"""The installer that is a file you double-click.

There is no Windows here, so what is tested is the part that decides things -
which Python to build on, which branch holds the code, what goes in the .env -
and the shapes of the two files a build needs. The part that touches Windows
is exercised by the `--check` run in the installer workflow, on a real
runner, against the exe that was actually built.
"""

from __future__ import annotations

import importlib.util
import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "setup" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


bootstrap = load("bootstrap")
make_icon = load("make_icon")

Interpreter = bootstrap.Interpreter


# ---------------------------------------------------------- finding python


def test_the_launcher_listing_is_read_in_both_of_its_shapes():
    listing = """ -V:3.13 *        C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\python.exe
 -V:3.10          C:\\Python310\\python.exe
 -3.9-64          C:\\Python39\\python.exe
"""

    found = bootstrap.parse_py_list(listing)

    assert [entry.version for entry in found] == [(3, 13), (3, 10), (3, 9)]
    assert found[1].exe == "C:\\Python310\\python.exe"


def test_lines_that_are_not_an_interpreter_are_ignored():
    assert bootstrap.parse_py_list("Installed Pythons found by py Launcher\n\n") == []


def test_the_store_stub_is_not_a_python():
    """It prints nothing and opens the Microsoft Store, and it is first on
    PATH on a machine that has never had Python."""
    stub = Interpreter((3, 12), "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe")
    real = Interpreter((3, 12), "C:\\Python312\\python.exe")

    assert bootstrap.usable([stub, real]) == [real]


def test_a_python_older_than_thursday_supports_is_not_offered():
    assert bootstrap.usable([Interpreter((3, 8), "C:\\Python38\\python.exe")]) == []


def test_the_newest_python_with_wheels_wins():
    """Not simply the newest: wheels lag a release by months, and without one
    pip builds from source and asks for a C++ compiler."""
    chosen = bootstrap.pick([
        Interpreter((3, 10), "C:\\a\\python.exe"),
        Interpreter((3, 14), "C:\\b\\python.exe"),
        Interpreter((3, 12), "C:\\c\\python.exe"),
    ])

    assert chosen.version == (3, 12)


def test_a_machine_with_only_a_too_new_python_still_gets_an_answer():
    """It may need a compiler, and the installer says so and offers to fetch
    an older one - but refusing outright would be worse."""
    chosen = bootstrap.pick([
        Interpreter((3, 15), "C:\\a\\python.exe"),
        Interpreter((3, 14), "C:\\b\\python.exe"),
    ])

    assert chosen.version == (3, 14)


def test_no_python_at_all_is_not_an_error_here():
    assert bootstrap.pick([]) is None


def test_the_python_that_gets_downloaded_matches_the_machine():
    assert "arm64" in bootstrap.python_installer_url("ARM64")
    assert "arm64" in bootstrap.python_installer_url("aarch64")
    assert "amd64" in bootstrap.python_installer_url("AMD64")
    assert bootstrap.python_installer_url("x86").endswith(f"python-{bootstrap.PYTHON_VERSION}.exe")


def test_python_is_only_ever_fetched_from_python_org_over_https():
    for url in bootstrap.PYTHON_INSTALLERS.values():
        assert url.startswith("https://www.python.org/ftp/python/")
        assert bootstrap.PYTHON_VERSION in url


# --------------------------------------------------------- finding thursday


def test_main_is_preferred_once_the_code_is_there():
    branch = bootstrap.resolve_branch(has_code=lambda name: True, branches=list)

    assert branch == bootstrap.MAIN_BRANCH


def test_the_working_branch_is_used_until_then():
    branch = bootstrap.resolve_branch(
        has_code=lambda name: name == bootstrap.WORK_BRANCH, branches=list,
    )

    assert branch == bootstrap.WORK_BRANCH


def test_a_renamed_branch_is_found_by_asking_github():
    """So that renaming a branch does not turn every install into a support
    question."""
    asked = []

    def has_code(name):
        asked.append(name)
        return name == "somewhere/else"

    branch = bootstrap.resolve_branch(has_code=has_code, branches=lambda: ["docs", "somewhere/else"])

    assert branch == "somewhere/else"
    assert asked[:2] == [bootstrap.MAIN_BRANCH, bootstrap.WORK_BRANCH]


def test_the_branches_already_tried_are_not_tried_again():
    tried = []
    bootstrap.resolve_branch(
        has_code=lambda name: tried.append(name) or False,
        branches=lambda: [bootstrap.MAIN_BRANCH, "other"],
    )

    assert tried.count(bootstrap.MAIN_BRANCH) == 1


def test_a_repository_with_no_thursday_in_it_says_so():
    assert bootstrap.resolve_branch(has_code=lambda name: False, branches=list) is None


def test_a_branch_with_slashes_unpacks_under_the_name_github_gives_it():
    assert bootstrap.zip_folder("claude/jarvis-assistant") == "Thursday-claude-jarvis-assistant"
    assert bootstrap.zip_folder("main") == "Thursday-main"


def test_the_code_is_unpacked_out_of_the_zip_github_serves(tmp_path, monkeypatch):
    import zipfile

    branch = "claude/thing"
    archive = tmp_path / "made.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(f"{bootstrap.zip_folder(branch)}/pyproject.toml", "[project]\n")
        bundle.writestr(f"{bootstrap.zip_folder(branch)}/thursday/__init__.py", "")

    monkeypatch.setattr(bootstrap, "download",
                        lambda url, target: target.write_bytes(archive.read_bytes()))

    into = tmp_path / "install"
    bootstrap.fetch_code(into, branch, bootstrap.Console())

    assert (into / "pyproject.toml").read_text() == "[project]\n"
    assert (into / "thursday" / "__init__.py").exists()


def test_a_download_that_fails_is_explained_not_traced(tmp_path, monkeypatch):
    def refuse(url, target):
        raise OSError("no route to host")

    monkeypatch.setattr(bootstrap, "download", refuse)

    with pytest.raises(bootstrap.Stop, match="could not download"):
        bootstrap.fetch_code(tmp_path / "x", "main", bootstrap.Console())


def test_it_installs_where_the_powershell_installer_does(monkeypatch):
    """Either one run after the other should update an install, not make a
    second one somewhere else."""
    monkeypatch.setenv("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local")

    assert bootstrap.default_path().name == "Thursday"
    assert "AppData" in str(bootstrap.default_path())


# ------------------------------------------------------------------- .env


def test_the_answers_become_env_lines():
    assert bootstrap.env_additions("sk-ant-123", "D:\\Vault") == [
        "ANTHROPIC_API_KEY=sk-ant-123",
        "THURSDAY_VAULT=D:\\Vault",
    ]


def test_pressing_enter_twice_writes_nothing():
    assert bootstrap.env_additions("", "  ") == []


def test_a_key_pasted_with_a_stray_space_still_works():
    assert bootstrap.env_additions("  sk-ant-123 ") == ["ANTHROPIC_API_KEY=sk-ant-123"]


def test_the_env_starts_from_the_example_and_the_answers_are_appended(tmp_path):
    (tmp_path / ".env.example").write_text("# defaults\nTHURSDAY_MODEL=claude\n")
    answers = iter(["sk-ant-xyz", ""])

    bootstrap.configure(tmp_path, bootstrap.Console(), ask=lambda prompt: next(answers))

    written = (tmp_path / ".env").read_text()
    assert "# defaults" in written
    assert written.strip().endswith("ANTHROPIC_API_KEY=sk-ant-xyz")


def test_an_env_that_is_already_there_is_left_alone(tmp_path):
    """Running the installer again to update must not lose someone's key."""
    (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=mine\n")

    bootstrap.configure(tmp_path, bootstrap.Console(), ask=lambda prompt: "something else")

    assert (tmp_path / ".env").read_text() == "ANTHROPIC_API_KEY=mine\n"


def test_a_vault_path_that_is_not_a_folder_is_refused_rather_than_saved(tmp_path):
    (tmp_path / ".env.example").write_text("")
    answers = iter(["", "D:\\typo"])

    bootstrap.configure(tmp_path, bootstrap.Console(), ask=lambda prompt: next(answers))

    assert "THURSDAY_VAULT" not in (tmp_path / ".env").read_text()


def test_a_real_vault_folder_is_saved(tmp_path):
    (tmp_path / ".env.example").write_text("")
    vault = tmp_path / "Brain"
    vault.mkdir()
    answers = iter(["", str(vault)])

    bootstrap.configure(tmp_path, bootstrap.Console(), ask=lambda prompt: next(answers))

    assert f"THURSDAY_VAULT={vault}" in (tmp_path / ".env").read_text()


# -------------------------------------------------------------- shortcuts


def test_the_shortcut_script_quotes_the_paths_it_is_given():
    script = bootstrap.shortcut_script(
        Path("C:/Menu/Thursday.lnk"), Path("C:/T/.venv/Scripts/pythonw.exe"),
        "-m thursday serve", Path("C:/T"), "Thursday",
    )

    assert "$link.Arguments = '-m thursday serve'" in script
    assert "CreateShortcut('C:" in script


def test_a_folder_name_cannot_rewrite_the_shortcut_script():
    """PowerShell expands nothing inside single quotes, so the only thing
    that could escape one is another single quote."""
    script = bootstrap.shortcut_script(
        Path("C:/it's/Thursday.lnk"), Path("C:/$env:temp/python.exe"), "", Path("C:/x"), "d",
    )

    assert "'C:/it''s/Thursday.lnk'" in script
    assert "'C:/$env:temp/python.exe'" in script
    assert script.count("'") % 2 == 0


# ---------------------------------------------------------------- talking


def test_what_is_printed_is_also_written_down(tmp_path):
    """A window that closes on failure takes the reason with it."""
    log = tmp_path / "logs" / "install.log"
    console = bootstrap.Console(log)

    console.step("Looking for Python")
    console.warn("none found")

    assert "Looking for Python" in log.read_text()
    assert "! none found" in log.read_text()


def test_a_log_that_cannot_be_written_does_not_stop_the_install(tmp_path):
    blocked = tmp_path / "file"
    blocked.write_text("in the way")

    console = bootstrap.Console(blocked / "install.log")
    console.say("still talking")


def test_the_closing_words_say_how_to_run_it(tmp_path):
    words = bootstrap.closing_words(tmp_path)

    assert "thursday.exe" in words
    assert "serve" in words and "pair" in words


# ------------------------------------------------------ the two installers


def read_install_ps1() -> str:
    return (ROOT / "install.ps1").read_text(encoding="utf-8")


def test_both_installers_point_at_the_same_repository():
    script = read_install_ps1()

    assert f'$Owner = "{bootstrap.OWNER}"' in script
    assert f'$Name = "{bootstrap.NAME}"' in script


def test_both_installers_know_the_same_branches():
    script = read_install_ps1()

    assert f'$MainBranch = "{bootstrap.MAIN_BRANCH}"' in script
    assert f'$WorkBranch = "{bootstrap.WORK_BRANCH}"' in script


def test_both_installers_install_the_same_extras():
    """Otherwise which installer someone used decides what Thursday can do."""
    script = read_install_ps1()

    assert f'$extras = "{bootstrap.EXTRAS}"' in script
    assert bootstrap.VOICE_EXTRAS == bootstrap.EXTRAS + ",voice"


def test_both_installers_agree_on_the_python_they_prefer():
    script = read_install_ps1()
    known = f"{bootstrap.KNOWN_GOOD[0]}.{bootstrap.KNOWN_GOOD[1]}"
    oldest = f"{bootstrap.OLDEST[0]}.{bootstrap.OLDEST[1]}"

    assert f'$KnownGood = [version]"{known}"' in script
    assert f'$Oldest = [version]"{oldest}"' in script


# ---------------------------------------------------------------- the icon


def test_the_icon_is_a_readable_ico():
    data = make_icon.build()
    reserved, kind, count = struct.unpack("<HHH", data[:6])

    assert (reserved, kind) == (0, 1)
    assert count == len(make_icon.SIZES)


def test_every_image_in_it_is_where_the_directory_says_it_is():
    data = make_icon.build()
    count = struct.unpack("<H", data[4:6])[0]

    for index in range(count):
        entry = data[6 + index * 16:6 + (index + 1) * 16]
        width, height, colours, _, planes, bits, length, offset = struct.unpack("<BBBBHHII", entry)
        assert (colours, planes, bits) == (0, 1, 32)
        assert width == height
        assert offset + length <= len(data)
        # A 40-byte header, then the pixels, then the mask.
        header_size, _, stored_height = struct.unpack("<Iii", data[offset:offset + 12])
        assert header_size == 40
        assert stored_height == width * 2


def test_the_icon_is_the_reactor_and_not_a_blank_square():
    """A ring: transparent in the middle of the gap, opaque on the band."""
    size = 64
    rows = make_icon.pixels(size)
    middle = size // 2

    on_the_ring = rows[middle * size + int(size * 0.375)]
    in_the_gap = rows[middle * size + int(size * 0.24)]
    at_the_core = rows[middle * size + middle]
    outside = rows[0]

    assert on_the_ring[3] == 255
    assert in_the_gap[3] == 0
    assert at_the_core[3] == 255
    assert outside[3] == 0


def test_the_icon_carries_the_sizes_windows_asks_for():
    assert 16 in make_icon.SIZES and 32 in make_icon.SIZES and 48 in make_icon.SIZES


# ------------------------------------------------------------- the build


def test_the_version_resource_matches_the_package():
    resource = (ROOT / "setup" / "version_info.txt").read_text()
    pyproject = (ROOT / "pyproject.toml").read_text()
    version = pyproject.split('version = "', 1)[1].split('"', 1)[0]

    assert f"StringStruct('ProductVersion', '{version}')" in resource
    assert "StringStruct('OriginalFilename', 'Thursday-Setup.exe')" in resource


def test_the_workflow_builds_the_file_the_readme_offers():
    workflow = (ROOT / ".github" / "workflows" / "installer.yml").read_text()
    readme = (ROOT / "README.md").read_text()

    assert "--name Thursday-Setup" in workflow
    assert "dist/Thursday-Setup.exe" in workflow
    assert f"https://github.com/{bootstrap.OWNER}/{bootstrap.NAME}/releases/download/setup/Thursday-Setup.exe" in readme


def test_the_workflow_proves_the_exe_starts_before_publishing_it():
    workflow = (ROOT / ".github" / "workflows" / "installer.yml").read_text()

    checked = workflow.index("Thursday-Setup.exe --check")
    published = workflow.index("gh release create")
    assert checked < published


def test_the_check_run_touches_nothing():
    """It is run on a CI machine, which should be the same machine
    afterwards as it was before."""
    source = (ROOT / "setup" / "bootstrap.py").read_text()
    body = source.split("def check(", 1)[1].split("\ndef ", 1)[0]

    for forbidden in ("install_python", "fetch_code", "build_venv", "configure",
                      "make_shortcuts", "mkdir", "write_text"):
        assert forbidden not in body
