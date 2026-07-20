# Demo walkthrough

Short script for evaluating Kyron Scribe against the brief. Seed accounts:

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@kyron.local` | `admin123` |
| Provider 1 | `provider1@kyron.local` | `provider123` |
| Provider 2 | `provider2@kyron.local` | `provider123` |
| Provider 3 | `provider3@kyron.local` | `provider123` |

Local: API `http://localhost:5001`, UI `http://localhost:5173`.  
Production: `https://kyron-scribe.duckdns.org` (after deploy).

---

## 1. New patient vs returning patient

1. Sign in as **provider1**. Create a new encounter (template: New Patient Eval).
2. Paste a short clinical transcript, **Generate**, review SOAP, **Save**.
3. From patient history, open a **new encounter** for the **same patient**.
4. Confirm the workspace badge shows **Returning patient — 1 prior note** (not “New patient”).
5. Generate again — Assessment/Plan should reference prior care when relevant (server-injected history; not pasted by the client).

## 2. Live template edit (no provider refresh)

1. Keep the provider workspace open on an encounter with a selected template.
2. In another browser/profile, sign in as **admin** → **Templates**.
3. Edit that template’s `system_prompt_addon` (e.g. add “Always mention gait assessment.”) and save.
4. Back on the provider tab (no reload), click **Generate** again.
5. Confirm the new note reflects the updated guidance — generation loads the template from the DB at request time.

## 3. Draft persistence + JWT expiry flush

1. As a provider, type into clinical input / edit SOAP without saving formally.
2. Confirm “Saving draft…” appears (debounced autosave to `PATCH …/draft`).
3. Optionally clear the JWT (or wait for expiry): on 401 the UI keeps a `sessionStorage` draft and prompts re-login.
4. Sign in again and reopen the encounter — draft text/SOAP should restore.

## 4. Admin deactivates provider mid-draft

1. Provider has an open draft (autosaved).
2. Admin → **Providers** → deactivate that provider.
3. Provider’s next API call shows an **account deactivated** banner; draft remains in RDS.
4. Admin reactivates; provider signs in again and opens the same encounter — draft is intact.

## 5. Non-clinical refusal

1. In an encounter, enter `asdf` (or similar gibberish) and **Generate**.
2. SOAP should refuse gracefully (Assessment explains insufficient clinical content) — no invented visit.

## 6. Pioneer: voice green-diff confirm

1. Generate a real clinical note.
2. Start voice session; say e.g. “Change the plan to start physical therapy twice a week.”
3. Confirm staged **green diffs** appear; **Confirm** applies, **Reject** discards.
4. Save — version history shows a `voice` source.

## 7. Admin dashboard

1. As admin: filter **Encounters** by provider/date.
2. Create a provider; toggle active.
3. CRUD templates used by providers on New Encounter / workspace.
