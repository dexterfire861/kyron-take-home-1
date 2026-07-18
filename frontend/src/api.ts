import { extractSseEvents } from './lib/sse'
import type {
  Encounter,
  IcdSearchResult,
  IcdSuggestion,
  InputType,
  Note,
  NoteVersion,
  PatientDetail,
  PatientSummary,
  SoapNote,
  User,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5001'

function authHeaders(token?: string | null): HeadersInit {
  const headers: HeadersInit = { 'Content-Type': 'application/json' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

async function parseError(response: Response): Promise<string> {
  const data = await response.json().catch(() => ({}))
  return typeof data.error === 'string' ? data.error : `Request failed (${response.status})`
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
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function fetchMe(token: string): Promise<User> {
  const response = await fetch(`${API_BASE}/api/auth/me`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const data = await response.json()
  return data.user as User
}

export async function listPatients(
  token: string,
): Promise<{ patients: PatientSummary[] }> {
  const response = await fetch(`${API_BASE}/api/patients`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function getPatientDetail(
  token: string,
  patientId: number,
): Promise<PatientDetail> {
  const response = await fetch(`${API_BASE}/api/patients/${patientId}`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function createEncounter(
  token: string,
  payload: { first_name: string; last_name: string; date_of_birth: string },
): Promise<Encounter> {
  const response = await fetch(`${API_BASE}/api/encounters`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(await parseError(response))
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
  if (!response.ok) throw new Error(await parseError(response))
  const data = await response.json()
  return data.encounter as Encounter
}

export type SoapStreamHandlers = {
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
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/api/encounters/${encounterId}/generate`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ text, input_type: inputType }),
      signal,
    },
  )

  if (!response.ok) {
    throw new Error(await parseError(response))
  }
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
  if (!response.ok) throw new Error(await parseError(response))
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
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}

export async function getIcdSuggestions(
  token: string,
  encounterId: number,
): Promise<{ suggestions: IcdSuggestion[] }> {
  const response = await fetch(`${API_BASE}/api/encounters/${encounterId}/icd10`, {
    headers: authHeaders(token),
  })
  if (!response.ok) throw new Error(await parseError(response))
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
  if (!response.ok) throw new Error(await parseError(response))
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
  if (!response.ok) throw new Error(await parseError(response))
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
  if (!response.ok) throw new Error(await parseError(response))
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
  if (!response.ok) throw new Error(await parseError(response))
  return response.json()
}
