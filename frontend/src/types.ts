export type InputType = 'transcript' | 'observations'

export type SoapNote = {
  subjective: string
  objective: string
  assessment: string
  plan: string
}

export type User = {
  id: number
  email: string
  full_name: string
  role: 'provider' | 'admin'
}

export type Patient = {
  id: number
  provider_id: number
  first_name: string
  last_name: string
  date_of_birth: string
}

export type NoteVersion = {
  id: number
  note_id: number
  version_number: number
  snapshot: SoapNote
  source: 'manual' | 'voice_session'
  created_by: number
  created_at: string
}

export type Note = SoapNote & {
  id: number
  encounter_id: number
  updated_at: string | null
}

export type Encounter = {
  id: number
  provider_id: number
  patient_id: number
  patient: Patient | null
  input_text: string
  input_type: InputType
  status: string
  created_at: string | null
  updated_at: string | null
  note: Note | null
  versions?: NoteVersion[]
}

export type IcdSuggestion = {
  id: number
  note_id: number
  code: string
  description: string
  similarity: number
  status: 'suggested' | 'accepted' | 'rejected'
  created_at: string
}

export type IcdSearchResult = {
  code: string
  description: string
  similarity: number
}

export const EMPTY_SOAP: SoapNote = {
  subjective: '',
  objective: '',
  assessment: '',
  plan: '',
}

export const SOAP_SECTIONS: { key: keyof SoapNote; label: string }[] = [
  { key: 'subjective', label: 'Subjective' },
  { key: 'objective', label: 'Objective' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'plan', label: 'Plan' },
]
