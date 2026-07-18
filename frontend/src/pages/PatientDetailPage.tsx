import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { createEncounter, getPatientDetail } from '../api'
import { useAuth } from '../auth'
import type { PatientDetail } from '../types'

const STATUS_LABELS: Record<string, string> = {
  draft: 'Not started',
  active: 'In progress',
  saved: 'Saved',
}

export default function PatientDetailPage() {
  const { patientId } = useParams()
  const id = Number(patientId)
  const { token, logout } = useAuth()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<PatientDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!token || !Number.isFinite(id)) return
    getPatientDetail(token, id)
      .then(setDetail)
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load patient')
      })
  }, [token, id])

  async function startNewEncounter() {
    if (!token || !detail) return
    setStarting(true)
    setStartError(null)
    try {
      const encounter = await createEncounter(token, {
        first_name: detail.patient.first_name,
        last_name: detail.patient.last_name,
        date_of_birth: detail.patient.date_of_birth,
      })
      navigate(`/encounters/${encounter.id}`)
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start encounter')
    } finally {
      setStarting(false)
    }
  }

  if (loadError) {
    return (
      <div className="app narrow">
        <p className="error">{loadError}</p>
        <Link to="/patients">Back to patients</Link>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="app narrow">
        <p className="empty">Loading…</p>
      </div>
    )
  }

  const { patient, encounters } = detail

  return (
    <div className="app">
      <header className="header row">
        <div>
          <h1>
            {patient.first_name} {patient.last_name}
          </h1>
          <p>
            DOB {patient.date_of_birth}
            {' · '}
            {encounters.length} encounter{encounters.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="header-actions">
          <Link className="secondary button-link" to="/patients">
            All patients
          </Link>
          <button type="button" onClick={startNewEncounter} disabled={starting}>
            {starting ? 'Starting…' : '+ New encounter'}
          </button>
          <button type="button" className="secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      {startError && (
        <p className="error" role="alert">
          {startError}
        </p>
      )}

      <div className="panel">
        <h2>Encounter history</h2>
        {encounters.length === 0 ? (
          <p className="empty">No encounters yet for this patient.</p>
        ) : (
          <ul className="encounter-history-list">
            {encounters.map((enc) => (
              <li key={enc.id}>
                <Link to={`/encounters/${enc.id}`}>
                  <span>
                    {enc.created_at ? new Date(enc.created_at).toLocaleString() : 'Unknown date'}
                    {' · '}
                    {enc.has_note ? 'has note' : 'no note yet'}
                  </span>
                  <span className={`encounter-status-chip status-${enc.status}`}>
                    {STATUS_LABELS[enc.status] ?? enc.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
