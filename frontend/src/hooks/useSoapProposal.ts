import { useCallback, useRef, useState } from 'react'
import type { SoapKey, SoapNote } from '../types'

export type PendingSection = {
  /** Section text as it stood in the committed note when the proposal started. */
  before: string
  /** Latest proposed text for the section (re-diffed against `before` each update). */
  after: string
}

export type PendingProposal = Partial<Record<SoapKey, PendingSection>>

/**
 * Tracks SOAP edits proposed by voice/AI as a pending diff against the
 * currently committed note, instead of applying them immediately.
 *
 * - `propose` stages/updates a proposal. Calling it again for a section that
 *   already has a pending change re-diffs against the *original* committed
 *   text (not the previous proposal), so further voice refinements always
 *   show the true net change from what's currently saved in the workspace.
 * - `confirmSection`/`confirmAll` merge the proposed text into the note via
 *   `applyChanges` and clear the corresponding pending entries.
 * - `rejectSection`/`rejectAll` discard pending entries without touching the
 *   note.
 */
export function useSoapProposal(
  note: SoapNote,
  applyChanges: (changes: Partial<SoapNote>) => void,
) {
  const [pending, setPending] = useState<PendingProposal>({})
  const [summary, setSummary] = useState<string | null>(null)
  const noteRef = useRef(note)
  noteRef.current = note

  const propose = useCallback((partial: Partial<SoapNote>, summaryText?: string) => {
    setPending((prev) => {
      const next: PendingProposal = { ...prev }
      for (const key of Object.keys(partial) as SoapKey[]) {
        const after = partial[key]
        if (typeof after !== 'string') continue
        const before = prev[key]?.before ?? noteRef.current[key]
        if (after === before) {
          // Proposal now matches the committed text again — nothing pending.
          delete next[key]
        } else {
          next[key] = { before, after }
        }
      }
      return next
    })
    if (summaryText) setSummary(summaryText)
  }, [])

  const confirmSection = useCallback(
    (key: SoapKey) => {
      const section = pending[key]
      if (!section) return
      applyChanges({ [key]: section.after } as Partial<SoapNote>)
      setPending((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    },
    [pending, applyChanges],
  )

  const rejectSection = useCallback((key: SoapKey) => {
    setPending((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const confirmAll = useCallback(() => {
    const changes: Partial<SoapNote> = {}
    for (const key of Object.keys(pending) as SoapKey[]) {
      const section = pending[key]
      if (section) changes[key] = section.after
    }
    if (Object.keys(changes).length > 0) applyChanges(changes)
    setPending({})
    setSummary(null)
  }, [pending, applyChanges])

  const rejectAll = useCallback(() => {
    setPending({})
    setSummary(null)
  }, [])

  const hasPending = Object.keys(pending).length > 0
  const pendingCount = Object.keys(pending).length

  return {
    pending,
    hasPending,
    pendingCount,
    summary,
    propose,
    confirmSection,
    rejectSection,
    confirmAll,
    rejectAll,
  }
}
