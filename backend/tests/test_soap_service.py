"""Unit tests for the SOAP parser and streaming assembler.

`parse_marked_soap` is pure and tested directly. `stream_soap_note` is
tested by monkeypatching `soap_service._client` with a fake OpenAI client
that yields pre-scripted chunks — no network call is ever made.
"""

from __future__ import annotations

import soap_service


# ---------------------------------------------------------------------------
# parse_marked_soap
# ---------------------------------------------------------------------------


def test_parse_marked_soap_happy_path():
    text = (
        "### SUBJECTIVE\nCough for 3 days.\n"
        "### OBJECTIVE\nAfebrile, lungs clear.\n"
        "### ASSESSMENT\nUpper respiratory infection.\n"
        "### PLAN\nRest and fluids.\n"
    )
    result = soap_service.parse_marked_soap(text)
    assert result == {
        "subjective": "Cough for 3 days.",
        "objective": "Afebrile, lungs clear.",
        "assessment": "Upper respiratory infection.",
        "plan": "Rest and fluids.",
    }


def test_parse_marked_soap_handles_out_of_order_headings():
    text = (
        "### PLAN\nRest and fluids.\n"
        "### SUBJECTIVE\nCough for 3 days.\n"
        "### ASSESSMENT\nURI.\n"
    )
    result = soap_service.parse_marked_soap(text)
    assert result["plan"] == "Rest and fluids."
    assert result["subjective"] == "Cough for 3 days."
    assert result["assessment"] == "URI."
    assert result["objective"] == ""  # missing entirely


def test_parse_marked_soap_handles_partial_sections():
    text = "### SUBJECTIVE\nCough for 3 days.\n"
    result = soap_service.parse_marked_soap(text)
    assert result["subjective"] == "Cough for 3 days."
    assert result["objective"] == ""
    assert result["assessment"] == ""
    assert result["plan"] == ""


def test_parse_marked_soap_is_case_and_whitespace_tolerant():
    text = "###subjective\n  Cough.  \n###   Objective   \nAfebrile.\n"
    result = soap_service.parse_marked_soap(text)
    assert result["subjective"] == "Cough."
    assert result["objective"] == "Afebrile."


def test_parse_marked_soap_last_duplicate_heading_wins():
    text = (
        "### SUBJECTIVE\nFirst version.\n"
        "### OBJECTIVE\nSomething.\n"
        "### SUBJECTIVE\nSecond, corrected version.\n"
    )
    result = soap_service.parse_marked_soap(text)
    assert result["subjective"] == "Second, corrected version."


def test_parse_marked_soap_with_no_markers_returns_all_empty():
    text = "Just a rambling paragraph with no structure at all."
    result = soap_service.parse_marked_soap(text)
    assert result == {"subjective": "", "objective": "", "assessment": "", "plan": ""}


def test_parse_marked_soap_empty_string():
    assert soap_service.parse_marked_soap("") == {
        "subjective": "",
        "objective": "",
        "assessment": "",
        "plan": "",
    }


# ---------------------------------------------------------------------------
# stream_soap_note (fake OpenAI streaming client)
# ---------------------------------------------------------------------------


class _FakeDelta:
    def __init__(self, content):
        self.content = content


class _FakeChoice:
    def __init__(self, content):
        self.delta = _FakeDelta(content)


class _FakeChunk:
    def __init__(self, content):
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def __init__(self, chunks):
        self._chunks = chunks

    def create(self, **kwargs):
        return iter(_FakeChunk(c) for c in self._chunks)


class _FakeChat:
    def __init__(self, chunks):
        self.completions = _FakeCompletions(chunks)


class _FakeOpenAIClient:
    def __init__(self, chunks):
        self.chat = _FakeChat(chunks)


def _run_stream(monkeypatch, chunks):
    monkeypatch.setattr(soap_service, "_client", lambda: _FakeOpenAIClient(chunks))
    return list(soap_service.stream_soap_note("some input", input_type="observations"))


def test_stream_soap_note_happy_path_emits_full_event_sequence(monkeypatch):
    chunks = [
        "### SUBJECTIVE\n",
        "Cough for 3 days.\n",
        "### OBJECTIVE\n",
        "Afebrile.\n",
        "### ASSESSMENT\n",
        "URI.\n",
        "### PLAN\n",
        "Rest and fluids.",
    ]
    events = _run_stream(monkeypatch, chunks)

    kinds = [e["event"] for e in events]
    assert kinds.count("section_start") == 4
    assert kinds.count("section_end") == 4
    assert kinds[-1] == "done"

    done_note = events[-1]["data"]["note"]
    assert done_note["subjective"] == "Cough for 3 days."
    assert done_note["objective"] == "Afebrile."
    assert done_note["assessment"] == "URI."
    assert done_note["plan"] == "Rest and fluids."


def test_stream_soap_note_handles_marker_split_across_chunks(monkeypatch):
    """A `### SUBJECTIVE` marker split mid-token across two stream chunks
    must still be recognized (never leaked into a prior section as text)."""
    chunks = [
        "### SUB",
        "JECTIVE\nCough for 3 days.\n### OBJ",
        "ECTIVE\nAfebrile.\n",
    ]
    events = _run_stream(monkeypatch, chunks)
    done_note = events[-1]["data"]["note"]
    assert done_note["subjective"] == "Cough for 3 days."
    assert done_note["objective"] == "Afebrile."
    # the split marker text itself must never appear as literal content
    all_deltas = "".join(
        e["data"].get("delta", "") for e in events if e["event"] == "section_delta"
    )
    assert "SUB" not in all_deltas
    assert "OBJ" not in all_deltas


def test_stream_soap_note_with_partial_sections_only_subjective(monkeypatch):
    chunks = ["### SUBJECTIVE\n", "Cough for 3 days, no other complaints noted."]
    events = _run_stream(monkeypatch, chunks)
    done_note = events[-1]["data"]["note"]
    assert done_note["subjective"] == "Cough for 3 days, no other complaints noted."
    assert done_note["objective"] == ""
    assert done_note["assessment"] == ""
    assert done_note["plan"] == ""


def test_stream_soap_note_with_no_markers_at_all_falls_back_to_empty_note(monkeypatch):
    chunks = ["Just some unstructured text with no SOAP headings whatsoever."]
    events = _run_stream(monkeypatch, chunks)
    assert events[-1]["event"] == "done"
    assert events[-1]["data"]["note"] == {
        "subjective": "",
        "objective": "",
        "assessment": "",
        "plan": "",
    }
    # no section_start/section_delta/section_end should have fired
    assert all(e["event"] == "done" for e in events)


def test_stream_soap_note_out_of_order_headings_from_llm(monkeypatch):
    chunks = [
        "### PLAN\nRest and fluids.\n",
        "### SUBJECTIVE\nCough for 3 days.\n",
    ]
    events = _run_stream(monkeypatch, chunks)
    done_note = events[-1]["data"]["note"]
    assert done_note["plan"] == "Rest and fluids."
    assert done_note["subjective"] == "Cough for 3 days."
    assert done_note["objective"] == ""
    assert done_note["assessment"] == ""


def test_stream_soap_note_ignores_empty_delta_chunks(monkeypatch):
    chunks = ["### SUBJECTIVE\n", "", "Cough.", None]
    events = _run_stream(monkeypatch, chunks)
    done_note = events[-1]["data"]["note"]
    assert done_note["subjective"] == "Cough."
