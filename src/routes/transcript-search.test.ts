import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { __clearRegistry, registerMeeting } from '../meeting/registry.js'
import { createTranscriptSearchRoutes } from './transcript-search.js'
import { ownerCookieValue } from '../auth/owner.js'
import { sessionHeader } from '../../tests/helpers/session.js'
import type { Config } from '../config.js'

const OWNER = 'owner-token-for-tests'
const config = { ownerToken: OWNER, tokenRegistry: new Map<string, string>() } as Config

let dataDir: string

function mount(): Hono {
  const app = new Hono()
  app.route('/', createTranscriptSearchRoutes(config, { dataDir }))
  return app
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )
}

/** Session header for a meeting whose teammate is 'example'. */
function auth(meetingId: string): Record<string, string> {
  return sessionHeader(config, meetingId, 'example')
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'meeting-transcript-'))
  __clearRegistry()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  __clearRegistry()
})

describe('POST /api/meetings/:id/transcript-search', () => {
  it('returns ranked results from the meeting-owned JSONL transcript', async () => {
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'example', persona: 'ai', title: 'M' })
    writeFileSync(
      join(dataDir, 'bot-1.jsonl'),
      [
        JSON.stringify({ speaker: 'Alice', text: 'The launch budget is approved.', timestamp: '2026-07-14T09:00:00.000Z' }),
        JSON.stringify({ speaker: 'Bob', text: 'Catering is still pending.', timestamp: '2026-07-14T09:01:00.000Z' }),
      ].join('\n'),
    )

    const res = await post(mount(), '/api/meetings/m1/transcript-search', { query: 'Alice launch budget' }, auth('m1'))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      results: [{ speaker: 'Alice', text: 'The launch budget is approved.', timestamp: '2026-07-14T09:00:00.000Z' }],
    })
  })

  it('returns 404 for an unknown meeting id', async () => {
    const res = await post(mount(), '/api/meetings/unknown/transcript-search', { query: 'launch' }, auth('unknown'))

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ code: 'not_found' })
  })

  it('returns an empty result set when the known meeting has no transcript file', async () => {
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'example', persona: 'ai', title: 'M' })

    const res = await post(mount(), '/api/meetings/m1/transcript-search', { query: 'launch' }, auth('m1'))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ results: [] })
  })

  it('returns 401 without a session token', async () => {
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'example', persona: 'ai', title: 'M' })
    writeFileSync(
      join(dataDir, 'bot-1.jsonl'),
      JSON.stringify({ speaker: 'Alice', text: 'The launch budget is approved.', timestamp: '2026-07-14T09:00:00.000Z' }),
    )

    const res = await post(mount(), '/api/meetings/m1/transcript-search', { query: 'launch budget' })

    expect(res.status).toBe(401)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ code: 'SESSION_REQUIRED' })
    expect(text).not.toContain('launch budget is approved')
  })

  it('returns 401 with a session token for a different meeting', async () => {
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'example', persona: 'ai', title: 'M' })
    registerMeeting({ meetingId: 'm2', botId: 'bot-2', teammate: 'example', persona: 'ai', title: 'M' })

    const res = await post(mount(), '/api/meetings/m1/transcript-search', { query: 'launch' }, auth('m2'))

    expect(res.status).toBe(401)
  })

  it('admits the owner cookie (the owner panel searches any meeting)', async () => {
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'example', persona: 'ai', title: 'M' })
    writeFileSync(
      join(dataDir, 'bot-1.jsonl'),
      JSON.stringify({ speaker: 'Alice', text: 'The launch budget is approved.', timestamp: '2026-07-14T09:00:00.000Z' }),
    )

    const res = await post(
      mount(),
      '/api/meetings/m1/transcript-search',
      { query: 'launch budget' },
      { Cookie: `jm_owner=${ownerCookieValue(config)}` },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toHaveLength(1)
  })

  it('rejects a forged owner cookie', async () => {
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'example', persona: 'ai', title: 'M' })

    const res = await post(mount(), '/api/meetings/m1/transcript-search', { query: 'launch' }, { Cookie: 'jm_owner=forged' })

    expect(res.status).toBe(401)
  })

  it('includes Jarvis spoken utterances from <meetingId>.agent.jsonl in search results', async () => {
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'example', persona: 'ai', title: 'M' })
    writeFileSync(
      join(dataDir, 'bot-1.jsonl'),
      JSON.stringify({ speaker: 'Alice', text: 'What is our pricing tier?', timestamp: '2026-07-14T09:00:00.000Z' }) + '\n',
    )
    writeFileSync(
      join(dataDir, 'm1.agent.jsonl'),
      JSON.stringify({ speaker: 'Agent', text: 'The enterprise retainer is $4,500 per month.', timestamp: '2026-07-14T09:00:05.000Z' }) + '\n',
    )

    const res = await post(mount(), '/api/meetings/m1/transcript-search', { query: 'enterprise retainer 4500' }, auth('m1'))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      results: [{ speaker: 'Jarvis', text: 'The enterprise retainer is $4,500 per month.', timestamp: '2026-07-14T09:00:05.000Z' }],
    })
  })
})
