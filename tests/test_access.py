"""Who may use Thursday: the token that gates it, and the face that names you."""

from __future__ import annotations

import json

import pytest

from thursday.auth import LOCKOUT_SECONDS, MAX_FAILURES, Gate, generate_token, is_loopback
from thursday.config import Settings
from thursday.identity import (
    Doorman,
    Enrolment,
    Match,
    cosine_distance,
    decode_data_url,
    distance,
)


# ------------------------------------------------------------------- token


def test_a_browser_on_this_machine_is_trusted_by_default():
    gate = Gate(token="secret", mode="remote")

    assert gate.needs_token("127.0.0.1") is False
    assert gate.allows("127.0.0.1", None) is True


def test_anything_else_has_to_present_the_token():
    gate = Gate(token="secret", mode="remote")

    assert gate.needs_token("192.168.1.20") is True
    assert gate.allows("192.168.1.20", None) is False

    session = gate.login("secret", "192.168.1.20")
    assert session and gate.allows("192.168.1.20", session) is True


def test_always_mode_asks_even_here():
    gate = Gate(token="secret", mode="always")
    assert gate.needs_token("127.0.0.1") is True


def test_off_mode_asks_nobody():
    gate = Gate(token="secret", mode="off")
    assert gate.allows("10.0.0.9", None) is True
    assert gate.enabled is False


def test_no_token_means_no_gate():
    """An empty token cannot be a password; it must not lock everyone out."""
    gate = Gate(token="", mode="always")
    assert gate.allows("10.0.0.9", None) is True
    assert gate.enabled is False


def test_a_wrong_token_is_refused():
    gate = Gate(token="secret", mode="remote")
    assert gate.login("guess", "10.0.0.9") is None


def test_guessing_gets_locked_out():
    gate = Gate(token="secret", mode="remote")
    for _ in range(MAX_FAILURES):
        gate.login("wrong", "10.0.0.9")

    assert gate.locked_out("10.0.0.9") is True
    # Even the right token is refused while locked out.
    assert gate.login("secret", "10.0.0.9") is None


def test_the_lockout_expires():
    gate = Gate(token="secret", mode="remote")
    for _ in range(MAX_FAILURES):
        gate.login("wrong", "10.0.0.9", now=1000.0)

    assert gate.locked_out("10.0.0.9", now=1000.0) is True
    assert gate.locked_out("10.0.0.9", now=1000.0 + LOCKOUT_SECONDS + 1) is False


def test_one_client_being_locked_out_does_not_lock_out_another():
    gate = Gate(token="secret", mode="remote")
    for _ in range(MAX_FAILURES):
        gate.login("wrong", "10.0.0.9")

    assert gate.login("secret", "10.0.0.10") is not None


def test_logging_out_invalidates_the_session():
    gate = Gate(token="secret", mode="remote")
    session = gate.login("secret", "10.0.0.9")

    gate.logout(session)
    assert gate.allows("10.0.0.9", session) is False


def test_generated_tokens_are_not_guessable():
    assert len({generate_token() for _ in range(50)}) == 50
    assert len(generate_token()) >= 24


def test_loopback_recognition():
    assert is_loopback("127.0.0.1") and is_loopback("::1")
    assert not is_loopback("192.168.0.5") and not is_loopback(None)


# ---------------------------------------------------------------- identity


def test_distance_measures_agree_with_intuition():
    assert distance([0, 0, 0], [0, 0, 0]) == 0
    assert distance([0, 0, 0], [3, 4, 0]) == pytest.approx(5.0)
    assert cosine_distance([1, 0], [1, 0]) == pytest.approx(0.0)
    assert cosine_distance([1, 0], [0, 1]) == pytest.approx(1.0)
    assert cosine_distance([0, 0], [1, 0]) == 1.0     # no direction, no match


def test_embeddings_of_different_lengths_are_refused():
    with pytest.raises(ValueError):
        distance([1, 2], [1, 2, 3])


@pytest.fixture()
def enrolled(tmp_path):
    book = Enrolment.load(tmp_path / "people.json")
    book.add("supakit", "face", [0.0, 0.0, 1.0])
    book.add("supakit", "voice", [1.0, 0.0, 0.0])
    return book


def test_a_known_face_is_recognised(enrolled):
    match = enrolled.identify([0.02, 0.0, 0.99], "face")

    assert match.recognised is True
    assert match.name == "supakit"
    assert match.confidence > 0.9


def test_a_stranger_is_not(enrolled):
    match = enrolled.identify([9.0, 9.0, 9.0], "face")

    assert match.recognised is False
    assert match.confidence == 0.0


def test_enrolment_survives_a_restart(tmp_path):
    book = Enrolment.load(tmp_path / "people.json")
    book.add("supakit", "face", [1.0, 2.0, 3.0])

    reopened = Enrolment.load(tmp_path / "people.json")
    assert reopened.summary() == [{"name": "supakit", "face": 1, "voice": 0}]


def test_the_enrolment_file_is_not_world_readable(tmp_path):
    book = Enrolment.load(tmp_path / "people.json")
    book.add("supakit", "face", [1.0])
    assert oct((tmp_path / "people.json").stat().st_mode & 0o077) == "0o0"


def test_raw_media_is_never_stored(tmp_path):
    """Only embeddings, so a stolen file is not a photo album."""
    book = Enrolment.load(tmp_path / "people.json")
    book.add("supakit", "face", [0.1, 0.2])

    stored = json.loads((tmp_path / "people.json").read_text())
    assert stored["people"]["supakit"]["face"] == [[0.1, 0.2]]
    assert "image" not in json.dumps(stored)


def test_forgetting_someone(enrolled):
    assert enrolled.forget("supakit", "voice") is True
    assert enrolled.summary() == [{"name": "supakit", "face": 1, "voice": 0}]

    assert enrolled.forget("supakit") is True
    assert enrolled.summary() == []
    assert enrolled.forget("nobody") is False


def test_an_embedding_from_another_model_is_skipped_not_fatal(enrolled):
    """Swapping recognition backends must not crash every later check."""
    enrolled.add("someone", "face", [1.0] * 128)

    match = enrolled.identify([0.0, 0.0, 1.0], "face")
    assert match.name == "supakit"


# ------------------------------------------------------------------ policy


def test_a_policy_with_nobody_enrolled_stays_open(tmp_path):
    """Otherwise turning it on would lock the owner out of their own machine."""
    empty = Enrolment.load(tmp_path / "people.json")
    doorman = Doorman(policy="face", enrolment=empty)

    assert doorman.enforced() is False
    assert doorman.admits([]) == (True, "")


def test_face_policy_admits_the_registered_person(enrolled):
    doorman = Doorman(policy="face", enrolment=enrolled)
    known = enrolled.identify([0.0, 0.0, 1.0], "face")

    assert doorman.enforced() is True
    assert doorman.admits([known]) == (True, "supakit")


def test_face_policy_turns_away_a_stranger(enrolled):
    doorman = Doorman(policy="face", enrolment=enrolled)
    stranger = enrolled.identify([9.0, 9.0, 9.0], "face")

    assert doorman.admits([stranger]) == (False, "")


def test_both_policy_needs_both_checks(enrolled):
    doorman = Doorman(policy="both", enrolment=enrolled)
    face = enrolled.identify([0.0, 0.0, 1.0], "face")
    voice = enrolled.identify([1.0, 0.0, 0.0], "voice")

    assert doorman.admits([face, voice])[0] is True
    assert doorman.admits([face])[0] is False


def test_either_policy_needs_only_one(enrolled):
    doorman = Doorman(policy="either", enrolment=enrolled)
    face = enrolled.identify([0.0, 0.0, 1.0], "face")

    assert doorman.admits([face])[0] is True


def test_off_policy_admits_anyone(enrolled):
    assert Doorman(policy="off", enrolment=enrolled).admits([]) == (True, "")


def test_data_urls_from_the_browser_are_accepted():
    assert decode_data_url("data:image/jpeg;base64,QUJD") == b"ABC"
    assert decode_data_url("QUJD") == b"ABC"


def test_a_match_with_no_name_is_not_recognised():
    assert Match(threshold=0.6).recognised is False


# ------------------------------------------------------------- over HTTP


@pytest.fixture()
def locked_client(tmp_path, monkeypatch):
    """A server that treats every caller as remote, so the token is required."""
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    from thursday import server as server_module

    monkeypatch.setenv("THURSDAY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("THURSDAY_ACCESS_TOKEN", "let-me-in")
    monkeypatch.setattr(server_module, "is_local", lambda host: False)

    settings = Settings(
        workspace=tmp_path, data_dir=tmp_path, plugin_dirs=(), auth="always"
    )
    return fastapi_testclient.TestClient(server_module.create_app(settings))


def test_the_page_is_told_it_needs_a_token(locked_client):
    payload = locked_client.get("/api/auth").json()

    assert payload["required"] is True
    assert payload["authenticated"] is False


def test_the_websocket_is_refused_without_a_token(locked_client):
    from starlette.websockets import WebSocketDisconnect

    with locked_client.websocket_connect("/ws") as socket:
        first = json.loads(socket.receive_text())
        assert first["type"] == "unauthorised"
        with pytest.raises(WebSocketDisconnect):
            socket.receive_text()


def test_the_right_token_opens_the_socket(locked_client):
    assert locked_client.post("/api/login", json={"token": "let-me-in"}).status_code == 200

    with locked_client.websocket_connect("/ws") as socket:
        assert json.loads(socket.receive_text())["type"] == "ready"


def test_the_wrong_token_is_refused(locked_client):
    response = locked_client.post("/api/login", json={"token": "nope"})

    assert response.status_code == 401
    assert "not right" in response.json()["error"]


def test_identity_endpoints_need_authorisation(locked_client):
    assert locked_client.get("/api/identity").status_code == 401
    assert locked_client.post("/api/identity/verify", json={"image": "QUJD"}).status_code == 401


def test_enrolment_is_refused_from_elsewhere(locked_client):
    """Registering a face from another machine would let anyone add themselves."""
    locked_client.post("/api/login", json={"token": "let-me-in"})
    response = locked_client.post("/api/identity/enrol", json={"name": "x", "image": "QUJD"})

    assert response.status_code == 403


def test_logging_out_closes_the_door_again(locked_client):
    locked_client.post("/api/login", json={"token": "let-me-in"})
    assert locked_client.get("/api/auth").json()["authenticated"] is True

    locked_client.post("/api/logout")
    assert locked_client.get("/api/auth").json()["authenticated"] is False
