import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listPatients } from '../api'
import { useAuth } from '../auth'
import type { PatientSummary } from '../types'

export default function PatientsPage() {
  const { token, user, logout } = useAuth()
  const [patients, setPatients] = useState<PatientSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    listPatients(token)
      .then((result) => setPatients(result.patients))
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load patients')
      })
      .finally(() => setLoading(false))
  }, [token])

  return (
    <div className="app">
      <header className="header row">
        <div>
          <h1>Patients</h1>
          <p>
            {user?.full_name}
            {' · '}
            {patients.length} patient{patients.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="header-actions">
          <Link className="button-link" to="/encounters/new">
            + New patient
          </Link>
          <button type="button" className="secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="empty">Loading patients…</p>}

      {!loading && patients.length === 0 && !error && (
        <div className="panel">
          <p className="empty">No patients yet. Start your first encounter to add one.</p>
          <Link className="button-link" to="/encounters/new">
            + New patient
          </Link>
        </div>
      )}

      {!loading && patients.length > 0 && (
        <div className="panel patient-list">
          {patients.map((p) => (
            <Link key={p.id} to={`/patients/${p.id}`} className="patient-row">
              <div className="patient-row-name">
                <strong>
                  {p.first_name} {p.last_name}
                </strong>
                <span>DOB {p.date_of_birth}</span>
              </div>
              <div className="patient-row-meta">
                <span>
                  {p.encounter_count} encounter{p.encounter_count === 1 ? '' : 's'}
                </span>
                {p.last_encounter_at && (
                  <span>Last visit {new Date(p.last_encounter_at).toLocaleDateString()}</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
