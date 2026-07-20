import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createEncounter, listTemplates } from '../api'
import { useAuth } from '../auth'
import type { NoteTemplate } from '../types'

export default function NewEncounterPage() {
  const { token, user, logout } = useAuth()
  const navigate = useNavigate()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [dob, setDob] = useState('')
  const [templates, setTemplates] = useState<NoteTemplate[]>([])
  const [templateId, setTemplateId] = useState<number | ''>('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!token) return
    listTemplates(token)
      .then((data) => {
        setTemplates(data.templates)
        const preferred =
          data.templates.find((t) => t.slug === 'new_patient_eval') ??
          data.templates[0]
        if (preferred) setTemplateId(preferred.id)
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load templates'),
      )
  }, [token])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!token) return
    setSubmitting(true)
    setError(null)
    try {
      const encounter = await createEncounter(token, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        date_of_birth: dob,
        template_id: templateId === '' ? undefined : Number(templateId),
      })
      navigate(`/encounters/${encounter.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create encounter')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="app narrow">
      <header className="header row">
        <div>
          <h1>New encounter</h1>
          <p>
            Signed in as {user?.full_name}. Enter patient identity to begin.
          </p>
        </div>
        <div className="header-actions">
          <Link className="secondary button-link" to="/patients">
            All patients
          </Link>
          <button type="button" className="secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <form className="panel" onSubmit={handleSubmit}>
        <label className="field">
          <span>First name</span>
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Last name</span>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Date of birth</span>
          <input
            type="date"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Note template</span>
          <select
            value={templateId}
            onChange={(e) =>
              setTemplateId(e.target.value ? Number(e.target.value) : '')
            }
            required
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {templateId !== '' && (
          <p className="hint">
            {templates.find((t) => t.id === templateId)?.description}
          </p>
        )}
        <button type="submit" disabled={submitting || templates.length === 0}>
          {submitting ? 'Starting…' : 'Start encounter'}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>

      <div className="panel next-steps">
        <p className="panel-eyebrow">What happens next</p>
        <ol className="next-steps-list">
          <li>Capture the visit as a transcript, typed observations, or live dictation.</li>
          <li>Generate a streaming SOAP note shaped by the selected template.</li>
          <li>Review and refine — edit sections, ICD-10 codes, or voice changes with green diffs.</li>
          <li>Save to persist the note and record a version.</li>
        </ol>
      </div>
    </div>
  )
}
