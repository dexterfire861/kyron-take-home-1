import { useCallback, useEffect, useRef, useState } from 'react'
import { createRealtimeSession } from '../api'
import type { SoapNote } from '../types'

type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error'

const LOG_PREFIX = '%c[voice]'
const LOG_STYLE = 'color:#0f766e;font-weight:600'

export type RealtimeVoiceHandlers = {
  /** A proposed edit arrived (from apply_soap_edits) — stage it as a pending diff, do not commit it. */
  onProposeEdit: (partial: Partial<SoapNote>, summary?: string) => void
  /** The provider verbally confirmed the pending proposal — merge it into the note. */
  onConfirmProposal: () => void
  /** The provider verbally rejected the pending proposal — discard it. */
  onRejectProposal: () => void
}

function extractFunctionArgs(event: Record<string, unknown>): string | null {
  // Support a few Realtime event shapes for tool/function calls
  if (typeof event.arguments === 'string') return event.arguments
  const item = event.item as Record<string, unknown> | undefined
  if (item && typeof item.arguments === 'string') return item.arguments
  return null
}

/** Realtime puts call_id on the event *or* nested under item — never invent one. */
function resolveCallId(event: Record<string, unknown>): string | null {
  if (typeof event.call_id === 'string' && event.call_id && event.call_id !== 'default') {
    return event.call_id
  }
  const item = event.item as Record<string, unknown> | undefined
  if (item && typeof item.call_id === 'string' && item.call_id && item.call_id !== 'default') {
    return item.call_id
  }
  return null
}

function isActiveResponseError(message: string): boolean {
  return /already has an active response/i.test(message)
}

function isBenignToolCallIdError(message: string): boolean {
  return /tool call id ['"]?default['"]? not found/i.test(message)
}

export function useRealtimeVoice(token: string | null, handlers: RealtimeVoiceHandlers) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastSummary, setLastSummary] = useState<string | null>(null)
  const [heardText, setHeardText] = useState<string>('')
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const argBufferRef = useRef<Record<string, string>>({})
  const callNameRef = useRef<Record<string, string>>({})
  const appliedCallIdsRef = useRef<Set<string>>(new Set())
  const transcriptBufferRef = useRef<Record<string, string>>({})
  // Realtime rejects overlapping response.create calls. Tool-call "done"
  // events often arrive *before* the parent response.done, so we must wait
  // (or queue) before asking the model to continue after a function output.
  const responseActiveRef = useRef(false)
  const pendingResponseCreateRef = useRef(false)

  // The data channel is a long-lived imperative object whose `onmessage`
  // handler is only assigned once per `start()` call. Routing handler
  // lookups through a ref (updated every render) means callers don't need
  // to worry about `handleServerEvent`'s identity going stale mid-session —
  // e.g. when the pending-proposal state (and therefore onConfirmProposal /
  // onRejectProposal) changes after the voice session already started.
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  const flushPendingResponseCreate = useCallback(() => {
    if (!pendingResponseCreateRef.current) return
    if (responseActiveRef.current) return
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    pendingResponseCreateRef.current = false
    console.log(LOG_PREFIX, LOG_STYLE, 'flushing queued response.create')
    responseActiveRef.current = true
    dc.send(JSON.stringify({ type: 'response.create' }))
  }, [])

  const requestResponseCreate = useCallback(() => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return
    if (responseActiveRef.current) {
      pendingResponseCreateRef.current = true
      console.log(
        LOG_PREFIX,
        LOG_STYLE,
        'response still active — queued response.create for after response.done',
      )
      return
    }
    pendingResponseCreateRef.current = false
    responseActiveRef.current = true
    dc.send(JSON.stringify({ type: 'response.create' }))
  }, [])

  const stop = useCallback(() => {
    dcRef.current?.close()
    pcRef.current?.close()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    dcRef.current = null
    pcRef.current = null
    streamRef.current = null
    responseActiveRef.current = false
    pendingResponseCreateRef.current = false
    setStatus('idle')
  }, [])

  const handleServerEvent = useCallback((raw: string) => {
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

      // Recover from the common race: we asked for a follow-up response
      // while the previous one was still finishing. Keep the tool output
      // ack; just retry create after the active response ends.
      if (isActiveResponseError(message)) {
        responseActiveRef.current = true
        pendingResponseCreateRef.current = true
        // Cancel the stuck/overlapping create attempt if the API allows it,
        // then wait for response.done to flush the queued create.
        try {
          dcRef.current?.send(JSON.stringify({ type: 'response.cancel' }))
        } catch {
          // ignore — cancel is best-effort
        }
        return
      }

      // Stale acks with a synthetic call_id — ignore; we no longer send these.
      if (isBenignToolCallIdError(message)) {
        console.warn(LOG_PREFIX, LOG_STYLE, 'ignoring stale tool-call-id error:', message)
        return
      }

      setError(message)
      return
    }

    if (type === 'response.created') {
      responseActiveRef.current = true
      return
    }

    if (type === 'response.done' || type === 'response.cancelled') {
      responseActiveRef.current = false
      const response = event.response as Record<string, unknown> | undefined
      if (type === 'response.done' && response?.status === 'failed') {
        const statusDetails = response.status_details as
          | Record<string, unknown>
          | undefined
        const err = statusDetails?.error as Record<string, unknown> | undefined
        const message =
          (err?.message as string | undefined) ?? 'Response generation failed'
        console.error(LOG_PREFIX, LOG_STYLE, 'response failed:', statusDetails ?? response)
        if (!isActiveResponseError(message)) {
          setError(message)
        }
      }
      flushPendingResponseCreate()
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

    // --- Tool call bookkeeping: the Realtime API announces a function call
    // via `response.output_item.added` before its arguments stream in, so
    // capture the tool name here (the later "done" events don't reliably
    // include it) and key everything off the real call_id.
    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type === 'function_call') {
        const callId = resolveCallId(event)
        const name = typeof item.name === 'string' ? item.name : ''
        if (callId && name) callNameRef.current[callId] = name
      }
      return
    }

    if (type === 'response.function_call_arguments.delta') {
      const callId = resolveCallId(event)
      if (!callId) return
      const delta = typeof event.delta === 'string' ? event.delta : ''
      argBufferRef.current[callId] = (argBufferRef.current[callId] ?? '') + delta
      return
    }

    if (
      type === 'response.function_call_arguments.done' ||
      type === 'response.output_item.done' ||
      type === 'conversation.item.done'
    ) {
      const item = event.item as Record<string, unknown> | undefined

      // output_item.done / conversation.item.done also fire for text items —
      // only continue for real function calls.
      if (
        type !== 'response.function_call_arguments.done' &&
        item?.type !== 'function_call'
      ) {
        return
      }

      const callId = resolveCallId(event)
      if (!callId) {
        console.warn(
          LOG_PREFIX,
          LOG_STYLE,
          'ignoring tool done event without call_id (would have been "default")',
          type,
          event,
        )
        return
      }

      if (item?.type === 'function_call' && typeof item.name === 'string' && item.name) {
        callNameRef.current[callId] = item.name
      }

      let argsText = argBufferRef.current[callId] ?? extractFunctionArgs(event) ?? ''
      if (!argsText && item?.type === 'function_call' && typeof item.arguments === 'string') {
        argsText = item.arguments
      }
      if (!argsText) return

      // The Realtime API fires multiple "done"-style events for the same
      // function call; only act on the first one per call_id.
      if (appliedCallIdsRef.current.has(callId)) {
        delete argBufferRef.current[callId]
        return
      }

      const toolName = callNameRef.current[callId] ?? 'apply_soap_edits'
      console.log(LOG_PREFIX, LOG_STYLE, 'tool call:', toolName, 'call_id=', callId, argsText)

      const ackAndRespond = (ackStatus: string) => {
        // Tell the model the tool call was handled so it can continue.
        // Without this ack the Realtime API leaves the tool call dangling.
        // Do NOT send response.create while the parent response is still
        // active — that produces "already has an active response in progress".
        // Never ack with a synthetic call_id — API returns
        // "Tool call ID 'default' not found in conversation."
        dcRef.current?.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ status: ackStatus }),
            },
          }),
        )
        requestResponseCreate()
      }

      if (toolName === 'confirm_pending_edits') {
        appliedCallIdsRef.current.add(callId)
        delete argBufferRef.current[callId]
        delete callNameRef.current[callId]
        console.log(LOG_PREFIX, LOG_STYLE, 'confirming pending proposal (voice)')
        handlersRef.current.onConfirmProposal()
        ackAndRespond('confirmed')
        return
      }

      if (toolName === 'reject_pending_edits') {
        appliedCallIdsRef.current.add(callId)
        delete argBufferRef.current[callId]
        delete callNameRef.current[callId]
        console.log(LOG_PREFIX, LOG_STYLE, 'rejecting pending proposal (voice)')
        handlersRef.current.onRejectProposal()
        ackAndRespond('rejected')
        return
      }

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
          delete callNameRef.current[callId]
          console.log(LOG_PREFIX, LOG_STYLE, 'proposing note edit:', partial)
          handlersRef.current.onProposeEdit(partial, args.assistant_summary)
          if (args.assistant_summary) setLastSummary(args.assistant_summary)
          ackAndRespond('proposed')
          console.log(LOG_PREFIX, LOG_STYLE, 'sent function_call_output + queued/sent response.create')
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
  }, [flushPendingResponseCreate, requestResponseCreate])

  const start = useCallback(
    async (encounterId: number) => {
      if (!token) throw new Error('Not authenticated')
      stop()
      setError(null)
      setLastSummary(null)
      setHeardText('')
      setStatus('connecting')
      argBufferRef.current = {}
      callNameRef.current = {}
      appliedCallIdsRef.current = new Set()
      transcriptBufferRef.current = {}
      responseActiveRef.current = false
      pendingResponseCreateRef.current = false

      try {
        const { client_secret, model } = await createRealtimeSession(
          token,
          encounterId,
        )

        const pc = new RTCPeerConnection()
        pcRef.current = pc

        // No pc.ontrack wiring — the session is configured for text-only
        // output_modalities, so no audio track is ever sent back to play.

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
