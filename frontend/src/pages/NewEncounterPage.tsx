import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createEncounter } from '../api'
import { useAuth } from '../auth'

export default function NewEncounterPage() {
  const { token, user, logout } = useAuth()
  const navigate = useNavigate()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [dob, setDob] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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
        <button type="submit" disabled={submitting}>
          {submitting ? 'Starting…' : 'Start encounter'}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  )
}
