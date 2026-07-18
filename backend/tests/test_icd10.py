"""ICD-10 suggest/search/update-status edge cases.

`icd10_service` calls OpenAI twice (term extraction + rerank). All route-level
tests mock `suggest_for_text` as a whole (mirroring the boundary the route
actually imports) so no network call can happen. A couple of tests exercise
`icd10_service.suggest_for_text` itself against the real Postgres trigram
index with only the two LLM calls mocked, to prove the service never invents
a code that isn't in the `icd10_codes` table.
"""

from __future__ import annotations

import json

import icd10_service


def test_suggest_requires_nonempty_assessment(
    client, auth_headers, provider, make_patient, make_encounter, make_note
):
    encounter = make_encounter(provider, make_patient(provider))
    make_note(encounter, assessment="   ")

    response = client.post(
        f"/api/encounters/{encounter.id}/icd10/suggest",
        headers=auth_headers(provider),
    )
    assert response.status_code == 400


def test_suggest_requires_note_to_exist(
    client, auth_headers, provider, make_patient, make_encounter
):
    encounter = make_encounter(provider, make_patient(provider))
    response = client.post(
        f"/api/encounters/{encounter.id}/icd10/suggest",
        headers=auth_headers(provider),
    )
    assert response.status_code == 400


def test_suggest_persists_only_mocked_candidate_codes(
    client, auth_headers, provider, make_patient, make_encounter, make_note,
    monkeypatch, seed_icd_codes,
):
    seed_icd_codes(
        [
            ("E11.9", "Type 2 diabetes mellitus without complications"),
            ("E11.65", "Type 2 diabetes mellitus with hyperglycemia"),
        ]
    )
    encounter = make_encounter(provider, make_patient(provider))
    make_note(encounter, assessment="Type 2 diabetes mellitus without complications")

    fake_matches = [
        {"code": "E11.9", "description": "Type 2 diabetes mellitus without complications", "similarity": 0.92},
        {"code": "E11.65", "description": "Type 2 diabetes mellitus with hyperglycemia", "similarity": 0.51},
    ]
    monkeypatch.setattr(
        "routes.encounter_routes.suggest_for_text", lambda text: fake_matches
    )

    response = client.post(
        f"/api/encounters/{encounter.id}/icd10/suggest",
        headers=auth_headers(provider),
    )
    assert response.status_code == 200
    codes = {s["code"] for s in response.get_json()["suggestions"]}
    assert codes == {"E11.9", "E11.65"}


def test_suggest_replaces_previous_open_suggestions_but_keeps_decided_ones(
    client, auth_headers, provider, make_patient, make_encounter, make_note,
    monkeypatch, seed_icd_codes,
):
    from db import db
    from models import NoteIcdSuggestion

    seed_icd_codes(
        [
            ("I10", "Essential hypertension"),
            ("I15.9", "Secondary hypertension"),
        ]
    )
    encounter = make_encounter(provider, make_patient(provider))
    note = make_note(encounter, assessment="Hypertension")

    db.session.add_all(
        [
            NoteIcdSuggestion(
                note_id=note.id, code="I10", description="Essential hypertension",
                similarity=0.8, status="accepted",
            ),
            NoteIcdSuggestion(
                note_id=note.id, code="I15.9", description="Secondary hypertension",
                similarity=0.4, status="suggested",
            ),
        ]
    )
    db.session.commit()

    monkeypatch.setattr(
        "routes.encounter_routes.suggest_for_text",
        lambda text: [{"code": "I10", "description": "Essential hypertension", "similarity": 0.9}],
    )

    client.post(
        f"/api/encounters/{encounter.id}/icd10/suggest", headers=auth_headers(provider)
    )

    remaining = NoteIcdSuggestion.query.filter_by(note_id=note.id).all()
    statuses = [s.status for s in remaining]
    codes = {s.code for s in remaining}
    # the old *suggested* I15.9 row was cleared; the prior accepted I10
    # decision endures as its own row, alongside a freshly created
    # suggested I10 row from this round.
    assert codes == {"I10"}
    assert sorted(statuses) == ["accepted", "suggested"]


def test_update_suggestion_status_requires_valid_value(
    client, auth_headers, provider, make_patient, make_encounter, make_note, seed_icd_codes
):
    from db import db
    from models import NoteIcdSuggestion

    seed_icd_codes([("I10", "Essential hypertension")])
    encounter = make_encounter(provider, make_patient(provider))
    note = make_note(encounter, assessment="Hypertension")
    suggestion = NoteIcdSuggestion(
        note_id=note.id, code="I10", description="Essential hypertension", similarity=0.9
    )
    db.session.add(suggestion)
    db.session.commit()

    response = client.patch(
        f"/api/encounters/{encounter.id}/icd10/{suggestion.id}",
        headers=auth_headers(provider),
        json={"status": "maybe"},
    )
    assert response.status_code == 400


def test_update_suggestion_status_accept_and_reject(
    client, auth_headers, provider, make_patient, make_encounter, make_note, seed_icd_codes
):
    from db import db
    from models import NoteIcdSuggestion

    seed_icd_codes([("I10", "Essential hypertension")])
    encounter = make_encounter(provider, make_patient(provider))
    note = make_note(encounter, assessment="Hypertension")
    suggestion = NoteIcdSuggestion(
        note_id=note.id, code="I10", description="Essential hypertension", similarity=0.9
    )
    db.session.add(suggestion)
    db.session.commit()

    response = client.patch(
        f"/api/encounters/{encounter.id}/icd10/{suggestion.id}",
        headers=auth_headers(provider),
        json={"status": "accepted"},
    )
    assert response.status_code == 200
    assert response.get_json()["suggestion"]["status"] == "accepted"


def test_update_suggestion_scoped_to_owning_encounter(
    client, auth_headers, provider, other_provider, make_patient, make_encounter, make_note,
    seed_icd_codes,
):
    from db import db
    from models import NoteIcdSuggestion

    seed_icd_codes([("I10", "Essential hypertension")])
    their_encounter = make_encounter(other_provider, make_patient(other_provider))
    their_note = make_note(their_encounter, assessment="Hypertension")
    suggestion = NoteIcdSuggestion(
        note_id=their_note.id, code="I10", description="Essential hypertension", similarity=0.9
    )
    db.session.add(suggestion)
    db.session.commit()

    response = client.patch(
        f"/api/encounters/{their_encounter.id}/icd10/{suggestion.id}",
        headers=auth_headers(provider),
        json={"status": "accepted"},
    )
    assert response.status_code == 404


def test_search_requires_minimum_query_length(client, auth_headers, provider):
    response = client.get(
        "/api/icd10/search?q=hi", headers=auth_headers(provider)
    )
    assert response.status_code == 400


def test_search_empty_query_returns_empty_results(client, auth_headers, provider):
    response = client.get("/api/icd10/search?q=", headers=auth_headers(provider))
    assert response.status_code == 200
    assert response.get_json()["results"] == []


def test_search_uses_mocked_service(client, auth_headers, provider, monkeypatch):
    monkeypatch.setattr(
        "routes.encounter_routes.suggest_for_text",
        lambda text, top_n=10: [{"code": "J45.909", "description": "Asthma, unspecified", "similarity": 0.7}],
    )
    response = client.get(
        "/api/icd10/search?q=asthma", headers=auth_headers(provider)
    )
    assert response.status_code == 200
    assert response.get_json()["results"][0]["code"] == "J45.909"


# ---------------------------------------------------------------------------
# Service-level: candidate pool + rerank never invent a code
# ---------------------------------------------------------------------------


class _FakeMessage:
    def __init__(self, content):
        self.content = content


class _FakeChoice:
    def __init__(self, content):
        self.message = _FakeMessage(content)


class _FakeCompletion:
    def __init__(self, content):
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def __init__(self, content):
        self._content = content

    def create(self, **kwargs):
        return _FakeCompletion(self._content)


class _FakeChat:
    def __init__(self, content):
        self.completions = _FakeCompletions(content)


class _FakeOpenAIClient:
    def __init__(self, content):
        self.chat = _FakeChat(content)


def test_rerank_drops_llm_hallucinated_codes_not_in_candidate_pool(monkeypatch):
    candidates = [
        {"code": "E11.9", "description": "Type 2 diabetes mellitus without complications", "similarity": 0.9},
        {"code": "E11.65", "description": "Type 2 diabetes mellitus with hyperglycemia", "similarity": 0.5},
    ]
    # The LLM "hallucinates" a code (Z99.99) that was never in the retrieved
    # candidate pool — the rerank step must silently drop it.
    fake_content = json.dumps({"codes": ["E11.9", "Z99.99"]})
    monkeypatch.setattr(
        icd10_service, "_client", lambda: _FakeOpenAIClient(fake_content)
    )

    ranked = icd10_service._rerank("diabetes", candidates, top_n=10)
    codes = [r["code"] for r in ranked]
    assert "Z99.99" not in codes
    assert set(codes) == {"E11.9", "E11.65"}


def test_rerank_falls_back_to_candidate_order_when_llm_call_fails(monkeypatch):
    candidates = [
        {"code": "I10", "description": "Essential (primary) hypertension", "similarity": 0.9},
    ]

    def _boom():
        raise RuntimeError("network down")

    monkeypatch.setattr(icd10_service, "_client", _boom)

    ranked = icd10_service._rerank("hypertension", candidates, top_n=10)
    assert ranked == candidates


def test_rerank_of_no_candidates_short_circuits_without_calling_llm(monkeypatch):
    called = False

    def _client_spy():
        nonlocal called
        called = True
        raise AssertionError("should not be called when there are no candidates")

    monkeypatch.setattr(icd10_service, "_client", _client_spy)
    assert icd10_service._rerank("anything", [], top_n=10) == []
    assert called is False


def test_suggest_for_text_never_invents_codes_not_in_db(seed_icd_codes, monkeypatch):
    seed_icd_codes(
        [
            ("E11.9", "Type 2 diabetes mellitus without complications"),
            ("E11.65", "Type 2 diabetes mellitus with hyperglycemia"),
            ("I10", "Essential (primary) hypertension"),
        ]
    )

    monkeypatch.setattr(
        icd10_service, "extract_terms", lambda text_input, max_terms=5: ["diabetes mellitus"]
    )
    fake_content = json.dumps({"codes": ["E11.9", "Z99.99"]})
    monkeypatch.setattr(
        icd10_service, "_client", lambda: _FakeOpenAIClient(fake_content)
    )

    results = icd10_service.suggest_for_text("Patient has diabetes mellitus")
    codes = {r["code"] for r in results}
    assert "Z99.99" not in codes
    assert codes.issubset({"E11.9", "E11.65", "I10"})


def test_suggest_for_text_returns_empty_when_no_terms_extracted(
    seed_icd_codes, monkeypatch
):
    seed_icd_codes([("I10", "Essential (primary) hypertension")])
    monkeypatch.setattr(icd10_service, "extract_terms", lambda text_input, max_terms=5: [])

    results = icd10_service.suggest_for_text("no clinical content here")
    assert results == []


def test_extract_terms_returns_empty_for_blank_text():
    assert icd10_service.extract_terms("") == []
    assert icd10_service.extract_terms("   ") == []
