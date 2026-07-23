# Kyron Scribe — AI Clinical Documentation Platform

A provider-facing AI clinical scribe. A physician pastes an encounter transcript
(or types freeform observations); the system streams a structured **SOAP note**
back into an editable workspace, suggests **ICD-10** codes, and supports
**conversational voice editing** of the note. Everything persists to Postgres
with an append-only version history.

**Live:** https://kyron-scribe.duckdns.org (HTTPS, valid Let's Encrypt cert)

- **Frontend:** Vite + React + TypeScript
- **Backend:** Flask + SQLAlchemy + JWT
- **Database:** PostgreSQL 16 (AWS RDS in prod), `pg_trgm` for ICD-10 search
- **LLM:** OpenAI Chat Completions (streaming SOAP + ICD rerank) and OpenAI
  Realtime over WebRTC (voice editing / dictation)
- **Infra:** AWS EC2 behind nginx (TLS) → gunicorn (Docker) → RDS in a private
  subnet, secrets in SSM Parameter Store

Architecture, ERD, and request traces: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

---

## Demo accounts

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@kyron.local` | `admin123` |
| Provider | `provider1@kyron.local` | `provider123` |
| Provider | `provider2@kyron.local` | `provider123` |
| Provider | `provider3@kyron.local` | `provider123` |

---

## Features (mapped to the brief)

| Requirement | Where |
|---|---|
| **Streaming SOAP generation** — renders progressively via SSE, not a spinner-then-dump | `soap_service.py` `stream_soap_note`, `useSoapStream.ts` |
| **Conversational voice editing** — propose→confirm, never silent; word-level green diffs; confirm/reject by button or voice | `useRealtimeVoice.ts`, `useSoapProposal.ts`, `SoapSectionDiff.tsx` |
| **Live voice dictation** — streaming speech-to-text, SOAP re-generates as you speak | `useDictation.ts`, `/realtime/transcription-session` |
| **Auth + two roles** — JWT, provider/admin, deactivation enforced every request | `auth.py`, `routes/auth_routes.py` |
| **Encounter workspace** — start encounter, paste/type, generate, inline-edit, save | `EncounterWorkspacePage.tsx` |
| **Patient history + context injection** — prior saved notes retrieved server-side at generate time (not frontend-stuffed); behaves differently for returning vs new patients | `soap_service.py` `fetch_prior_notes` |
| **Note versioning + audit trail** — every save appends an immutable version (who/when/source) in RDS; full history viewable; **restore** creates a new version | `models.py` `NoteVersion`, `encounter_routes.py` |
| **ICD-10 search** — plain-English symptom → trigram similarity over an embedded code set, append to Assessment | `icd10_service.py`, migration `002` (`pg_trgm` GIN index) |
| **Admin dashboard** — all encounters filterable by provider/date, provider CRUD + deactivate, template CRUD | `AdminDashboardPage.tsx`, `routes/admin_routes.py` |
| **Note templates** — structured prompts per encounter type; admin edits take effect on the provider's next generation **with no refresh** | `note_templates`, template re-read at generate time |
| **Session persistence** — mid-encounter draft restored from RDS across refresh/device | `encounter_routes.py` `/draft`, `last_draft_at` |
| **Non-happy paths** — (1) non-clinical input refused gracefully, no hallucinated visit; (2) provider deactivated mid-draft → banner, draft preserved | `soap_service.py` `REFUSAL_NOTE`, `auth.py` deactivation guard |

Pioneer feature: **version restore** and the **voice green-diff confirm** flow.

---

## Quick start (local)

### 1. Postgres

```bash
docker compose up -d
```

### 2. Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # then set OPENAI_API_KEY
```

`backend/.env`:

```
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql+psycopg://kyron:kyron@localhost:5432/kyron
JWT_SECRET=change-me-to-a-long-random-string-32b+
PORT=5001
```

Migrate + seed (users, templates, **and ~300 embedded ICD-10 codes**), then run:

```bash
export FLASK_APP=app
flask db upgrade
python seed.py            # embeds backend/data/icd10_seed.csv so ICD search works out of the box
python app.py
```

API health: http://localhost:5001/api/health

> The seed embeds a curated ICD-10 subset so a fresh clone has working code
> search immediately. For the **full** CMS code list, run
> `python scripts/import_icd10.py <path-to-cms-zip>` instead — both use the same
> idempotence guard (skip if `icd10_codes` already has rows), so neither can
> clobber a database that already holds the complete set.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev            # http://localhost:5173
```

Frontend defaults to `http://localhost:5001`; override with `VITE_API_BASE_URL`.
Voice/dictation requires a mic and an HTTPS (or `localhost`) origin.

---

## Provider workflow

1. Sign in as a provider, start an encounter (patient first/last name + DOB).
2. Paste a transcript or type observations, pick a template, **Generate** —
   SOAP streams into editable S/O/A/P fields.
3. Search ICD-10 by symptom and append codes to the Assessment.
4. Optionally **Start voice session** and speak edits ("move the knee pain into
   Subjective", "shorten the plan"). Each proposal shows as a per-section
   word-level diff; confirm/reject by button or by voice.
5. **Save** to persist the confirmed draft and append a version-history entry;
   open any prior version and **Restore** it.

For a returning patient (same name + DOB), generation automatically references
prior saved notes — retrieved server-side, shown by a "Returning patient" badge.

A full evaluator script is in [`docs/DEMO_WALKTHROUGH.md`](docs/DEMO_WALKTHROUGH.md).

---

## API overview

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | JWT login |
| GET | `/api/auth/me` | Current user |
| GET | `/api/patients` · `/api/patients/:id` | Provider's patients |
| POST | `/api/encounters` | Create encounter (find-or-create patient) |
| GET | `/api/encounters/:id` | Encounter + note + versions + returning-patient context |
| PATCH | `/api/encounters/:id/draft` | Autosave in-progress draft |
| POST | `/api/encounters/:id/generate` | **SSE** streaming SOAP generation |
| PUT | `/api/encounters/:id/note` | Save note + append version |
| GET | `/api/encounters/:id/versions` | Version history |
| POST | `/api/encounters/:id/versions/:vid/restore` | Restore a version (as a new version) |
| POST | `/api/encounters/:id/realtime/session` | Mint Realtime client secret (voice edit) |
| POST | `/api/encounters/:id/realtime/transcription-session` | Mint Realtime client secret (dictation) |
| POST | `/api/encounters/:id/icd10/suggest` | ICD-10 suggestions for a note |
| GET | `/api/icd10/search?q=` | Plain-English ICD-10 search |
| GET | `/api/templates` | Active templates (provider) |
| GET | `/api/admin/encounters` | All encounters, filterable (admin) |
| GET/POST/PATCH | `/api/admin/providers` | Provider roster + activate/deactivate |
| GET/POST/PATCH/DELETE | `/api/admin/templates` | Template CRUD |

`/generate` SSE events: `context`, `section_start`, `section_delta`,
`section_end`, `done`, `error`.

---

## Testing

### Backend (pytest) — covers doctor-relevant edge cases, mocks every LLM boundary

```bash
cd backend && source .venv/bin/activate
export TEST_DATABASE_URL="postgresql+psycopg://kyron:kyron@localhost:5432/kyron_test"
pytest
```

Covers auth/tenancy + JWT edge cases, patient identity/DOB, encounter
generate/save/versioning + SSE event shapes, ICD-10 suggest/search (incl. the
guarantee that the LLM rerank can never surface a code not actually retrieved
from the DB), Realtime session guards, and the SOAP marker/streaming assembler
against split chunks. See [`backend/tests/README.md`](backend/tests/README.md)
and one-time test-DB setup. A concurrent load harness lives at
`backend/scripts/stress_test.py`.

### Frontend (Vitest)

```bash
cd frontend && npm install && npm test
```

---

## Deployment

Deployed on AWS EC2 (nginx TLS reverse proxy → dockerized gunicorn on
`127.0.0.1:5001`) with Postgres on a **private, non-public** RDS instance and all
secrets in SSM Parameter Store. Full resource inventory and redeploy steps:
[`deploy/DEPLOYMENT.md`](deploy/DEPLOYMENT.md).

---

## Trade-offs / what I'd do next

- **Prior-history retrieval** is a server-side function call, not an OpenAI
  tool the model chooses to invoke — deterministic and cheap, but tool-calling is
  the upgrade if we want the model to decide when history is relevant.
- **ICD-10 search is `pg_trgm`**, not embeddings — fast and dependency-free;
  pgvector/embeddings would improve recall on paraphrased symptoms.
- **Deploys are `rsync` + a shell script**, not CI/CD — a GitHub Actions
  pipeline, plus CloudWatch alarms, is the next step.

No credentials, keys, or `.env` files are committed; `backend/.env` and build
artifacts are gitignored.
