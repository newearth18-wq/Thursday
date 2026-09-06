"""Settings you can change from the page, without editing files."""

from __future__ import annotations

import json

import pytest

from thursday.config import Settings
from thursday.settings_store import (
    FIELDS,
    FIELDS_BY_KEY,
    MASK,
    default_for,
    describe,
    load_overlay,
    save_overlay,
    update,
    validate,
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    """A blank environment and a throwaway settings file for every test."""
    import os

    for key in list(os.environ):
        if key.startswith("THURSDAY_") or key.endswith("_API_KEY"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("THURSDAY_DATA_DIR", str(tmp_path))
    return tmp_path


# ------------------------------------------------------------------ schema


def test_every_field_is_wired_to_a_real_setting():
    """An attr that does not exist would show a blank default forever."""
    defaults = Settings()
    for entry in FIELDS:
        if not entry.attr:
            continue
        target = defaults
        for part in entry.attr.split("."):
            assert hasattr(target, part), f"{entry.key} points at a missing {entry.attr}"
            target = getattr(target, part)


def test_api_keys_are_recognised_as_secret():
    assert FIELDS_BY_KEY["ANTHROPIC_API_KEY"].secret is True
    assert FIELDS_BY_KEY["THURSDAY_MODEL"].secret is False


def test_choice_fields_offer_real_choices():
    for entry in FIELDS:
        if entry.kind == "choice":
            assert entry.choices, f"{entry.key} is a choice with no options"


# ----------------------------------------------------------------- defaults


def test_the_form_shows_the_real_default_not_the_first_option():
    """Otherwise opening settings and saving would silently change things."""
    fields = {entry["key"]: entry for entry in describe()["fields"]}

    assert fields["THURSDAY_EFFORT"]["value"] == "medium"   # not "low"
    assert fields["THURSDAY_THINKING"]["value"] == "1"      # not off
    assert fields["THURSDAY_ALLOW_SHELL"]["value"] == "1"
    assert fields["THURSDAY_ROUTING"]["value"] == "keyword"
    assert fields["THURSDAY_TTS_RATE"]["value"] == "175"


def test_defaults_track_the_settings_dataclass():
    assert default_for(FIELDS_BY_KEY["THURSDAY_EFFORT"]) == Settings().effort
    assert default_for(FIELDS_BY_KEY["THURSDAY_STT_BACKEND"]) == Settings().voice.stt_backend


def test_a_field_reports_where_its_value_came_from(monkeypatch):
    monkeypatch.setenv("THURSDAY_MODEL", "from-the-shell")
    fields = {entry["key"]: entry for entry in describe()["fields"]}
    assert fields["THURSDAY_MODEL"]["source"] == "env"
    assert fields["THURSDAY_EFFORT"]["source"] == "default"

    update({"THURSDAY_EFFORT": "high"})
    fields = {entry["key"]: entry for entry in describe()["fields"]}
    assert fields["THURSDAY_EFFORT"]["source"] == "settings"


# ------------------------------------------------------------------ secrets


def test_a_key_is_never_sent_back_to_the_page():
    update({"ANTHROPIC_API_KEY": "sk-ant-verysecret"})
    fields = {entry["key"]: entry for entry in describe()["fields"]}

    assert fields["ANTHROPIC_API_KEY"]["value"] == MASK
    assert fields["ANTHROPIC_API_KEY"]["set"] is True
    assert "verysecret" not in json.dumps(describe())


def test_saving_a_masked_secret_leaves_it_alone():
    """The page echoes the mask back for a key the user did not retype."""
    update({"ANTHROPIC_API_KEY": "sk-ant-original"})
    update({"ANTHROPIC_API_KEY": MASK})

    assert load_overlay()["ANTHROPIC_API_KEY"] == "sk-ant-original"


def test_a_key_can_be_cleared_with_an_empty_value():
    update({"ANTHROPIC_API_KEY": "sk-ant-original"})
    update({"ANTHROPIC_API_KEY": ""})

    import os

    assert "ANTHROPIC_API_KEY" not in load_overlay()
    assert "ANTHROPIC_API_KEY" not in os.environ


def test_the_file_is_not_world_readable(clean_env):
    path = save_overlay({"ANTHROPIC_API_KEY": "sk-ant-x"}, clean_env / "settings.json")
    assert oct(path.stat().st_mode & 0o077) == "0o0"


# --------------------------------------------------------------- validation


def test_bad_values_are_refused_with_a_reason():
    problems = validate({"THURSDAY_EFFORT": "turbo", "THURSDAY_MAX_TOKENS": "lots"})
    assert any("Effort" in problem for problem in problems)
    assert any("Max tokens" in problem for problem in problems)


def test_unknown_settings_are_refused():
    assert validate({"PATH": "/tmp"}) == ["unknown setting: PATH"]


def test_an_unknown_setting_is_never_written():
    update({"PATH": "/tmp/evil", "THURSDAY_MODEL": "fine"})
    saved = load_overlay()

    assert "PATH" not in saved
    assert saved["THURSDAY_MODEL"] == "fine"


def test_empty_values_are_allowed_through_validation():
    assert validate({"THURSDAY_MODEL": "", "THURSDAY_EFFORT": ""}) == []


# --------------------------------------------------------------- precedence


def test_a_setting_from_the_page_beats_the_environment(monkeypatch):
    """Otherwise a change in the UI would visibly do nothing."""
    monkeypatch.setenv("THURSDAY_PROVIDER", "anthropic")
    assert Settings.from_env().provider == "anthropic"

    update({"THURSDAY_PROVIDER": "ollama"})
    assert Settings.from_env().provider == "ollama"


def test_settings_survive_a_restart(clean_env):
    update({"THURSDAY_MODEL": "qwen2.5", "THURSDAY_EFFORT": "high"})

    # A fresh process reads the same file.
    assert (clean_env / "settings.json").is_file()
    reloaded = Settings.from_env()
    assert reloaded.model == "qwen2.5"
    assert reloaded.effort == "high"


def test_a_broken_settings_file_does_not_stop_startup(clean_env):
    (clean_env / "settings.json").write_text("{not json", encoding="utf-8")
    assert load_overlay() == {}
    assert Settings.from_env().provider == "anthropic"


def test_the_overlay_only_holds_what_was_set():
    update({"THURSDAY_MODEL": "qwen2.5"})
    assert set(load_overlay()) == {"THURSDAY_MODEL"}


# ---------------------------------------------------------------- over HTTP


@pytest.fixture()
def api(clean_env, monkeypatch):
    """The web app, with the settings file pointed at a temporary directory."""
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    from thursday import server as server_module

    settings = Settings(workspace=clean_env, data_dir=clean_env, plugin_dirs=())
    return fastapi_testclient.TestClient(server_module.create_app(settings))


def test_the_page_can_read_the_form(api):
    payload = api.get("/api/settings").json()

    assert payload["editable"] is True
    assert "Model" in payload["groups"]
    keys = {field["key"] for field in payload["fields"]}
    assert {"THURSDAY_PROVIDER", "ANTHROPIC_API_KEY", "THURSDAY_ROUTING"} <= keys


def test_saving_applies_immediately(api):
    response = api.post("/api/settings", json={"THURSDAY_PROVIDER": "ollama", "THURSDAY_MODEL": "qwen2.5"})
    assert response.status_code == 200
    assert response.json()["saved"] is True

    # The status endpoint reflects it without a restart.
    status = api.get("/api/status").json()
    assert status["provider"] == "ollama"
    assert status["model"] == "qwen2.5"


def test_a_bad_value_is_rejected_and_nothing_is_written(api):
    response = api.post("/api/settings", json={"THURSDAY_EFFORT": "turbo"})

    assert response.status_code == 400
    assert "Effort" in response.json()["error"]
    assert load_overlay() == {}


def test_the_api_never_returns_a_key(api):
    api.post("/api/settings", json={"ANTHROPIC_API_KEY": "sk-ant-topsecret"})
    body = api.get("/api/settings").text

    assert "topsecret" not in body
    assert MASK in body


def test_a_remote_client_cannot_change_settings(clean_env, monkeypatch):
    """The settings hold API keys, so only this machine may write them."""
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    from thursday import server as server_module

    monkeypatch.setattr(server_module, "is_local", lambda host: False)
    settings = Settings(workspace=clean_env, data_dir=clean_env, plugin_dirs=())
    client = fastapi_testclient.TestClient(server_module.create_app(settings))

    assert client.post("/api/settings", json={"THURSDAY_PROVIDER": "ollama"}).status_code == 403
    assert load_overlay() == {}

    # It may still look, but the page is told it cannot edit.
    payload = client.get("/api/settings").json()
    assert payload["editable"] is False
    assert payload["note"]


def test_the_local_check_accepts_loopback_and_refuses_the_rest(monkeypatch):
    from thursday.server import is_local

    monkeypatch.delenv("THURSDAY_ALLOW_REMOTE_CONFIG", raising=False)
    assert is_local("127.0.0.1") is True
    assert is_local("::1") is True
    assert is_local("192.168.1.50") is False
    assert is_local(None) is False

    monkeypatch.setenv("THURSDAY_ALLOW_REMOTE_CONFIG", "1")
    assert is_local("192.168.1.50") is True


def test_a_non_object_body_is_refused(api):
    assert api.post("/api/settings", json=["not", "an", "object"]).status_code == 400


def test_testing_a_backend_reports_why_it_is_unreachable(api):
    payload = api.post("/api/settings/test", json={"provider": "ollama"}).json()

    assert payload["provider"] == "ollama"
    assert payload["ok"] is False
    assert "ollama serve" in payload["detail"]      # the preset's own hint


# ------------------------------------------------------ the page agrees


def test_the_page_builds_its_form_from_the_schema():
    """A hardcoded field list in the page would drift from the server's."""
    from pathlib import Path

    page = (Path(__file__).parent.parent / "thursday" / "web" / "index.html").read_text(
        encoding="utf-8"
    )

    assert "/api/settings" in page
    assert "payload.fields" in page          # it renders whatever it is given
    # None of the individual settings should be named in the page.
    named = [entry.key for entry in FIELDS if entry.key in page]
    assert named == ["THURSDAY_PROVIDER"]    # only the one the test button reads


def test_the_page_only_sends_what_changed():
    from pathlib import Path

    page = (Path(__file__).parent.parent / "thursday" / "web" / "index.html").read_text(
        encoding="utf-8"
    )
    assert "if (value === before) continue" in page
