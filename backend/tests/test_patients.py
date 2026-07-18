"""Patient identity and tenancy edge cases.

Covers: find-or-create by (provider, first, last, DOB), same name/different
DOB creating separate patients, DOB validation, and provider A being unable
to read provider B's patients.
"""

from __future__ import annotations


def test_create_encounter_creates_patient_when_new(client, auth_headers, provider):
    response = client.post(
        "/api/encounters",
        headers=auth_headers(provider),
        json={
            "first_name": "Jane",
            "last_name": "Doe",
            "date_of_birth": "1990-01-01",
        },
    )
    assert response.status_code == 201
    body = response.get_json()["encounter"]
    assert body["patient"]["first_name"] == "Jane"
    assert body["patient"]["date_of_birth"] == "1990-01-01"


def test_create_encounter_finds_existing_patient_by_identity(
    client, auth_headers, provider
):
    payload = {
        "first_name": "Jane",
        "last_name": "Doe",
        "date_of_birth": "1990-01-01",
    }
    first = client.post(
        "/api/encounters", headers=auth_headers(provider), json=payload
    ).get_json()["encounter"]
    second = client.post(
        "/api/encounters", headers=auth_headers(provider), json=payload
    ).get_json()["encounter"]

    assert first["patient_id"] == second["patient_id"]
    assert first["id"] != second["id"]


def test_same_name_different_dob_creates_separate_patients(
    client, auth_headers, provider
):
    base = {"first_name": "Jane", "last_name": "Doe"}
    first = client.post(
        "/api/encounters",
        headers=auth_headers(provider),
        json={**base, "date_of_birth": "1990-01-01"},
    ).get_json()["encounter"]
    second = client.post(
        "/api/encounters",
        headers=auth_headers(provider),
        json={**base, "date_of_birth": "1985-06-15"},
    ).get_json()["encounter"]

    assert first["patient_id"] != second["patient_id"]


def test_two_providers_can_have_same_named_patient_as_distinct_records(
    client, auth_headers, provider, other_provider
):
    payload = {
        "first_name": "Jane",
        "last_name": "Doe",
        "date_of_birth": "1990-01-01",
    }
    mine = client.post(
        "/api/encounters", headers=auth_headers(provider), json=payload
    ).get_json()["encounter"]
    theirs = client.post(
        "/api/encounters", headers=auth_headers(other_provider), json=payload
    ).get_json()["encounter"]

    assert mine["patient_id"] != theirs["patient_id"]


def test_create_encounter_requires_all_identity_fields(client, auth_headers, provider):
    response = client.post(
        "/api/encounters",
        headers=auth_headers(provider),
        json={"first_name": "Jane", "last_name": "", "date_of_birth": "1990-01-01"},
    )
    assert response.status_code == 400


def test_create_encounter_rejects_malformed_dob(client, auth_headers, provider):
    response = client.post(
        "/api/encounters",
        headers=auth_headers(provider),
        json={
            "first_name": "Jane",
            "last_name": "Doe",
            "date_of_birth": "01/01/1990",
        },
    )
    assert response.status_code == 400
    assert "date_of_birth" in response.get_json()["error"]


def test_create_encounter_rejects_impossible_calendar_date(
    client, auth_headers, provider
):
    response = client.post(
        "/api/encounters",
        headers=auth_headers(provider),
        json={
            "first_name": "Jane",
            "last_name": "Doe",
            "date_of_birth": "2021-02-30",
        },
    )
    assert response.status_code == 400


def test_list_patients_only_returns_own_patients(
    client, auth_headers, provider, other_provider, make_patient
):
    make_patient(provider, first_name="Mine", last_name="Patient")
    make_patient(other_provider, first_name="Theirs", last_name="Patient")

    response = client.get("/api/patients", headers=auth_headers(provider))
    names = [p["first_name"] for p in response.get_json()["patients"]]
    assert names == ["Mine"]


def test_admin_can_list_all_patients(
    client, auth_headers, provider, other_provider, admin_user, make_patient
):
    make_patient(provider, first_name="Mine", last_name="Patient")
    make_patient(other_provider, first_name="Theirs", last_name="Patient")

    response = client.get("/api/patients", headers=auth_headers(admin_user))
    names = {p["first_name"] for p in response.get_json()["patients"]}
    assert names == {"Mine", "Theirs"}


def test_owner_can_read_own_patient(client, auth_headers, other_provider, make_patient):
    patient = make_patient(other_provider)
    response = client.get(
        f"/api/patients/{patient.id}", headers=auth_headers(other_provider)
    )
    assert response.status_code == 200


def test_unauthenticated_request_is_rejected(client, other_provider, make_patient):
    patient = make_patient(other_provider)
    response = client.get(f"/api/patients/{patient.id}")
    assert response.status_code == 401


def test_provider_a_cannot_read_provider_bs_patient(
    client, auth_headers, provider, other_provider, make_patient
):
    their_patient = make_patient(other_provider, first_name="Secret")

    response = client.get(
        f"/api/patients/{their_patient.id}", headers=auth_headers(provider)
    )
    assert response.status_code == 404


def test_admin_can_read_any_patient(
    client, auth_headers, other_provider, admin_user, make_patient
):
    their_patient = make_patient(other_provider, first_name="Secret")

    response = client.get(
        f"/api/patients/{their_patient.id}", headers=auth_headers(admin_user)
    )
    assert response.status_code == 200
    assert response.get_json()["patient"]["first_name"] == "Secret"


def test_get_nonexistent_patient_returns_404(client, auth_headers, provider):
    response = client.get("/api/patients/999999", headers=auth_headers(provider))
    assert response.status_code == 404
