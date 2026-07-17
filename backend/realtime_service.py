from __future__ import annotations

import os

import requests

REALTIME_MODEL = "gpt-realtime"
CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"

APPLY_SOAP_EDITS_TOOL = {
    "type": "function",
    "name": "apply_soap_edits",
    "description": (
        "Apply edits to the current SOAP note. Include only sections that change. "
        "For each included section, provide the full updated section text. "
        "Preserve all prior content unless the clinician asked to change or remove it."
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
                "description": "Brief conversational acknowledgment of the edit",
            },
        },
        "additionalProperties": False,
    },
}


def build_voice_instructions(note: dict[str, str], patient_label: str) -> str:
    return f"""You are a clinical documentation voice assistant helping a provider edit a SOAP note in real time.

Patient: {patient_label}

Current SOAP note:
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
- After calling apply_soap_edits, briefly confirm out loud what you changed.
- The provider may interrupt you; stop and listen when they speak.
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
            "tools": [APPLY_SOAP_EDITS_TOOL],
            "tool_choice": "auto",
            "audio": {
                "input": {
                    "turn_detection": {"type": "server_vad"},
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
