import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ApiError,
  getEncounter,
  getIcdSuggestions,
  listTemplates,
  saveEncounterDraft,
  saveNote,
  searchIcdCodes,
  suggestIcdCodes,
  updateIcdSuggestion,
} from '../api'
import { SoapSectionDiff } from '../components/SoapSectionDiff'
import { useAuth } from '../auth'
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
  type NoteTemplate,
  type NoteVersion,
  type SoapNote,
} from '../types'

const DRAFT_STORAGE_PREFIX = 'kyron_draft_'

function draftStorageKey(encounterId: number) {
  return `${DRAFT_STORAGE_PREFIX}${encounterId}`
}

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

  const [icdSuggestions, setIcdSuggestions] = useState<IcdSuggestion[]>([])
  const [icdLoading, setIcdLoading] = useState(false)
  const [icdError, setIcdError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<IcdSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [templates, setTemplates] = useState<NoteTemplate[]>([])
  const [templateId, setTemplateId] = useState<number | null>(null)
  const [priorNoteCount, setPriorNoteCount] = useState(0)
  const [returningPatient, setReturningPatient] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [accountDeactivated, setAccountDeactivated] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const skipNextAutosave = useRef(true)

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
      void generate(
        encounter.id,
        trimmed,
        'transcript',
        (n) => {
          finalNote = n
          setNote(n)
        },
        {
          templateId,
          onContext: (ctx) => {
            setPriorNoteCount(ctx.prior_note_count)
            setReturningPatient(ctx.returning_patient)
          },
        },
      ).then(() => {
        if (finalNote.assessment.trim()) void runIcdSuggest()
      })
    }, 1500)
  }, [encounter, generate, rejectAllProposals, templateId])

  function handleAuthFailure(err: unknown) {
    if (err instanceof ApiError) {
      if (err.code === 'account_deactivated') {
        setAccountDeactivated(true)
        return true
      }
      if (err.status === 401) {
        setSessionExpired(true)
        if (Number.isFinite(id)) {
          sessionStorage.setItem(
            draftStorageKey(id),
            JSON.stringify({
              input_text: textRef.current,
              input_type: inputType,
              template_id: templateId,
              ...note,
            }),
          )
        }
        return true
      }
    }
    return false
  }

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
    skipNextAutosave.current = true
    Promise.all([getEncounter(token, id), listTemplates(token)])
      .then(([enc, templateData]) => {
        setEncounter(enc)
        setTemplates(templateData.templates)
        updateText(enc.input_text || '')
        setInputType(enc.input_type || 'transcript')
        setTemplateId(enc.template_id ?? templateData.templates[0]?.id ?? null)
        setPriorNoteCount(enc.prior_note_count ?? 0)
        setReturningPatient(Boolean(enc.returning_patient))
        const loadedNote: SoapNote = enc.note
          ? {
              subjective: enc.note.subjective,
              objective: enc.note.objective,
              assessment: enc.note.assessment,
              plan: enc.note.plan,
            }
          : EMPTY_SOAP

        // Flush any draft captured after a session expiry
        const cached = sessionStorage.getItem(draftStorageKey(id))
        if (cached) {
          try {
            const parsed = JSON.parse(cached) as Partial<SoapNote> & {
              input_text?: string
              input_type?: InputType
              template_id?: number
            }
            if (parsed.input_text) updateText(parsed.input_text)
            if (parsed.input_type) setInputType(parsed.input_type)
            if (parsed.template_id) setTemplateId(parsed.template_id)
            setNote({
              subjective: parsed.subjective ?? loadedNote.subjective,
              objective: parsed.objective ?? loadedNote.objective,
              assessment: parsed.assessment ?? loadedNote.assessment,
              plan: parsed.plan ?? loadedNote.plan,
            })
            sessionStorage.removeItem(draftStorageKey(id))
            setSessionExpired(false)
          } catch {
            setNote(loadedNote)
          }
        } else {
          setNote(loadedNote)
        }
        savedSnapshotRef.current = loadedNote
        setVersions(enc.versions ?? [])
      })
      .catch((err) => {
        if (handleAuthFailure(err)) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load encounter')
      })
    getIcdSuggestions(token, id)
      .then((result) => setIcdSuggestions(result.suggestions))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, id])

  // Debounced draft autosave for cross-device session persistence
  useEffect(() => {
    if (!token || !encounter || skipNextAutosave.current) {
      skipNextAutosave.current = false
      return
    }
    const timer = setTimeout(() => {
      setDraftSaving(true)
      void saveEncounterDraft(token, encounter.id, {
        input_text: text,
        input_type: inputType,
        template_id: templateId,
        ...note,
      })
        .then((enc) => {
          setEncounter(enc)
          setSessionExpired(false)
        })
        .catch((err) => {
          handleAuthFailure(err)
        })
        .finally(() => setDraftSaving(false))
    }, 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, inputType, templateId, note.subjective, note.objective, note.assessment, note.plan])

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
    await generate(
      encounter.id,
      trimmed,
      inputType,
      (n) => {
        finalNote = n
        setNote(n)
      },
      {
        templateId,
        onContext: (ctx) => {
          setPriorNoteCount(ctx.prior_note_count)
          setReturningPatient(ctx.returning_patient)
        },
      },
    )
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
    if (hasPendingProposal) {
      setSaveError('Confirm or reject pending voice edits before saving.')
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
      savedSnapshotRef.current = note
      setDirty(false)
      setLastSavedAt(new Date())
      setEncounter((prev) => (prev ? { ...prev, status: 'saved' } : prev))
      setSessionExpired(false)
    } catch (err) {
      if (!handleAuthFailure(err)) {
        setSaveError(err instanceof Error ? err.message : 'Save failed')
      }
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
    if (hasPendingProposal) {
      return {
        tone: 'warning',
        label: 'Pending AI edits',
        detail: 'Review the green diff, then confirm or reject',
      }
    }
    if (voiceStatus === 'connecting') return { tone: 'info', label: 'Connecting voice session…' }
    if (voiceStatus === 'live') {
      return {
        tone: 'live',
        label: 'Voice session live',
        detail: 'Speak changes — they stage as a diff until you confirm',
      }
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
    hasPendingProposal,
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
      : hasPendingProposal || dirty
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
                <span
                  className={`patient-history-badge ${returningPatient ? 'returning' : 'new'}`}
                >
                  {returningPatient
                    ? `Returning patient — ${priorNoteCount} prior note${priorNoteCount === 1 ? '' : 's'}`
                    : 'New patient'}
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
                {draftSaving ? ' · Saving draft…' : ''}
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

        {accountDeactivated && (
          <div className="workspace-banner banner-error" role="alert">
            Your account has been deactivated by an administrator. Your draft is
            preserved — contact an admin to restore access.
            <button type="button" className="secondary small" onClick={logout}>
              Sign out
            </button>
          </div>
        )}
        {sessionExpired && !accountDeactivated && (
          <div className="workspace-banner banner-warning" role="alert">
            Your session expired. Draft is saved locally — sign in again to continue.
            <button type="button" className="secondary small" onClick={logout}>
              Sign in again
            </button>
          </div>
        )}

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
          <label className="field">
            <span>Note template</span>
            <select
              value={templateId ?? ''}
              onChange={(e) =>
                setTemplateId(e.target.value ? Number(e.target.value) : null)
              }
              disabled={streaming || accountDeactivated}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="input-type">
            <legend>Input type</legend>
            <label>
              <input
                type="radio"
                name="inputType"
                value="transcript"
                checked={inputType === 'transcript'}
                onChange={() => setInputType('transcript')}
                disabled={accountDeactivated}
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
                disabled={accountDeactivated}
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

          <button type="submit" disabled={streaming || !text.trim() || accountDeactivated}>
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
                Optional — speak changes; additions show in green until you confirm.
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
          {proposalSummary && <p className="voice-summary">{proposalSummary}</p>}
          {!proposalSummary && lastSummary && <p className="voice-summary">{lastSummary}</p>}

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

          {voiceError && (
            <p className="error" role="alert">
              {voiceError}
            </p>
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
                      {v.created_by_name ? ` · ${v.created_by_name}` : ''}
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
