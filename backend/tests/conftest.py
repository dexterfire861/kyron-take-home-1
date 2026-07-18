"""Shared pytest fixtures for the backend test suite.

Test isolation strategy
------------------------
Flask-SQLAlchemy 3.x scopes ``db.session`` to the current Flask application
context (see ``flask_sqlalchemy.session._app_ctx_id``). We push a single app
context per test (see ``app_ctx`` below) and keep it alive for the whole
test, including any requests made through the Flask test client — Flask
reuses an already-active app context for the same app instead of pushing a
new one, so fixtures, direct ORM calls, and client requests all share one
session/scope inside a given test.

We run against a real Postgres database (not SQLite) because
``icd10_service`` relies on the ``pg_trgm`` extension (the ``%`` similarity
operator and ``similarity()`` function), which SQLite cannot provide. Between
tests we truncate every table rather than dropping/recreating the schema,
which keeps the suite fast while guaranteeing a clean slate.
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# These must be set before `app` (and therefore `secrets_loader`/`db`) is
# imported, since `app.py` builds the Flask app at import time.
os.environ.setdefault(
    "DATABASE_URL",
    os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql+psycopg://kyron:kyron@localhost:5432/kyron_test",
    ),
)
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-do-not-use-in-production-0123456789")
os.environ.setdefault("OPENAI_API_KEY", "test-openai-key-not-real")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")
# Never touch Parameter Store in tests.
os.environ.pop("AWS_SSM_PREFIX", None)

import jwt  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import create_app  # noqa: E402
from auth import JWT_ALGORITHM, create_access_token  # noqa: E402
from db import db  # noqa: E402
from models import Encounter, Note, NoteVersion, Patient, User  # noqa: E402


@pytest.fixture(scope="session")
def app():
    flask_app = create_app()
    flask_app.config.update(TESTING=True)
    with flask_app.app_context():
        db.session.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        db.session.commit()
        db.create_all()
    yield flask_app
    with flask_app.app_context():
        db.session.remove()


def _truncate_all() -> None:
    for table in reversed(db.metadata.sorted_tables):
        db.session.execute(table.delete())
    db.session.commit()


@pytest.fixture(autouse=True)
def app_ctx(app):
    """Push one app context (and therefore one db.session scope) per test."""
    ctx = app.app_context()
    ctx.push()
    _truncate_all()
    try:
        yield app
    finally:
        db.session.rollback()
        _truncate_all()
        ctx.pop()


@pytest.fixture()
def client(app_ctx):
    return app_ctx.test_client()


@pytest.fixture()
def make_user() -> Callable[..., User]:
    def _make(
        email: str = "provider@example.com",
        password: str = "password123",
        full_name: str = "Dr. Test Provider",
        role: str = "provider",
    ) -> User:
        user = User(email=email, full_name=full_name, role=role)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        return user

    return _make


@pytest.fixture()
def provider(make_user) -> User:
    return make_user(email="provider1@example.com", full_name="Dr. Ava Chen")


@pytest.fixture()
def other_provider(make_user) -> User:
    return make_user(email="provider2@example.com", full_name="Dr. Marcus Lee")


@pytest.fixture()
def admin_user(make_user) -> User:
    return make_user(email="admin@example.com", full_name="Kyron Admin", role="admin")


@pytest.fixture()
def auth_headers() -> Callable[[User], dict]:
    def _headers(user: User) -> dict:
        token = create_access_token(user)
        return {"Authorization": f"Bearer {token}"}

    return _headers


def make_expired_token(user: User) -> str:
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "exp": datetime.now(timezone.utc) - timedelta(hours=1),
        "iat": datetime.now(timezone.utc) - timedelta(hours=2),
    }
    return jwt.encode(payload, os.environ["JWT_SECRET"], algorithm=JWT_ALGORITHM)


@pytest.fixture()
def make_patient() -> Callable[..., Patient]:
    def _make(
        provider: User,
        first_name: str = "Jane",
        last_name: str = "Doe",
        date_of_birth: date = date(1990, 1, 1),
    ) -> Patient:
        patient = Patient(
            provider_id=provider.id,
            first_name=first_name,
            last_name=last_name,
            date_of_birth=date_of_birth,
        )
        db.session.add(patient)
        db.session.commit()
        return patient

    return _make


@pytest.fixture()
def make_encounter() -> Callable[..., Encounter]:
    def _make(
        provider: User,
        patient: Patient,
        input_text: str = "",
        input_type: str = "observations",
        status: str = "draft",
    ) -> Encounter:
        encounter = Encounter(
            provider_id=provider.id,
            patient_id=patient.id,
            input_text=input_text,
            input_type=input_type,
            status=status,
        )
        db.session.add(encounter)
        db.session.commit()
        return encounter

    return _make


@pytest.fixture()
def make_note() -> Callable[..., Note]:
    def _make(
        encounter: Encounter,
        subjective: str = "",
        objective: str = "",
        assessment: str = "",
        plan: str = "",
    ) -> Note:
        note = Note(
            encounter_id=encounter.id,
            subjective=subjective,
            objective=objective,
            assessment=assessment,
            plan=plan,
        )
        db.session.add(note)
        db.session.commit()
        return note

    return _make


@pytest.fixture()
def seed_icd_codes() -> Callable[[list[tuple[str, str]]], None]:
    from models import IcdCode

    def _seed(codes: list[tuple[str, str]]) -> None:
        for code, description in codes:
            db.session.add(IcdCode(code=code, description=description))
        db.session.commit()

    return _seed
