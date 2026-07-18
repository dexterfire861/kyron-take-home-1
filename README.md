# SOAP Note Generator

React + Flask clinical workspace that turns encounter transcripts or freeform observations into structured SOAP notes, streams generation into an editable note, and supports interruptible OpenAI Realtime voice editing. Notes are persisted in Postgres with version history.

## Stack

- **Frontend:** Vite + React + TypeScript
- **Backend:** Flask + SQLAlchemy + JWT auth
- **Database:** Postgres 16 (Docker Compose)
- **LLM:** OpenAI Chat Completions (streaming SOAP) + OpenAI Realtime (WebRTC voice)

## Prerequisites

- Docker / Docker Compose
- Python 3.11+
- Node.js 18+
- An [OpenAI API key](https://platform.openai.com/api-keys) with access to Chat Completions and Realtime

## Quick start

### 1. Postgres

```bash
docker compose up -d
```

### 2. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `backend/.env`:

```
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql+psycopg://kyron:kyron@localhost:5432/kyron
JWT_SECRET=change-me-to-a-long-random-string-32b+
PORT=5001
```

Apply migrations and seed demo users:

```bash
export FLASK_APP=app
flask db upgrade
python seed.py
python app.py
```

API: [http://localhost:5001/api/health](http://localhost:5001/api/health)

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

UI: [http://localhost:5173](http://localhost:5173)

## Demo users

| Role     | Email                   | Password     |
|----------|-------------------------|--------------|
| Provider | `provider1@kyron.local` | `provider123` |
| Provider | `provider2@kyron.local` | `provider123` |
| Admin    | `admin@kyron.local`     | `admin123`    |

Admin UI is not built yet; the admin role is stored for a later dashboard.

## Provider workflow

1. Sign in as a provider.
2. Start a new encounter with patient first name, last name, and DOB.
3. Paste a transcript or type observations, then **Generate SOAP note** (streams into editable S/O/A/P fields).
4. Optionally **Start voice session** for full-duplex Realtime editing (browser mic + speaker). Voice/AI edits
   are never applied silently: each proposed change is shown per-section as a word-level diff (green
   additions, struck-through red deletions) with **Confirm**/**Reject** actions. You can keep talking while a
   proposal is pending — further clarifications re-diff the same proposal against the last confirmed text —
   and confirm/reject either by clicking the buttons or by saying so out loud (e.g. "confirm that" / "undo
   that").
5. **Save note** to persist the current (confirmed) draft and append a version history entry.

## API overview

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | JWT login |
| GET | `/api/auth/me` | Current user |
| POST | `/api/encounters` | Create encounter (find-or-create patient) |
| GET | `/api/encounters/:id` | Encounter + note + versions |
| POST | `/api/encounters/:id/generate` | SSE streaming SOAP generation |
| PUT | `/api/encounters/:id/note` | Save note + create version |
| GET | `/api/encounters/:id/versions` | Version history |
| POST | `/api/encounters/:id/realtime/session` | Mint OpenAI Realtime ephemeral client secret |

### Generate (SSE)

`POST /api/encounters/:id/generate`

```json
{ "text": "...", "input_type": "transcript" }
```

Events: `section_start`, `section_delta`, `section_end`, `done`, `error`.

### Save note

```json
{
  "subjective": "...",
  "objective": "...",
  "assessment": "...",
  "plan": "...",
  "source": "manual"
}
```

`source` may be `manual` or `voice_session`.

## Notes

- Frontend defaults to `http://localhost:5001`. Override with `VITE_API_BASE_URL`.
- Never commit `backend/.env`.
- Voice editing uses an ephemeral Realtime client secret; the server API key never ships to the browser.
- Mic permission is required for voice sessions.

## Testing

### Backend (pytest)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export TEST_DATABASE_URL="postgresql+psycopg://kyron:kyron@localhost:5432/kyron_test"  # a Postgres test DB, separate from dev
pytest
```

Covers auth/tenancy, patient identity + DOB validation, encounter
generate/save/versioning, ICD-10 suggest/search, Realtime session guards,
and the SOAP marker parser/streaming assembler — all without calling
OpenAI (every LLM/Realtime boundary is mocked). See
[`backend/tests/README.md`](backend/tests/README.md) for full details and
one-time test-database setup.

### Frontend (Vitest)

```bash
cd frontend
npm install
npm test
```

Currently covers the pure SSE chunk parser used by the streaming
`/generate` client (`src/lib/sse.ts`).
