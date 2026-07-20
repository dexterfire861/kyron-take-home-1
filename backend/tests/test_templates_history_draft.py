"""Draft persistence, template-at-generate, prior history, nonclinical gate."""

from __future__ import annotations

from db import db
from models import NoteTemplate
import soap_service
from tests.test_encounters import parse_sse


def _make_template(**overrides) -> NoteTemplate:
    defaults = dict(
        name="Ortho Follow-up",
        slug="ortho_fu_test",
        description="Test template",
        system_prompt_addon="TEMPLATE_ADDON_UNIQUE_TOKEN",
        is_active=True,
    )
    defaults.update(overrides)
    template = NoteTemplate(**defaults)
    db.session.add(template)
    db.session.commit()
    return template


def test_draft_patch_round_trip(client, auth_headers, provider, make_patient, make_encounter):
    patient = make_patient(provider)
    encounter = make_encounter(provider, patient)
    template = _make_template()

    response = client.patch(
        f"/api/encounters/{encounter.id}/draft",
        headers=auth_headers(provider),
        json={
            "input_text": "Patient reports knee pain for 2 weeks.",
            "input_type": "transcript",
            "template_id": template.id,
            "subjective": "Knee pain 2 weeks",
            "objective": "",
            "assessment": "Possible sprain",
            "plan": "RICE",
        },
    )
    assert response.status_code == 200
    body = response.get_json()["encounter"]
    assert body["input_text"].startswith("Patient reports")
    assert body["template_id"] == template.id
    assert body["status"] == "active"
    assert body["note"]["subjective"] == "Knee pain 2 weeks"
    assert body["note"]["plan"] == "RICE"

    loaded = client.get(
        f"/api/encounters/{encounter.id}", headers=auth_headers(provider)
    )
    assert loaded.status_code == 200
    enc = loaded.get_json()["encounter"]
    assert enc["input_text"].startswith("Patient reports")
    assert enc["note"]["assessment"] == "Possible sprain"


def test_generate_uses_live_template_addon(
    client, auth_headers, provider, make_patient, make_encounter, monkeypatch
):
    patient = make_patient(provider)
    encounter = make_encounter(provider, patient)
    template = _make_template(system_prompt_addon="LIVE_TEMPLATE_ADDON_XYZ")
    encounter.template_id = template.id
    db.session.commit()

    captured = {}

    def fake_stream(text, input_type="observations", template_addon=None, prior_history=None):
        captured["template_addon"] = template_addon
        captured["prior_history"] = prior_history
        yield {"event": "context", "data": {"prior_note_count": 0, "returning_patient": False}}
        yield {
            "event": "done",
            "data": {
                "note": {
                    "subjective": "s",
                    "objective": "o",
                    "assessment": "a",
                    "plan": "p",
                }
            },
        }

    monkeypatch.setattr("routes.encounter_routes.stream_soap_note", fake_stream)

    # Admin-style live edit of the template before generate
    template.system_prompt_addon = "UPDATED_LIVE_ADDON_ABC"
    db.session.commit()

    response = client.post(
        f"/api/encounters/{encounter.id}/generate",
        headers=auth_headers(provider),
        json={
            "text": "Patient with right knee pain for two weeks after twisting injury.",
            "input_type": "transcript",
        },
    )
    assert response.status_code == 200
    # Drain SSE
    parse_sse(response.data)
    assert captured["template_addon"] == "UPDATED_LIVE_ADDON_ABC"


def test_fetch_prior_notes_only_saved_same_patient(
    provider, make_patient, make_encounter, make_note
):
    patient = make_patient(provider)
    other = make_patient(provider, first_name="Other")

    saved = make_encounter(provider, patient, status="saved")
    make_note(saved, assessment="Prior OA of knee", plan="PT")

    draft = make_encounter(provider, patient, status="draft")
    make_note(draft, assessment="Should not appear")

    other_saved = make_encounter(provider, other, status="saved")
    make_note(other_saved, assessment="Wrong patient")

    current = make_encounter(provider, patient, status="active")

    history = soap_service.fetch_prior_notes(patient.id, exclude_encounter_id=current.id)
    assert len(history) == 1
    assert history[0]["encounter_id"] == saved.id
    assert "OA" in history[0]["note"]["assessment"]


def test_get_encounter_returns_prior_badge_fields(
    client, auth_headers, provider, make_patient, make_encounter, make_note
):
    patient = make_patient(provider)
    prior = make_encounter(provider, patient, status="saved")
    make_note(prior, assessment="Old sprain")
    current = make_encounter(provider, patient, status="active")

    response = client.get(
        f"/api/encounters/{current.id}", headers=auth_headers(provider)
    )
    assert response.status_code == 200
    enc = response.get_json()["encounter"]
    assert enc["prior_note_count"] == 1
    assert enc["returning_patient"] is True


def test_nonclinical_gate_returns_refusal_shape():
    assert soap_service.looks_nonclinical("asdf") is True
    assert soap_service.looks_nonclinical("asdf asdf asdf asdf asdf") is True
    assert soap_service.looks_nonclinical("x") is True
    clinical = (
        "Patient reports progressive right knee pain for two weeks "
        "after twisting injury while playing soccer. Swelling noted."
    )
    assert soap_service.looks_nonclinical(clinical) is False

    events = list(soap_service.stream_soap_note("asdf asdf"))
    done = [e for e in events if e["event"] == "done"]
    assert len(done) == 1
    assert done[0]["data"].get("refused") is True
    note = done[0]["data"]["note"]
    assert "insufficient" in note["assessment"].lower() or "clinical" in note["assessment"].lower()
    assert note["plan"] == soap_service.REFUSAL_NOTE["plan"]


def test_generate_injects_prior_history(
    client, auth_headers, provider, make_patient, make_encounter, make_note, monkeypatch
):
    patient = make_patient(provider)
    prior = make_encounter(provider, patient, status="saved")
    make_note(prior, assessment="ACL reconstruction 2022", plan="Continue PT")
    current = make_encounter(provider, patient, status="active")

    captured = {}

    def fake_stream(text, input_type="observations", template_addon=None, prior_history=None):
        captured["prior_history"] = prior_history
        yield {
            "event": "context",
            "data": {
                "prior_note_count": len(prior_history or []),
                "returning_patient": bool(prior_history),
            },
        }
        yield {
            "event": "done",
            "data": {
                "note": {
                    "subjective": "s",
                    "objective": "o",
                    "assessment": "a",
                    "plan": "p",
                }
            },
        }

    monkeypatch.setattr("routes.encounter_routes.stream_soap_note", fake_stream)

    response = client.post(
        f"/api/encounters/{current.id}/generate",
        headers=auth_headers(provider),
        json={
            "text": "Follow-up visit for right knee pain. Swelling improved with ice.",
            "input_type": "transcript",
        },
    )
    assert response.status_code == 200
    events = parse_sse(response.data)
    context = [e for e in events if e[0] == "context"]
    assert context
    assert context[0][1]["returning_patient"] is True
    assert len(captured["prior_history"]) == 1
    assert "ACL" in captured["prior_history"][0]["note"]["assessment"]
