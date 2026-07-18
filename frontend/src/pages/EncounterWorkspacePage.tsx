import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
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
import { SoapSectionDiff } from '../components/SoapSectionDiff'
import { useDictation } from '../hooks/useDictation'
import { useRealtimeVoice } from '../hooks/useRealtimeVoice'
import { useSoapProposal } from '../hooks/useSoapProposal'
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

  const [icdSuggestions, setIcdSuggestions] = useState<IcdSuggestion[]>([])
  const [icdLoading, setIcdLoading] = useState(false)
  const [icdError, setIcdError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<IcdSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const { generate, streaming, error: streamError, setError: setStreamError } =
    useSoapStream(token)

  const applyProposedChanges = useCallback((changes: Partial<SoapNote>) => {
    setNote((prev) => ({ ...prev, ...changes }))
    setDirtyFromVoice(true)
    setSaveSource('voice_session')
  }, [])

  const {
    pending: pendingProposal,
    hasPending: hasPendingProposal,
    pendingCount: pendingProposalCount,
    summary: proposalSummary,
    propose: proposeEdit,
    confirmSection: confirmProposalSection,
    rejectSection: rejectProposalSection,
    confirmAll: confirmAllProposals,
    rejectAll: rejectAllProposals,
  } = useSoapProposal(note, applyProposedChanges)

  const {
    status: voiceStatus,
    error: voiceError,
    lastSummary,
    heardText,
    start: startVoice,
    stop: stopVoice,
  } = useRealtimeVoice(token, {
    onProposeEdit: proposeEdit,
    onConfirmProposal: confirmAllProposals,
    onRejectProposal: rejectAllProposals,
  })

  const dictationRegenerateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleDictationRegenerate = useCallback(() => {
    if (!encounter) return
    if (dictationRegenerateTimer.current) clearTimeout(dictationRegenerateTimer.current)
    dictationRegenerateTimer.current = setTimeout(() => {
      const trimmed = textRef.current.trim()
      if (!trimmed) return
      setSaveError(null)
      setSaveSource('manual')
      rejectAllProposals()
      let finalNote: SoapNote = EMPTY_SOAP
      void generate(encounter.id, trimmed, 'transcript', (n) => {
        finalNote = n
        setNote(n)
      }).then(() => {
        if (finalNote.assessment.trim()) void runIcdSuggest()
      })
    }, 1500)
  }, [encounter, generate, rejectAllProposals])

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
    return () => {
      stopDictation()
      stopVoice()
      if (dictationRegenerateTimer.current) clearTimeout(dictationRegenerateTimer.current)
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
        if (enc.note) {
          setNote({
            subjective: enc.note.subjective,
            objective: enc.note.objective,
            assessment: enc.note.assessment,
            plan: enc.note.plan,
          })
        }
        setVersions(enc.versions ?? [])
        rejectAllProposals()
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
    rejectAllProposals()
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
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const hasNote = Object.values(note).some((v) => v.trim())
  const patient = encounter?.patient

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
    <div className="app">
      <header className="header row">
        <div>
          <h1>Encounter workspace</h1>
          <p>
            {patient
              ? `${patient.first_name} ${patient.last_name} · DOB ${patient.date_of_birth}`
              : 'Patient'}
            {' · '}
            {user?.full_name}
          </p>
        </div>
        <div className="header-actions">
          <Link className="secondary button-link" to="/patients">
            All patients
          </Link>
          <Link className="secondary button-link" to="/encounters/new">
            New encounter
          </Link>
          <button type="button" className="secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="layout">
        <form className="panel input-panel" onSubmit={handleGenerate}>
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
                <span className="dictation-live-badge">
                  {dictationStatus === 'listening' ? '● listening' : '⏸ paused'}
                </span>
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
            {streaming ? 'Streaming SOAP…' : 'Generate SOAP note'}
          </button>
          {(streamError || saveError) && (
            <p className="error" role="alert">
              {streamError || saveError}
            </p>
          )}
        </form>

        <section className="panel output-panel">
          <div className="panel-heading">
            <h2>SOAP note</h2>
            <div className="header-actions">
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
                  {voiceStatus === 'connecting'
                    ? 'Connecting…'
                    : 'Start voice session'}
                </button>
              )}
              <button
                type="button"
                disabled={!hasNote || streaming || saving}
                onClick={handleSave}
              >
                {saving ? 'Saving…' : 'Save note'}
              </button>
            </div>
          </div>

          {voiceStatus === 'live' && (
            <p className="voice-live">Voice session live — speak naturally to edit the note.</p>
          )}
          {voiceStatus === 'live' && heardText && (
            <p className="voice-heard">Heard: “{heardText}”</p>
          )}
          {proposalSummary && <p className="voice-summary">{proposalSummary}</p>}
          {!proposalSummary && lastSummary && <p className="voice-summary">{lastSummary}</p>}
          {voiceError && (
            <p className="error" role="alert">
              {voiceError}
            </p>
          )}

          {hasPendingProposal && (
            <div className="pending-banner">
              <span>
                Pending changes — confirm to apply
                {pendingProposalCount > 1 ? ` (${pendingProposalCount} sections)` : ''}.
              </span>
              {pendingProposalCount > 1 && (
                <div className="pending-banner-actions">
                  <button type="button" className="small" onClick={confirmAllProposals}>
                    Confirm all
                  </button>
                  <button
                    type="button"
                    className="secondary small"
                    onClick={rejectAllProposals}
                  >
                    Reject all
                  </button>
                </div>
              )}
            </div>
          )}

          {!hasNote && !streaming && (
            <p className="empty">Generated sections will stream in here.</p>
          )}

          <div className="soap-sections">
            {SOAP_SECTIONS.map(({ key, label }) => {
              const pendingSection = pendingProposal[key]
              return (
                <div key={key}>
                  {pendingSection ? (
                    <SoapSectionDiff
                      label={label}
                      before={pendingSection.before}
                      after={pendingSection.after}
                      onConfirm={() => confirmProposalSection(key)}
                      onReject={() => rejectProposalSection(key)}
                    />
                  ) : (
                    <label className="soap-section edit">
                      <span>{label}</span>
                      <textarea
                        value={note[key]}
                        onChange={(e) => {
                          setNote((prev) => ({ ...prev, [key]: e.target.value }))
                          setSaveSource('manual')
                        }}
                        rows={5}
                        disabled={streaming}
                      />
                    </label>
                  )}

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
              )
            })}
          </div>

          <div className="panel icd-search-widget">
            <h3>ICD-10 code search</h3>
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

          <div className="versions">
            <h3>Version history</h3>
            {versions.length === 0 ? (
              <p className="empty">Saved versions will appear here.</p>
            ) : (
              <ul>
                {versions.map((v) => (
                  <li key={v.id}>
                    <strong>v{v.version_number}</strong>
                    {' · '}
                    {new Date(v.created_at).toLocaleString()}
                    {' · '}
                    {v.source}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
