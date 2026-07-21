import { extractSseEvents } from './lib/sse'
import type {
  AdminEncounterRow,
  Encounter,
  IcdSearchResult,
  IcdSuggestion,
  InputType,
  Note,
  NoteTemplate,
  NoteVersion,
  PatientDetail,
  PatientSummary,
  SoapNote,
  User,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5001'

export class ApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function authHeaders(token?: string | null): HeadersInit {
  const headers: HeadersInit = { 'Content-Type': 'application/json' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

async function parseError(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => ({}))
  const code = typeof data.error === 'string' ? data.error : undefined
  const message =
    typeof data.message === 'string'
      ? data.message
      : typeof data.error === 'string'
        ? data.error
        : `Request failed (${response.status})`
  return new ApiError(message, response.status, code)
}

export async function login(
  email: string,
  password: string,
): Promise<{ access_token: string; user: User }> {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function fetchMe(token: string): Promise<User> {
  const response = await fetch(`${API_BASE}/api/auth/me`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
  const data = await response.json()
  return data.user as User
}

export async function listPatients(
  token: string,
): Promise<{ patients: PatientSummary[] }> {
  const response = await fetch(`${API_BASE}/api/patients`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function getPatientDetail(
  token: string,
  patientId: number,
): Promise<PatientDetail> {
  const response = await fetch(`${API_BASE}/api/patients/${patientId}`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function listTemplates(
  token: string,
): Promise<{ templates: NoteTemplate[] }> {
  const response = await fetch(`${API_BASE}/api/templates`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function createEncounter(
  token: string,
  payload: {
    first_name: string
    last_name: string
    date_of_birth: string
    template_id?: number
  },
): Promise<Encounter> {
  const response = await fetch(`${API_BASE}/api/encounters`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await parseError(response)
  const data = await response.json()
  return data.encounter as Encounter
}

export async function getEncounter(
  token: string,
  encounterId: number,
): Promise<Encounter> {
  const response = await fetch(`${API_BASE}/api/encounters/${encounterId}`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
  const data = await response.json()
  return data.encounter as Encounter
}

export async function saveEncounterDraft(
  token: string,
  encounterId: number,
  payload: Partial<SoapNote> & {
    input_text?: string
    input_type?: InputType
    template_id?: number | null
  },
): Promise<Encounter> {
  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/draft`,
    {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    },
  )
  if (!response.ok) throw await parseError(response)
  const data = await response.json()
  return data.encounter as Encounter
}

export type SoapStreamHandlers = {
  onContext?: (data: { prior_note_count: number; returning_patient: boolean }) => void
  onSectionStart?: (section: keyof SoapNote) => void
  onSectionDelta?: (section: keyof SoapNote, delta: string) => void
  onSectionEnd?: (section: keyof SoapNote, text: string) => void
  onDone?: (note: SoapNote) => void
  onError?: (message: string) => void
}

export async function streamSoapGenerate(
  token: string,
  encounterId: number,
  text: string,
  inputType: InputType,
  handlers: SoapStreamHandlers,
  signal?: AbortSignal,
  templateId?: number | null,
): Promise<void> {
  const body: Record<string, unknown> = { text, input_type: inputType }
  if (templateId != null) body.template_id = templateId

  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/generate`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal,
    },
  )

  if (!response.ok) throw await parseError(response)
  if (!response.body) {
    throw new Error('Streaming is not supported in this browser')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const { events, remainder } = extractSseEvents(buffer)
    buffer = remainder

    for (const { event, data: dataLine } of events) {
      const data = JSON.parse(dataLine)
      if (event === 'context') handlers.onContext?.(data)
      if (event === 'section_start') handlers.onSectionStart?.(data.section)
      if (event === 'section_delta') {
        handlers.onSectionDelta?.(data.section, data.delta)
      }
      if (event === 'section_end') {
        handlers.onSectionEnd?.(data.section, data.text)
      }
      if (event === 'done') handlers.onDone?.(data.note)
      if (event === 'error') handlers.onError?.(data.error ?? 'Stream error')
    }
  }
}

export async function saveNote(
  token: string,
  encounterId: number,
  note: SoapNote,
  source: 'manual' | 'voice_session' = 'manual',
): Promise<{ note: Note; version: NoteVersion }> {
  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/note`,
    {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ ...note, source }),
    },
  )
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function restoreNoteVersion(
  token: string,
  encounterId: number,
  versionId: number,
): Promise<{ note: Note; version: NoteVersion; restored_from: NoteVersion }> {
  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/versions/${versionId}/restore`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  )
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function suggestIcdCodes(
  token: string,
  encounterId: number,
): Promise<{ suggestions: IcdSuggestion[] }> {
  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/icd10/suggest`,
    { method: 'POST', headers: authHeaders(token) },
  )
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function getIcdSuggestions(
  token: string,
  encounterId: number,
): Promise<{ suggestions: IcdSuggestion[] }> {
  const response = await fetch(`${API_BASE}/api/encounters/${encounterId}/icd10`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function updateIcdSuggestion(
  token: string,
  encounterId: number,
  suggestionId: number,
  status: 'accepted' | 'rejected',
): Promise<{ suggestion: IcdSuggestion }> {
  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/icd10/${suggestionId}`,
    {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ status }),
    },
  )
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function searchIcdCodes(
  token: string,
  query: string,
): Promise<{ results: IcdSearchResult[] }> {
  const response = await fetch(
    `${API_BASE}/api/icd10/search?q=${encodeURIComponent(query)}`,
    { headers: authHeaders(token) },
  )
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function createRealtimeSession(
  token: string,
  encounterId: number,
): Promise<{ client_secret: string; model: string }> {
  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/realtime/session`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  )
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function createTranscriptionSession(
  token: string,
  encounterId: number,
): Promise<{ client_secret: string }> {
  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/realtime/transcription-session`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  )
  if (!response.ok) throw await parseError(response)
  return response.json()
}

// --- Admin ---

export async function adminListEncounters(
  token: string,
  params: { provider_id?: number; from?: string; to?: string } = {},
): Promise<{ encounters: AdminEncounterRow[] }> {
  const qs = new URLSearchParams()
  if (params.provider_id) qs.set('provider_id', String(params.provider_id))
  if (params.from) qs.set('from', params.from)
  if (params.to) qs.set('to', params.to)
  const response = await fetch(
    `${API_BASE}/api/admin/encounters?${qs.toString()}`,
    { headers: authHeaders(token) },
  )
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function adminListProviders(
  token: string,
): Promise<{ providers: User[] }> {
  const response = await fetch(`${API_BASE}/api/admin/providers`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function adminCreateProvider(
  token: string,
  payload: { email: string; full_name: string; password: string },
): Promise<User> {
  const response = await fetch(`${API_BASE}/api/admin/providers`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await parseError(response)
  const data = await response.json()
  return data.provider as User
}

export async function adminUpdateProvider(
  token: string,
  providerId: number,
  payload: { full_name?: string; is_active?: boolean; password?: string },
): Promise<User> {
  const response = await fetch(`${API_BASE}/api/admin/providers/${providerId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await parseError(response)
  const data = await response.json()
  return data.provider as User
}

export async function adminListTemplates(
  token: string,
): Promise<{ templates: NoteTemplate[] }> {
  const response = await fetch(`${API_BASE}/api/admin/templates`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
  return response.json()
}

export async function adminCreateTemplate(
  token: string,
  payload: Partial<NoteTemplate> & {
    name: string
    slug: string
    system_prompt_addon: string
  },
): Promise<NoteTemplate> {
  const response = await fetch(`${API_BASE}/api/admin/templates`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await parseError(response)
  const data = await response.json()
  return data.template as NoteTemplate
}

export async function adminUpdateTemplate(
  token: string,
  templateId: number,
  payload: Partial<NoteTemplate>,
): Promise<NoteTemplate> {
  const response = await fetch(`${API_BASE}/api/admin/templates/${templateId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await parseError(response)
  const data = await response.json()
  return data.template as NoteTemplate
}

export async function adminDeleteTemplate(
  token: string,
  templateId: number,
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/admin/templates/${templateId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseError(response)
}
