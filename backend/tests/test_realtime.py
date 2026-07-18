"""Realtime voice-session edge cases.

The route-level tests never hit the network: `create_realtime_client_secret`
/ `create_transcription_client_secret` are monkeypatched at the boundary the
route imports. The service-level tests confirm that, when `OPENAI_API_KEY`
is missing, we fail fast with a clear error *before* any HTTP call is made
(verified by asserting `requests.post` is never invoked).
"""

from __future__ import annotations

import pytest

import realtime_service


def test_realtime_session_requires_note_to_exist(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    response = client.post(
        f"/api/encounters/{encounter.id}/realtime/session",
        headers=auth_headers(provider),
    )
    assert response.status_code == 400
    assert "SOAP note" in response.get_json()["error"]


def test_realtime_session_requires_nonempty_note_content(
    client, auth_headers, provider, make_patient, make_encounter, make_note
):
    encounter = make_encounter(provider, make_patient(provider))
    make_note(encounter)  # all sections blank

    response = client.post(
        f"/api/encounters/{encounter.id}/realtime/session",
        headers=auth_headers(provider),
    )
    assert response.status_code == 400


def test_realtime_session_scoped_to_owner(
    client, auth_headers, provider, other_provider, make_patient, make_encounter, make_note
):
    their_encounter = make_encounter(other_provider, make_patient(other_provider))
    make_note(their_encounter, subjective="content")

    response = client.post(
        f"/api/encounters/{their_encounter.id}/realtime/session",
        headers=auth_headers(provider),
    )
    assert response.status_code == 404


def test_realtime_session_success_returns_normalized_client_secret(
    client, auth_headers, provider, make_patient, make_encounter, make_note, monkeypatch
):
    encounter = make_encounter(provider, make_patient(provider))
    make_note(encounter, subjective="Cough for 3 days.")

    monkeypatch.setattr(
        "routes.encounter_routes.create_realtime_client_secret",
        lambda note, patient_label, safety_identifier: {
            "value": "ek_abc123",
            "expires_at": 1234567890,
        },
    )

    response = client.post(
        f"/api/encounters/{encounter.id}/realtime/session",
        headers=auth_headers(provider),
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["client_secret"] == "ek_abc123"
    assert body["model"] == "gpt-realtime"


def test_realtime_session_reports_missing_key_without_calling_openai(
    client, auth_headers, provider, make_patient, make_encounter, make_note, monkeypatch
):
    encounter = make_encounter(provider, make_patient(provider))
    make_note(encounter, subjective="Cough for 3 days.")

    def _raise(note, patient_label, safety_identifier):
        raise RuntimeError("OPENAI_API_KEY is not set")

    monkeypatch.setattr(
        "routes.encounter_routes.create_realtime_client_secret", _raise
    )

    response = client.post(
        f"/api/encounters/{encounter.id}/realtime/session",
        headers=auth_headers(provider),
    )
    assert response.status_code == 500
    assert "OpenAI API key is missing or invalid" in response.get_json()["error"]


def test_transcription_session_scoped_to_owner(
    client, auth_headers, provider, other_provider, make_patient, make_encounter
):
    their_encounter = make_encounter(other_provider, make_patient(other_provider))
    response = client.post(
        f"/api/encounters/{their_encounter.id}/realtime/transcription-session",
        headers=auth_headers(provider),
    )
    assert response.status_code == 404


def test_transcription_session_missing_secret_value_is_a_server_error(
    client, auth_headers, provider, make_patient, make_encounter, monkeypatch
):
    encounter = make_encounter(provider, make_patient(provider))
    monkeypatch.setattr(
        "routes.encounter_routes.create_transcription_client_secret",
        lambda safety_identifier: {},
    )

    response = client.post(
        f"/api/encounters/{encounter.id}/realtime/transcription-session",
        headers=auth_headers(provider),
    )
    assert response.status_code == 500


# ---------------------------------------------------------------------------
# Service-level: no network call is made when OPENAI_API_KEY is missing
# ---------------------------------------------------------------------------


def test_create_realtime_client_secret_fails_fast_without_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    def _fail_if_called(*args, **kwargs):
        raise AssertionError("requests.post should not be called without an API key")

    monkeypatch.setattr(realtime_service.requests, "post", _fail_if_called)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        realtime_service.create_realtime_client_secret(
            note={"subjective": "x", "objective": "", "assessment": "", "plan": ""},
            patient_label="Jane Doe (DOB 1990-01-01)",
            safety_identifier="provider-1-encounter-1",
        )


def test_create_transcription_client_secret_fails_fast_without_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    def _fail_if_called(*args, **kwargs):
        raise AssertionError("requests.post should not be called without an API key")

    monkeypatch.setattr(realtime_service.requests, "post", _fail_if_called)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        realtime_service.create_transcription_client_secret(
            safety_identifier="provider-1-encounter-1-dictation"
        )


def test_create_realtime_client_secret_raises_on_non_ok_response(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fake")

    class _FakeResponse:
        ok = False
        text = "insufficient_quota"

    monkeypatch.setattr(
        realtime_service.requests, "post", lambda *a, **k: _FakeResponse()
    )

    with pytest.raises(RuntimeError, match="Failed to create Realtime client secret"):
        realtime_service.create_realtime_client_secret(
            note={"subjective": "x", "objective": "", "assessment": "", "plan": ""},
            patient_label="Jane Doe (DOB 1990-01-01)",
            safety_identifier="provider-1-encounter-1",
        )
