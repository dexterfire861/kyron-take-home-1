"""Admin tenancy, providers, templates, and deactivate flows."""

from __future__ import annotations

from db import db


def test_provider_cannot_access_admin_endpoints(client, auth_headers, provider):
    response = client.get("/api/admin/providers", headers=auth_headers(provider))
    assert response.status_code == 403


def test_admin_lists_encounters_with_provider_filter(
    client, auth_headers, admin_user, provider, other_provider, make_patient, make_encounter
):
    p1 = make_patient(provider, first_name="A")
    p2 = make_patient(other_provider, first_name="B")
    make_encounter(provider, p1)
    make_encounter(other_provider, p2)

    all_resp = client.get("/api/admin/encounters", headers=auth_headers(admin_user))
    assert all_resp.status_code == 200
    assert len(all_resp.get_json()["encounters"]) == 2

    filtered = client.get(
        f"/api/admin/encounters?provider_id={provider.id}",
        headers=auth_headers(admin_user),
    )
    assert filtered.status_code == 200
    rows = filtered.get_json()["encounters"]
    assert len(rows) == 1
    assert rows[0]["provider"]["id"] == provider.id


def test_admin_create_and_deactivate_provider(client, auth_headers, admin_user):
    create = client.post(
        "/api/admin/providers",
        headers=auth_headers(admin_user),
        json={
            "email": "newdoc@example.com",
            "full_name": "Dr. New",
            "password": "provider123",
        },
    )
    assert create.status_code == 201
    provider_id = create.get_json()["provider"]["id"]

    login_ok = client.post(
        "/api/auth/login",
        json={"email": "newdoc@example.com", "password": "provider123"},
    )
    assert login_ok.status_code == 200
    token = login_ok.get_json()["access_token"]

    deactivate = client.patch(
        f"/api/admin/providers/{provider_id}",
        headers=auth_headers(admin_user),
        json={"is_active": False},
    )
    assert deactivate.status_code == 200
    assert deactivate.get_json()["provider"]["is_active"] is False

    login_blocked = client.post(
        "/api/auth/login",
        json={"email": "newdoc@example.com", "password": "provider123"},
    )
    assert login_blocked.status_code == 403
    assert login_blocked.get_json()["error"] == "account_deactivated"

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 403
    assert me.get_json()["error"] == "account_deactivated"


def test_inactive_user_blocked_on_protected_route(
    client, auth_headers, provider, make_patient, make_encounter
):
    patient = make_patient(provider)
    encounter = make_encounter(provider, patient)
    provider.is_active = False
    db.session.commit()

    response = client.get(
        f"/api/encounters/{encounter.id}", headers=auth_headers(provider)
    )
    assert response.status_code == 403
    assert response.get_json()["error"] == "account_deactivated"


def test_admin_template_crud(client, auth_headers, admin_user):
    create = client.post(
        "/api/admin/templates",
        headers=auth_headers(admin_user),
        json={
            "name": "Sports Med",
            "slug": "sports_med",
            "description": "Sports injuries",
            "system_prompt_addon": "Emphasize mechanism of injury.",
        },
    )
    assert create.status_code == 201
    template_id = create.get_json()["template"]["id"]

    listed = client.get("/api/admin/templates", headers=auth_headers(admin_user))
    assert listed.status_code == 200
    assert any(t["id"] == template_id for t in listed.get_json()["templates"])

    updated = client.patch(
        f"/api/admin/templates/{template_id}",
        headers=auth_headers(admin_user),
        json={"system_prompt_addon": "UPDATED ADDON MARKER"},
    )
    assert updated.status_code == 200
    assert "UPDATED ADDON MARKER" in updated.get_json()["template"]["system_prompt_addon"]

    deleted = client.delete(
        f"/api/admin/templates/{template_id}",
        headers=auth_headers(admin_user),
    )
    assert deleted.status_code == 200
