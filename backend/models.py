from __future__ import annotations

from datetime import date, datetime, timezone

from werkzeug.security import check_password_hash, generate_password_hash

from db import db


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    full_name = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(32), nullable=False, default="provider")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    patients = db.relationship("Patient", back_populates="provider", lazy="dynamic")
    encounters = db.relationship("Encounter", back_populates="provider", lazy="dynamic")

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "email": self.email,
            "full_name": self.full_name,
            "role": self.role,
        }


class Patient(db.Model):
    __tablename__ = "patients"
    __table_args__ = (
        db.UniqueConstraint(
            "provider_id",
            "first_name",
            "last_name",
            "date_of_birth",
            name="uq_patient_provider_identity",
        ),
    )

    id = db.Column(db.Integer, primary_key=True)
    provider_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    first_name = db.Column(db.String(120), nullable=False)
    last_name = db.Column(db.String(120), nullable=False)
    date_of_birth = db.Column(db.Date, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    provider = db.relationship("User", back_populates="patients")
    encounters = db.relationship("Encounter", back_populates="patient", lazy="dynamic")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "provider_id": self.provider_id,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "date_of_birth": self.date_of_birth.isoformat(),
        }


class Encounter(db.Model):
    __tablename__ = "encounters"

    id = db.Column(db.Integer, primary_key=True)
    provider_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    patient_id = db.Column(db.Integer, db.ForeignKey("patients.id"), nullable=False)
    input_text = db.Column(db.Text, nullable=False, default="")
    input_type = db.Column(db.String(32), nullable=False, default="transcript")
    status = db.Column(db.String(32), nullable=False, default="draft")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = db.Column(
        db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    provider = db.relationship("User", back_populates="encounters")
    patient = db.relationship("Patient", back_populates="encounters")
    note = db.relationship(
        "Note", back_populates="encounter", uselist=False, cascade="all, delete-orphan"
    )

    def to_dict(self, include_note: bool = True) -> dict:
        data = {
            "id": self.id,
            "provider_id": self.provider_id,
            "patient_id": self.patient_id,
            "patient": self.patient.to_dict() if self.patient else None,
            "input_text": self.input_text,
            "input_type": self.input_type,
            "status": self.status,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if include_note:
            data["note"] = self.note.to_dict() if self.note else None
        return data


class Note(db.Model):
    __tablename__ = "notes"

    id = db.Column(db.Integer, primary_key=True)
    encounter_id = db.Column(
        db.Integer, db.ForeignKey("encounters.id"), unique=True, nullable=False
    )
    subjective = db.Column(db.Text, nullable=False, default="")
    objective = db.Column(db.Text, nullable=False, default="")
    assessment = db.Column(db.Text, nullable=False, default="")
    plan = db.Column(db.Text, nullable=False, default="")
    updated_at = db.Column(
        db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    encounter = db.relationship("Encounter", back_populates="note")
    versions = db.relationship(
        "NoteVersion",
        back_populates="note",
        lazy="dynamic",
        cascade="all, delete-orphan",
        order_by="NoteVersion.version_number.desc()",
    )

    def soap_dict(self) -> dict:
        return {
            "subjective": self.subjective,
            "objective": self.objective,
            "assessment": self.assessment,
            "plan": self.plan,
        }

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "encounter_id": self.encounter_id,
            **self.soap_dict(),
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class NoteVersion(db.Model):
    __tablename__ = "note_versions"

    id = db.Column(db.Integer, primary_key=True)
    note_id = db.Column(db.Integer, db.ForeignKey("notes.id"), nullable=False)
    version_number = db.Column(db.Integer, nullable=False)
    snapshot = db.Column(db.JSON, nullable=False)
    source = db.Column(db.String(32), nullable=False, default="manual")
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    note = db.relationship("Note", back_populates="versions")
    creator = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "note_id": self.note_id,
            "version_number": self.version_number,
            "snapshot": self.snapshot,
            "source": self.source,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class IcdCode(db.Model):
    __tablename__ = "icd10_codes"

    code = db.Column(db.String(8), primary_key=True)
    description = db.Column(db.Text, nullable=False)

    def to_dict(self) -> dict:
        return {"code": self.code, "description": self.description}


class NoteIcdSuggestion(db.Model):
    __tablename__ = "note_icd_suggestions"

    id = db.Column(db.Integer, primary_key=True)
    note_id = db.Column(db.Integer, db.ForeignKey("notes.id"), nullable=False, index=True)
    code = db.Column(db.String(8), db.ForeignKey("icd10_codes.code"), nullable=False)
    description = db.Column(db.Text, nullable=False)
    similarity = db.Column(db.Float, nullable=False)
    status = db.Column(db.String(16), nullable=False, default="suggested")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    note = db.relationship("Note")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "note_id": self.note_id,
            "code": self.code,
            "description": self.description,
            "similarity": self.similarity,
            "status": self.status,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


def parse_dob(value: str) -> date:
    return date.fromisoformat(value)
