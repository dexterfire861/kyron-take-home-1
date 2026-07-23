"""Seed demo users, note templates, and a curated ICD-10 code subset.

Run: python seed.py

The ICD-10 seed embeds ~300 codes (backend/data/icd10_seed.csv) so a fresh
clone has a working ICD-10 search out of the box. For the full CMS code list,
run scripts/import_icd10.py against the official zip instead — both use the
same idempotence guard (skip if icd10_codes already has rows), so seeding can
never clobber a database that already holds the complete set.
"""

from __future__ import annotations

import csv
from pathlib import Path

from app import create_app
from db import db
from models import IcdCode, NoteTemplate, User, utcnow

ICD_SEED_CSV = Path(__file__).resolve().parent / "data" / "icd10_seed.csv"

SEED_USERS = [
    {
        "email": "admin@kyron.local",
        "password": "admin123",
        "full_name": "Kyron Admin",
        "role": "admin",
    },
    {
        "email": "provider1@kyron.local",
        "password": "provider123",
        "full_name": "Dr. Ava Chen",
        "role": "provider",
    },
    {
        "email": "provider2@kyron.local",
        "password": "provider123",
        "full_name": "Dr. Marcus Lee",
        "role": "provider",
    },
    {
        "email": "provider3@kyron.local",
        "password": "provider123",
        "full_name": "Dr. Priya Nair",
        "role": "provider",
    },
]

SEED_TEMPLATES = [
    {
        "name": "New patient evaluation",
        "slug": "new_patient_eval",
        "description": "Comprehensive first-visit note with full HPI and ROS tone.",
        "system_prompt_addon": (
            "TEMPLATE: New patient evaluation.\n"
            "Write a thorough first-visit SOAP note. Emphasize complete HPI, relevant PMH/meds/"
            "allergies if present, and a clear differential in Assessment. Plan should include "
            "diagnostics and follow-up appropriate for a new patient."
        ),
    },
    {
        "name": "Orthopedic follow-up",
        "slug": "orthopedic_followup",
        "description": "MSK follow-up focused on interval change, exam, and rehab plan.",
        "system_prompt_addon": (
            "TEMPLATE: Orthopedic follow-up.\n"
            "Focus on interval symptom change, mechanical symptoms, focused MSK exam findings, "
            "imaging if mentioned, and a rehab/activity-modification plan. Prefer concise "
            "orthopedic language (e.g. weight-bearing status, ROM, special tests)."
        ),
    },
    {
        "name": "Urgent care visit",
        "slug": "urgent_care",
        "description": "Brief acute-care note emphasizing red flags and disposition.",
        "system_prompt_addon": (
            "TEMPLATE: Urgent care visit.\n"
            "Keep sections brief and action-oriented. Explicitly address red-flag negatives when "
            "supported by the input. Assessment should state the working acute diagnosis; Plan "
            "should emphasize disposition, return precautions, and immediate treatments."
        ),
    },
]


def seed() -> None:
    app = create_app()
    with app.app_context():
        db.create_all()
        for item in SEED_USERS:
            existing = User.query.filter_by(email=item["email"]).first()
            if existing:
                if not getattr(existing, "is_active", True):
                    existing.is_active = True
                print(f"skip existing user: {item['email']}")
                continue
            user = User(
                email=item["email"],
                full_name=item["full_name"],
                role=item["role"],
                is_active=True,
            )
            user.set_password(item["password"])
            db.session.add(user)
            print(f"created {item['role']}: {item['email']} / {item['password']}")

        for item in SEED_TEMPLATES:
            existing = NoteTemplate.query.filter_by(slug=item["slug"]).first()
            if existing:
                print(f"skip existing template: {item['slug']}")
                continue
            now = utcnow()
            db.session.add(
                NoteTemplate(
                    name=item["name"],
                    slug=item["slug"],
                    description=item["description"],
                    system_prompt_addon=item["system_prompt_addon"],
                    is_active=True,
                    created_at=now,
                    updated_at=now,
                )
            )
            print(f"created template: {item['slug']}")

        seed_icd10_codes()

        db.session.commit()
        print("seed complete")


def seed_icd10_codes() -> None:
    """Load the curated ICD-10 subset, unless the table already has rows.

    The guard mirrors scripts/import_icd10.py so this is safe to run against a
    database that already holds the full CMS list (e.g. production) — it will
    skip rather than replace the larger set with the ~300-code demo subset.
    """
    existing = IcdCode.query.count()
    if existing:
        print(f"skip ICD-10 seed: table already has {existing} rows")
        return
    if not ICD_SEED_CSV.exists():
        print(f"skip ICD-10 seed: {ICD_SEED_CSV} not found")
        return

    with open(ICD_SEED_CSV, newline="") as f:
        reader = csv.DictReader(f)
        mappings = [
            {"code": row["code"].strip(), "description": row["description"].strip()}
            for row in reader
            if row.get("code") and row.get("description")
        ]
    db.session.bulk_insert_mappings(IcdCode, mappings)
    print(f"created {len(mappings)} ICD-10 codes from {ICD_SEED_CSV.name}")


if __name__ == "__main__":
    seed()
