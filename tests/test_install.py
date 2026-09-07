"""Getting Thursday onto a Windows machine and a phone."""

from __future__ import annotations

import platform
import re
import xml.dom.minidom
from pathlib import Path

import pytest

from thursday import service
from thursday.pairing import Pairing, PairingError, build, instructions, qr_lines


@pytest.fixture()
def on_windows(monkeypatch):
    """Pretend to be Windows, so the Windows paths are testable anywhere."""
    monkeypatch.setattr(platform, "system", lambda: "Windows")
    monkeypatch.setenv("LOCALAPPDATA", "/tmp/localappdata")


# ------------------------------------------------------------------ windows


def test_windows_gets_a_scheduled_task(on_windows):
    """There is no systemd. Task Scheduler is what a normal user can reach
    without administrator rights."""
    text = service.unit_text("Thursday", Path("C:/Users/me/Thursday"))

    xml.dom.minidom.parseString(text)        # it has to be valid XML
    assert "<LogonTrigger>" in text
    assert "-m thursday serve" in text
    assert "C:/Users/me/Thursday" in text


def test_the_task_survives_a_laptop_lid(on_windows):
    """A laptop assistant that dies when the power is unplugged is not one."""
    text = service.unit_text()

    assert "<DisallowStartIfOnBatteries>false" in text
    assert "<StopIfGoingOnBatteries>false" in text
    assert "<RestartOnFailure>" in text
    # No timeout, or Windows stops it after three days.
    assert "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>" in text


def test_the_task_runs_without_a_console_window(on_windows, monkeypatch, tmp_path):
    """Anything that starts with the machine should not open a black window."""
    fake = tmp_path / "python.exe"
    fake.write_text("", encoding="utf-8")
    (tmp_path / "pythonw.exe").write_text("", encoding="utf-8")
    monkeypatch.setattr(service.sys, "executable", str(fake))

    assert "pythonw.exe" in service.unit_text()


def test_a_missing_pythonw_falls_back_rather_than_breaking(on_windows, monkeypatch, tmp_path):
    fake = tmp_path / "python.exe"
    fake.write_text("", encoding="utf-8")
    monkeypatch.setattr(service.sys, "executable", str(fake))

    text = service.unit_text()

    assert str(fake) in text
    xml.dom.minidom.parseString(text)


def test_the_task_file_is_written_as_utf16(on_windows, monkeypatch, tmp_path):
    """Task Scheduler refuses anything else, with an error naming neither the
    file nor the encoding."""
    target = tmp_path / "thursday-task.xml"
    monkeypatch.setattr(service, "unit_path", lambda: target)
    monkeypatch.setattr(service.shutil, "which", lambda name: "/fake/schtasks")

    service.install("Thursday", tmp_path, apply=False)

    raw = target.read_bytes()
    assert raw.startswith(b"\xff\xfe") or raw[1:2] == b"\x00"   # UTF-16
    assert "<LogonTrigger>" in target.read_text(encoding="utf-16")


def test_windows_install_uses_schtasks(on_windows):
    commands = service.enable_commands()

    assert commands[0][:2] == ["schtasks", "/Create"]
    assert any("/Run" in command for command in commands)


def test_every_platform_still_has_its_own_answer(monkeypatch):
    for system, expected in (
        ("Linux", "systemctl"),
        ("Darwin", "launchctl"),
        ("Windows", "schtasks"),
    ):
        monkeypatch.setattr(platform, "system", lambda system=system: system)
        assert expected in " ".join(" ".join(c) for c in service.enable_commands())


def test_an_unknown_platform_says_so_rather_than_guessing(monkeypatch):
    monkeypatch.setattr(platform, "system", lambda: "Plan9")

    ok, why = service.supported()

    assert ok is False
    assert "Plan9" in why


# ------------------------------------------------------------- the installer


def test_the_windows_installer_is_shipped():
    script = Path(__file__).resolve().parent.parent / "install.ps1"

    assert script.is_file()
    text = script.read_text(encoding="utf-8")
    # The things that make a PowerShell script fail at parse time rather than
    # at the point of the mistake.
    assert text.count("{") == text.count("}")
    assert text.count("(") == text.count(")")
    assert text.count('@"') == text.count('"@')


def test_the_installer_leaves_out_what_needs_a_compiler():
    """dlib needs Visual Studio Build Tools - several gigabytes, for one
    optional feature. It has to be opt-in, and it has to say so."""
    text = (Path(__file__).resolve().parent.parent / "install.ps1").read_text(
        encoding="utf-8"
    )

    assert "identity" not in re.search(r'\$extras = "([^"]*)"', text).group(1)
    assert "BuildTools" in text          # and it says how to add it


def test_the_installer_refuses_the_store_stub():
    """The Microsoft Store ships a `python` that prints nothing and opens the
    Store. Every Windows install script gets caught by it once."""
    text = (Path(__file__).resolve().parent.parent / "install.ps1").read_text(
        encoding="utf-8"
    )

    assert "WindowsApps" in text


# ---------------------------------------------------------------- pairing


def test_a_pairing_carries_the_token_in_the_link():
    pairing = Pairing(url="http://192.168.1.20:8765", token="s3cr3t")

    assert pairing.link == "http://192.168.1.20:8765/?t=s3cr3t"


def test_a_token_with_awkward_characters_is_escaped():
    pairing = Pairing(url="http://x:8765", token="a b/c&d")

    assert " " not in pairing.link
    assert "a%20b%2Fc%26d" in pairing.link


def test_no_token_is_still_a_usable_link():
    assert Pairing(url="http://x:8765").link == "http://x:8765/"


def test_pairing_never_points_a_phone_at_loopback(monkeypatch):
    """127.0.0.1 is exactly the address that cannot work from a phone, and it
    is the one the server prints at startup."""
    monkeypatch.setattr("thursday.pairing.local_addresses", lambda: ["192.168.1.20"])

    pairing = build(port=8765, token="x")

    assert "127.0.0.1" not in pairing.link
    assert "192.168.1.20" in pairing.link


def test_a_machine_with_no_network_says_so(monkeypatch):
    monkeypatch.setattr("thursday.pairing.local_addresses", lambda: [])

    with pytest.raises(PairingError, match="same wifi"):
        build()


def test_an_explicit_host_wins(monkeypatch):
    monkeypatch.setattr("thursday.pairing.local_addresses", lambda: ["192.168.1.20"])

    assert "thursday.example.com" in build(host="thursday.example.com").link


def test_the_qr_code_is_drawn_two_rows_at_a_time():
    """Half blocks, or a code 41 rows tall does not fit in a terminal."""
    lines = qr_lines("http://192.168.1.20:8765/?t=abc")
    if not lines:
        pytest.skip("qrcode is not installed")

    assert 10 < len(lines) < 30
    assert all(len(line) == len(lines[0]) for line in lines)
    # Dark drawn as background: a phone camera wants dark-on-light and a
    # terminal is the other way round.
    assert "█" in "".join(lines)


def test_no_qr_library_is_not_a_failure(monkeypatch):
    """It falls back to a link you can type, and says how to get the code."""
    import builtins

    real = builtins.__import__

    def refuse(name, *args, **kwargs):
        if name == "qrcode":
            raise ImportError("no qrcode")
        return real(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", refuse)
    assert qr_lines("http://x") == []

    said = "\n".join(instructions(Pairing(url="http://x:8765", token="t"), has_qr=False))
    assert "http://x:8765/?t=t" in said
    assert "pip install qrcode" in said


def test_the_instructions_say_the_code_is_a_key():
    """It is one scan because the token is in it. That is worth saying."""
    said = "\n".join(
        instructions(Pairing(url="http://x", token="t", addresses=("192.168.1.20",)), True)
    )

    assert "key" in said
    assert "same wifi" in said
    assert "Home Screen" in said


def test_no_token_means_no_warning_about_one():
    said = "\n".join(instructions(Pairing(url="http://x", addresses=("1.2.3.4",)), True))

    assert "key" not in said


def test_local_addresses_are_real_and_reachable():
    from thursday.pairing import local_addresses

    for address in local_addresses():
        assert not address.startswith("127.")
        assert not address.startswith("169.254.")


def test_the_installer_can_be_pointed_at_a_branch():
    """Until a change is merged, `main` is not where the code is - and the
    404 that produces is the least helpful error in the whole flow."""
    text = (Path(__file__).resolve().parent.parent / "install.ps1").read_text(
        encoding="utf-8"
    )

    assert "$Branch" in text
    assert "--branch $Branch" in text                  # the clone honours it
    assert "refs/heads/$Branch.zip" in text            # so does the download


def test_the_installer_notices_a_branch_with_no_code_in_it():
    """A branch that exists but is empty clones perfectly happily; without
    this the first sign is a confusing pip error several steps later."""
    text = (Path(__file__).resolve().parent.parent / "install.ps1").read_text(
        encoding="utf-8"
    )

    assert "does not contain Thursday" in text


def test_a_branch_name_with_a_slash_unpacks_under_the_right_folder():
    """GitHub turns every / in a branch name into a - in the zip's folder,
    so feature/thing arrives as Repo-feature-thing."""
    text = (Path(__file__).resolve().parent.parent / "install.ps1").read_text(
        encoding="utf-8"
    )

    assert '$Branch -replace "/", "-"' in text
    assert "Thursday-main" not in text          # no hardcoded branch left


def _installer() -> str:
    return (Path(__file__).resolve().parent.parent / "install.ps1").read_text(
        encoding="utf-8"
    )


def test_the_installer_survives_being_piped_into_iex():
    """$PSScriptRoot is empty when there is no script file, and Join-Path
    throws on an empty path rather than returning one - which is exactly what
    the one-line install hit."""
    text = _installer()

    assert "$PSScriptRoot -and (Test-Path" in text
    # And the fallbacks it lands on are themselves guarded.
    assert "elseif ($env:LOCALAPPDATA)" in text
    assert 'Join-Path $HOME "Thursday"' in text


def test_the_installer_prefers_a_python_that_has_wheels():
    """The newest Python is often the wrong one: wheels lag a release by
    months, and without one pip builds from source - needing exactly the
    compiler this script exists to avoid."""
    text = _installer()

    assert '$KnownGood = [version]"3.13"' in text
    assert "$_.version -le $KnownGood" in text
    # Too new is not fatal - it fetches a supported one rather than stopping.
    assert "$python.version -gt $KnownGood" in text
    assert "Install-Python" in text


def test_the_installer_finds_pythons_that_are_not_on_path():
    """`py -0p` lists every install; not being on PATH is the usual reason
    `python` fails on a machine that definitely has Python."""
    text = _installer()

    assert "py -0p" in text
