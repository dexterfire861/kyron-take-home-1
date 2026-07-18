# Backend test suite

A pytest suite covering doctor-relevant edge cases and API/service
correctness for the Flask backend. It never calls OpenAI — every LLM /
Realtime boundary is mocked.

## What's covered

| File | Focus |
| --- | --- |
| `test_auth.py` | Login, `/me`, invalid/expired/garbage JWTs, role gating, case-insensitive email |
| `test_patients.py` | Find-or-create patient identity by (provider, first, last, DOB), same name/different DOB, DOB validation, provider/admin tenancy |
| `test_encounters.py` | Encounter CRUD tenancy, streaming `/generate` SSE event shapes + persistence (upsert on repeat generate), empty/invalid input rejection, note save + `NoteVersion` incrementing, `manual` vs `voice_session` source |
| `test_icd10.py` | Suggest/search/update-status routes, empty-assessment guard, replacing "suggested" rows while preserving accepted/rejected decisions, and a service-level guarantee that the LLM rerank step can never surface a code that wasn't actually retrieved from `icd10_codes` |
| `test_realtime.py` | Realtime + transcription session routes require existing note content, are scoped to the owning provider, and fail fast with a clear error *without* making any HTTP call when `OPENAI_API_KEY` is missing |
| `test_soap_service.py` | `parse_marked_soap` (messy markers, out-of-order headings, partial sections, duplicate headings, no headings) and the `stream_soap_note` chunk assembler (markers split across stream chunks, partial/out-of-order sections, no-markers fallback) against a fake OpenAI streaming client |
| `test_models.py` | `parse_dob` validation (invalid/impossible dates), the DB-level unique constraint on patient identity |

## Why Postgres (not SQLite) for tests

`icd10_service` queries `icd10_codes` using the `pg_trgm` extension's `%`
similarity operator and `similarity()` function directly in raw SQL. This
has no SQLite equivalent, so the suite runs against a real Postgres
database rather than an in-memory substitute — the same engine the app
uses in production. Tests create the `pg_trgm` extension automatically if
it isn't already present.

Everything else uses the app's real SQLAlchemy models via
`db.create_all()`; between tests every table is truncated (not
dropped/recreated) to keep the suite fast while guaranteeing a clean slate
per test. See the module docstring in `conftest.py` for how test isolation
works with Flask-SQLAlchemy's app-context-scoped sessions.

## Running the tests

### 1. One-time setup: a test Postgres database

If you already run the project's `docker-compose.yml` Postgres locally,
you can reuse that server and just create a second database for tests:

```bash
docker compose up -d db
psql "postgresql://kyron:kyron@localhost:5432/postgres" -c "CREATE DATABASE kyron_test;"
```

Or, without Docker, using a local Postgres install:

```bash
sudo -u postgres psql -c "CREATE USER kyron WITH PASSWORD 'kyron' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE kyron_test OWNER kyron;"
```

(`pg_trgm` does not need to be created manually — the test suite creates
the extension itself on first run.)

### 2. Install dependencies

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Run

```bash
cd backend
export TEST_DATABASE_URL="postgresql+psycopg://kyron:kyron@localhost:5432/kyron_test"
pytest
```

If `TEST_DATABASE_URL` is not set, tests default to
`postgresql+psycopg://kyron:kyron@localhost:5432/kyron_test` (matching the
credentials in the repo's `docker-compose.yml`).

`JWT_SECRET` and `OPENAI_API_KEY` are given safe dummy values by
`conftest.py` automatically if not already set in the environment — no
real API key is ever required to run the suite, and no test makes a
network call.

Useful flags:

```bash
pytest -k icd10        # just the ICD-10 tests
pytest -k soap_service  # just the parser/streaming-assembler unit tests
pytest -v               # verbose test names
```

## Notes / deliberate scope limits

- No tests exercise the actual OpenAI/Realtime network calls — that's by
  design per the task brief. `soap_service._client`, `icd10_service._client`,
  and `realtime_service.requests.post` are the mocked boundaries.
- The SOAP green-diff UI and any broader frontend UI work are explicitly
  out of scope for this suite.
