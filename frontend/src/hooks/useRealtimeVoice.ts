import { useCallback, useRef, useState } from 'react'
import { createRealtimeSession } from '../api'
import type { SoapNote } from '../types'

type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error'

const LOG_PREFIX = '%c[voice]'
const LOG_STYLE = 'color:#0f766e;font-weight:600'

function extractFunctionArgs(event: Record<string, unknown>): string | null {
  // Support a few Realtime event shapes for tool/function calls
  if (typeof event.arguments === 'string') return event.arguments
  const item = event.item as Record<string, unknown> | undefined
  if (item && typeof item.arguments === 'string') return item.arguments
  const delta = event.delta as string | undefined
  if (typeof delta === 'string') return null
  return null
}

export function useRealtimeVoice(
  token: string | null,
  onNoteEdit: (partial: Partial<SoapNote>, summary?: string) => void,
) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastSummary, setLastSummary] = useState<string | null>(null)
  const [heardText, setHeardText] = useState<string>('')
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const argBufferRef = useRef<Record<string, string>>({})
  const appliedCallIdsRef = useRef<Set<string>>(new Set())
  const transcriptBufferRef = useRef<Record<string, string>>({})

  const stop = useCallback(() => {
    dcRef.current?.close()
    pcRef.current?.close()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    dcRef.current = null
    pcRef.current = null
    streamRef.current = null
    if (audioRef.current) {
      audioRef.current.srcObject = null
    }
    setStatus('idle')
  }, [])

  const handleServerEvent = useCallback(
    (raw: string) => {
      let event: Record<string, unknown>
      try {
        event = JSON.parse(raw)
      } catch {
        console.warn(LOG_PREFIX, LOG_STYLE, 'received non-JSON message', raw)
        return
      }

      const type = String(event.type ?? '')

      // Full firehose so you can see exactly what's coming over the wire.
      // Delta events are extremely chatty, so those get a single collapsed
      // debug line; everything else is logged in full.
      if (type.endsWith('.delta')) {
        console.debug(LOG_PREFIX, LOG_STYLE, type)
      } else {
        console.log(LOG_PREFIX, LOG_STYLE, type, event)
      }

      // --- Errors: the Realtime API reports problems (bad session config,
      // rate limits, malformed tool calls) via a dedicated "error" event.
      // Previously this was silently ignored, which can look identical to
      // "the model just didn't do anything."
      if (type === 'error') {
        const err = event.error as Record<string, unknown> | undefined
        const message =
          (err?.message as string | undefined) ?? 'Realtime API reported an error'
        console.error(LOG_PREFIX, LOG_STYLE, 'server error:', err ?? event)
        setError(message)
        return
      }

      if (type === 'response.done') {
        const response = event.response as Record<string, unknown> | undefined
        if (response?.status === 'failed') {
          const statusDetails = response.status_details as
            | Record<string, unknown>
            | undefined
          const err = statusDetails?.error as Record<string, unknown> | undefined
          const message =
            (err?.message as string | undefined) ?? 'Response generation failed'
          console.error(LOG_PREFIX, LOG_STYLE, 'response failed:', statusDetails ?? response)
          setError(message)
        }
        return
      }

      // --- What the model heard you say (input speech-to-text) ---
      if (type === 'conversation.item.input_audio_transcription.delta') {
        const itemId = String(event.item_id ?? 'default')
        const delta = typeof event.delta === 'string' ? event.delta : ''
        transcriptBufferRef.current[itemId] =
          (transcriptBufferRef.current[itemId] ?? '') + delta
        setHeardText(transcriptBufferRef.current[itemId])
        return
      }

      if (type === 'conversation.item.input_audio_transcription.completed') {
        const itemId = String(event.item_id ?? 'default')
        const finalText =
          (event.transcript as string | undefined) ??
          transcriptBufferRef.current[itemId] ??
          ''
        console.log(LOG_PREFIX, LOG_STYLE, 'heard:', finalText)
        setHeardText(finalText)
        delete transcriptBufferRef.current[itemId]
        return
      }

      if (type === 'conversation.item.input_audio_transcription.failed') {
        console.error(LOG_PREFIX, LOG_STYLE, 'transcription failed:', event.error)
        return
      }

      if (type === 'response.function_call_arguments.delta') {
        const callId = String(event.call_id ?? 'default')
        const delta = typeof event.delta === 'string' ? event.delta : ''
        argBufferRef.current[callId] = (argBufferRef.current[callId] ?? '') + delta
        return
      }

      if (
        type === 'response.function_call_arguments.done' ||
        type === 'response.output_item.done' ||
        type === 'conversation.item.done'
      ) {
        const callId = String(event.call_id ?? 'default')
        let argsText =
          argBufferRef.current[callId] ?? extractFunctionArgs(event) ?? ''

        const item = event.item as Record<string, unknown> | undefined
        if (!argsText && item?.type === 'function_call' && typeof item.arguments === 'string') {
          argsText = item.arguments
        }
        if (!argsText) return

        // The Realtime API fires multiple "done"-style events for the same
        // function call (function_call_arguments.done, output_item.done,
        // conversation.item.done); only act on the first one per call_id.
        if (appliedCallIdsRef.current.has(callId)) {
          delete argBufferRef.current[callId]
          return
        }

        console.log(LOG_PREFIX, LOG_STYLE, 'tool call arguments:', argsText)

        try {
          const args = JSON.parse(argsText) as Partial<SoapNote> & {
            assistant_summary?: string
          }
          const partial: Partial<SoapNote> = {}
          for (const key of ['subjective', 'objective', 'assessment', 'plan'] as const) {
            if (typeof args[key] === 'string') partial[key] = args[key]
          }
          if (Object.keys(partial).length > 0) {
            appliedCallIdsRef.current.add(callId)
            console.log(LOG_PREFIX, LOG_STYLE, 'applying note edit:', partial)
            onNoteEdit(partial, args.assistant_summary)
            if (args.assistant_summary) setLastSummary(args.assistant_summary)

            // Tell the model the edit succeeded so it can confirm out loud
            // and continue the conversation. Without this ack the Realtime
            // API leaves the tool call dangling and the assistant goes
            // silent instead of responding.
            dcRef.current?.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: callId,
                  output: JSON.stringify({ status: 'applied' }),
                },
              }),
            )
            dcRef.current?.send(JSON.stringify({ type: 'response.create' }))
            console.log(LOG_PREFIX, LOG_STYLE, 'sent function_call_output + response.create')
          } else {
            console.warn(
              LOG_PREFIX,
              LOG_STYLE,
              'tool call arguments parsed but had no SOAP fields:',
              args,
            )
          }
        } catch (err) {
          console.error(LOG_PREFIX, LOG_STYLE, 'failed to parse tool call arguments:', argsText, err)
        } finally {
          delete argBufferRef.current[callId]
        }
      }
    },
    [onNoteEdit],
  )

  const start = useCallback(
    async (encounterId: number) => {
      if (!token) throw new Error('Not authenticated')
      stop()
      setError(null)
      setLastSummary(null)
      setHeardText('')
      setStatus('connecting')
      argBufferRef.current = {}
      appliedCallIdsRef.current = new Set()
      transcriptBufferRef.current = {}

      try {
        const { client_secret, model } = await createRealtimeSession(
          token,
          encounterId,
        )

        const pc = new RTCPeerConnection()
        pcRef.current = pc

        const audioEl = audioRef.current ?? new Audio()
        audioEl.autoplay = true
        audioRef.current = audioEl
        pc.ontrack = (e) => {
          audioEl.srcObject = e.streams[0]
        }

        const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = ms
        ms.getTracks().forEach((track) => pc.addTrack(track, ms))

        const dc = pc.createDataChannel('oai-events')
        dcRef.current = dc
        dc.onopen = () => console.log(LOG_PREFIX, LOG_STYLE, 'data channel open')
        dc.onclose = () => console.log(LOG_PREFIX, LOG_STYLE, 'data channel closed')
        dc.onerror = (e) => console.error(LOG_PREFIX, LOG_STYLE, 'data channel error', e)
        dc.onmessage = (e) => handleServerEvent(String(e.data))

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        const baseUrl = 'https://api.openai.com/v1/realtime/calls'
        const sdpResponse = await fetch(baseUrl, {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${client_secret}`,
            'Content-Type': 'application/sdp',
          },
        })

        if (!sdpResponse.ok) {
          const detail = await sdpResponse.text()
          console.error(LOG_PREFIX, LOG_STYLE, 'SDP exchange failed:', detail)
          throw new Error(detail || 'Failed to connect to Realtime API')
        }

        const answer: RTCSessionDescriptionInit = {
          type: 'answer',
          sdp: await sdpResponse.text(),
        }
        await pc.setRemoteDescription(answer)

        console.log(LOG_PREFIX, LOG_STYLE, 'connected, model:', model)
        setStatus('live')
      } catch (err) {
        stop()
        const message =
          err instanceof Error ? err.message : 'Failed to start voice session'
        console.error(LOG_PREFIX, LOG_STYLE, 'failed to start:', err)
        setError(message)
        setStatus('error')
      }
    },
    [token, stop, handleServerEvent],
  )

  return { status, error, lastSummary, heardText, start, stop }
}
