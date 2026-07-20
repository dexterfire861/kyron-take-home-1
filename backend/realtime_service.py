from __future__ import annotations

import os

import requests

REALTIME_MODEL = "gpt-realtime"
CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"

APPLY_SOAP_EDITS_TOOL = {
    "type": "function",
    "name": "apply_soap_edits",
    "description": (
        "Propose edits to the current SOAP note. Include only sections that change. "
        "For each included section, provide the full updated section text. "
        "Preserve all prior content unless the clinician asked to change or remove it. "
        "This does NOT save the note — it stages a proposal that the clinician sees as a "
        "highlighted diff and must explicitly confirm (via confirm_pending_edits or the on-screen "
        "Confirm button) before it becomes part of the official note. Calling this again before "
        "confirmation replaces the previous proposal for that section with a fresh one, still "
        "diffed against the last confirmed text."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "subjective": {
                "type": "string",
                "description": "Full updated Subjective section, if changed",
            },
            "objective": {
                "type": "string",
                "description": "Full updated Objective section, if changed",
            },
            "assessment": {
                "type": "string",
                "description": "Full updated Assessment section, if changed",
            },
            "plan": {
                "type": "string",
                "description": "Full updated Plan section, if changed",
            },
            "assistant_summary": {
                "type": "string",
                "description": "Brief conversational acknowledgment describing the proposed edit",
            },
        },
        "additionalProperties": False,
    },
}

CONFIRM_PENDING_EDITS_TOOL = {
    "type": "function",
    "name": "confirm_pending_edits",
    "description": (
        "Confirm and apply the currently pending SOAP edits proposed via apply_soap_edits, "
        "merging them into the official note. Call this ONLY when the provider explicitly "
        "accepts the pending changes (e.g. says 'confirm', 'yes, apply that', 'looks good', "
        "'accept it'). If nothing is pending, calling this has no effect."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}

REJECT_PENDING_EDITS_TOOL = {
    "type": "function",
    "name": "reject_pending_edits",
    "description": (
        "Discard the currently pending SOAP edits proposed via apply_soap_edits, leaving the "
        "official note unchanged. Call this ONLY when the provider explicitly rejects or cancels "
        "the pending changes (e.g. says 'reject that', 'no, discard it', 'undo', 'never mind'). "
        "If nothing is pending, calling this has no effect."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}


def build_voice_instructions(note: dict[str, str], patient_label: str) -> str:
    return f"""You are a clinical documentation voice assistant helping a provider edit a SOAP note in real time.

Patient: {patient_label}

Current SOAP note (last confirmed version):
SUBJECTIVE:
{note.get('subjective') or '(empty)'}

OBJECTIVE:
{note.get('objective') or '(empty)'}

ASSESSMENT:
{note.get('assessment') or '(empty)'}

PLAN:
{note.get('plan') or '(empty)'}

Behavior:
- Respond conversationally and briefly.
- Treat ANY new clinical detail the provider states out loud as content to capture in the note immediately —
  not just explicit editing commands. If they mention a symptom, exam finding, diagnosis, medication, or
  plan item ("there's a broken leg", "no fever", "started him on ibuprofen"), call apply_soap_edits right
  away and place it in the most clinically appropriate section (e.g. a stated finding usually belongs in
  Objective or Assessment; a patient-reported symptom in Subjective; a treatment in Plan). Do not wait for
  the provider to say "add" or "change" — a stated fact is itself the instruction to document it.
- For explicit instructions ("move the knee pain into Subjective," "shorten the plan," "change the
  assessment to include osteoarthritis"), call apply_soap_edits with the requested change.
- For each call, include the full updated text of every section that changed, preserving all prior content
  in that section unless the provider asked to remove or replace it.
- Do not invent clinical findings beyond what the provider stated.
- Only ask a clarifying question when it is genuinely unclear what should change (e.g. which of two active
  problems "it" refers to) — never merely because the provider phrased something as a statement rather
  than a command.

IMPORTANT — proposals, not immediate edits:
- apply_soap_edits does NOT save anything. It stages a proposed edit that the provider sees on screen as a
  highlighted diff (green additions, struck-through red deletions) against the current note. Nothing is
  saved until the provider explicitly confirms.
- If the provider gives further clarifications or corrections before confirming, call apply_soap_edits again
  with the full updated text reflecting ALL desired changes so far (not just the latest delta) — this
  replaces the previous proposal for that section with a fresh diff, still measured against the last
  confirmed text, not the previous proposal.
- Call confirm_pending_edits when the provider explicitly confirms/accepts the pending proposal (they may
  also use the on-screen Confirm button instead — that's fine, you don't need to do anything in that case).
- Call reject_pending_edits when the provider explicitly rejects/cancels the pending proposal.
- Never assume a proposal was confirmed just because the provider didn't object — wait for an explicit
  confirmation. In the meantime, keep listening and keep documenting further stated facts as staged
  proposals.
- You have no voice output — your replies are text only, shown on screen, never spoken. Keep
  assistant_summary and any text reply short, since it's read, not heard.
- The provider may keep talking at any time — stay ready to accept new instructions.
"""


def create_realtime_client_secret(
    note: dict[str, str],
    patient_label: str,
    safety_identifier: str,
) -> dict:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    session_config = {
        "session": {
            "type": "realtime",
            "model": REALTIME_MODEL,
            "instructions": build_voice_instructions(note, patient_label),
            "tools": [
                APPLY_SOAP_EDITS_TOOL,
                CONFIRM_PENDING_EDITS_TOOL,
                REJECT_PENDING_EDITS_TOOL,
            ],
            "tool_choice": "auto",
            # Text-only replies: no TTS synthesis, nothing plays over the
            # provider's speakers. This is both the requested behavior (the
            # assistant shouldn't talk back) and a fix for a real bug it
            # caused — without headphones, the assistant's own spoken replies
            # were being picked up by the mic and re-interpreted by
            # server_vad as a new user turn, occasionally triggering a
            # spurious reject_pending_edits on its own voice.
            "output_modalities": ["text"],
            "audio": {
                "input": {
                    "turn_detection": {
                        "type": "server_vad",
                        # Higher than the 0.5 default so quieter ambient
                        # background noise doesn't get treated as speech.
                        "threshold": 0.65,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500,
                    },
                    "transcription": {"model": "gpt-4o-mini-transcribe"},
                },
            },
        }
    }

    response = requests.post(
        CLIENT_SECRETS_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": safety_identifier,
        },
        json=session_config,
        timeout=30,
    )
    if not response.ok:
        detail = response.text[:500]
        raise RuntimeError(f"Failed to create Realtime client secret: {detail}")
    return response.json()


def create_transcription_client_secret(safety_identifier: str) -> dict:
    """Mint a client secret for a transcription-only Realtime session, used
    for hands-free dictation. This is a dedicated session type (no
    conversational model, no tools, no spoken responses) — cheaper and
    lower-latency than the full conversational session used for voice
    editing, since dictation only needs streaming speech-to-text."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    session_config = {
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "transcription": {"model": "gpt-4o-mini-transcribe"},
                    "turn_detection": {"type": "server_vad"},
                },
            },
        }
    }

    response = requests.post(
        CLIENT_SECRETS_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": safety_identifier,
        },
        json=session_config,
        timeout=30,
    )
    if not response.ok:
        detail = response.text[:500]
        raise RuntimeError(f"Failed to create transcription client secret: {detail}")
    return response.json()
