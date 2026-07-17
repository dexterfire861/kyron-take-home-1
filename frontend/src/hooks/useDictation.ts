import { useCallback, useRef, useState } from 'react'
import { createTranscriptionSession } from '../api'

type DictationStatus = 'idle' | 'connecting' | 'listening' | 'paused' | 'error'

const LOG_PREFIX = '%c[dictation]'
const LOG_STYLE = 'color:#7c3aed;font-weight:600'

/**
 * Hands-free dictation: streams mic audio to a transcription-only Realtime
 * session (no conversational model, no tool calls, no spoken responses —
 * just low-latency streaming speech-to-text) and reports each finalized
 * utterance as it completes. The caller is responsible for appending
 * transcript text and (debounced) re-running SOAP generation — this hook
 * only owns the audio connection and transcription events.
 */
export function useDictation(token: string | null, onUtterance: (text: string) => void) {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [partialText, setPartialText] = useState('')
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const transcriptBufferRef = useRef<Record<string, string>>({})

  const stop = useCallback(() => {
    dcRef.current?.close()
    pcRef.current?.close()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    dcRef.current = null
    pcRef.current = null
    streamRef.current = null
    setPartialText('')
    setStatus('idle')
  }, [])

  const pause = useCallback(() => {
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false))
    setStatus('paused')
  }, [])

  const resume = useCallback(() => {
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = true))
    setStatus('listening')
  }, [])

  const handleServerEvent = useCallback(
    (raw: string) => {
      let event: Record<string, unknown>
      try {
        event = JSON.parse(raw)
      } catch {
        return
      }

      const type = String(event.type ?? '')
      if (!type.endsWith('.delta')) {
        console.log(LOG_PREFIX, LOG_STYLE, type, event)
      }

      if (type === 'error') {
        const err = event.error as Record<string, unknown> | undefined
        console.error(LOG_PREFIX, LOG_STYLE, 'server error:', err ?? event)
        setError((err?.message as string | undefined) ?? 'Dictation session error')
        return
      }

      if (type === 'conversation.item.input_audio_transcription.delta') {
        const itemId = String(event.item_id ?? 'default')
        const delta = typeof event.delta === 'string' ? event.delta : ''
        transcriptBufferRef.current[itemId] =
          (transcriptBufferRef.current[itemId] ?? '') + delta
        setPartialText(transcriptBufferRef.current[itemId])
        return
      }

      if (type === 'conversation.item.input_audio_transcription.completed') {
        const itemId = String(event.item_id ?? 'default')
        const finalText =
          (event.transcript as string | undefined) ??
          transcriptBufferRef.current[itemId] ??
          ''
        delete transcriptBufferRef.current[itemId]
        setPartialText('')
        if (finalText.trim()) {
          console.log(LOG_PREFIX, LOG_STYLE, 'utterance:', finalText)
          onUtterance(finalText.trim())
        }
        return
      }

      if (type === 'conversation.item.input_audio_transcription.failed') {
        console.error(LOG_PREFIX, LOG_STYLE, 'transcription failed:', event.error)
      }
    },
    [onUtterance],
  )

  const start = useCallback(
    async (encounterId: number) => {
      if (!token) throw new Error('Not authenticated')
      stop()
      setError(null)
      setStatus('connecting')
      transcriptBufferRef.current = {}

      try {
        const { client_secret } = await createTranscriptionSession(token, encounterId)

        const pc = new RTCPeerConnection()
        pcRef.current = pc

        const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = ms
        ms.getTracks().forEach((track) => pc.addTrack(track, ms))

        const dc = pc.createDataChannel('oai-events')
        dcRef.current = dc
        dc.onopen = () => console.log(LOG_PREFIX, LOG_STYLE, 'data channel open')
        dc.onmessage = (e) => handleServerEvent(String(e.data))

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${client_secret}`,
            'Content-Type': 'application/sdp',
          },
        })

        if (!sdpResponse.ok) {
          const detail = await sdpResponse.text()
          throw new Error(detail || 'Failed to connect dictation session')
        }

        await pc.setRemoteDescription({
          type: 'answer',
          sdp: await sdpResponse.text(),
        })

        console.log(LOG_PREFIX, LOG_STYLE, 'listening')
        setStatus('listening')
      } catch (err) {
        stop()
        const message = err instanceof Error ? err.message : 'Failed to start dictation'
        console.error(LOG_PREFIX, LOG_STYLE, 'failed to start:', err)
        setError(message)
        setStatus('error')
      }
    },
    [token, stop, handleServerEvent],
  )

  return { status, error, partialText, start, pause, resume, stop }
}
