export type InputType = 'transcript' | 'observations'

export type SoapNote = {
  subjective: string
  objective: string
  assessment: string
  plan: string
}

export type SoapKey = keyof SoapNote

export type User = {
  id: number
  email: string
  full_name: string
  role: 'provider' | 'admin'
  is_active?: boolean
}

export type NoteTemplate = {
  id: number
  name: string
  slug: string
  description: string
  system_prompt_addon: string
  is_active: boolean
  created_at: string | null
  updated_at: string | null
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
  snapshot: SoapNote & { restored_from_version?: number }
  source: 'manual' | 'voice_session' | 'revert'
  created_by: number
  created_by_name?: string | null
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
  template_id?: number | null
  patient: Patient | null
  template?: NoteTemplate | null
  input_text: string
  input_type: InputType
  status: string
  last_draft_at?: string | null
  created_at: string | null
  updated_at: string | null
  note: Note | null
  versions?: NoteVersion[]
  prior_note_count?: number
  returning_patient?: boolean
}

export type PatientSummary = Patient & {
  encounter_count: number
  last_encounter_at: string | null
  last_status: string | null
}

export type PatientHistoryEncounter = {
  id: number
  provider_id: number
  patient_id: number
  input_text: string
  input_type: InputType
  status: string
  created_at: string | null
  updated_at: string | null
  has_note: boolean
}

export type PatientDetail = {
  patient: Patient
  encounters: PatientHistoryEncounter[]
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

export type AdminEncounterRow = Encounter & {
  provider?: { id: number; full_name: string; email: string }
  has_note?: boolean
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
