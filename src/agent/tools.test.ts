import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleToolCall, truncateResults, TRUNCATION_MARKER, safeFetch, VOICE_TOOLS } from './tools.js'
import { storePrefetch, clearSpeculativeCache } from './speculative-cache.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  clearSpeculativeCache()
})

describe('truncateResults (F5)', () => {
  it('appends an explicit truncation marker when content exceeds the cap', () => {
    const long = 'x'.repeat(2500)
    const [row] = truncateResults([{ content: long }])
    expect(row!.content).toContain(TRUNCATION_MARKER)
    expect((row!.content as string).length).toBe(2000 + TRUNCATION_MARKER.length)
  })

  it('leaves content under the cap untouched (no marker)', () => {
    const short = 'just a short note'
    const [row] = truncateResults([{ content: short }])
    expect(row!.content).toBe(short)
    expect(row!.content).not.toContain(TRUNCATION_MARKER)
  })

  it('defaults to 8 items', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ content: `item ${i}` }))
    expect(truncateResults(rows)).toHaveLength(8)
  })

  it('does not mutate the source rows', () => {
    const source = [{ content: 'y'.repeat(2500) }]
    truncateResults(source)
    expect(source[0]!.content).toHaveLength(2500)
  })
})

describe('VOICE_TOOLS', () => {
  it('declares the earlier-in-meeting transcript search tool', () => {
    const tool = VOICE_TOOLS.find((candidate) => candidate.name === 'search_meeting_transcript')
    expect(tool?.description).toContain('EARLIER IN THIS MEETING')
  })
})

describe('safeFetch (F5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns parsed JSON on a 2xx response without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [1, 2], count: 2 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const data = await safeFetch('/x')
    expect(data).toEqual({ results: [1, 2], count: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 4xx and returns the typed code from the body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'BAD_REQUEST', error: 'nope' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const data = await safeFetch('/x')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(data.code).toBe('BAD_REQUEST')
  })

  it('maps a 404 to NOT_FOUND and does not retry', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const data = await safeFetch('/x')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(data.code).toBe('NOT_FOUND')
  })

  it('retries once on HTTP 5xx then returns UNAVAILABLE', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'UNAVAILABLE' }), { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = safeFetch('/x')
    await vi.advanceTimersByTimeAsync(300)
    const data = await promise
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(data.code).toBe('UNAVAILABLE')
  })

  it('recovers when the retry succeeds after a transient 5xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'UNAVAILABLE' }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = safeFetch('/x')
    await vi.advanceTimersByTimeAsync(300)
    const data = await promise
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(data).toEqual({ results: [] })
  })

  it('retries once on a network error then returns UNAVAILABLE', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    const promise = safeFetch('/x')
    await vi.advanceTimersByTimeAsync(300)
    const data = await promise
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(data.code).toBe('UNAVAILABLE')
  })

  it('classifies a timeout error as TIMEOUT', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('The operation timed out'))
    vi.stubGlobal('fetch', fetchMock)

    const promise = safeFetch('/x')
    await vi.advanceTimersByTimeAsync(300)
    const data = await promise
    expect(data.code).toBe('TIMEOUT')
  })

  it('returns CANCELLED immediately on an AbortError — no retry, no backoff', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    vi.stubGlobal('fetch', fetchMock)

    // No timer advancement: a cancelled fetch must resolve without the 300ms
    // backoff sleep (a retry would re-run with an already-aborted signal).
    const data = await safeFetch('/x')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(data.code).toBe('CANCELLED')
  })

  it('returns CANCELLED when the init signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn(async () => {
      throw new Error('signal is aborted without reason')
    })
    vi.stubGlobal('fetch', fetchMock)

    const data = await safeFetch('/x', { signal: controller.signal })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(data.code).toBe('CANCELLED')
  })
})

describe('handleToolCall error propagation (F6)', () => {
  it('surfaces an error panel + typed code when a route fails with 5xx', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Search failed', code: 'UNAVAILABLE' }), { status: 503 })))

    const result = await handleToolCall('search_brain', { query: 'x' }, false)
    expect(result.result.code).toBe('UNAVAILABLE')
    expect(result.uiAction?.type).toBe('show_panel')
    expect(result.uiAction?.panel).toBe('error')
    expect(result.uiAction?.props?.code).toBe('UNAVAILABLE')
  })

  it('does NOT flash an error panel for a BAD_REQUEST', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'query is required', code: 'BAD_REQUEST' }), { status: 400 })))

    const result = await handleToolCall('search_brain', { query: '' }, false)
    expect(result.result.code).toBe('BAD_REQUEST')
    expect(result.uiAction).toBeUndefined()
  })
})

describe('handleToolCall search_meeting_transcript', () => {
  it('posts a meeting-scoped query to the transcript route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ speaker: 'Alice', text: 'Launch Monday', timestamp: '2026-07-14T09:00:00.000Z' }],
    })))
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', fetchMock)

    const result = await handleToolCall(
      'search_meeting_transcript',
      { meetingId: 'm1', query: 'what did Alice say', k: 4 },
      false,
    )

    expect(fetchMock).toHaveBeenCalledWith('http://dashboard.test/api/meetings/m1/transcript-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'what did Alice say', k: 4 }),
    })
    expect(result.result).toMatchObject({ count: 1 })
  })
})

describe('handleToolCall search_brain — speculative cache (R1a)', () => {
  // Realistic RRF score (hybrid_search k=60 caps the score at 1/61 ≈ 0.0164).
  const RRF = 0.016

  it('serves from the prefetch cache without fetching when the query matches', async () => {
    storePrefetch('what is the funnel status', [
      { id: 'p1', content: 'Conversion up.', entity_key: 'funnel', rrf_score: RRF },
    ])
    const fetchMock = vi.fn()
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', fetchMock)

    const result = await handleToolCall('search_brain', { query: 'What is the funnel status?' }, false)

    expect(fetchMock).not.toHaveBeenCalled() // 0ms — served from cache
    expect(result.result.served_from).toBe('prefetch')
    expect((result.result.results as Record<string, unknown>[])[0]!.id).toBe('p1')
    expect(result.uiAction?.panel).toBe('search_results')
  })

  it('respects args.limit when serving from the prefetch cache', async () => {
    storePrefetch('what is the funnel status', [
      { id: 'p1', content: 'one', rrf_score: RRF },
      { id: 'p2', content: 'two', rrf_score: RRF },
      { id: 'p3', content: 'three', rrf_score: RRF },
    ])
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', vi.fn())

    const result = await handleToolCall('search_brain', { query: 'what is the funnel status', limit: 2 }, false)

    expect(result.result.served_from).toBe('prefetch')
    expect(result.result.results).toHaveLength(2)
  })

  it('skips the prefetch cache in incognito mode', async () => {
    storePrefetch('what is the funnel status', [
      { id: 'p1', content: 'cached', rrf_score: RRF },
    ])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: 'live1', content: 'x' }] }), { status: 200 }))
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', fetchMock)

    const result = await handleToolCall('search_brain', { query: 'what is the funnel status' }, true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.result.served_from).toBe('live')
  })

  it('falls through to a live fetch (served_from: live) on a cache miss', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: 'live1', content: 'x' }] }), { status: 200 }))
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', fetchMock)

    const result = await handleToolCall('search_brain', { query: 'totally different query here' }, false)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.result.served_from).toBe('live')
  })
})

describe('handleToolCall abort signal (R3 — abort cancels the pending fetch)', () => {
  it('passes the turn abort signal into the search fetch', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    )
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', fetchMock)

    await handleToolCall('search_brain', { query: 'a unique uncached query' }, false, controller.signal)

    const init = fetchMock.mock.calls[0]![1]
    expect(init?.signal).toBe(controller.signal)
  })

  it('returns CANCELLED with NO error panel when the fetch is aborted mid-flight', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', fetchMock)
    controller.abort()

    const result = await handleToolCall('search_brain', { query: 'another uncached query' }, false, controller.signal)

    // A barge-in cancellation is not an outage: single attempt, typed code,
    // and crucially NO error panel flash (review finding 5).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.result.code).toBe('CANCELLED')
    expect(result.uiAction).toBeUndefined()
  })
})

describe('handleToolCall task tools', () => {
  it('normalizes task detail array responses from the route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      task: [
        {
          id: 'BZ-1',
          title: 'Verify voice dashboard',
          status: 'open',
          priority: 1,
          type: 'task',
          description: 'Make sure voice can answer OpenBrain questions.',
        },
      ],
    }), { status: 200 }))

    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', fetchMock)

    const result = await handleToolCall('get_task_detail', { id: 'BD-BZ-1' }, false)

    expect(fetchMock).toHaveBeenCalledWith('http://dashboard.test/api/voice/task-detail?id=BZ-1', { signal: undefined })
    expect(result.result.title).toBe('Verify voice dashboard')
    expect(result.uiAction?.props?.task).toEqual(expect.objectContaining({
      title: 'Verify voice dashboard',
    }))
  })

  it('uses the normalized task title when generating a task prompt panel', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://dashboard.test' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      prompt: '## Task: Verify voice dashboard',
      task: [{ id: 'BZ-1', title: 'Verify voice dashboard' }],
    }), { status: 200 })))

    const result = await handleToolCall('generate_task_prompt', { id: 'BZ-1' }, false)

    expect(result.result.taskTitle).toBe('Verify voice dashboard')
    expect(result.uiAction?.props?.taskTitle).toBe('Verify voice dashboard')
  })
})
