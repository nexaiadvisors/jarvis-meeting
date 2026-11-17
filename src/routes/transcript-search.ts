import { Hono } from 'hono'
import { basename, join } from 'node:path'
import { getMeeting } from '../meeting/registry.js'
import { readMergedTranscript } from '../meeting/transcript.js'
import { rankTranscriptEntries } from '../meeting/transcript-search.js'
import { requireMeetingAccess } from '../auth/meeting-session.js'
import type { Config } from '../config.js'

const DEFAULT_K = 6
const MAX_K = 20

interface TranscriptSearchBody {
  query?: unknown
  k?: unknown
}

export interface TranscriptSearchRouteOptions {
  dataDir?: string
}

function resolveK(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_K
  return Math.min(MAX_K, Math.floor(parsed))
}

/**
 * Search the durable JSONL transcript owned by the requested meeting, merged
 * with any agent utterances spoken during the call.
 * Needs the meeting's session token, or the owner (the owner panel searches any meeting).
 */
export function createTranscriptSearchRoutes(
  config: Config,
  options: TranscriptSearchRouteOptions = {},
): Hono {
  const app = new Hono()
  const dataDir = options.dataDir ?? join(process.cwd(), '.data')

  app.post('/api/meetings/:id/transcript-search', async (c) => {
    const id = c.req.param('id')
    const denied = requireMeetingAccess(c, config, id, { allowOwner: true })
    if (denied) return denied

    const body = (await c.req.json().catch(() => ({}))) as TranscriptSearchBody
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) return c.json({ error: 'query is required', code: 'BAD_REQUEST' }, 400)

    const meeting = getMeeting(id)
    // Unreachable: the guard 404s an unknown meeting. Kept so the type narrows.
    if (!meeting) return c.json({ error: 'Meeting not found', code: 'not_found' }, 404)
    if (!meeting.botId) return c.json({ results: [] })

    // Recall bot ids are expected to be opaque identifiers; keep the file read
    // inside .data even if a malformed registry entry is ever introduced.
    const filename = `${meeting.botId}.jsonl`
    if (basename(filename) !== filename) {
      return c.json({ error: 'Meeting transcript is unavailable', code: 'UNAVAILABLE' }, 500)
    }

    const entries = readMergedTranscript(
      { meetingId: meeting.meetingId, botId: meeting.botId },
      meeting.botName ?? config.jarvisBotName ?? 'Jarvis',
      dataDir,
    )
    return c.json({ results: rankTranscriptEntries(entries, query, resolveK(body.k)) })
  })

  return app
}
