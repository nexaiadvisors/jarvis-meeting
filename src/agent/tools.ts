/**
 * Gemini tool declarations and dispatch handler.
 * Maps voice requests to existing dashboard API routes.
 */

import type { FunctionDeclaration } from './types.js'
import type { ToolCallResult } from './types.js'
import { normalizeVoiceTask, voiceTaskString } from './task-normalize.js'
import { matchPrefetch } from './speculative-cache.js'

export type ToolErrorCode = 'TIMEOUT' | 'UNAVAILABLE' | 'NOT_FOUND' | 'BAD_REQUEST' | 'CANCELLED'

const RETRY_BACKOFF_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Map an HTTP status (or network failure) to a typed error code.
 * Returns null for 2xx responses (no error).
 */
function classifyStatus(status: number): ToolErrorCode {
  if (status === 404) return 'NOT_FOUND'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status >= 500) return 'UNAVAILABLE'
  return 'BAD_REQUEST'
}

/** Whether a fetch outcome is worth one retry (transient only). */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 504 || status >= 500
}

/**
 * Fetch a voice API route with one retry (~300ms backoff) on transient failures
 * ONLY — network errors, HTTP 5xx, and timeouts. Never retries 4xx, empty
 * results, or deliberate aborts (R3 barge-in: an aborted fetch returns
 * `CANCELLED` immediately — no retry, no error panel). On failure returns a
 * typed `{ error, code }` the routes/UI can act on.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        const code = classifyStatus(res.status)
        // Prefer a code emitted by the route body if present.
        let bodyCode: ToolErrorCode | undefined
        try {
          const body: unknown = await res.clone().json()
          const bodyCodeValue =
            typeof body === 'object' && body !== null
              ? (body as Record<string, unknown>).code
              : undefined
          if (typeof bodyCodeValue === 'string') bodyCode = bodyCodeValue as ToolErrorCode
        } catch {
          // body not JSON — fall back to status-derived code
        }
        if (attempt === 0 && isTransientStatus(res.status)) {
          await sleep(RETRY_BACKOFF_MS)
          continue
        }
        return { error: `HTTP ${res.status}: ${res.statusText}`, code: bodyCode ?? code }
      }
      return (await res.json()) as Record<string, unknown>
    } catch (err) {
      // Deliberate abort (barge-in) — NOT transient. Return immediately; the
      // turn is dead and a retry would re-run with an already-aborted signal.
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') || init?.signal?.aborted === true
      if (isAbort) {
        return { error: 'cancelled', code: 'CANCELLED' }
      }
      // Network error — transient, retry once.
      if (attempt === 0) {
        await sleep(RETRY_BACKOFF_MS)
        continue
      }
      const isTimeout = err instanceof Error && /(timeout|timed out)/i.test(err.message)
      return {
        error: `Fetch failed: ${err instanceof Error ? err.message : 'unknown'}`,
        code: isTimeout ? 'TIMEOUT' : 'UNAVAILABLE',
      }
    }
  }
  // Unreachable in practice; satisfies the type checker.
  return { error: 'Fetch failed: exhausted retries', code: 'UNAVAILABLE' }
}

export const VOICE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'search_brain',
    description: 'Search all of OpenBrain using hybrid vector + keyword search (Reciprocal Rank Fusion). This is the PRIMARY search tool — use it for any knowledge retrieval question like "what do I know about X". Returns the most relevant results across all thoughts, documents, contacts, and projects.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        query: { type: 'STRING' as never, description: 'The search query — be specific and include key terms' },
        limit: { type: 'NUMBER' as never, description: 'Max results to return, default 12' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_meeting_transcript',
    description: 'Search what was actually said EARLIER IN THIS MEETING. Use for any question about earlier discussion in the current meeting.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        query: { type: 'STRING' as never, description: 'The earlier-meeting topic or question to search for' },
        k: { type: 'NUMBER' as never, description: 'Max matching transcript turns to return, default 6' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_brain_context',
    description: 'Get LLM-ready formatted context from OpenBrain for a query. Returns pre-formatted readable markdown text (not raw JSON). Use this when you need to give a DETAILED spoken answer — the results are human-readable summaries perfect for speaking aloud.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        query: { type: 'STRING' as never, description: 'The context query' },
        limit: { type: 'NUMBER' as never, description: 'Max context entries, default 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_documents',
    description: 'Search within OpenBrain documents with optional namespace and type filters. Use when looking for specific document types like meeting transcripts (doc_type: "meeting-transcript"), work outputs (doc_type: "work-output"), communications (doc_type: "communication"), or decisions.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        query: { type: 'STRING' as never, description: 'The search query' },
        namespace: { type: 'STRING' as never, description: 'Filter by namespace, e.g. "second-brain", "wiki"' },
        doc_type: { type: 'STRING' as never, description: 'Filter by doc type, e.g. "meeting-transcript", "work-output", "communication"' },
        limit: { type: 'NUMBER' as never, description: 'Max results, default 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_exact_document',
    description: 'Retrieve a specific document by its exact namespace, doc_type, and entity_key. Use when you know the exact document to retrieve, e.g. getting a specific person profile, project record, or decision log.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        namespace: { type: 'STRING' as never, description: 'Document namespace' },
        doc_type: { type: 'STRING' as never, description: 'Document type' },
        entity_key: { type: 'STRING' as never, description: 'Entity key' },
      },
      required: ['namespace', 'doc_type', 'entity_key'],
    },
  },
  {
    name: 'get_wiki_graph',
    description: 'Get the knowledge graph centered on an entity (person, project, concept). Use when user says "show me X" or asks about relationships between entities.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        entity: { type: 'STRING' as never, description: 'Entity key to focus on (e.g. "morgan", "acme")' },
        depth: { type: 'NUMBER' as never, description: 'Graph depth 1-5, default 3' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'get_document',
    description: 'Retrieve a specific document by its ID. Use when referring to a known document.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        id: { type: 'STRING' as never, description: 'Document ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_documents',
    description: 'List recent documents, optionally filtered by namespace or type. Use when user asks to see recent notes, documents, or knowledge.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        namespace: { type: 'STRING' as never, description: 'Filter by namespace (e.g. "second-brain", "wiki")' },
        doc_type: { type: 'STRING' as never, description: 'Filter by document type' },
        limit: { type: 'NUMBER' as never, description: 'Max results, default 10' },
      },
    },
  },
  {
    name: 'get_tasks',
    description: 'Get ready or in-progress tasks from the task board. Use when user asks "what should I work on", "my tasks", or "what\'s next".',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        filter: { type: 'STRING' as never, description: 'Filter: ready, in_progress, or all', enum: ['ready', 'in_progress', 'all'] },
      },
    },
  },
  {
    name: 'get_calendar',
    description: 'Get upcoming meetings and schedule. Use when user asks about meetings, schedule, or "what do I have today".',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        date: { type: 'STRING' as never, description: 'ISO date string, default today' },
      },
    },
  },
  {
    name: 'save_thought',
    description: 'Save a thought or note to OpenBrain. Use when the user says "remember this", "save that", or "note that...".',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        text: { type: 'STRING' as never, description: 'The thought to save' },
        tags: { type: 'ARRAY' as never, items: { type: 'STRING' as never }, description: 'Optional tags' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_task_detail',
    description: 'Get full details for a specific Beads task by ID. Use when user says "tell me more about task X" or "show me BD-42".',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        id: { type: 'STRING' as never, description: 'The task ID (e.g. "42" or "BD-42")' },
      },
      required: ['id'],
    },
  },
  {
    name: 'generate_task_prompt',
    description: 'Generate a structured implementation prompt for a Beads task that the user can paste into their editor for an AI agent to execute. Use when user says "let me work on task X", "generate a prompt for task X", or selects a task to work on.',
    parameters: {
      type: 'OBJECT' as never,
      properties: {
        id: { type: 'STRING' as never, description: 'The task ID to generate a prompt for' },
      },
      required: ['id'],
    },
  },
]

export const TRUNCATION_MARKER = '… [truncated]'

export function truncateResults(results: Record<string, unknown>[], maxItems: number = 8, maxContentLength: number = 2000): Record<string, unknown>[] {
  return results.slice(0, maxItems).map((r) => {
    const truncated = { ...r }
    if (typeof truncated.content === 'string' && truncated.content.length > maxContentLength) {
      truncated.content = truncated.content.slice(0, maxContentLength) + TRUNCATION_MARKER
    }
    return truncated
  })
}

/**
 * Build a typed-error tool result that also surfaces an `error` panel in the UI
 * (F6). The panel only renders for genuine outages: BAD_REQUEST is the model's
 * fault (malformed request), and CANCELLED is a deliberate user barge-in (R3) —
 * neither should flash an error panel.
 */
function toolError(data: Record<string, unknown>, toolName: string): ToolCallResult {
  const code = (typeof data.code === 'string' ? data.code : 'UNAVAILABLE') as ToolErrorCode
  const message = typeof data.error === 'string' ? data.error : 'Tool call failed'
  const result: ToolCallResult = { result: { error: message, code } }
  if (code !== 'BAD_REQUEST' && code !== 'CANCELLED') {
    result.uiAction = {
      type: 'show_panel',
      panel: 'error',
      props: { code, message, tool: toolName },
    }
  }
  return result
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  isIncognito: boolean,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''

  switch (name) {
    case 'search_brain': {
      const query = String(args.query ?? '')
      const rawLimit = Number(args.limit)
      const maxItems = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 8

      // R1a: serve from the speculative prefetch cache when the model's query
      // semantically matches an utterance we already prefetched (0ms, no fetch).
      // Skipped in incognito (the cache may hold pre-incognito entries), and a
      // matched entry with no results falls through to the live fetch.
      const prefetched = isIncognito ? null : matchPrefetch(query)
      if (prefetched && prefetched.results.length > 0) {
        const results = truncateResults(prefetched.results, maxItems)
        return {
          result: { results, count: results.length, served_from: 'prefetch' },
          uiAction: {
            type: 'show_panel',
            panel: 'search_results',
            props: { results: prefetched.results, query: args.query },
          },
        }
      }

      const data = await safeFetch(`${baseUrl}/api/voice/ob-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: args.query, limit: args.limit }),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (data.error) return toolError(data, name)
      const results = truncateResults((data.results as Record<string, unknown>[]) || [])
      return {
        // O1: pass through the route's tookMs so the turn tracer can record the
        // server-side retrieval time alongside the client-observed duration.
        result: { results, count: results.length, served_from: 'live', ...(data.tookMs ? { tookMs: data.tookMs } : {}) },
        uiAction: {
          type: 'show_panel',
          panel: 'search_results',
          props: { results: (data.results as Record<string, unknown>[]) || [], query: args.query },
        },
      }
    }

    case 'search_meeting_transcript': {
      const meetingId = String(args.meetingId ?? '')
      if (!meetingId) return { result: { error: 'meetingId is required', code: 'BAD_REQUEST' } }
      const data = await safeFetch(
        `${baseUrl}/api/meetings/${encodeURIComponent(meetingId)}/transcript-search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: args.query, k: args.k }),
          ...(signal !== undefined ? { signal } : {}),
        },
      )
      if (data.error) return toolError(data, name)
      const results = Array.isArray(data.results) ? data.results : []
      return { result: { results, count: results.length } }
    }

    case 'get_brain_context': {
      const data = await safeFetch(`${baseUrl}/api/voice/ob-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: args.query, limit: args.limit }),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (data.error) return toolError(data, name)
      return {
        result: { context: data.context || '' },
      }
    }

    case 'search_documents': {
      const data = await safeFetch(`${baseUrl}/api/voice/ob-search-documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: args.query, namespace: args.namespace, doc_type: args.doc_type, limit: args.limit }),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (data.error) return toolError(data, name)
      const docs = truncateResults((data.results as Record<string, unknown>[]) || [])
      return {
        result: { documents: docs, count: docs.length },
        uiAction: {
          type: 'show_panel',
          panel: 'document_list',
          props: { documents: (data.results as Record<string, unknown>[]) || [], query: args.query },
        },
      }
    }

    case 'get_exact_document': {
      const data = await safeFetch(`${baseUrl}/api/voice/ob-get-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: args.namespace, doc_type: args.doc_type, entity_key: args.entity_key }),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (data.error) return toolError(data, name)
      const doc = (data.document as Record<string, unknown>) || {}
      return {
        result: {
          title: doc.entity_key || doc.id,
          namespace: doc.namespace,
          doc_type: doc.doc_type,
          content: typeof doc.content === 'string' ? doc.content.slice(0, 500) : '',
        },
        uiAction: {
          type: 'show_panel',
          panel: 'document_detail',
          props: { document: doc },
        },
      }
    }

    case 'get_wiki_graph': {
      const rawDepth = Number(args.depth)
      const depth = Number.isFinite(rawDepth) && rawDepth >= 1 && rawDepth <= 5
        ? Math.floor(rawDepth)
        : 3
      const data = await safeFetch(`${baseUrl}/api/wiki/graph/focused?root=${encodeURIComponent(args.entity as string)}&depth=${depth}`, signal !== undefined ? { signal } : {})
      if (data.error) return toolError(data, name)
      return {
        result: {
          nodeCount: (data.nodes as unknown[])?.length || 0,
          edgeCount: (data.edges as unknown[])?.length || 0,
          root: data.root,
        },
        uiAction: {
          type: 'show_panel',
          panel: 'wiki_graph',
          props: { nodes: data.nodes, edges: data.edges, root: data.root },
        },
      }
    }

    case 'get_document': {
      const id = String(args.id)
      if (!/^[a-zA-Z0-9_.-]{1,256}$/.test(id)) {
        return { result: { error: 'Invalid document ID' } }
      }
      const data = await safeFetch(`${baseUrl}/api/documents/${encodeURIComponent(id)}`, signal !== undefined ? { signal } : {})
      if (data.error) return toolError(data, name)
      const doc = (data.document as Record<string, unknown>) || data
      return {
        result: {
          title: doc.entity_key || doc.id,
          namespace: doc.namespace,
          doc_type: doc.doc_type,
          content: typeof doc.content === 'string' ? doc.content.slice(0, 500) : '',
        },
        uiAction: {
          type: 'show_panel',
          panel: 'document_detail',
          props: { document: doc },
        },
      }
    }

    case 'list_documents': {
      const params = new URLSearchParams()
      if (args.namespace) params.set('namespace', args.namespace as string)
      if (args.doc_type) params.set('doc_type', args.doc_type as string)
      if (args.limit) params.set('limit', String(args.limit))
      const data = await safeFetch(`${baseUrl}/api/views?${params.toString()}`, signal !== undefined ? { signal } : {})
      if (data.error) return toolError(data, name)
      const allDocs = (data.documents as Record<string, unknown>[]) || (data.rows as Record<string, unknown>[]) || []
      const docs = truncateResults(allDocs, Number(args.limit) || 10)
      return {
        result: { documents: docs, count: docs.length },
        uiAction: {
          type: 'show_panel',
          panel: 'document_list',
          props: { documents: allDocs, namespace: args.namespace, docType: args.doc_type },
        },
      }
    }

    case 'get_tasks': {
      const filter = (args.filter as string) || 'ready'
      const data = await safeFetch(`${baseUrl}/api/voice/tasks?filter=${filter}`, signal !== undefined ? { signal } : {})
      if (data.error) return toolError(data, name)
      const tasks = (data.tasks as Record<string, unknown>[]) || []
      return {
        result: { tasks: truncateResults(tasks, 8), count: tasks.length },
        uiAction: {
          type: 'show_panel',
          panel: 'task_board',
          props: { tasks, filter },
        },
      }
    }

    case 'get_calendar': {
      const date = (args.date as string) || new Date().toISOString().slice(0, 10)
      const data = await safeFetch(`${baseUrl}/api/voice/calendar?date=${date}`, signal !== undefined ? { signal } : {})
      if (data.error) return toolError(data, name)
      const events = (data.events as Record<string, unknown>[]) || []
      return {
        result: { events, count: events.length },
        uiAction: {
          type: 'show_panel',
          panel: 'calendar',
          props: { events, date },
        },
      }
    }

    case 'save_thought': {
      if (isIncognito) {
        return {
          result: { saved: false, reason: 'incognito mode active' },
          uiAction: { type: 'toast', message: 'Incognito mode — thought not saved' },
        }
      }
      const res = await fetch(`${baseUrl}/api/voice/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'thought', content: args.text, tags: args.tags }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
        return toolError({ error: `HTTP ${res.status}: ${res.statusText}`, ...body }, name)
      }
      const data = (await res.json()) as Record<string, unknown>
      return {
        result: { saved: true, entityKey: data.entityKey },
        uiAction: { type: 'toast', message: 'Saved to OpenBrain' },
      }
    }

    case 'get_task_detail': {
      const id = String(args.id).replace(/^BD-/i, '')
      const data = await safeFetch(`${baseUrl}/api/voice/task-detail?id=${encodeURIComponent(id)}`, signal !== undefined ? { signal } : {})
      if (data.error) return toolError(data, name)
      const task = normalizeVoiceTask(data.task)
      return {
        result: {
          id: task.id,
          title: voiceTaskString(task, 'title'),
          status: voiceTaskString(task, 'status'),
          priority: task.priority,
          type: voiceTaskString(task, 'type'),
          description: voiceTaskString(task, 'description').slice(0, 500),
        },
        uiAction: {
          type: 'show_panel',
          panel: 'task_detail',
          props: { task },
        },
      }
    }

    case 'generate_task_prompt': {
      const id = String(args.id).replace(/^BD-/i, '')
      const data = await safeFetch(`${baseUrl}/api/voice/task-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (data.error) return toolError(data, name)
      const task = normalizeVoiceTask(data.task)
      const taskTitle = voiceTaskString(task, 'title')
      return {
        result: { prompt: data.prompt, taskId: id, taskTitle },
        uiAction: {
          type: 'show_panel',
          panel: 'task_prompt',
          props: { prompt: data.prompt, taskId: id, taskTitle },
        },
      }
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } }
  }
}
