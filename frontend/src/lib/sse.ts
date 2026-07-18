/**
 * Minimal, framework-free Server-Sent-Events chunk parser.
 *
 * Extracted from `streamSoapGenerate` (see `../api.ts`) purely so it can be
 * unit tested without a real `fetch`/`ReadableStream`. Behavior is
 * unchanged: SSE events are separated by a blank line (`\n\n`); each event
 * may span multiple `event:`/`data:` lines. Any trailing, not-yet-complete
 * event text is returned as `remainder` so the caller can prepend it to the
 * next decoded chunk.
 */

export type SseEvent = {
  event: string
  data: string
}

export function extractSseEvents(buffer: string): {
  events: SseEvent[]
  remainder: string
} {
  const parts = buffer.split('\n\n')
  const remainder = parts.pop() ?? ''
  const events: SseEvent[] = []

  for (const part of parts) {
    let event = 'message'
    let dataLine = ''
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) dataLine += line.slice(5).trim()
    }
    if (!dataLine) continue
    events.push({ event, data: dataLine })
  }

  return { events, remainder }
}
