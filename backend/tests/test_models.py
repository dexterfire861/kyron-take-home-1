"""Model-level unit tests: DOB parsing and identity constraints."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy.exc import IntegrityError

from db import db
from models import Patient, parse_dob


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("1990-01-01", date(1990, 1, 1)),
        ("2000-02-29", date(2000, 2, 29)),  # leap day
    ],
)
def test_parse_dob_accepts_valid_iso_dates(raw, expected):
    assert parse_dob(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["", "not-a-date", "01/01/1990", "2021-02-30", "2021-13-01", "1990-1-1x"],
)
def test_parse_dob_rejects_invalid_dates(raw):
    with pytest.raises(ValueError):
        parse_dob(raw)


def test_patient_unique_constraint_enforced_at_db_level(provider):
    db.session.add(
        Patient(
            provider_id=provider.id,
            first_name="Jane",
            last_name="Doe",
            date_of_birth=date(1990, 1, 1),
        )
    )
    db.session.commit()

    db.session.add(
        Patient(
            provider_id=provider.id,
            first_name="Jane",
            last_name="Doe",
            date_of_birth=date(1990, 1, 1),
        )
    )
    with pytest.raises(IntegrityError):
        db.session.commit()
    db.session.rollback()


def test_patient_to_dict_serializes_dob_as_iso_string(provider):
    patient = Patient(
        provider_id=provider.id,
        first_name="Jane",
        last_name="Doe",
        date_of_birth=date(1990, 1, 1),
    )
    db.session.add(patient)
    db.session.commit()
    assert patient.to_dict()["date_of_birth"] == "1990-01-01"
