from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator

from openai import OpenAI

from models import Encounter, Note

SECTION_KEYS = ("subjective", "objective", "assessment", "plan")
SECTION_MARKERS = {
    "SUBJECTIVE": "subjective",
    "OBJECTIVE": "objective",
    "ASSESSMENT": "assessment",
    "PLAN": "plan",
}

SYSTEM_PROMPT = """You are a clinical documentation assistant. Transform the clinician's input into a structured, professional SOAP note.

Return the note using exactly these markdown headings, in this order:

### SUBJECTIVE
...
### OBJECTIVE
...
### ASSESSMENT
...
### PLAN
...

Rules:
- Use clear, professional clinical language.
- Do not invent findings that are not supported by the input; if a section lacks data, state that briefly.
- Keep each section concise but complete enough for a clinical note.
- Do not include any text before ### SUBJECTIVE or after the Plan section.
- If prior patient history is provided, reference relevant prior diagnoses or treatments where clinically appropriate. Do not copy prior notes wholesale.
- If the input has no clinically meaningful content (gibberish, placeholders, or unrelated text), do NOT invent a visit. Put a brief explanation in Assessment that clinical content is insufficient, leave other sections stating that no clinical data was provided, and keep Plan empty or limited to "Obtain clinical history."
"""

JSON_SYSTEM_PROMPT = """You are a clinical documentation assistant. Transform the clinician's input into a structured, professional SOAP note.

Return ONLY a JSON object with exactly these keys:
- "subjective": patient-reported symptoms, history, and concerns
- "objective": measurable findings, vitals, exam results, or observed signs present in the input (or note what is not documented)
- "assessment": clinical impression / working diagnosis based on the input
- "plan": recommended next steps, treatments, follow-up, or orders

Rules:
- Use clear, professional clinical language.
- Do not invent findings that are not supported by the input; if a section lacks data, state that briefly.
- Keep each section concise but complete enough for a clinical note.
- If prior patient history is provided, reference relevant prior diagnoses or treatments where clinically appropriate.
- If the input has no clinically meaningful content, do not invent a visit; explain insufficient clinical content in assessment.
"""

CLINICAL_TOKEN_RE = re.compile(
    r"\b("
    r"pain|ache|fever|cough|nausea|vomit|dizziness|swelling|injury|knee|hip|back|"
    r"chest|shortness|breath|headache|diabetes|hypertension|fracture|infection|"
    r"patient|hx|history|exam|vitals|bp|hr|temp|plan|follow|therapy|x-?ray|mri|"
    r"medication|allergy|surgery|diagnos|symptom|visit|weeks?|days?|months?"
    r")\b",
    re.I,
)

REFUSAL_NOTE = {
    "subjective": "No clinically meaningful patient-reported information was provided.",
    "objective": "No objective findings were documented in the input.",
    "assessment": (
        "Insufficient clinical content to generate a SOAP note. "
        "The submitted text does not contain identifiable symptoms, exam findings, "
        "or clinical context. Please provide an encounter transcript or clinical observations."
    ),
    "plan": "Obtain a clinical history and relevant exam findings before documenting.",
}


def _client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return OpenAI(api_key=api_key)


def looks_nonclinical(text: str) -> bool:
    """Heuristic gate: short gibberish / no clinical tokens → refuse generation."""
    cleaned = (text or "").strip()
    if len(cleaned) < 12:
        return True
    letters = sum(ch.isalpha() for ch in cleaned)
    if letters < 8:
        return True
    if not CLINICAL_TOKEN_RE.search(cleaned):
        # Allow longer prose that still might be clinical without keywords,
        # but treat short keyword-free strings as nonclinical.
        if len(cleaned) < 80:
            return True
        # Very low word diversity (e.g. "asdf asdf asdf")
        words = re.findall(r"[A-Za-z]+", cleaned.lower())
        if len(words) >= 3 and len(set(words)) <= 2:
            return True
    return False


def fetch_prior_notes(patient_id: int, exclude_encounter_id: int | None = None) -> list[dict]:
    """Backend retrieval of prior *saved* notes for a patient (not frontend-stuffed)."""
    query = (
        Encounter.query.filter_by(patient_id=patient_id, status="saved")
        .order_by(Encounter.updated_at.desc())
    )
    if exclude_encounter_id is not None:
        query = query.filter(Encounter.id != exclude_encounter_id)

    history: list[dict] = []
    for enc in query.limit(5).all():
        note: Note | None = enc.note
        if note is None or not any(note.soap_dict().values()):
            continue
        history.append(
            {
                "encounter_id": enc.id,
                "saved_at": enc.updated_at.isoformat() if enc.updated_at else None,
                "note": note.soap_dict(),
            }
        )
    return history


def format_prior_history_block(history: list[dict]) -> str:
    if not history:
        return ""
    parts = ["PRIOR PATIENT ENCOUNTER HISTORY (retrieved server-side):"]
    for i, item in enumerate(history, start=1):
        note = item["note"]
        parts.append(
            f"\n--- Prior visit {i} (encounter {item['encounter_id']}, "
            f"saved {item.get('saved_at') or 'unknown'}) ---\n"
            f"Subjective: {note.get('subjective') or '(none)'}\n"
            f"Objective: {note.get('objective') or '(none)'}\n"
            f"Assessment: {note.get('assessment') or '(none)'}\n"
            f"Plan: {note.get('plan') or '(none)'}"
        )
    return "\n".join(parts)


def _build_system_prompt(template_addon: str | None = None) -> str:
    prompt = SYSTEM_PROMPT
    addon = (template_addon or "").strip()
    if addon:
        prompt = f"{prompt}\n\n{addon}"
    return prompt


def _user_prompt(
    text: str,
    input_type: str,
    prior_history_block: str = "",
) -> str:
    if input_type == "transcript":
        label = "Raw encounter transcript"
    else:
        label = "Freeform clinical observations"
    parts = [f"{label}:\n\n{text}"]
    if prior_history_block:
        parts.append(prior_history_block)
    return "\n\n".join(parts)


def generate_soap_note(
    text: str,
    input_type: str = "observations",
    *,
    template_addon: str | None = None,
    prior_history: list[dict] | None = None,
) -> dict[str, str]:
    if looks_nonclinical(text):
        return dict(REFUSAL_NOTE)

    history_block = format_prior_history_block(prior_history or [])
    system = JSON_SYSTEM_PROMPT
    addon = (template_addon or "").strip()
    if addon:
        system = f"{system}\n\n{addon}"

    response = _client().chat.completions.create(
        model="gpt-4o-mini",
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": _user_prompt(text, input_type, history_block),
            },
        ],
        temperature=0.2,
    )
    content = response.choices[0].message.content
    if not content:
        raise RuntimeError("OpenAI returned an empty response")
    data = json.loads(content)
    missing = [key for key in SECTION_KEYS if key not in data]
    if missing:
        raise RuntimeError(f"SOAP response missing keys: {', '.join(missing)}")
    return {key: str(data[key]).strip() for key in SECTION_KEYS}


def parse_marked_soap(text: str) -> dict[str, str]:
    pattern = re.compile(
        r"###\s*(SUBJECTIVE|OBJECTIVE|ASSESSMENT|PLAN)\s*\n(.*?)(?=###\s*(?:SUBJECTIVE|OBJECTIVE|ASSESSMENT|PLAN)\s*\n|\Z)",
        re.IGNORECASE | re.DOTALL,
    )
    result = {key: "" for key in SECTION_KEYS}
    for match in pattern.finditer(text):
        key = SECTION_MARKERS[match.group(1).upper()]
        result[key] = match.group(2).strip()
    return result


def _yield_refusal_stream() -> Iterator[dict]:
    for key in SECTION_KEYS:
        yield {"event": "section_start", "data": {"section": key}}
        text = REFUSAL_NOTE[key]
        yield {"event": "section_delta", "data": {"section": key, "delta": text}}
        yield {"event": "section_end", "data": {"section": key, "text": text}}
    yield {"event": "done", "data": {"note": dict(REFUSAL_NOTE), "refused": True}}


def stream_soap_note(
    text: str,
    input_type: str = "observations",
    *,
    template_addon: str | None = None,
    prior_history: list[dict] | None = None,
) -> Iterator[dict]:
    """Yield SSE-friendly event dicts while streaming a marked SOAP note."""
    if looks_nonclinical(text):
        yield from _yield_refusal_stream()
        return

    history_block = format_prior_history_block(prior_history or [])
    if prior_history:
        yield {
            "event": "context",
            "data": {
                "prior_note_count": len(prior_history),
                "returning_patient": True,
            },
        }
    else:
        yield {
            "event": "context",
            "data": {"prior_note_count": 0, "returning_patient": False},
        }

    stream = _client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": _build_system_prompt(template_addon)},
            {
                "role": "user",
                "content": _user_prompt(text, input_type, history_block),
            },
        ],
        temperature=0.2,
        stream=True,
    )

    buffer = ""
    current_section: str | None = None
    section_buffers = {key: "" for key in SECTION_KEYS}
    marker_re = re.compile(r"###\s*(SUBJECTIVE|OBJECTIVE|ASSESSMENT|PLAN)\s*\n?", re.I)
    max_marker_len = max(len(f"### {name}\n") for name in SECTION_MARKERS)

    for chunk in stream:
        delta = chunk.choices[0].delta.content or ""
        if not delta:
            continue
        buffer += delta

        while True:
            match = marker_re.search(buffer)
            if not match:
                break

            before = buffer[: match.start()]
            if current_section and before:
                section_buffers[current_section] += before
                yield {
                    "event": "section_delta",
                    "data": {"section": current_section, "delta": before},
                }

            if current_section:
                yield {
                    "event": "section_end",
                    "data": {
                        "section": current_section,
                        "text": section_buffers[current_section].strip(),
                    },
                }

            current_section = SECTION_MARKERS[match.group(1).upper()]
            buffer = buffer[match.end() :]
            yield {"event": "section_start", "data": {"section": current_section}}

        if current_section and len(buffer) > max_marker_len:
            flush_len = len(buffer) - max_marker_len
            to_flush = buffer[:flush_len]
            if to_flush:
                section_buffers[current_section] += to_flush
                yield {
                    "event": "section_delta",
                    "data": {"section": current_section, "delta": to_flush},
                }
            buffer = buffer[flush_len:]

    if current_section and buffer:
        section_buffers[current_section] += buffer
        yield {
            "event": "section_delta",
            "data": {"section": current_section, "delta": buffer},
        }

    if current_section:
        yield {
            "event": "section_end",
            "data": {
                "section": current_section,
                "text": section_buffers[current_section].strip(),
            },
        }

    note = {key: section_buffers[key].strip() for key in SECTION_KEYS}
    if not any(note.values()) and buffer:
        note = parse_marked_soap(buffer)

    yield {"event": "done", "data": {"note": note}}
