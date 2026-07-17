from __future__ import annotations

import json
import os

from openai import OpenAI
from sqlalchemy import text

from db import db

TERMS_SYSTEM_PROMPT = """You extract short diagnosis/condition phrases from clinical text for ICD-10 code lookup.

Return ONLY a JSON object: {"terms": ["phrase 1", "phrase 2", ...]}

Rules:
- Each phrase should be a short, canonical clinical diagnosis or condition name (2-5 words), not a full sentence.
- Prefer standard clinical terminology over the patient's own words (e.g. "high blood sugar" -> "hyperglycemia").
- Return at most {max_terms} phrases, ordered by clinical relevance.
- If the text contains no identifiable diagnosis or condition, return {"terms": []}.
"""

RERANK_SYSTEM_PROMPT = """You are ranking candidate ICD-10-CM codes for relevance to a clinical note.

Return ONLY a JSON object: {"codes": ["CODE1", "CODE2", ...]}

Rules:
- Only return codes that appear in the candidate list you are given. Never invent or modify a code.
- Order from most to least clinically appropriate for the given text.
- Prefer the most specific code that is fully supported by the text. Do not rank a code implying a
  complication, severity, or detail (e.g. "with foot ulcer", "with cataract") ahead of a plainer code
  (e.g. "without complications") unless the text actually documents that detail.
- Return at most {top_n} codes.
"""


def _client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return OpenAI(api_key=api_key)


def extract_terms(text_input: str, max_terms: int = 5) -> list[str]:
    text_input = (text_input or "").strip()
    if not text_input:
        return []

    response = _client().chat.completions.create(
        model="gpt-4o-mini",
        response_format={"type": "json_object"},
        messages=[
            {
                "role": "system",
                "content": TERMS_SYSTEM_PROMPT.replace("{max_terms}", str(max_terms)),
            },
            {"role": "user", "content": text_input},
        ],
        temperature=0.1,
    )
    content = response.choices[0].message.content
    if not content:
        return []
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return []
    terms = data.get("terms", [])
    if not isinstance(terms, list):
        return []
    return [str(t).strip() for t in terms if str(t).strip()][:max_terms]


def _candidate_pool(
    terms: list[str],
    per_term_limit: int = 15,
    pool_limit: int = 25,
    threshold: float = 0.15,
) -> list[dict]:
    if not terms:
        return []

    best_by_code: dict[str, dict] = {}
    for term in terms:
        rows = db.session.execute(
            text(
                """
                SELECT code, description, similarity(description, :term) AS sim
                FROM icd10_codes
                WHERE description % :term
                ORDER BY sim DESC
                LIMIT :limit
                """
            ),
            {"term": term, "limit": per_term_limit},
        ).fetchall()
        for row in rows:
            if row.sim < threshold:
                continue
            existing = best_by_code.get(row.code)
            if not existing or row.sim > existing["similarity"]:
                best_by_code[row.code] = {
                    "code": row.code,
                    "description": row.description,
                    "similarity": round(float(row.sim), 4),
                }

    ranked = sorted(best_by_code.values(), key=lambda r: r["similarity"], reverse=True)
    return ranked[:pool_limit]


def match_codes(terms: list[str], total_limit: int = 10, **kwargs) -> list[dict]:
    """Trigram-only match (no LLM rerank) — used as a fallback."""
    return _candidate_pool(terms, **kwargs)[:total_limit]


def _rerank(text_input: str, candidates: list[dict], top_n: int) -> list[dict]:
    if not candidates:
        return []

    candidate_lines = "\n".join(f"{c['code']}: {c['description']}" for c in candidates)
    try:
        response = _client().chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": RERANK_SYSTEM_PROMPT.replace("{top_n}", str(top_n)),
                },
                {
                    "role": "user",
                    "content": f"Clinical text:\n{text_input}\n\nCandidate codes:\n{candidate_lines}",
                },
            ],
            temperature=0,
        )
        content = response.choices[0].message.content
        data = json.loads(content) if content else {}
        chosen_codes = data.get("codes", [])
        if not isinstance(chosen_codes, list):
            chosen_codes = []
    except Exception:
        chosen_codes = []

    by_code = {c["code"]: c for c in candidates}
    ranked = [by_code[code] for code in chosen_codes if code in by_code]

    seen = {r["code"] for r in ranked}
    for candidate in candidates:
        if candidate["code"] not in seen:
            ranked.append(candidate)
            seen.add(candidate["code"])

    return ranked[:top_n]


def suggest_for_text(text_input: str, top_n: int = 10) -> list[dict]:
    """Extract diagnosis terms, trigram-match against the real code table
    (guarantees every candidate exists), then use an LLM pass to rerank the
    verified candidates for clinical relevance. The LLM never introduces a
    code that wasn't already retrieved from the database."""
    terms = extract_terms(text_input)
    candidates = _candidate_pool(terms)
    return _rerank(text_input, candidates, top_n)
