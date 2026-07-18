# Encounter workspace: UI flow

This documents the provider-facing flow implemented on this branch, the
alternatives that were considered and rejected, and why the approach is
technically feasible on top of the existing Realtime/streaming
architecture (no backend rewrite required — every change below is
frontend-only, built on the API surface that already exists).

Screenshots referenced below live in [`docs/screenshots/`](./screenshots).
`before-*.png` is the state of `main` @ `7916a9f`; `after-*.png` is this
branch, captured against a real local Postgres + Flask backend (not a
mockup) seeded with a representative patient/encounter.

## The problem with the starting point

`before-03-workspace-review.png` shows the original workspace: a two-column
layout where the transcript, the SOAP note, ICD suggestions, an ICD search
box, and version history are all visible, unstyled-by-priority, at once.
There's no indication of:

- **Where you are** — is this encounter drafted, generated, or saved?
- **What the system is doing right now** — generating, listening,
  connected to a voice session, or just idle?
- **What to do next** — "Generate", "Start voice session", and "Save
  note" all compete for attention with equal visual weight, regardless of
  encounter state.

## The chosen flow

### 1. A four-stage mental model: Capture → Generate → Review & refine → Save

`EncounterWorkspacePage` now derives a `currentStageId` from state that
already exists (`streaming`, `hasNote`, `dirty`) — no new state machine,
no backend field. This powers a horizontal stage tracker rendered once at
the top of the page (`after-03-workspace-review.png`, `after-02-workspace-capture.png`):

- **Capture** is done once there's transcript/observation text.
- **Generate** is done once a note exists.
- **Review & refine** is done once at least one version has been saved.
- **Save** is done once there's a saved version *and* no unsaved edits.

Only one stage is ever "current." Completed stages get a checkmark; the
connecting line between completed stages turns teal, giving a lightweight
progress bar without a rigid, step-gated wizard (which was rejected — see
below).

### 2. A persistent, sticky patient/status header

`workspace-header` is `position: sticky` and always shows, regardless of
scroll position: patient name, DOB + computed age, an encounter status
chip (`Not started` / `In progress` / `Saved`, driven by the existing
`encounter.status` field), and the signed-in provider. This directly
answers "who is this patient" without the provider needing to scroll back
up mid-review.

### 3. A single, real-time system status strip

Underneath the patient identity, one line always reflects exactly one of:
`idle`, `listening` (dictation), `voice session live`, `generating`,
`saving`, `unsaved changes`, or `all changes saved` — each with a distinct
tone (color + icon dot, pulsing while live). This is a pure derivation
(`useMemo`) over state already produced by `useSoapStream`, `useDictation`,
and `useRealtimeVoice` — those hooks were not touched. Priority is
error > voice > dictation > streaming > saving > dirty > saved > idle, so
the strip never shows two contradictory things at once.

A new `dirty` flag (note contents vs. last-persisted snapshot, compared by
value) is what makes "unsaved changes" possible without adding any new
mutation path — every existing way of changing the note (typing, streaming
generation, voice edit, "+ Add to Assessment") funnels into the same
`note` state and is automatically covered.

### 4. One primary action per stage

- **Capture stage**: the only button that reads as "primary" (solid teal,
  full width) is `Generate SOAP note`. Dictation controls are secondary.
- **Review stage**: `Save note` is the sole primary action in the note
  panel's heading. It is disabled — and visibly relabeled `Saved` — when
  there is nothing new to save, so the provider is never left wondering if
  a click did anything (`after-03-workspace-review.png`).
- Once a note exists, the capture-panel button is relabeled
  `Regenerate SOAP note` and demoted to a secondary/plain look, because at
  that point regenerating is a deliberate, slightly destructive action, not
  the primary next step.
- **Voice refine** is pulled out of the note panel's header (where it
  used to compete with Save) into its own clearly-labeled, optional row
  ("Voice refine — Optional — speak changes and they apply to the note
  live") directly above the note body.

### 5. Information hierarchy: note first, everything else disclosed

The per-assessment ICD-10 suggestion list stays inline (it's tightly
coupled to reviewing the Assessment section and needs Accept/Reject right
there). The free-text ICD-10 **search** tool and **version history** —
both power-tools used less often — are now `<details>` disclosures,
collapsed by default, with a count badge on version history
(`after-07-workspace-disclosures.png` shows them expanded). This alone
removes a large amount of always-on visual weight from the note without
deleting any functionality.

### 6. Designed to fit a pending-confirmation voice-edit model

A separate workstream is adding green-diff + confirm-before-apply for
voice edits. `useRealtimeVoice` today applies edits immediately (that
behavior was intentionally **not** changed here — re-implementing a
different immediate-apply UX would conflict with that work landing later).
Instead, this branch adds the surrounding scaffolding that a
confirm/reject model will slot into directly:

- Every voice-applied `partial` note update is tracked in
  `recentlyChanged: Set<keyof SoapNote>`, which adds the CSS class
  `note-recently-changed` to the affected SOAP section for ~4s (a teal
  highlight + an "Updated" micro-badge — see `after-06-workspace-voice-edit.png`).
- An `ai-edit-banner` appears with the assistant's summary of what it
  changed, plus **Undo** (reverts to the pre-edit snapshot, which is
  captured before the edit is applied) and **Looks good** (dismiss).

This is a deliberately small, real, working stand-in for "AI proposed
changes, confirm or reject" — implemented as post-hoc undo rather than
pre-apply confirmation, because the apply path itself belongs to the other
workstream. When that lands, the natural migration is:

1. Stop calling `setNote` immediately in `onNoteEdit`; store the proposed
   diff instead.
2. Reuse `ai-edit-banner` with Accept/Reject instead of Undo/Looks good.
3. Reuse `note-recently-changed` (or a `note-diff` variant) to render the
   actual green diff instead of a plain highlight, and make it persist
   until accepted/rejected instead of auto-fading.

No layout or component restructuring is required — the integration points
already exist at the right granularity (per-SOAP-section, with a
single banner slot in the note panel).

### 7. Small, additive improvements to Patients / New Encounter

- **Patients list** and **patient detail** now surface the existing (but
  previously unused) `last_status` / `status` field as the same status
  chip used in the workspace header, so a provider scanning their patient
  list can see who has an in-progress vs. saved encounter without opening
  it (`after-08-patients.png`, `after-09-patient-detail.png`). Zero backend
  changes — the field was already returned by the API.
- **New encounter** now states the four-stage flow up front ("What happens
  next"), so the mental model is introduced before the provider ever sees
  the workspace (`after-10-new-encounter.png`).

## Alternatives considered

- **Step-gated wizard** (must complete Capture before Generate is
  reachable, etc.): rejected. Real encounters are not linear — a provider
  may dictate more after generating, jump straight to editing a pasted
  note, or regenerate after refining the transcript. A wizard would fight
  the existing (correct) ability to move freely between the two panels.
  The stage tracker gives orientation without gating anything.
- **Tabs for Transcript / Note / ICD-10 / History**: rejected. Providers
  actively cross-reference the transcript while reviewing the generated
  note (e.g., verifying a detail made it into the Assessment), so hiding
  the transcript behind a tab during review adds clicks to the most
  common review action. The two-column layout was kept; only the
  lower-priority ICD search and version history were tucked into
  disclosures.
- **Modal confirmation for every AI action** (ICD suggestion, generation,
  voice edit): rejected as too heavy for a real-time voice conversation —
  a modal per utterance would make voice editing unusable. The
  status-strip + inline highlight + banner pattern was chosen specifically
  because it doesn't block the Realtime audio loop.
- **Chat-style / "AI assistant" dashboard aesthetic** (bubble avatars,
  purple gradients, floating panels): rejected per the product brief —
  this is a clinical tool, not a marketing surface. All new UI (status
  dots, chips, disclosures, banners) reuses the existing teal/slate
  palette and card language already in `App.css`.

## Why this is feasible for a Realtime + streaming architecture

Nothing here required a new backend endpoint, a new socket, or a new
protocol:

- The status strip is a pure function of state three hooks
  (`useSoapStream`, `useDictation`, `useRealtimeVoice`) already exposed
  before this change — it required zero changes to those hooks.
- "Dirty" tracking is a plain value comparison against a ref snapshot,
  updated on load and on successful save — it works identically whether
  the note arrived via typed edits, a full SSE stream, or a Realtime
  function-call — because all three paths already funnel through the same
  `setNote` call.
- The voice-edit highlight/banner subscribes to the exact same
  `onNoteEdit(partial, summary)` callback the Realtime tool-call handler
  already invokes; it does not add a new event type or change the
  WebRTC/data-channel logic in `useRealtimeVoice.ts` at all.
- Everything is CSS/JSX-level, so it composes with (rather than blocks)
  whatever pending-confirmation model lands for voice edits next.

## How this was verified

- `npx tsc --noEmit` and `npm run lint` (oxlint) pass with the same
  pre-existing warning set as `main` (no new warnings introduced).
- A real backend was stood up locally (Postgres 16, Flask, migrations,
  seed users) and a demo patient/encounter with two saved versions and
  ICD-10 suggestions was created through the real API to produce the
  screenshots in `docs/screenshots/after/` — these are live renders of the
  actual app, not mockups.
- Desktop (1440px), narrow/mobile (420px), capture-stage (empty note),
  review-stage (saved note), and unsaved-changes states were all
  screenshotted.
