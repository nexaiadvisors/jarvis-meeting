// The researcher's tools. Each is a thin, typed wrapper over a lookup the service already
// has; the route supplies the lookups (deps), so the access rules stay in one place.

import type { Audience, ResearchTool } from './researcher.js';

export interface NoteHit {
  source: string;
  date?: string;
  text: string;
}

export interface ResearchDeps {
  /** Work-scoped notes search, with the period filter already applied. */
  searchNotes: (query: string, limit: number) => Promise<{ results: NoteHit[]; window?: unknown; instruction?: string; unreachable?: boolean }>;
  /** One local day of the owner's calendar. Absent when the calendar is not configured. */
  calendarDay?: (date: string | undefined) => Promise<unknown>;
  /** Read-only search of the owner's work mailbox. Absent when not configured. */
  searchEmail?: (query: string, max: number) => Promise<unknown>;
  /** The owner's own pull requests. Absent when gh is not configured. */
  searchPullRequests?: (input: { query?: string; state?: string; limit: number }) => Promise<unknown>;
  /** One pull request's state and checks. */
  pullRequestStatus?: (input: { repo: string; number: number }) => Promise<unknown>;
  /** Recent messages in a Buzz channel, or the channel names when none is given. Absent when Buzz is not configured. */
  readBuzz?: (input: { channel?: string; limit: number }) => Promise<unknown>;
}

const NOTE_TEXT_LIMIT = 1800;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** The tools for one question. Calendar and email exist only when the owner is alone. */
export function buildResearchTools(deps: ResearchDeps, audience: Audience): ResearchTool[] {
  const tools: ResearchTool[] = [
    {
      def: {
        name: 'search_notes',
        description:
          "Search the owner's work notes: project and client notes, work summaries, decisions, lessons, plans and past meeting records. Each result has a source key, a date and text. Keep time words from the question in the query (yesterday, last week, a date); they select the dates searched. Use names and project words, not a full sentence.",
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search words: names, projects, topics, and any time words from the question' },
            limit: { type: 'integer', description: 'Results to return, 1 to 12. Default 6. Use 12 for a summary of a period.' },
          },
          required: ['query'],
        },
      },
      run: async (input) => {
        const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
        if (query === '') throw new Error('query is required');
        const found = await deps.searchNotes(query, clampInt(input['limit'], 6, 1, 12));
        if (found.unreachable) return { unreachable: true, instruction: 'The notes could not be reached. Say that you could not reach the notes just now.' };
        return {
          results: found.results.map((hit) => ({ source: hit.source, ...(hit.date ? { date: hit.date } : {}), text: hit.text.slice(0, NOTE_TEXT_LIMIT) })),
          ...(found.window ? { period: found.window } : {}),
          ...(found.instruction ? { instruction: found.instruction } : {}),
        };
      },
    },
  ];
  if (audience !== 'owner_only') return tools;

  if (deps.calendarDay) {
    const calendarDay = deps.calendarDay;
    tools.push({
      def: {
        name: 'check_calendar',
        description:
          "Read one day of the owner's calendar: every event with its start and end time. The only source for the schedule, meetings on a day, or free time. Call it once per day asked about.",
        input_schema: {
          type: 'object',
          properties: { date: { type: 'string', description: 'YYYY-MM-DD. Omit for today.' } },
          required: [],
        },
      },
      run: async (input) => calendarDay(typeof input['date'] === 'string' && input['date'].trim() !== '' ? input['date'].trim() : undefined),
    });
  }
  if (deps.searchEmail) {
    const searchEmail = deps.searchEmail;
    tools.push({
      def: {
        name: 'search_email',
        description:
          "Search the owner's work mailbox, read-only. Returns sender, recipients, subject, date and a short snippet for each match. Uses Gmail search syntax: from:name, to:name, subject:word, newer_than:7d, after:2026/11/01.",
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Gmail search query, for example "from:jc newer_than:14d"' },
            max: { type: 'integer', description: 'Messages to return, 1 to 8. Default 5.' },
          },
          required: ['query'],
        },
      },
      run: async (input) => {
        const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
        if (query === '') throw new Error('query is required');
        return searchEmail(query, clampInt(input['max'], 5, 1, 8));
      },
    });
  }
  if (deps.searchPullRequests) {
    const searchPullRequests = deps.searchPullRequests;
    tools.push({
      def: {
        name: 'search_pull_requests',
        description:
          "List the owner's own GitHub pull requests, most recently updated first. Use for what was shipped, what is open or in draft, or to find a pull request's repo and number.",
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Words from the title or repo name. Omit for the most recent ones.' },
            state: { type: 'string', enum: ['open', 'closed'], description: 'Omit for both.' },
            limit: { type: 'integer', description: 'Results, 1 to 15. Default 8.' },
          },
          required: [],
        },
      },
      run: async (input) =>
        searchPullRequests({
          ...(typeof input['query'] === 'string' && input['query'].trim() !== '' ? { query: input['query'].trim() } : {}),
          ...(typeof input['state'] === 'string' ? { state: input['state'] } : {}),
          limit: clampInt(input['limit'], 8, 1, 15),
        }),
    });
  }
  if (deps.pullRequestStatus) {
    const pullRequestStatus = deps.pullRequestStatus;
    tools.push({
      def: {
        name: 'pull_request_status',
        description: 'One GitHub pull request: whether it is open, draft or merged, its review state and its CI checks. Needs the repo as owner/name and the number.',
        input_schema: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name, for example nexaiadvisors/jarvis-meeting' },
            number: { type: 'integer', description: 'The pull request number' },
          },
          required: ['repo', 'number'],
        },
      },
      run: async (input) => pullRequestStatus({ repo: String(input['repo'] ?? ''), number: Number(input['number']) }),
    });
  }
  if (deps.readBuzz) {
    const readBuzz = deps.readBuzz;
    tools.push({
      def: {
        name: 'read_buzz',
        description:
          "Read the owner's Buzz chat (client channels such as 3cats and globex). With a channel name: the newest messages there, with sender and time. Without one: the list of channel names. The only source for what was said in Buzz.",
        input_schema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Channel name, for example 3cats. Omit to list the channels.' },
            limit: { type: 'integer', description: 'Messages to return, 1 to 20. Default 10.' },
          },
          required: [],
        },
      },
      run: async (input) =>
        readBuzz({
          ...(typeof input['channel'] === 'string' && input['channel'].trim() !== '' ? { channel: input['channel'].trim() } : {}),
          limit: clampInt(input['limit'], 10, 1, 20),
        }),
    });
  }
  return tools;
}
