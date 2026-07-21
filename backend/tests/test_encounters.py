"""Encounter CRUD, streaming generation, and note-save/versioning edge cases.

The LLM boundary (`soap_service.stream_soap_note`) is always mocked here —
these tests never call OpenAI.
"""

from __future__ import annotations

import json

from models import Note, NoteVersion


def fake_stream(events):
    """Build a fake `stream_soap_note` replacement that yields fixed events."""

    def _fake(text, input_type="observations", **_kwargs):
        for event, data in events:
            yield {"event": event, "data": data}

    return _fake


def parse_sse(raw: bytes):
    """Parse raw SSE bytes into a list of (event, data) tuples."""
    text = raw.decode("utf-8")
    events = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        event = "message"
        data = None
        for line in block.splitlines():
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data = json.loads(line[len("data:") :].strip())
        events.append((event, data))
    return events


# ---------------------------------------------------------------------------
# Encounter CRUD + tenancy
# ---------------------------------------------------------------------------


def test_get_encounter_not_found(client, auth_headers, provider):
    response = client.get("/api/encounters/999999", headers=auth_headers(provider))
    assert response.status_code == 404


def test_provider_cannot_read_other_providers_encounter(
    client, auth_headers, other_provider, provider, make_patient, make_encounter
):
    their_patient = make_patient(other_provider)
    their_encounter = make_encounter(other_provider, their_patient)

    response = client.get(
        f"/api/encounters/{their_encounter.id}", headers=auth_headers(provider)
    )
    assert response.status_code == 404


def test_admin_can_read_any_encounter(
    client, auth_headers, other_provider, admin_user, make_patient, make_encounter
):
    their_patient = make_patient(other_provider)
    their_encounter = make_encounter(other_provider, their_patient)

    response = client.get(
        f"/api/encounters/{their_encounter.id}", headers=auth_headers(admin_user)
    )
    assert response.status_code == 200


def test_get_encounter_includes_versions_ordered_desc(
    client, auth_headers, provider, make_patient, make_encounter, make_note
):
    from db import db

    patient = make_patient(provider)
    encounter = make_encounter(provider, patient)
    note = make_note(encounter)
    db.session.add_all(
        [
            NoteVersion(
                note_id=note.id,
                version_number=1,
                snapshot={"subjective": "v1"},
                source="manual",
                created_by=provider.id,
            ),
            NoteVersion(
                note_id=note.id,
                version_number=2,
                snapshot={"subjective": "v2"},
                source="manual",
                created_by=provider.id,
            ),
        ]
    )
    db.session.commit()

    response = client.get(
        f"/api/encounters/{encounter.id}", headers=auth_headers(provider)
    )
    versions = response.get_json()["encounter"]["versions"]
    assert [v["version_number"] for v in versions] == [2, 1]


# ---------------------------------------------------------------------------
# Streaming generate endpoint
# ---------------------------------------------------------------------------


def test_generate_rejects_empty_transcript(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    response = client.post(
        f"/api/encounters/{encounter.id}/generate",
        headers=auth_headers(provider),
        json={"text": "   ", "input_type": "transcript"},
    )
    assert response.status_code == 400


def test_generate_rejects_invalid_input_type(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    response = client.post(
        f"/api/encounters/{encounter.id}/generate",
        headers=auth_headers(provider),
        json={"text": "cough for 3 days", "input_type": "essay"},
    )
    assert response.status_code == 400


def test_generate_scoped_to_owner(
    client, auth_headers, other_provider, provider, make_patient, make_encounter
):
    their_encounter = make_encounter(other_provider, make_patient(other_provider))
    response = client.post(
        f"/api/encounters/{their_encounter.id}/generate",
        headers=auth_headers(provider),
        json={"text": "cough for 3 days"},
    )
    assert response.status_code == 404


def test_generate_emits_expected_sse_event_shapes_and_persists_note(
    client, auth_headers, provider, make_patient, make_encounter, monkeypatch
):
    encounter = make_encounter(provider, make_patient(provider))
    events = [
        ("section_start", {"section": "subjective"}),
        ("section_delta", {"section": "subjective", "delta": "Cough x3 days."}),
        ("section_end", {"section": "subjective", "text": "Cough x3 days."}),
        (
            "done",
            {
                "note": {
                    "subjective": "Cough x3 days.",
                    "objective": "",
                    "assessment": "",
                    "plan": "",
                }
            },
        ),
    ]
    monkeypatch.setattr(
        "routes.encounter_routes.stream_soap_note", fake_stream(events)
    )

    response = client.post(
        f"/api/encounters/{encounter.id}/generate",
        headers=auth_headers(provider),
        json={"text": "cough for 3 days", "input_type": "transcript"},
    )
    assert response.status_code == 200
    assert response.mimetype == "text/event-stream"

    parsed = parse_sse(response.data)
    assert [e for e, _ in parsed] == [
        "section_start",
        "section_delta",
        "section_end",
        "done",
    ]
    assert parsed[-1][1]["note"]["subjective"] == "Cough x3 days."

    persisted = Note.query.filter_by(encounter_id=encounter.id).first()
    assert persisted is not None
    assert persisted.subjective == "Cough x3 days."
    assert persisted.objective == ""


def test_generate_upserts_existing_note_draft_on_second_call(
    client, auth_headers, provider, make_patient, make_encounter, make_note, monkeypatch
):
    encounter = make_encounter(provider, make_patient(provider))
    make_note(encounter, subjective="old draft")

    events = [
        (
            "done",
            {
                "note": {
                    "subjective": "new draft",
                    "objective": "",
                    "assessment": "",
                    "plan": "",
                }
            },
        ),
    ]
    monkeypatch.setattr(
        "routes.encounter_routes.stream_soap_note", fake_stream(events)
    )

    response = client.post(
        f"/api/encounters/{encounter.id}/generate",
        headers=auth_headers(provider),
        json={"text": "follow-up visit"},
    )
    response.get_data()  # force the streamed generator to fully run

    notes = Note.query.filter_by(encounter_id=encounter.id).all()
    assert len(notes) == 1
    assert notes[0].subjective == "new draft"


def test_generate_with_no_markers_persists_empty_note_without_crashing(
    client, auth_headers, provider, make_patient, make_encounter, monkeypatch
):
    """Simulates a malformed LLM response with no SOAP headings at all."""
    encounter = make_encounter(provider, make_patient(provider))
    events = [
        (
            "done",
            {"note": {"subjective": "", "objective": "", "assessment": "", "plan": ""}},
        ),
    ]
    monkeypatch.setattr(
        "routes.encounter_routes.stream_soap_note", fake_stream(events)
    )

    response = client.post(
        f"/api/encounters/{encounter.id}/generate",
        headers=auth_headers(provider),
        json={"text": "some ramble with no structure"},
    )
    response.get_data()  # force the streamed generator to fully run
    assert response.status_code == 200
    note = Note.query.filter_by(encounter_id=encounter.id).first()
    assert note is not None
    assert note.soap_dict() == {
        "subjective": "",
        "objective": "",
        "assessment": "",
        "plan": "",
    }


def test_generate_stream_error_event_when_llm_raises(
    client, auth_headers, provider, make_patient, make_encounter, monkeypatch
):
    def _raise(text, input_type="observations", **_kwargs):
        raise RuntimeError("OPENAI_API_KEY missing")
        yield  # pragma: no cover - makes this a generator function

    monkeypatch.setattr("routes.encounter_routes.stream_soap_note", _raise)
    encounter = make_encounter(provider, make_patient(provider))

    response = client.post(
        f"/api/encounters/{encounter.id}/generate",
        headers=auth_headers(provider),
        json={"text": "cough"},
    )
    parsed = parse_sse(response.data)
    assert parsed[0][0] == "error"
    assert "OpenAI API key" in parsed[0][1]["error"]


# ---------------------------------------------------------------------------
# Save note + versioning
# ---------------------------------------------------------------------------


def test_save_note_requires_at_least_one_section(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    response = client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={"subjective": "", "objective": "", "assessment": "", "plan": ""},
    )
    assert response.status_code == 400


def test_save_note_rejects_invalid_source(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    response = client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={"subjective": "note", "source": "typed"},
    )
    assert response.status_code == 400


def test_save_note_creates_note_and_first_version(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    response = client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={
            "subjective": "Cough.",
            "objective": "Afebrile.",
            "assessment": "URI.",
            "plan": "Rest.",
            "source": "manual",
        },
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["version"]["version_number"] == 1
    assert body["version"]["source"] == "manual"
    assert body["note"]["subjective"] == "Cough."

    from db import db

    db.session.refresh(encounter)
    assert encounter.status == "saved"


def test_second_save_increments_version_number(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    first = client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={"subjective": "v1", "source": "manual"},
    ).get_json()
    second = client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={"subjective": "v2", "source": "voice_session"},
    ).get_json()

    assert first["version"]["version_number"] == 1
    assert second["version"]["version_number"] == 2
    assert second["version"]["source"] == "voice_session"
    assert second["note"]["subjective"] == "v2"


def test_save_note_scoped_to_owner(
    client, auth_headers, other_provider, provider, make_patient, make_encounter
):
    their_encounter = make_encounter(other_provider, make_patient(other_provider))
    response = client.put(
        f"/api/encounters/{their_encounter.id}/note",
        headers=auth_headers(provider),
        json={"subjective": "hijacked"},
    )
    assert response.status_code == 404


def test_list_note_versions_empty_before_any_save(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    response = client.get(
        f"/api/encounters/{encounter.id}/versions", headers=auth_headers(provider)
    )
    assert response.status_code == 200
    assert response.get_json()["versions"] == []


def test_list_note_versions_after_multiple_saves(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={"subjective": "v1"},
    )
    client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={"subjective": "v2"},
    )
    response = client.get(
        f"/api/encounters/{encounter.id}/versions", headers=auth_headers(provider)
    )
    versions = response.get_json()["versions"]
    assert [v["version_number"] for v in versions] == [2, 1]


def test_restore_note_version_creates_new_version_from_snapshot(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    v1 = client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={
            "subjective": "Original knee pain",
            "objective": "Mild swelling",
            "assessment": "Sprain",
            "plan": "RICE",
        },
    ).get_json()
    client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={
            "subjective": "Changed later",
            "objective": "Worse swelling",
            "assessment": "Possible tear",
            "plan": "MRI",
        },
    )
    version_id = v1["version"]["id"]

    restore = client.post(
        f"/api/encounters/{encounter.id}/versions/{version_id}/restore",
        headers=auth_headers(provider),
    )
    assert restore.status_code == 200
    body = restore.get_json()
    assert body["note"]["subjective"] == "Original knee pain"
    assert body["note"]["plan"] == "RICE"
    assert body["version"]["version_number"] == 3
    assert body["version"]["source"] == "revert"
    assert body["version"]["snapshot"]["restored_from_version"] == 1
    assert body["restored_from"]["version_number"] == 1

    listed = client.get(
        f"/api/encounters/{encounter.id}/versions", headers=auth_headers(provider)
    )
    assert [v["version_number"] for v in listed.get_json()["versions"]] == [3, 2, 1]


def test_restore_unknown_version_returns_404(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    client.put(
        f"/api/encounters/{encounter.id}/note",
        headers=auth_headers(provider),
        json={"subjective": "Only version"},
    )
    response = client.post(
        f"/api/encounters/{encounter.id}/versions/999999/restore",
        headers=auth_headers(provider),
    )
    assert response.status_code == 404
