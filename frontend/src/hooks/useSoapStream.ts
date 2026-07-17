import { useCallback, useRef, useState } from 'react'
import { streamSoapGenerate } from '../api'
import type { InputType, SoapNote } from '../types'
import { EMPTY_SOAP } from '../types'

export function useSoapStream(token: string | null) {
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const generate = useCallback(
    async (
      encounterId: number,
      text: string,
      inputType: InputType,
      onUpdate: (note: SoapNote) => void,
    ) => {
      if (!token) throw new Error('Not authenticated')
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setStreaming(true)
      setError(null)
      let draft: SoapNote = { ...EMPTY_SOAP }
      onUpdate(draft)

      try {
        await streamSoapGenerate(
          token,
          encounterId,
          text,
          inputType,
          {
            onSectionStart(section) {
              draft = { ...draft, [section]: '' }
              onUpdate(draft)
            },
            onSectionDelta(section, delta) {
              draft = { ...draft, [section]: draft[section] + delta }
              onUpdate({ ...draft })
            },
            onSectionEnd(section, textValue) {
              draft = { ...draft, [section]: textValue }
              onUpdate({ ...draft })
            },
            onDone(note) {
              draft = { ...note }
              onUpdate(draft)
            },
            onError(message) {
              setError(message)
            },
          },
          controller.signal,
        )
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Generation failed')
        }
      } finally {
        setStreaming(false)
      }
    },
    [token],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { generate, streaming, error, setError, cancel }
}
