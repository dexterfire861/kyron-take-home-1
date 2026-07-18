from __future__ import annotations

from flask import Blueprint, g, jsonify

from auth import provider_required
from db import db
from models import Encounter, Patient

patients_bp = Blueprint("patients", __name__, url_prefix="/api")


@patients_bp.get("/patients")
@provider_required
def list_patients():
    user = g.current_user
    query = Patient.query
    if user.role != "admin":
        query = query.filter_by(provider_id=user.id)

    results = []
    for patient in query.all():
        encounters = patient.encounters.order_by(Encounter.updated_at.desc()).all()
        last = encounters[0] if encounters else None
        results.append(
            {
                **patient.to_dict(),
                "encounter_count": len(encounters),
                "last_encounter_at": last.updated_at.isoformat() if last else None,
                "last_status": last.status if last else None,
            }
        )

    results.sort(key=lambda p: p["last_encounter_at"] or "", reverse=True)
    return jsonify({"patients": results})


@patients_bp.get("/patients/<int:patient_id>")
@provider_required
def get_patient(patient_id: int):
    user = g.current_user
    patient = db.session.get(Patient, patient_id)
    if patient is None:
        return jsonify({"error": "Patient not found"}), 404
    if user.role != "admin" and patient.provider_id != user.id:
        return jsonify({"error": "Patient not found"}), 404

    encounters = []
    for enc in patient.encounters.order_by(Encounter.updated_at.desc()).all():
        data = enc.to_dict(include_note=False)
        data["has_note"] = enc.note is not None
        encounters.append(data)

    return jsonify({"patient": patient.to_dict(), "encounters": encounters})
