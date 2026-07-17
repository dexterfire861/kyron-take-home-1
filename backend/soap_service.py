from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator

from openai import OpenAI

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
"""


def _client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return OpenAI(api_key=api_key)


def _user_prompt(text: str, input_type: str) -> str:
    if input_type == "transcript":
        label = "Raw encounter transcript"
    else:
        label = "Freeform clinical observations"
    return f"{label}:\n\n{text}"


def generate_soap_note(text: str, input_type: str = "observations") -> dict[str, str]:
    response = _client().chat.completions.create(
        model="gpt-4o-mini",
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": JSON_SYSTEM_PROMPT},
            {"role": "user", "content": _user_prompt(text, input_type)},
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


def stream_soap_note(text: str, input_type: str = "observations") -> Iterator[dict]:
    """Yield SSE-friendly event dicts while streaming a marked SOAP note."""
    stream = _client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _user_prompt(text, input_type)},
        ],
        temperature=0.2,
        stream=True,
    )

    buffer = ""
    current_section: str | None = None
    section_buffers = {key: "" for key in SECTION_KEYS}
    marker_re = re.compile(r"###\s*(SUBJECTIVE|OBJECTIVE|ASSESSMENT|PLAN)\s*\n?", re.I)
    # A marker could be split across two stream chunks (e.g. "...\n\n##" then
    # "# OBJECTIVE\n..."). Never flush the trailing MAX_MARKER_LEN characters
    # of the buffer as plain text — hold them back until either a full marker
    # match rules them in, or enough further text rules them out.
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
    # Fallback parse if markers were incomplete
    if not any(note.values()) and buffer:
        note = parse_marked_soap(buffer)

    yield {"event": "done", "data": {"note": note}}
