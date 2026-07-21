from __future__ import annotations

import json
from datetime import datetime, timezone

from flask import Blueprint, Response, g, jsonify, request, stream_with_context

from auth import provider_required
from db import db
from icd10_service import suggest_for_text
from models import Encounter, Note, NoteIcdSuggestion, NoteTemplate, NoteVersion, Patient, parse_dob
from realtime_service import create_realtime_client_secret, create_transcription_client_secret
from soap_service import fetch_prior_notes, stream_soap_note

encounters_bp = Blueprint("encounters", __name__, url_prefix="/api")

VALID_INPUT_TYPES = {"transcript", "observations"}
VALID_SAVE_SOURCES = {"manual", "voice_session", "revert"}
VALID_SUGGESTION_STATUSES = {"accepted", "rejected"}


def _get_owned_encounter(encounter_id: int) -> Encounter | None:
    encounter = db.session.get(Encounter, encounter_id)
    if encounter is None:
        return None
    user = g.current_user
    if user.role == "admin" or encounter.provider_id == user.id:
        return encounter
    return None


@encounters_bp.post("/encounters")
@provider_required
def create_encounter():
    payload = request.get_json(silent=True) or {}
    first_name = (payload.get("first_name") or "").strip()
    last_name = (payload.get("last_name") or "").strip()
    dob_raw = (payload.get("date_of_birth") or "").strip()
    template_id = payload.get("template_id")

    if not first_name or not last_name or not dob_raw:
        return jsonify(
            {"error": "first_name, last_name, and date_of_birth are required"}
        ), 400

    try:
        dob = parse_dob(dob_raw)
    except ValueError:
        return jsonify({"error": "date_of_birth must be YYYY-MM-DD"}), 400

    provider = g.current_user
    if provider.role == "admin":
        return jsonify({"error": "Admins cannot create provider encounters"}), 403

    patient = Patient.query.filter_by(
        provider_id=provider.id,
        first_name=first_name,
        last_name=last_name,
        date_of_birth=dob,
    ).first()

    if patient is None:
        patient = Patient(
            provider_id=provider.id,
            first_name=first_name,
            last_name=last_name,
            date_of_birth=dob,
        )
        db.session.add(patient)
        db.session.flush()

    resolved_template_id = None
    if template_id is not None:
        template = db.session.get(NoteTemplate, int(template_id))
        if template is None or not template.is_active:
            return jsonify({"error": "Invalid template_id"}), 400
        resolved_template_id = template.id
    else:
        default = NoteTemplate.query.filter_by(
            slug="new_patient_eval", is_active=True
        ).first()
        resolved_template_id = default.id if default else None

    prior_count = (
        Encounter.query.filter_by(patient_id=patient.id, status="saved").count()
    )

    encounter = Encounter(
        provider_id=provider.id,
        patient_id=patient.id,
        template_id=resolved_template_id,
        status="draft",
    )
    db.session.add(encounter)
    db.session.commit()
    data = encounter.to_dict()
    data["prior_note_count"] = prior_count
    data["returning_patient"] = prior_count > 0
    return jsonify({"encounter": data}), 201


@encounters_bp.get("/templates")
@provider_required
def list_active_templates():
    templates = (
        NoteTemplate.query.filter_by(is_active=True)
        .order_by(NoteTemplate.name.asc())
        .all()
    )
    return jsonify({"templates": [t.to_dict() for t in templates]})


@encounters_bp.get("/encounters/<int:encounter_id>")
@provider_required
def get_encounter(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404
    versions = []
    if encounter.note:
        versions = [
            v.to_dict()
            for v in encounter.note.versions.order_by(NoteVersion.version_number.desc())
        ]
    prior_count = (
        Encounter.query.filter(
            Encounter.patient_id == encounter.patient_id,
            Encounter.status == "saved",
            Encounter.id != encounter.id,
        ).count()
    )
    data = encounter.to_dict()
    data["versions"] = versions
    data["prior_note_count"] = prior_count
    data["returning_patient"] = prior_count > 0
    return jsonify({"encounter": data})


@encounters_bp.patch("/encounters/<int:encounter_id>/draft")
@provider_required
def save_encounter_draft(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404
    if g.current_user.role != "admin" and encounter.provider_id != g.current_user.id:
        return jsonify({"error": "Encounter not found"}), 404

    payload = request.get_json(silent=True) or {}
    if "input_text" in payload:
        encounter.input_text = payload.get("input_text") or ""
    if "input_type" in payload:
        input_type = (payload.get("input_type") or "").strip().lower()
        if input_type and input_type not in VALID_INPUT_TYPES:
            return jsonify(
                {"error": "input_type must be 'transcript' or 'observations'"}
            ), 400
        if input_type:
            encounter.input_type = input_type
    if "template_id" in payload:
        tid = payload.get("template_id")
        if tid is None:
            encounter.template_id = None
        else:
            template = db.session.get(NoteTemplate, int(tid))
            if template is None or not template.is_active:
                return jsonify({"error": "Invalid template_id"}), 400
            encounter.template_id = template.id

    soap_keys = ("subjective", "objective", "assessment", "plan")
    if any(k in payload for k in soap_keys):
        note = encounter.note
        if note is None:
            note = Note(encounter_id=encounter.id)
            db.session.add(note)
        for key in soap_keys:
            if key in payload:
                setattr(note, key, (payload.get(key) or "").strip())
        note.updated_at = datetime.now(timezone.utc)

    encounter.last_draft_at = datetime.now(timezone.utc)
    if encounter.status == "draft" and (encounter.input_text or "").strip():
        encounter.status = "active"
    db.session.commit()
    return jsonify({"encounter": encounter.to_dict()})


@encounters_bp.post("/encounters/<int:encounter_id>/generate")
@provider_required
def generate_encounter_note(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404

    payload = request.get_json(silent=True) or {}
    text = (payload.get("text") or encounter.input_text or "").strip()
    input_type = (
        payload.get("input_type") or encounter.input_type or "observations"
    ).strip().lower()

    if not text:
        return jsonify({"error": "text is required"}), 400
    if input_type not in VALID_INPUT_TYPES:
        return jsonify(
            {"error": "input_type must be 'transcript' or 'observations'"}
        ), 400

    if "template_id" in payload and payload.get("template_id") is not None:
        template = db.session.get(NoteTemplate, int(payload["template_id"]))
        if template is None or not template.is_active:
            return jsonify({"error": "Invalid template_id"}), 400
        encounter.template_id = template.id

    # Always reload template from DB at generate time (admin edits take effect immediately)
    template_addon = None
    if encounter.template_id:
        live_template = db.session.get(NoteTemplate, encounter.template_id)
        if live_template and live_template.is_active:
            template_addon = live_template.system_prompt_addon

    prior_history = fetch_prior_notes(
        patient_id=encounter.patient_id,
        exclude_encounter_id=encounter.id,
    )

    encounter.input_text = text
    encounter.input_type = input_type
    encounter.status = "active"
    encounter.last_draft_at = datetime.now(timezone.utc)
    db.session.commit()
    eid = encounter.id

    def event_stream():
        final_note = None
        try:
            for item in stream_soap_note(
                text=text,
                input_type=input_type,
                template_addon=template_addon,
                prior_history=prior_history,
            ):
                event = item["event"]
                data = item["data"]
                if event == "done":
                    final_note = data["note"]
                yield f"event: {event}\ndata: {json.dumps(data)}\n\n"

            if final_note is not None:
                enc = db.session.get(Encounter, eid)
                if enc is None:
                    return
                note = enc.note
                if note is None:
                    note = Note(encounter_id=enc.id)
                    db.session.add(note)
                note.subjective = final_note.get("subjective", "")
                note.objective = final_note.get("objective", "")
                note.assessment = final_note.get("assessment", "")
                note.plan = final_note.get("plan", "")
                note.updated_at = datetime.now(timezone.utc)
                db.session.commit()
        except Exception as exc:
            message = str(exc)
            if "api_key" in message.lower() or "OPENAI_API_KEY" in message:
                message = "OpenAI API key is missing or invalid"
            yield f"event: error\ndata: {json.dumps({'error': message})}\n\n"

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@encounters_bp.put("/encounters/<int:encounter_id>/note")
@provider_required
def save_encounter_note(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404

    payload = request.get_json(silent=True) or {}
    source = (payload.get("source") or "manual").strip().lower()
    if source not in VALID_SAVE_SOURCES:
        return jsonify({"error": "source must be 'manual' or 'voice_session'"}), 400

    soap = {
        "subjective": (payload.get("subjective") or "").strip(),
        "objective": (payload.get("objective") or "").strip(),
        "assessment": (payload.get("assessment") or "").strip(),
        "plan": (payload.get("plan") or "").strip(),
    }
    if not any(soap.values()):
        return jsonify({"error": "At least one SOAP section is required"}), 400

    note = encounter.note
    if note is None:
        note = Note(encounter_id=encounter.id)
        db.session.add(note)
        db.session.flush()

    note.subjective = soap["subjective"]
    note.objective = soap["objective"]
    note.assessment = soap["assessment"]
    note.plan = soap["plan"]
    note.updated_at = datetime.now(timezone.utc)

    latest = (
        NoteVersion.query.filter_by(note_id=note.id)
        .order_by(NoteVersion.version_number.desc())
        .first()
    )
    next_version = (latest.version_number + 1) if latest else 1
    version = NoteVersion(
        note_id=note.id,
        version_number=next_version,
        snapshot=dict(soap),
        source=source,
        created_by=g.current_user.id,
    )
    db.session.add(version)
    encounter.status = "saved"
    db.session.commit()

    return jsonify(
        {
            "note": note.to_dict(),
            "version": version.to_dict(),
        }
    )


@encounters_bp.get("/encounters/<int:encounter_id>/versions")
@provider_required
def list_note_versions(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404
    if encounter.note is None:
        return jsonify({"versions": []})
    versions = [
        v.to_dict()
        for v in encounter.note.versions.order_by(NoteVersion.version_number.desc())
    ]
    return jsonify({"versions": versions})


@encounters_bp.post("/encounters/<int:encounter_id>/versions/<int:version_id>/restore")
@provider_required
def restore_note_version(encounter_id: int, version_id: int):
    """Restore a prior version's snapshot into the live note and record a new version."""
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404
    if encounter.note is None:
        return jsonify({"error": "No note to restore"}), 404

    target = (
        NoteVersion.query.filter_by(id=version_id, note_id=encounter.note.id)
        .first()
    )
    if target is None:
        return jsonify({"error": "Version not found"}), 404

    snapshot = target.snapshot or {}
    soap = {
        "subjective": (snapshot.get("subjective") or "").strip(),
        "objective": (snapshot.get("objective") or "").strip(),
        "assessment": (snapshot.get("assessment") or "").strip(),
        "plan": (snapshot.get("plan") or "").strip(),
    }
    if not any(soap.values()):
        return jsonify({"error": "Selected version has no SOAP content"}), 400

    note = encounter.note
    note.subjective = soap["subjective"]
    note.objective = soap["objective"]
    note.assessment = soap["assessment"]
    note.plan = soap["plan"]
    note.updated_at = datetime.now(timezone.utc)

    latest = (
        NoteVersion.query.filter_by(note_id=note.id)
        .order_by(NoteVersion.version_number.desc())
        .first()
    )
    next_version = (latest.version_number + 1) if latest else 1
    version = NoteVersion(
        note_id=note.id,
        version_number=next_version,
        snapshot={
            **dict(soap),
            "restored_from_version": target.version_number,
        },
        source="revert",
        created_by=g.current_user.id,
    )
    db.session.add(version)
    encounter.status = "saved"
    db.session.commit()

    return jsonify(
        {
            "note": note.to_dict(),
            "version": version.to_dict(),
            "restored_from": target.to_dict(),
        }
    )


@encounters_bp.post("/encounters/<int:encounter_id>/realtime/session")
@provider_required
def create_realtime_session(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404

    note = encounter.note
    if note is None or not any(note.soap_dict().values()):
        return jsonify({"error": "Generate a SOAP note before starting voice editing"}), 400

    patient = encounter.patient
    patient_label = (
        f"{patient.first_name} {patient.last_name} (DOB {patient.date_of_birth.isoformat()})"
    )
    safety_id = f"provider-{g.current_user.id}-encounter-{encounter.id}"

    try:
        secret_payload = create_realtime_client_secret(
            note=note.soap_dict(),
            patient_label=patient_label,
            safety_identifier=safety_id,
        )
    except Exception as exc:
        message = str(exc)
        if "api_key" in message.lower() or "OPENAI_API_KEY" in message:
            message = "OpenAI API key is missing or invalid"
        return jsonify({"error": f"Failed to start voice session: {message}"}), 500

    # Normalize client secret shape for the frontend
    value = None
    if isinstance(secret_payload.get("value"), str):
        value = secret_payload["value"]
    elif isinstance(secret_payload.get("client_secret"), dict):
        value = secret_payload["client_secret"].get("value")

    if not value:
        return jsonify({"error": "Realtime client secret missing from OpenAI response"}), 500

    return jsonify(
        {
            "client_secret": value,
            "expires_at": secret_payload.get("expires_at")
            or (secret_payload.get("client_secret") or {}).get("expires_at"),
            "model": "gpt-realtime",
        }
    )


@encounters_bp.post("/encounters/<int:encounter_id>/realtime/transcription-session")
@provider_required
def create_transcription_session(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404

    safety_id = f"provider-{g.current_user.id}-encounter-{encounter.id}-dictation"

    try:
        secret_payload = create_transcription_client_secret(safety_identifier=safety_id)
    except Exception as exc:
        message = str(exc)
        if "api_key" in message.lower() or "OPENAI_API_KEY" in message:
            message = "OpenAI API key is missing or invalid"
        return jsonify({"error": f"Failed to start dictation session: {message}"}), 500

    value = None
    if isinstance(secret_payload.get("value"), str):
        value = secret_payload["value"]
    elif isinstance(secret_payload.get("client_secret"), dict):
        value = secret_payload["client_secret"].get("value")

    if not value:
        return jsonify({"error": "Realtime client secret missing from OpenAI response"}), 500

    return jsonify(
        {
            "client_secret": value,
            "expires_at": secret_payload.get("expires_at")
            or (secret_payload.get("client_secret") or {}).get("expires_at"),
        }
    )


@encounters_bp.post("/encounters/<int:encounter_id>/icd10/suggest")
@provider_required
def suggest_icd10_codes(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404

    note = encounter.note
    if note is None or not note.assessment.strip():
        return jsonify({"error": "Generate or write an Assessment before suggesting codes"}), 400

    matches = suggest_for_text(note.assessment)

    # Replace the previous round of open suggestions; keep any the provider
    # already accepted or rejected as a record of that decision.
    NoteIcdSuggestion.query.filter_by(note_id=note.id, status="suggested").delete()

    created = []
    for match in matches:
        suggestion = NoteIcdSuggestion(
            note_id=note.id,
            code=match["code"],
            description=match["description"],
            similarity=match["similarity"],
            status="suggested",
        )
        db.session.add(suggestion)
        created.append(suggestion)
    db.session.commit()

    return jsonify({"suggestions": [s.to_dict() for s in created]})


@encounters_bp.get("/encounters/<int:encounter_id>/icd10")
@provider_required
def list_icd10_suggestions(encounter_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404
    if encounter.note is None:
        return jsonify({"suggestions": []})
    suggestions = (
        NoteIcdSuggestion.query.filter_by(note_id=encounter.note.id)
        .order_by(NoteIcdSuggestion.similarity.desc())
        .all()
    )
    return jsonify({"suggestions": [s.to_dict() for s in suggestions]})


@encounters_bp.patch("/encounters/<int:encounter_id>/icd10/<int:suggestion_id>")
@provider_required
def update_icd10_suggestion(encounter_id: int, suggestion_id: int):
    encounter = _get_owned_encounter(encounter_id)
    if encounter is None:
        return jsonify({"error": "Encounter not found"}), 404

    payload = request.get_json(silent=True) or {}
    status = (payload.get("status") or "").strip().lower()
    if status not in VALID_SUGGESTION_STATUSES:
        return jsonify({"error": "status must be 'accepted' or 'rejected'"}), 400

    suggestion = db.session.get(NoteIcdSuggestion, suggestion_id)
    if suggestion is None or not encounter.note or suggestion.note_id != encounter.note.id:
        return jsonify({"error": "Suggestion not found"}), 404

    suggestion.status = status
    db.session.commit()
    return jsonify({"suggestion": suggestion.to_dict()})


@encounters_bp.get("/icd10/search")
@provider_required
def search_icd10_codes():
    query = (request.args.get("q") or "").strip()
    if not query:
        return jsonify({"results": []})
    if len(query) < 3:
        return jsonify({"error": "Query must be at least 3 characters"}), 400

    results = suggest_for_text(query, top_n=10)
    return jsonify({"results": results})
