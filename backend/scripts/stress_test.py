#!/usr/bin/env python3
"""Concurrent stress harness for Kyron admin / draft / generate / auth paths.

Usage (from backend/):
  .venv/bin/python scripts/stress_test.py
  .venv/bin/python scripts/stress_test.py --workers 32 --rounds 50

Does not call OpenAI — generate is mocked. Uses the test Postgres DB.
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

os.environ["DATABASE_URL"] = os.environ.get(
    "STRESS_DATABASE_URL",
    "postgresql+psycopg://kyron:kyron@localhost:5432/kyron_stress",
)
os.environ.setdefault("JWT_SECRET", "stress-jwt-secret-0123456789abcdef")
os.environ.setdefault("OPENAI_API_KEY", "test-openai-key-not-real")
os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")
os.environ.pop("AWS_SSM_PREFIX", None)

from sqlalchemy import text  # noqa: E402

from app import create_app  # noqa: E402
from auth import create_access_token  # noqa: E402
from db import db  # noqa: E402
from models import Encounter, Note, NoteTemplate, Patient, User  # noqa: E402


@dataclass
class Result:
    name: str
    ok: bool
    ms: float
    detail: str = ""


@dataclass
class Stats:
    results: list[Result] = field(default_factory=list)

    def add(self, r: Result) -> None:
        self.results.append(r)

    def report(self) -> int:
        by_name: dict[str, list[Result]] = {}
        for r in self.results:
            by_name.setdefault(r.name, []).append(r)

        print("\n=== Stress report ===")
        failures = 0
        for name, items in sorted(by_name.items()):
            oks = [i for i in items if i.ok]
            fails = [i for i in items if not i.ok]
            failures += len(fails)
            lat = [i.ms for i in items]
            print(
                f"{name:28s}  n={len(items):4d}  "
                f"ok={len(oks):4d}  fail={len(fails):3d}  "
                f"p50={statistics.median(lat):7.1f}ms  "
                f"p95={sorted(lat)[max(0, int(len(lat) * 0.95) - 1)]:7.1f}ms  "
                f"max={max(lat):7.1f}ms"
            )
            for f in fails[:5]:
                print(f"    FAIL: {f.detail[:200]}")
            if len(fails) > 5:
                print(f"    … {len(fails) - 5} more failures")

        print(f"\nTotal: {len(self.results)} ops, {failures} failures")
        return failures


def _headers(user: User) -> dict:
    return {
        "Authorization": f"Bearer {create_access_token(user)}",
        "Content-Type": "application/json",
    }


def _mock_stream(*_a, **_k):
    yield {
        "event": "context",
        "data": {"prior_note_count": 0, "returning_patient": False},
    }
    yield {
        "event": "done",
        "data": {
            "note": {
                "subjective": "Stress subjective",
                "objective": "Stress objective",
                "assessment": "Stress assessment — knee pain",
                "plan": "Stress plan — RICE",
            }
        },
    }


def seed(app):
    with app.app_context():
        db.session.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        db.session.commit()
        for table in reversed(db.metadata.sorted_tables):
            db.session.execute(table.delete())
        db.session.commit()

        admin = User(email="stress-admin@example.com", full_name="Stress Admin", role="admin")
        admin.set_password("admin123")
        providers = []
        for i in range(3):
            p = User(
                email=f"stress-provider{i}@example.com",
                full_name=f"Dr. Stress {i}",
                role="provider",
                is_active=True,
            )
            p.set_password("provider123")
            providers.append(p)
        db.session.add_all([admin, *providers])
        db.session.commit()

        templates = []
        for slug, name, addon in [
            ("new_patient_eval", "New Patient Eval", "Emphasize HPI completeness."),
            ("orthopedic_followup", "Ortho Follow-up", "Focus on musculoskeletal exam."),
            ("urgent_care", "Urgent Care", "Be concise; highlight red flags."),
        ]:
            t = NoteTemplate(
                name=name,
                slug=slug,
                description=name,
                system_prompt_addon=addon,
                is_active=True,
            )
            templates.append(t)
        db.session.add_all(templates)
        db.session.commit()

        encounters = []
        for i, provider in enumerate(providers):
            patient = Patient(
                provider_id=provider.id,
                first_name=f"Pat{i}",
                last_name="Stress",
                date_of_birth="1990-01-01",
            )
            db.session.add(patient)
            db.session.flush()
            # Saved prior encounter for returning-patient path
            prior = Encounter(
                provider_id=provider.id,
                patient_id=patient.id,
                template_id=templates[0].id,
                input_text="Prior knee sprain visit with swelling and pain for one week.",
                input_type="transcript",
                status="saved",
            )
            db.session.add(prior)
            db.session.flush()
            db.session.add(
                Note(
                    encounter_id=prior.id,
                    subjective="Prior knee pain",
                    objective="Mild swelling",
                    assessment="Sprain",
                    plan="RICE",
                )
            )
            active = Encounter(
                provider_id=provider.id,
                patient_id=patient.id,
                template_id=templates[i % len(templates)].id,
                input_text="",
                input_type="transcript",
                status="draft",
            )
            db.session.add(active)
            encounters.append(active)
        db.session.commit()

        return {
            "admin_id": admin.id,
            "provider_ids": [p.id for p in providers],
            "encounter_ids": [e.id for e in encounters],
            "template_ids": [t.id for t in templates],
        }


def timed(name: str, fn) -> Result:
    start = time.perf_counter()
    try:
        detail = fn() or ""
        return Result(name=name, ok=True, ms=(time.perf_counter() - start) * 1000, detail=str(detail))
    except Exception as exc:  # noqa: BLE001
        return Result(
            name=name,
            ok=False,
            ms=(time.perf_counter() - start) * 1000,
            detail=f"{exc}\n{traceback.format_exc(limit=3)}",
        )


def worker(app, ids: dict, worker_id: int, rounds: int) -> list[Result]:
    # Patch generate once per process; safe for threads (no I/O)
    import routes.encounter_routes as er

    er.stream_soap_note = _mock_stream

    out: list[Result] = []
    client = app.test_client()

    with app.app_context():
        admin = db.session.get(User, ids["admin_id"])
        providers = [db.session.get(User, pid) for pid in ids["provider_ids"]]
        assert admin and all(providers)

    for r in range(rounds):
        provider = providers[worker_id % len(providers)]
        encounter_id = ids["encounter_ids"][worker_id % len(ids["encounter_ids"])]
        template_id = ids["template_ids"][r % len(ids["template_ids"])]
        auth = _headers(provider)
        admin_auth = _headers(admin)

        def draft():
            resp = client.patch(
                f"/api/encounters/{encounter_id}/draft",
                headers=auth,
                json={
                    "input_text": (
                        f"Worker {worker_id} round {r}: patient reports progressive "
                        "right knee pain for two weeks after twisting injury with swelling."
                    ),
                    "input_type": "transcript",
                    "template_id": template_id,
                    "subjective": f"Knee pain w{worker_id}r{r}",
                    "objective": "Swelling noted",
                    "assessment": "Possible sprain",
                    "plan": "RICE and follow-up",
                },
            )
            if resp.status_code != 200:
                raise AssertionError(f"draft {resp.status_code}: {resp.get_json()}")
            return "ok"

        def generate():
            resp = client.post(
                f"/api/encounters/{encounter_id}/generate",
                headers=auth,
                json={
                    "text": (
                        "Patient with right knee pain for two weeks after twisting "
                        "injury while playing soccer. Swelling and limited ROM."
                    ),
                    "input_type": "transcript",
                    "template_id": template_id,
                },
            )
            if resp.status_code != 200:
                raise AssertionError(f"generate {resp.status_code}: {resp.get_json()}")
            body = resp.data.decode("utf-8", errors="replace")
            if "event: done" not in body:
                raise AssertionError("missing done event in SSE")
            return f"bytes={len(resp.data)}"

        def get_enc():
            resp = client.get(f"/api/encounters/{encounter_id}", headers=auth)
            if resp.status_code != 200:
                raise AssertionError(f"get {resp.status_code}: {resp.get_json()}")
            enc = resp.get_json()["encounter"]
            if "prior_note_count" not in enc:
                raise AssertionError("missing prior_note_count")
            return f"prior={enc['prior_note_count']}"

        def admin_list():
            resp = client.get("/api/admin/encounters", headers=admin_auth)
            if resp.status_code != 200:
                raise AssertionError(f"admin enc {resp.status_code}")
            resp2 = client.get("/api/admin/providers", headers=admin_auth)
            if resp2.status_code != 200:
                raise AssertionError(f"admin providers {resp2.status_code}")
            resp3 = client.get("/api/admin/templates", headers=admin_auth)
            if resp3.status_code != 200:
                raise AssertionError(f"admin templates {resp3.status_code}")
            return f"enc={len(resp.get_json()['encounters'])}"

        def nonclinical():
            # Hit real looks_nonclinical path via soap_service (not mocked route)
            import soap_service

            events = list(soap_service.stream_soap_note("asdf asdf asdf"))
            done = [e for e in events if e["event"] == "done"]
            if not done or not done[0]["data"].get("refused"):
                raise AssertionError("expected refusal")
            return "refused"

        def inactive_check():
            # Provider accessing admin must be 403
            resp = client.get("/api/admin/providers", headers=auth)
            if resp.status_code != 403:
                raise AssertionError(f"expected 403 got {resp.status_code}")
            return "forbidden"

        out.append(timed("draft_patch", draft))
        out.append(timed("generate_sse", generate))
        out.append(timed("get_encounter", get_enc))
        out.append(timed("admin_lists", admin_list))
        out.append(timed("nonclinical_gate", nonclinical))
        out.append(timed("provider_admin_403", inactive_check))

        # Mid-stress: flip template addon (live template path)
        if r % 7 == 0:

            def patch_template():
                tid = ids["template_ids"][0]
                resp = client.patch(
                    f"/api/admin/templates/{tid}",
                    headers=admin_auth,
                    json={"system_prompt_addon": f"LIVE_ADDON_w{worker_id}_r{r}"},
                )
                if resp.status_code != 200:
                    raise AssertionError(f"template patch {resp.status_code}")
                return "patched"

            out.append(timed("admin_template_patch", patch_template))

    return out


def deactivate_reactivate_cycle(app, ids: dict) -> list[Result]:
    """Serial stress of deactivate mid-draft then reactivate."""
    client = app.test_client()
    out: list[Result] = []

    with app.app_context():
        db.session.expire_all()
        admin = db.session.get(User, ids["admin_id"])
        provider = db.session.get(User, ids["provider_ids"][0])
        if admin is None or provider is None:
            raise RuntimeError(
                f"seed users missing after concurrent phase "
                f"(admin={admin}, provider={provider}, ids={ids})"
            )
        admin_id = admin.id
        provider_id = provider.id
        encounter_id = ids["encounter_ids"][0]
        admin_auth = _headers(admin)
        provider_auth = _headers(provider)

    def draft_then_deactivate():
        d = client.patch(
            f"/api/encounters/{encounter_id}/draft",
            headers=provider_auth,
            json={
                "input_text": "Draft before deactivate: knee pain for two weeks with swelling.",
                "subjective": "Preserved draft",
                "objective": "",
                "assessment": "",
                "plan": "",
            },
        )
        if d.status_code != 200:
            raise AssertionError(f"pre-deact draft {d.status_code}: {d.get_json()}")
        de = client.patch(
            f"/api/admin/providers/{provider_id}",
            headers=admin_auth,
            json={"is_active": False},
        )
        if de.status_code != 200:
            raise AssertionError(f"deactivate {de.status_code}")
        blocked = client.get(
            f"/api/encounters/{encounter_id}", headers=provider_auth
        )
        if blocked.status_code != 403:
            raise AssertionError(f"expected 403 got {blocked.status_code}")
        if blocked.get_json().get("error") != "account_deactivated":
            raise AssertionError(blocked.get_json())
        # Draft still in DB
        with app.app_context():
            enc = db.session.get(Encounter, encounter_id)
            assert enc is not None
            assert enc.note is not None
            assert "Preserved draft" in enc.note.subjective
        re = client.patch(
            f"/api/admin/providers/{provider_id}",
            headers=admin_auth,
            json={"is_active": True},
        )
        if re.status_code != 200:
            raise AssertionError(f"reactivate {re.status_code}")
        ok = client.get(f"/api/encounters/{encounter_id}", headers=provider_auth)
        if ok.status_code != 200:
            raise AssertionError(f"post-reactivate {ok.status_code}: {ok.get_json()}")
        return f"cycle-ok admin={admin_id}"

    out.append(timed("deactivate_mid_draft", draft_then_deactivate))
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--rounds", type=int, default=25)
    args = parser.parse_args()

    app = create_app()
    app.config.update(TESTING=True)
    with app.app_context():
        db.create_all()

    ids = seed(app)
    stats = Stats()

    print(
        f"Starting stress: workers={args.workers} rounds/worker={args.rounds} "
        f"(~{args.workers * args.rounds * 6} ops)"
    )
    t0 = time.perf_counter()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(worker, app, ids, wid, args.rounds)
            for wid in range(args.workers)
        ]
        for fut in as_completed(futures):
            for r in fut.result():
                stats.add(r)

    for r in deactivate_reactivate_cycle(app, ids):
        stats.add(r)

    # Burst: same encounter drafted by many workers (last-write-wins integrity)
    def burst_draft(i: int) -> Result:
        client = app.test_client()
        with app.app_context():
            provider = db.session.get(User, ids["provider_ids"][0])
        auth = _headers(provider)
        eid = ids["encounter_ids"][0]

        def run():
            resp = client.patch(
                f"/api/encounters/{eid}/draft",
                headers=auth,
                json={
                    "input_text": f"burst {i} clinical knee pain swelling two weeks injury",
                    "subjective": f"burst-{i}",
                    "objective": "o",
                    "assessment": "a",
                    "plan": "p",
                },
            )
            if resp.status_code != 200:
                raise AssertionError(f"burst {resp.status_code}: {resp.get_json()}")
            return "ok"

        return timed("burst_draft_same_enc", run)

    print("Burst: 64 concurrent drafts on one encounter…")
    with ThreadPoolExecutor(max_workers=32) as pool:
        for fut in as_completed([pool.submit(burst_draft, i) for i in range(64)]):
            stats.add(fut.result())

    elapsed = time.perf_counter() - t0
    print(f"Wall time: {elapsed:.2f}s")
    failures = stats.report()
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
