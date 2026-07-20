import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  adminCreateProvider,
  adminCreateTemplate,
  adminDeleteTemplate,
  adminListEncounters,
  adminListProviders,
  adminListTemplates,
  adminUpdateProvider,
  adminUpdateTemplate,
} from '../api'
import { useAuth } from '../auth'
import type { AdminEncounterRow, NoteTemplate, User } from '../types'

type Tab = 'encounters' | 'providers' | 'templates'

export default function AdminDashboardPage() {
  const { token, user, logout } = useAuth()
  const [tab, setTab] = useState<Tab>('encounters')
  const [error, setError] = useState<string | null>(null)

  const [providers, setProviders] = useState<User[]>([])
  const [encounters, setEncounters] = useState<AdminEncounterRow[]>([])
  const [templates, setTemplates] = useState<NoteTemplate[]>([])

  const [filterProviderId, setFilterProviderId] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')

  const [newProvider, setNewProvider] = useState({
    email: '',
    full_name: '',
    password: 'provider123',
  })

  const [editingTemplate, setEditingTemplate] = useState<NoteTemplate | null>(null)
  const [newTemplate, setNewTemplate] = useState({
    name: '',
    slug: '',
    description: '',
    system_prompt_addon: '',
  })

  const refreshProviders = useCallback(async () => {
    if (!token) return
    const data = await adminListProviders(token)
    setProviders(data.providers)
  }, [token])

  const refreshEncounters = useCallback(async () => {
    if (!token) return
    const data = await adminListEncounters(token, {
      provider_id: filterProviderId ? Number(filterProviderId) : undefined,
      from: filterFrom || undefined,
      to: filterTo || undefined,
    })
    setEncounters(data.encounters)
  }, [token, filterProviderId, filterFrom, filterTo])

  const refreshTemplates = useCallback(async () => {
    if (!token) return
    const data = await adminListTemplates(token)
    setTemplates(data.templates)
  }, [token])

  useEffect(() => {
    if (!token) return
    void refreshProviders().catch((err) =>
      setError(err instanceof Error ? err.message : 'Failed to load providers'),
    )
  }, [token, refreshProviders])

  useEffect(() => {
    if (!token || tab !== 'encounters') return
    void refreshEncounters().catch((err) =>
      setError(err instanceof Error ? err.message : 'Failed to load encounters'),
    )
  }, [token, tab, refreshEncounters])

  useEffect(() => {
    if (!token || tab !== 'templates') return
    void refreshTemplates().catch((err) =>
      setError(err instanceof Error ? err.message : 'Failed to load templates'),
    )
  }, [token, tab, refreshTemplates])

  async function handleCreateProvider(event: FormEvent) {
    event.preventDefault()
    if (!token) return
    setError(null)
    try {
      await adminCreateProvider(token, newProvider)
      setNewProvider({ email: '', full_name: '', password: 'provider123' })
      await refreshProviders()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create provider')
    }
  }

  async function toggleProviderActive(provider: User) {
    if (!token) return
    setError(null)
    try {
      await adminUpdateProvider(token, provider.id, {
        is_active: !provider.is_active,
      })
      await refreshProviders()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update provider')
    }
  }

  async function handleSaveTemplate(event: FormEvent) {
    event.preventDefault()
    if (!token || !editingTemplate) return
    setError(null)
    try {
      await adminUpdateTemplate(token, editingTemplate.id, {
        name: editingTemplate.name,
        description: editingTemplate.description,
        system_prompt_addon: editingTemplate.system_prompt_addon,
        is_active: editingTemplate.is_active,
      })
      setEditingTemplate(null)
      await refreshTemplates()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update template')
    }
  }

  async function handleCreateTemplate(event: FormEvent) {
    event.preventDefault()
    if (!token) return
    setError(null)
    try {
      await adminCreateTemplate(token, newTemplate)
      setNewTemplate({
        name: '',
        slug: '',
        description: '',
        system_prompt_addon: '',
      })
      await refreshTemplates()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create template')
    }
  }

  async function handleDeleteTemplate(templateId: number) {
    if (!token) return
    setError(null)
    try {
      await adminDeleteTemplate(token, templateId)
      await refreshTemplates()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template')
    }
  }

  return (
    <div className="app admin-app">
      <header className="header row">
        <div>
          <h1>Admin dashboard</h1>
          <p>
            Signed in as {user?.full_name}. Manage encounters, providers, and note
            templates.
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Admin sections">
        {(['encounters', 'providers', 'templates'] as Tab[]).map((id) => (
          <button
            key={id}
            type="button"
            className={tab === id ? '' : 'secondary'}
            onClick={() => setTab(id)}
          >
            {id.charAt(0).toUpperCase() + id.slice(1)}
          </button>
        ))}
      </nav>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {tab === 'encounters' && (
        <section className="panel">
          <div className="admin-filters">
            <label className="field">
              <span>Provider</span>
              <select
                value={filterProviderId}
                onChange={(e) => setFilterProviderId(e.target.value)}
              >
                <option value="">All providers</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From</span>
              <input
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
              />
            </label>
            <button type="button" className="secondary" onClick={() => void refreshEncounters()}>
              Apply filters
            </button>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Provider</th>
                  <th>Patient</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {encounters.map((enc) => (
                  <tr key={enc.id}>
                    <td>
                      <Link to={`/encounters/${enc.id}`}>{enc.id}</Link>
                    </td>
                    <td>{enc.provider?.full_name ?? enc.provider_id}</td>
                    <td>
                      {enc.patient
                        ? `${enc.patient.first_name} ${enc.patient.last_name}`
                        : enc.patient_id}
                    </td>
                    <td>{enc.status}</td>
                    <td>
                      {enc.created_at
                        ? new Date(enc.created_at).toLocaleString()
                        : '—'}
                    </td>
                    <td>{enc.has_note ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
                {encounters.length === 0 && (
                  <tr>
                    <td colSpan={6}>No encounters match these filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'providers' && (
        <section className="panel">
          <h2>Provider roster</h2>
          <ul className="admin-list">
            {providers.map((p) => (
              <li key={p.id} className="admin-list-item">
                <div>
                  <strong>{p.full_name}</strong>
                  <div className="hint">
                    {p.email} · {p.is_active ? 'Active' : 'Deactivated'}
                  </div>
                </div>
                <button
                  type="button"
                  className={p.is_active ? 'danger' : ''}
                  onClick={() => void toggleProviderActive(p)}
                >
                  {p.is_active ? 'Deactivate' : 'Reactivate'}
                </button>
              </li>
            ))}
          </ul>

          <h3>Add provider</h3>
          <form className="admin-form" onSubmit={handleCreateProvider}>
            <label className="field">
              <span>Full name</span>
              <input
                value={newProvider.full_name}
                onChange={(e) =>
                  setNewProvider((prev) => ({ ...prev, full_name: e.target.value }))
                }
                required
              />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={newProvider.email}
                onChange={(e) =>
                  setNewProvider((prev) => ({ ...prev, email: e.target.value }))
                }
                required
              />
            </label>
            <label className="field">
              <span>Temp password</span>
              <input
                value={newProvider.password}
                onChange={(e) =>
                  setNewProvider((prev) => ({ ...prev, password: e.target.value }))
                }
                required
              />
            </label>
            <button type="submit">Create provider</button>
          </form>
        </section>
      )}

      {tab === 'templates' && (
        <section className="panel">
          <h2>Note templates</h2>
          <p className="hint">
            Edits take effect on the provider&apos;s next Generate without a page refresh —
            the server loads the template at generation time.
          </p>
          <ul className="admin-list">
            {templates.map((t) => (
              <li key={t.id} className="admin-list-item">
                <div>
                  <strong>{t.name}</strong>
                  <div className="hint">
                    {t.slug} · {t.is_active ? 'Active' : 'Inactive'}
                  </div>
                  <p className="empty">{t.description}</p>
                </div>
                <div className="header-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setEditingTemplate({ ...t })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void handleDeleteTemplate(t.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {editingTemplate && (
            <form className="admin-form" onSubmit={handleSaveTemplate}>
              <h3>Edit template</h3>
              <label className="field">
                <span>Name</span>
                <input
                  value={editingTemplate.name}
                  onChange={(e) =>
                    setEditingTemplate({ ...editingTemplate, name: e.target.value })
                  }
                  required
                />
              </label>
              <label className="field">
                <span>Description</span>
                <input
                  value={editingTemplate.description}
                  onChange={(e) =>
                    setEditingTemplate({
                      ...editingTemplate,
                      description: e.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>System prompt add-on</span>
                <textarea
                  rows={6}
                  value={editingTemplate.system_prompt_addon}
                  onChange={(e) =>
                    setEditingTemplate({
                      ...editingTemplate,
                      system_prompt_addon: e.target.value,
                    })
                  }
                  required
                />
              </label>
              <label className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={editingTemplate.is_active}
                  onChange={(e) =>
                    setEditingTemplate({
                      ...editingTemplate,
                      is_active: e.target.checked,
                    })
                  }
                />
                <span>Active</span>
              </label>
              <div className="header-actions">
                <button type="submit">Save template</button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditingTemplate(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <form className="admin-form" onSubmit={handleCreateTemplate}>
            <h3>Create template</h3>
            <label className="field">
              <span>Name</span>
              <input
                value={newTemplate.name}
                onChange={(e) =>
                  setNewTemplate((prev) => ({ ...prev, name: e.target.value }))
                }
                required
              />
            </label>
            <label className="field">
              <span>Slug</span>
              <input
                value={newTemplate.slug}
                onChange={(e) =>
                  setNewTemplate((prev) => ({ ...prev, slug: e.target.value }))
                }
                required
              />
            </label>
            <label className="field">
              <span>Description</span>
              <input
                value={newTemplate.description}
                onChange={(e) =>
                  setNewTemplate((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
              />
            </label>
            <label className="field">
              <span>System prompt add-on</span>
              <textarea
                rows={5}
                value={newTemplate.system_prompt_addon}
                onChange={(e) =>
                  setNewTemplate((prev) => ({
                    ...prev,
                    system_prompt_addon: e.target.value,
                  }))
                }
                required
              />
            </label>
            <button type="submit">Create template</button>
          </form>
        </section>
      )}
    </div>
  )
}
