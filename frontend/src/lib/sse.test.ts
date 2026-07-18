import { describe, expect, it } from 'vitest'
import { extractSseEvents } from './sse'

describe('extractSseEvents', () => {
  it('parses a single complete event', () => {
    const { events, remainder } = extractSseEvents(
      'event: section_start\ndata: {"section":"subjective"}\n\n',
    )
    expect(events).toEqual([
      { event: 'section_start', data: '{"section":"subjective"}' },
    ])
    expect(remainder).toBe('')
  })

  it('parses multiple events delivered in one chunk', () => {
    const buffer =
      'event: section_start\ndata: {"section":"subjective"}\n\n' +
      'event: section_delta\ndata: {"section":"subjective","delta":"Cough."}\n\n'
    const { events, remainder } = extractSseEvents(buffer)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('section_start')
    expect(events[1].event).toBe('section_delta')
    expect(remainder).toBe('')
  })

  it('holds back an incomplete trailing event as remainder', () => {
    const buffer =
      'event: section_start\ndata: {"section":"subjective"}\n\n' +
      'event: section_delta\ndata: {"secti'
    const { events, remainder } = extractSseEvents(buffer)
    expect(events).toEqual([
      { event: 'section_start', data: '{"section":"subjective"}' },
    ])
    expect(remainder).toBe('event: section_delta\ndata: {"secti')
  })

  it('reassembles an event whose bytes arrive split across two chunks', () => {
    const first = extractSseEvents('event: done\ndata: {"note":{"su')
    expect(first.events).toEqual([])
    expect(first.remainder).toBe('event: done\ndata: {"note":{"su')

    const second = extractSseEvents(first.remainder + 'bjective":"ok"}}\n\n')
    expect(second.events).toEqual([
      { event: 'done', data: '{"note":{"subjective":"ok"}}' },
    ])
    expect(second.remainder).toBe('')
  })

  it('defaults to a "message" event when no event: line is present', () => {
    const { events } = extractSseEvents('data: {"foo":"bar"}\n\n')
    expect(events).toEqual([{ event: 'message', data: '{"foo":"bar"}' }])
  })

  it('joins multi-line data: fields into a single data string', () => {
    const buffer = 'event: done\ndata: {"note":\ndata: {}}\n\n'
    const { events } = extractSseEvents(buffer)
    expect(events).toEqual([{ event: 'done', data: '{"note":{}}' }])
  })

  it('skips blocks with no data: line', () => {
    const buffer = 'event: ping\n\nevent: done\ndata: {"note":{}}\n\n'
    const { events } = extractSseEvents(buffer)
    expect(events).toEqual([{ event: 'done', data: '{"note":{}}' }])
  })

  it('returns no events and an empty remainder for an empty buffer', () => {
    const { events, remainder } = extractSseEvents('')
    expect(events).toEqual([])
    expect(remainder).toBe('')
  })

  it('parses an error event shape', () => {
    const { events } = extractSseEvents(
      'event: error\ndata: {"error":"OpenAI API key is missing or invalid"}\n\n',
    )
    expect(events[0]).toEqual({
      event: 'error',
      data: '{"error":"OpenAI API key is missing or invalid"}',
    })
  })
})
