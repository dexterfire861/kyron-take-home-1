"""Auth edge cases: login, /me, invalid/expired JWT, role gating."""

from __future__ import annotations

from tests.conftest import make_expired_token


def test_login_success_returns_token_and_user(client, provider):
    response = client.post(
        "/api/auth/login",
        json={"email": provider.email, "password": "password123"},
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["access_token"]
    assert body["user"]["email"] == provider.email
    assert "password_hash" not in body["user"]


def test_login_wrong_password_rejected(client, provider):
    response = client.post(
        "/api/auth/login",
        json={"email": provider.email, "password": "wrong-password"},
    )
    assert response.status_code == 401
    assert "error" in response.get_json()


def test_login_unknown_email_rejected(client):
    response = client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "whatever"},
    )
    assert response.status_code == 401


def test_login_missing_fields_rejected(client):
    response = client.post("/api/auth/login", json={"email": "", "password": ""})
    assert response.status_code == 400


def test_login_email_is_case_insensitive(client, provider):
    response = client.post(
        "/api/auth/login",
        json={"email": provider.email.upper(), "password": "password123"},
    )
    assert response.status_code == 200


def test_me_requires_bearer_token(client):
    response = client.get("/api/auth/me")
    assert response.status_code == 401


def test_me_rejects_malformed_header(client):
    response = client.get("/api/auth/me", headers={"Authorization": "Token abc"})
    assert response.status_code == 401


def test_me_rejects_garbage_token(client):
    response = client.get(
        "/api/auth/me", headers={"Authorization": "Bearer not-a-real-jwt"}
    )
    assert response.status_code == 401


def test_me_rejects_expired_token(client, provider):
    token = make_expired_token(provider)
    response = client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 401


def test_me_returns_current_user(client, auth_headers, provider):
    response = client.get("/api/auth/me", headers=auth_headers(provider))
    assert response.status_code == 200
    assert response.get_json()["user"]["id"] == provider.id


def test_token_for_deleted_user_is_rejected(client, auth_headers, make_user):
    from db import db

    user = make_user(email="temp@example.com")
    headers = auth_headers(user)
    db.session.delete(user)
    db.session.commit()

    response = client.get("/api/auth/me", headers=headers)
    assert response.status_code == 401


def test_provider_required_rejects_unrecognized_role(client, make_user, auth_headers):
    guest = make_user(email="guest@example.com", role="guest")
    response = client.get("/api/patients", headers=auth_headers(guest))
    assert response.status_code == 403
