# Encounter workspace: UI design rationale

Why the provider workspace is laid out the way it is. This is a clinical tool,
not a consumer app — the design goal is a dense, high-trust surface where a
provider always knows where they are, what the system is doing, and what to do
next. Screenshots in [`docs/screenshots/`](./screenshots) are live renders
against a real Postgres + Flask backend, not mockups.

## A four-stage mental model: Capture → Generate → Review & refine → Save

`EncounterWorkspacePage` derives a `currentStageId` from state that already
exists (`streaming`, `hasNote`, `dirty`) — no separate state machine, no backend
field. A horizontal stage tracker at the top of the page reflects it:

- **Capture** — done once there's transcript/observation text.
- **Generate** — done once a note exists.
- **Review & refine** — done once at least one version has been saved.
- **Save** — done once there's a saved version *and* no unsaved edits.

Only one stage is ever "current"; completed stages get a checkmark and the
connecting line turns teal. It's orientation, **not** a step-gated wizard —
providers can move freely between panels (dictate more after generating, edit a
pasted note directly, regenerate after refining the transcript).

## A sticky patient/status header

`workspace-header` is `position: sticky` and always shows patient name, DOB +
computed age, an encounter status chip (`Not started` / `In progress` / `Saved`,
driven by `encounter.status`), and the signed-in provider — so "who is this
patient" is answered without scrolling back up mid-review.

## One real-time system-status strip

A single line always reflects exactly one of: `idle`, `listening` (dictation),
`voice session live`, `generating`, `saving`, `unsaved changes`, or `all changes
saved` — each with a distinct tone (color + icon dot, pulsing while live). It's a
pure `useMemo` derivation over state produced by `useSoapStream`, `useDictation`,
and `useRealtimeVoice`. Priority is error > voice > dictation > streaming >
saving > dirty > saved > idle, so it never shows two contradictory things.

A `dirty` flag (note contents vs. last-persisted snapshot, compared by value)
powers "unsaved changes" without a new mutation path — every way of changing the
note (typing, streaming generation, confirmed voice edit, "+ Add to Assessment")
funnels into the same `note` state and is automatically covered.

## One primary action per stage

- **Capture:** the only primary-styled button (solid teal, full width) is
  `Generate SOAP note`; dictation controls are secondary.
- **Review:** `Save note` is the sole primary action in the note panel heading.
  It's disabled — and relabeled `Saved` — when there's nothing new to save, so a
  click never feels like a no-op.
- Once a note exists, the capture button becomes `Regenerate SOAP note` and is
  demoted to a plain look, since regenerating is then a deliberate, slightly
  destructive action rather than the primary next step.
- **Voice refine** sits in its own clearly-labeled optional row above the note
  body, rather than competing with Save in the panel header.

## Information hierarchy: note first, power-tools disclosed

The per-Assessment ICD-10 suggestion list stays inline (Accept/Reject belongs
right next to the Assessment). The free-text ICD-10 **search** and **version
history** — used less often — are `<details>` disclosures collapsed by default,
with a count badge on version history. This removes always-on visual weight from
the note without hiding any functionality.

## Voice edits are proposed, not applied silently

Voice/AI edits never mutate the note without provider consent. The Realtime model
calls an `apply_soap_edits` tool that **stages** a proposal; `useSoapProposal`
holds it as a diff against the committed note and `SoapSectionDiff` renders
word-level green additions / struck-through red deletions per section. The
provider confirms or rejects each section — by clicking, or by saying so out loud
(a `confirm_pending_edits` tool). Re-issuing a voice edit before confirming
re-diffs against the original committed text, so successive refinements always
show the true net change. Confirmed edits flow into the same `note` state as
every other edit; saving records the version with `source = 'voice_session'`.

This was a deliberate choice over immediate-apply-with-undo: in a real-time voice
conversation, a modal per utterance would make voice editing unusable, and silent
application is unacceptable for a clinical note. Staging + inline diff + verbal
confirm keeps the audio loop unblocked while keeping the provider in control.

## Patients / New Encounter

- The **patients list** and **patient detail** surface each patient's
  `last_status` / `status` as the same chip used in the workspace header, so a
  provider scanning the list sees who has an in-progress vs. saved encounter
  without opening it.
- **New encounter** states the four-stage flow up front ("What happens next"),
  introducing the mental model before the provider reaches the workspace.

## Alternatives considered and rejected

- **Step-gated wizard** — real encounters aren't linear; a wizard would fight
  the (correct) ability to move freely between panels. The stage tracker
  orients without gating.
- **Tabs for Transcript / Note / ICD-10 / History** — providers cross-reference
  the transcript while reviewing the note (e.g. verifying a detail landed in the
  Assessment), so hiding it behind a tab adds clicks to the most common review
  action. The two-column layout stays; only lower-priority tools are disclosed.
- **A modal confirmation for every AI action** — too heavy for a real-time voice
  loop. The status-strip + inline diff pattern doesn't block the audio.
- **A chat-style "AI assistant" aesthetic** (bubble avatars, gradients) —
  rejected per the brief; this is a clinical surface. All UI reuses the existing
  teal/slate palette and card language in `App.css`.
