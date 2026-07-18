import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  getEncounter,
  getIcdSuggestions,
  saveNote,
  searchIcdCodes,
  suggestIcdCodes,
  updateIcdSuggestion,
} from '../api'
import { useAuth } from '../auth'
import { useDictation } from '../hooks/useDictation'
import { useRealtimeVoice } from '../hooks/useRealtimeVoice'
import { useSoapStream } from '../hooks/useSoapStream'
import {
  EMPTY_SOAP,
  SOAP_SECTIONS,
  type Encounter,
  type IcdSearchResult,
  type IcdSuggestion,
  type InputType,
  type NoteVersion,
  type SoapNote,
} from '../types'

type StageId = 'capture' | 'generate' | 'review' | 'save'

const STAGES: { id: StageId; label: string }[] = [
  { id: 'capture', label: 'Capture' },
  { id: 'generate', label: 'Generate' },
  { id: 'review', label: 'Review & refine' },
  { id: 'save', label: 'Save' },
]

const ENCOUNTER_STATUS_LABELS: Record<string, string> = {
  draft: 'Not started',
  active: 'In progress',
  saved: 'Saved',
}

type StatusTone = 'idle' | 'info' | 'live' | 'warning' | 'success' | 'error'

type WorkspaceStatus = {
  tone: StatusTone
  label: string
  detail?: string
}

function calculateAge(dob: string): number | null {
  const parsed = new Date(dob)
  if (Number.isNaN(parsed.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - parsed.getFullYear()
  const monthDiff = now.getMonth() - parsed.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < parsed.getDate())) {
    age -= 1
  }
  return age
}

function soapEquals(a: SoapNote, b: SoapNote): boolean {
  return (
    a.subjective === b.subjective &&
    a.objective === b.objective &&
    a.assessment === b.assessment &&
    a.plan === b.plan
  )
}

export default function EncounterWorkspacePage() {
  const { encounterId } = useParams()
  const id = Number(encounterId)
  const { token, user, logout } = useAuth()
  const [encounter, setEncounter] = useState<Encounter | null>(null)
  const [inputType, setInputType] = useState<InputType>('transcript')
  const [text, setText] = useState('')
  const textRef = useRef('')
  const updateText = useCallback((next: string) => {
    textRef.current = next
    setText(next)
  }, [])
  const [note, setNote] = useState<SoapNote>(EMPTY_SOAP)
  const [versions, setVersions] = useState<NoteVersion[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveSource, setSaveSource] = useState<'manual' | 'voice_session'>('manual')
  const [dirtyFromVoice, setDirtyFromVoice] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  // Tracks the last note contents persisted to the server so the UI can
  // always tell the provider "you have unsaved changes" regardless of
  // whether the edit came from typing, generation, or voice.
  const savedSnapshotRef = useRef<SoapNote>(EMPTY_SOAP)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    setDirty(!soapEquals(note, savedSnapshotRef.current))
  }, [note])

  // Mirrors `note` synchronously so the voice-edit handler can snapshot
  // "before" state without depending on stale closures.
  const noteRef = useRef<SoapNote>(EMPTY_SOAP)
  useEffect(() => {
    noteRef.current = note
  }, [note])

  // Sections the AI just touched (voice edit) get a brief highlight so the
  // provider's eye goes straight to what changed instead of re-reading the
  // whole note. This — plus the undo banner below — is a deliberately
  // lightweight stand-in for the green-diff + confirm-before-apply flow
  // being built separately: today `useRealtimeVoice` applies edits
  // immediately, so we surface "what changed" + "one-shot undo" after the
  // fact. `note-recently-changed` and `ai-edit-banner` are the intended
  // integration points once that work lands — no restructuring needed,
  // just swap "auto-fades after 4s" for "stays until accepted/rejected".
  const [recentlyChanged, setRecentlyChanged] = useState<Set<keyof SoapNote>>(new Set())
  const recentlyChangedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const markRecentlyChanged = useCallback((keys: (keyof SoapNote)[]) => {
    setRecentlyChanged((prev) => {
      const next = new Set(prev)
      keys.forEach((key) => next.add(key))
      return next
    })
    keys.forEach((key) => {
      if (recentlyChangedTimers.current[key]) clearTimeout(recentlyChangedTimers.current[key])
      recentlyChangedTimers.current[key] = setTimeout(() => {
        setRecentlyChanged((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }, 4000)
    })
  }, [])

  const [voiceEditBanner, setVoiceEditBanner] = useState<
    { summary?: string; before: SoapNote } | null
  >(null)

  const [icdSuggestions, setIcdSuggestions] = useState<IcdSuggestion[]>([])
  const [icdLoading, setIcdLoading] = useState(false)
  const [icdError, setIcdError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<IcdSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const { generate, streaming, error: streamError, setError: setStreamError } =
    useSoapStream(token)

  const onNoteEdit = useCallback(
    (partial: Partial<SoapNote>, summary?: string) => {
      const before = noteRef.current
      setNote((prev) => ({ ...prev, ...partial }))
      setDirtyFromVoice(true)
      setSaveSource('voice_session')
      markRecentlyChanged(Object.keys(partial) as (keyof SoapNote)[])
      setVoiceEditBanner({ summary, before })
    },
    [markRecentlyChanged],
  )

  const {
    status: voiceStatus,
    error: voiceError,
    lastSummary,
    heardText,
    start: startVoice,
    stop: stopVoice,
  } = useRealtimeVoice(token, onNoteEdit)

  function undoVoiceEdit() {
    if (!voiceEditBanner) return
    setNote(voiceEditBanner.before)
    setVoiceEditBanner(null)
  }

  function dismissVoiceEditBanner() {
    setVoiceEditBanner(null)
  }

  const dictationRegenerateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleDictationRegenerate = useCallback(() => {
    if (!encounter) return
    if (dictationRegenerateTimer.current) clearTimeout(dictationRegenerateTimer.current)
    dictationRegenerateTimer.current = setTimeout(() => {
      const trimmed = textRef.current.trim()
      if (!trimmed) return
      setSaveError(null)
      setSaveSource('manual')
      let finalNote: SoapNote = EMPTY_SOAP
      void generate(encounter.id, trimmed, 'transcript', (n) => {
        finalNote = n
        setNote(n)
      }).then(() => {
        if (finalNote.assessment.trim()) void runIcdSuggest()
      })
    }, 1500)
  }, [encounter, generate])

  const handleDictatedUtterance = useCallback(
    (utterance: string) => {
      const next = textRef.current.trim()
        ? `${textRef.current.trim()} ${utterance}`
        : utterance
      updateText(next)
      scheduleDictationRegenerate()
    },
    [updateText, scheduleDictationRegenerate],
  )

  const {
    status: dictationStatus,
    error: dictationError,
    partialText,
    start: startDictation,
    pause: pauseDictation,
    resume: resumeDictation,
    stop: stopDictation,
  } = useDictation(token, handleDictatedUtterance)

  useEffect(() => {
    const timers = recentlyChangedTimers.current
    return () => {
      stopDictation()
      stopVoice()
      if (dictationRegenerateTimer.current) clearTimeout(dictationRegenerateTimer.current)
      Object.values(timers).forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!token || !Number.isFinite(id)) return
    getEncounter(token, id)
      .then((enc) => {
        setEncounter(enc)
        updateText(enc.input_text || '')
        setInputType(enc.input_type || 'transcript')
        const loadedNote: SoapNote = enc.note
          ? {
              subjective: enc.note.subjective,
              objective: enc.note.objective,
              assessment: enc.note.assessment,
              plan: enc.note.plan,
            }
          : EMPTY_SOAP
        setNote(loadedNote)
        savedSnapshotRef.current = loadedNote
        setVersions(enc.versions ?? [])
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load encounter')
      })
    getIcdSuggestions(token, id)
      .then((result) => setIcdSuggestions(result.suggestions))
      .catch(() => {})
  }, [token, id])

  const runIcdSuggest = useCallback(async () => {
    if (!token || !Number.isFinite(id)) return
    setIcdLoading(true)
    setIcdError(null)
    try {
      const result = await suggestIcdCodes(token, id)
      setIcdSuggestions(result.suggestions)
    } catch (err) {
      setIcdError(err instanceof Error ? err.message : 'Failed to suggest ICD-10 codes')
    } finally {
      setIcdLoading(false)
    }
  }, [token, id])

  async function handleIcdStatus(suggestionId: number, status: 'accepted' | 'rejected') {
    if (!token || !Number.isFinite(id)) return
    try {
      const result = await updateIcdSuggestion(token, id, suggestionId, status)
      setIcdSuggestions((prev) =>
        prev.map((s) => (s.id === suggestionId ? result.suggestion : s)),
      )
    } catch (err) {
      setIcdError(err instanceof Error ? err.message : 'Failed to update suggestion')
    }
  }

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    const query = searchQuery.trim()
    if (query.length < 3) {
      setSearchResults([])
      setSearchError(null)
      return
    }
    searchDebounceRef.current = setTimeout(() => {
      if (!token) return
      setSearching(true)
      setSearchError(null)
      searchIcdCodes(token, query)
        .then((result) => setSearchResults(result.results))
        .catch((err) => {
          setSearchError(err instanceof Error ? err.message : 'Search failed')
        })
        .finally(() => setSearching(false))
    }, 400)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [searchQuery, token])

  function appendToAssessment(code: string, description: string) {
    setNote((prev) => ({
      ...prev,
      assessment: prev.assessment
        ? `${prev.assessment}\n${code} - ${description}`
        : `${code} - ${description}`,
    }))
    setSaveSource('manual')
    setVoiceEditBanner(null)
  }

  async function handleGenerate(event: FormEvent) {
    event.preventDefault()
    if (!token || !encounter) return
    const trimmed = text.trim()
    if (!trimmed) {
      setStreamError('Enter a transcript or clinical observations first.')
      return
    }
    setSaveError(null)
    setDirtyFromVoice(false)
    setSaveSource('manual')
    setVoiceEditBanner(null)
    let finalNote: SoapNote = EMPTY_SOAP
    await generate(encounter.id, trimmed, inputType, (n) => {
      finalNote = n
      setNote(n)
    })
    if (finalNote.assessment.trim()) {
      void runIcdSuggest()
    }
  }

  async function handleSave() {
    if (!token || !encounter) return
    if (!Object.values(note).some((v) => v.trim())) {
      setSaveError('Nothing to save yet.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const result = await saveNote(
        token,
        encounter.id,
        note,
        dirtyFromVoice ? 'voice_session' : saveSource,
      )
      setVersions((prev) => [result.version, ...prev])
      setDirtyFromVoice(false)
      setSaveSource('manual')
      setVoiceEditBanner(null)
      savedSnapshotRef.current = note
      setDirty(false)
      setLastSavedAt(new Date())
      setEncounter((prev) => (prev ? { ...prev, status: 'saved' } : prev))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const hasNote = Object.values(note).some((v) => v.trim())
  const patient = encounter?.patient
  const patientAge = patient ? calculateAge(patient.date_of_birth) : null

  const status: WorkspaceStatus = useMemo(() => {
    if (streamError) return { tone: 'error', label: 'Generation error', detail: streamError }
    if (saveError) return { tone: 'error', label: 'Save error', detail: saveError }
    if (voiceError) return { tone: 'error', label: 'Voice session error', detail: voiceError }
    if (dictationError) return { tone: 'error', label: 'Dictation error', detail: dictationError }
    if (voiceStatus === 'connecting') return { tone: 'info', label: 'Connecting voice session…' }
    if (voiceStatus === 'live') {
      return { tone: 'live', label: 'Voice session live', detail: 'Speak naturally to edit the note' }
    }
    if (dictationStatus === 'connecting') return { tone: 'info', label: 'Connecting dictation…' }
    if (dictationStatus === 'listening') {
      return { tone: 'live', label: 'Listening', detail: 'Dictating into clinical input' }
    }
    if (dictationStatus === 'paused') return { tone: 'warning', label: 'Dictation paused' }
    if (streaming) return { tone: 'info', label: 'Generating SOAP note…' }
    if (saving) return { tone: 'info', label: 'Saving note…' }
    if (dirty) {
      return {
        tone: 'warning',
        label: 'Unsaved changes',
        detail: hasNote ? 'Review, then save when ready' : undefined,
      }
    }
    if (hasNote) {
      return {
        tone: 'success',
        label: 'All changes saved',
        detail: lastSavedAt
          ? `at ${lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : undefined,
      }
    }
    return { tone: 'idle', label: 'Awaiting input', detail: 'Paste a transcript or start dictation' }
  }, [
    streamError,
    saveError,
    voiceError,
    dictationError,
    voiceStatus,
    dictationStatus,
    streaming,
    saving,
    dirty,
    hasNote,
    lastSavedAt,
  ])

  const currentStageId: StageId = streaming
    ? 'generate'
    : !hasNote
      ? 'capture'
      : dirty
        ? 'review'
        : 'save'

  const stageDone: Record<StageId, boolean> = {
    capture: hasNote || text.trim().length > 0,
    generate: hasNote,
    review: versions.length > 0,
    save: versions.length > 0 && !dirty,
  }

  if (loadError) {
    return (
      <div className="app narrow">
        <p className="error">{loadError}</p>
        <Link to="/patients">Back to patients</Link>
      </div>
    )
  }

  if (!encounter) {
    return (
      <div className="app narrow">
        <p className="empty">Loading encounter…</p>
      </div>
    )
  }

  return (
    <div className="app app-workspace">
      <header className="workspace-header">
        <div className="workspace-header-top">
          <div className="patient-context">
            <Link to="/patients" className="context-back" aria-label="Back to all patients">
              ‹
            </Link>
            <div>
              <div className="patient-context-name">
                <span>{patient ? `${patient.first_name} ${patient.last_name}` : 'Patient'}</span>
                <span className={`encounter-status-chip status-${encounter.status}`}>
                  {ENCOUNTER_STATUS_LABELS[encounter.status] ?? encounter.status}
                </span>
              </div>
              <div className="patient-context-meta">
                {patient
                  ? `DOB ${patient.date_of_birth}${
                      patientAge !== null ? ` · age ${patientAge}` : ''
                    }`
                  : 'Patient'}
                {' · '}
                {user?.full_name}
              </div>
            </div>
          </div>
          <div className="header-actions">
            <Link className="secondary button-link small" to="/encounters/new">
              New encounter
            </Link>
            <button type="button" className="secondary small" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>

        <div className={`status-strip status-tone-${status.tone}`}>
          <span className="status-dot" aria-hidden="true" />
          <span className="status-label">{status.label}</span>
          {status.detail && <span className="status-detail">{status.detail}</span>}
        </div>
      </header>

      <ol className="stage-tracker">
        {STAGES.map((stage, index) => {
          const isCurrent = stage.id === currentStageId
          const isDone = stageDone[stage.id] && !isCurrent
          return (
            <li
              key={stage.id}
              className={`stage${isCurrent ? ' current' : ''}${isDone ? ' done' : ''}`}
            >
              <span className="stage-marker">{isDone ? '✓' : index + 1}</span>
              <span className="stage-label">{stage.label}</span>
            </li>
          )
        })}
      </ol>

      <main className="layout">
        <form className="panel input-panel" onSubmit={handleGenerate}>
          <p className="panel-eyebrow">Capture</p>
          <fieldset className="input-type">
            <legend>Input type</legend>
            <label>
              <input
                type="radio"
                name="inputType"
                value="transcript"
                checked={inputType === 'transcript'}
                onChange={() => setInputType('transcript')}
              />
              Encounter transcript
            </label>
            <label>
              <input
                type="radio"
                name="inputType"
                value="observations"
                checked={inputType === 'observations'}
                onChange={() => setInputType('observations')}
              />
              Clinical observations
            </label>
          </fieldset>

          <div className="dictation-controls">
            {dictationStatus === 'idle' || dictationStatus === 'error' ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setInputType('transcript')
                  void startDictation(id)
                }}
              >
                Start dictation
              </button>
            ) : dictationStatus === 'connecting' ? (
              <button type="button" className="secondary" disabled>
                Connecting…
              </button>
            ) : (
              <>
                {dictationStatus === 'listening' ? (
                  <button type="button" className="secondary" onClick={pauseDictation}>
                    Pause dictation
                  </button>
                ) : (
                  <button type="button" className="secondary" onClick={resumeDictation}>
                    Resume dictation
                  </button>
                )}
                <button type="button" className="danger" onClick={stopDictation}>
                  Stop dictation
                </button>
              </>
            )}
          </div>
          {dictationError && (
            <p className="error" role="alert">
              {dictationError}
            </p>
          )}

          <label className="textarea-label" htmlFor="clinical-input">
            Clinical input
          </label>
          <textarea
            id="clinical-input"
            value={text}
            onChange={(e) => updateText(e.target.value)}
            placeholder={
              inputType === 'transcript'
                ? 'Paste the raw encounter transcript here…'
                : 'Type freeform clinical observations here…'
            }
            rows={12}
            disabled={streaming}
          />
          {partialText && <p className="dictation-partial">…{partialText}</p>}

          <button type="submit" disabled={streaming || !text.trim()}>
            {streaming ? 'Streaming SOAP…' : hasNote ? 'Regenerate SOAP note' : 'Generate SOAP note'}
          </button>
          {(streamError || saveError) && (
            <p className="error" role="alert">
              {streamError || saveError}
            </p>
          )}
        </form>

        <section className="panel output-panel">
          <p className="panel-eyebrow">Review &amp; refine</p>
          <div className="panel-heading">
            <h2>SOAP note</h2>
            <button
              type="button"
              disabled={!hasNote || streaming || saving || !dirty}
              onClick={handleSave}
              title={!dirty && hasNote ? 'No unsaved changes' : undefined}
            >
              {saving ? 'Saving…' : hasNote && !dirty ? 'Saved' : 'Save note'}
            </button>
          </div>

          <div className="voice-refine-row">
            <div className="voice-refine-copy">
              <span className="voice-refine-title">Voice refine</span>
              <span className="voice-refine-hint">
                Optional — speak changes and they apply to the note live.
              </span>
            </div>
            {voiceStatus === 'live' ? (
              <button type="button" className="danger" onClick={stopVoice}>
                Stop voice
              </button>
            ) : (
              <button
                type="button"
                className="secondary"
                disabled={!hasNote || streaming || voiceStatus === 'connecting'}
                onClick={() => startVoice(encounter.id)}
              >
                {voiceStatus === 'connecting' ? 'Connecting…' : 'Start voice session'}
              </button>
            )}
          </div>

          {voiceStatus === 'live' && heardText && (
            <p className="voice-heard">Heard: “{heardText}”</p>
          )}

          {voiceEditBanner && (
            <div className="ai-edit-banner" role="status">
              <div className="ai-edit-banner-text">
                <strong>AI updated the note from voice.</strong>
                {(voiceEditBanner.summary || lastSummary) && (
                  <span> {voiceEditBanner.summary || lastSummary}</span>
                )}
              </div>
              <div className="ai-edit-banner-actions">
                <button type="button" className="secondary small" onClick={undoVoiceEdit}>
                  Undo
                </button>
                <button type="button" className="secondary small" onClick={dismissVoiceEditBanner}>
                  Looks good
                </button>
              </div>
            </div>
          )}

          {voiceError && (
            <p className="error" role="alert">
              {voiceError}
            </p>
          )}

          {!hasNote && !streaming && (
            <p className="empty">Generated sections will stream in here.</p>
          )}

          <div className="soap-sections">
            {SOAP_SECTIONS.map(({ key, label }) => (
              <div key={key}>
                <label
                  className={`soap-section edit${
                    recentlyChanged.has(key) ? ' note-recently-changed' : ''
                  }`}
                >
                  <span>{label}</span>
                  <textarea
                    value={note[key]}
                    onChange={(e) => {
                      setNote((prev) => ({ ...prev, [key]: e.target.value }))
                      setSaveSource('manual')
                      setVoiceEditBanner(null)
                    }}
                    rows={5}
                    disabled={streaming}
                  />
                </label>

                {key === 'assessment' && (
                  <div className="icd-suggestions">
                    <div className="icd-suggestions-heading">
                      <h4>Suggested ICD-10 codes</h4>
                      <button
                        type="button"
                        className="secondary small"
                        disabled={!note.assessment.trim() || icdLoading}
                        onClick={() => void runIcdSuggest()}
                      >
                        {icdLoading ? 'Suggesting…' : 'Suggest codes'}
                      </button>
                    </div>
                    {icdError && (
                      <p className="error" role="alert">
                        {icdError}
                      </p>
                    )}
                    {icdSuggestions.length === 0 && !icdLoading && (
                      <p className="empty">
                        No suggestions yet — generate or write an assessment, then click
                        Suggest codes.
                      </p>
                    )}
                    <ul className="icd-list">
                      {icdSuggestions.map((s) => (
                        <li key={s.id} className={`icd-item icd-${s.status}`}>
                          <span className="icd-code">{s.code}</span>
                          <span className="icd-desc">{s.description}</span>
                          <span className="icd-sim">{Math.round(s.similarity * 100)}%</span>
                          {s.status === 'suggested' ? (
                            <span className="icd-actions">
                              <button
                                type="button"
                                className="secondary small"
                                onClick={() => handleIcdStatus(s.id, 'accepted')}
                              >
                                Accept
                              </button>
                              <button
                                type="button"
                                className="secondary small"
                                onClick={() => handleIcdStatus(s.id, 'rejected')}
                              >
                                Reject
                              </button>
                            </span>
                          ) : (
                            <span className={`icd-status-badge icd-${s.status}`}>
                              {s.status === 'accepted' ? '✓ accepted' : '✕ rejected'}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>

          <details className="disclosure">
            <summary>
              <span className="disclosure-title">ICD-10 code search</span>
              <span className="disclosure-hint">Look up any code</span>
            </summary>
            <div className="disclosure-body">
              <input
                type="text"
                placeholder="Type a symptom or condition, e.g. &quot;shortness of breath&quot;…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searching && <p className="empty">Searching…</p>}
              {searchError && (
                <p className="error" role="alert">
                  {searchError}
                </p>
              )}
              {searchResults.length > 0 && (
                <ul className="icd-list">
                  {searchResults.map((r) => (
                    <li key={r.code} className="icd-item">
                      <span className="icd-code">{r.code}</span>
                      <span className="icd-desc">{r.description}</span>
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => appendToAssessment(r.code, r.description)}
                      >
                        + Add to Assessment
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>

          <details className="disclosure">
            <summary>
              <span className="disclosure-title">Version history</span>
              {versions.length > 0 && <span className="disclosure-count">{versions.length}</span>}
            </summary>
            <div className="disclosure-body">
              {versions.length === 0 ? (
                <p className="empty">Saved versions will appear here.</p>
              ) : (
                <ul className="version-list">
                  {versions.map((v) => (
                    <li key={v.id}>
                      <strong>v{v.version_number}</strong>
                      {' · '}
                      {new Date(v.created_at).toLocaleString()}
                      {' · '}
                      <span className={`version-source version-source-${v.source}`}>
                        {v.source === 'voice_session' ? 'voice' : 'manual'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </section>
      </main>
    </div>
  )
}
