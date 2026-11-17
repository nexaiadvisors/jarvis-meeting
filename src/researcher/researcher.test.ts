import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runResearcher, type ResearchClient, type ResearchTool } from './researcher.js';
import { buildResearchTools } from './tools.js';
import { searchEmail } from './email.js';

function message(content: unknown[], stop_reason: string): Anthropic.Message {
  return { id: 'm', type: 'message', role: 'assistant', model: 'x', content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } as unknown as Anthropic.Message;
}
const text = (t: string) => ({ type: 'text', text: t });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

function clientOf(replies: Anthropic.Message[]): { client: ResearchClient; calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    calls,
    client: {
      messages: {
        create: async (params) => {
          // Snapshot: the loop appends to the same messages array afterwards.
          calls.push(JSON.parse(JSON.stringify(params)) as Anthropic.MessageCreateParamsNonStreaming);
          const reply = replies[Math.min(i, replies.length - 1)]!;
          i += 1;
          return reply;
        },
      },
    },
  };
}

const notesTool = (run: ResearchTool['run']): ResearchTool => ({
  def: { name: 'search_notes', description: 'd', input_schema: { type: 'object', properties: {}, required: [] } },
  run,
});
const base = { model: 'claude-opus-5-5', effort: 'low', question: 'who is the client for Northwind?', audience: 'owner_only' as const, today: '2026-11-14', weekday: 'Saturday', timeZone: 'America/New_York', ownerName: 'David' };

describe('runResearcher', () => {
  it('runs the tools the model asks for and returns its answer', async () => {
    const run = vi.fn(async () => ({ results: [{ source: 'a', text: 'Pat Lee is the client' }] }));
    const { client, calls } = clientOf([
      message([use('t1', 'search_notes', { query: 'Northwind client' })], 'tool_use'),
      message([text('The client is  Pat Lee.')], 'end_turn'),
    ]);
    const result = await runResearcher({ ...base, client, tools: [notesTool(run)] });
    expect(result.answer).toBe('The client is Pat Lee.');
    expect(result.steps).toBe(1);
    expect(result.toolCalls.map((c) => c.name)).toEqual(['search_notes']);
    expect(run).toHaveBeenCalledWith({ query: 'Northwind client' });
    expect(result.inputTokens).toBe(20);
    // The second request carries the assistant turn unchanged and ONE user turn of results.
    const second = calls[1]!.messages;
    expect(second).toHaveLength(3);
    expect(second[1]).toMatchObject({ role: 'assistant' });
    expect((second[2]!.content as Array<{ type: string; tool_use_id: string }>)[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect((calls[0] as unknown as { output_config: { effort: string } }).output_config).toEqual({ effort: 'low' });
    expect(String(calls[0]!.messages[0]!.content)).toContain('Today is Saturday, 2026-11-14');
    // Alone, the asker is the owner: the answer says "you", not his name.
    expect(String(calls[0]!.messages[0]!.content)).toContain('say "you" and "your"');
  });

  it('runs parallel tool calls and returns every result in one message', async () => {
    const { client, calls } = clientOf([
      message([use('a', 'search_notes', { query: 'x' }), use('b', 'search_notes', { query: 'y' })], 'tool_use'),
      message([text('Done.')], 'end_turn'),
    ]);
    await runResearcher({ ...base, client, tools: [notesTool(async () => ({ results: [] }))] });
    expect((calls[1]!.messages[2]!.content as unknown[]).length).toBe(2);
  });

  it('hands a failed tool back as an error result instead of dropping it', async () => {
    const { client, calls } = clientOf([
      message([use('a', 'search_notes', {}), use('b', 'nope', {})], 'tool_use'),
      message([text('I could not reach the notes.')], 'end_turn'),
    ]);
    const result = await runResearcher({ ...base, client, tools: [notesTool(async () => { throw new Error('backend down'); })] });
    const results = calls[1]!.messages[2]!.content as Array<{ is_error?: boolean }>;
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(result.toolCalls.every((c) => c.error !== undefined)).toBe(true);
    expect(result.answer).toContain('could not reach');
  });

  it('forces an answer once the tool rounds are used up', async () => {
    const { client, calls } = clientOf([
      message([use('a', 'search_notes', {})], 'tool_use'),
      message([text('Here is what I have.')], 'end_turn'),
    ]);
    const result = await runResearcher({ ...base, client, tools: [notesTool(async () => ({}))], maxSteps: 1 });
    expect(calls[1]!.tool_choice).toEqual({ type: 'none' });
    expect(result.answer).toBe('Here is what I have.');
  });

  it('reports a refusal, an empty reply and a thrown error without an answer', async () => {
    expect((await runResearcher({ ...base, client: clientOf([message([], 'refusal')]).client, tools: [] })).code).toBe('REFUSED');
    expect((await runResearcher({ ...base, client: clientOf([message([], 'end_turn')]).client, tools: [] })).code).toBe('EMPTY');
    const broken: ResearchClient = { messages: { create: async () => { throw new Error('boom'); } } };
    expect((await runResearcher({ ...base, client: broken, tools: [] })).code).toBe('ERROR');
  });

  it('hands over lookups that already ran, so the model can answer in one call', async () => {
    const { client, calls } = clientOf([message([text('The client is Pat Lee.')], 'end_turn')]);
    const result = await runResearcher({
      ...base,
      client,
      tools: [notesTool(async () => ({}))],
      preloaded: [{ name: 'search_notes', input: { query: 'who is the client for Northwind?' }, output: { results: [{ source: 'a', text: 'Pat Lee' }] }, ms: 420 }],
    });
    const turn = String(calls[0]!.messages[0]!.content);
    expect(turn).toContain('<lookup tool="search_notes"');
    expect(turn).toContain('Pat Lee');
    expect(turn).toContain('never repeat the same lookup');
    expect(calls).toHaveLength(1);
    expect(result.steps).toBe(0);
    expect(result.toolCalls).toEqual([{ name: 'search_notes', input: { query: 'who is the client for Northwind?' }, ms: 420 }]);
  });

  it('passes server tools through and continues a paused turn', async () => {
    const { client, calls } = clientOf([
      message([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }], 'pause_turn'),
      message([text('The price is 20 dollars.')], 'end_turn'),
    ]);
    const serverTools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];
    const result = await runResearcher({ ...base, client, tools: [notesTool(async () => ({}))], serverTools });
    expect((calls[0]!.tools as unknown[]).slice(-1)).toEqual(serverTools);
    // The paused turn goes back unchanged, with no user message added.
    expect(calls[1]!.messages).toHaveLength(2);
    expect(calls[1]!.messages[1]).toMatchObject({ role: 'assistant' });
    expect(result.answer).toBe('The price is 20 dollars.');
  });

  it('tells the model when calendar and email are not available', async () => {
    const { client, calls } = clientOf([message([text('ok')], 'end_turn')]);
    await runResearcher({ ...base, audience: 'guests', client, tools: [] });
    expect(String(calls[0]!.messages[0]!.content)).toContain('calendar and email are not available');
  });
});

describe('buildResearchTools', () => {
  const deps = {
    searchNotes: vi.fn(async () => ({ results: [{ source: 's', date: '2026-11-13', text: 'x'.repeat(5000) }], window: { label: 'yesterday' }, instruction: 'say so' })),
    calendarDay: vi.fn(async () => ({ available: true, events: [] })),
    searchEmail: vi.fn(async () => ({ messages: [] })),
  };

  it('offers only the notes search when other people are in the call', () => {
    expect(buildResearchTools(deps, 'guests').map((t) => t.def.name)).toEqual(['search_notes']);
  });

  it('adds the calendar and the mailbox when the owner is alone', () => {
    expect(buildResearchTools(deps, 'owner_only').map((t) => t.def.name)).toEqual(['search_notes', 'check_calendar', 'search_email']);
  });

  it('adds the GitHub tools when gh is configured, owner alone only', () => {
    const withGh = { ...deps, searchPullRequests: vi.fn(async () => ({})), pullRequestStatus: vi.fn(async () => ({})) };
    expect(buildResearchTools(withGh, 'owner_only').map((t) => t.def.name)).toEqual(['search_notes', 'check_calendar', 'search_email', 'search_pull_requests', 'pull_request_status']);
    expect(buildResearchTools(withGh, 'guests').map((t) => t.def.name)).toEqual(['search_notes']);
  });

  it('adds the Buzz reader when Buzz is configured, owner alone only', async () => {
    const readBuzz = vi.fn(async () => ({ channel: '3cats', messages: [] }));
    const tools = buildResearchTools({ ...deps, readBuzz }, 'owner_only');
    expect(tools.map((t) => t.def.name)).toContain('read_buzz');
    await tools.find((t) => t.def.name === 'read_buzz')!.run({ channel: ' 3cats ', limit: 99 });
    expect(readBuzz).toHaveBeenCalledWith({ channel: '3cats', limit: 20 });
    expect(buildResearchTools({ ...deps, readBuzz }, 'guests').map((t) => t.def.name)).toEqual(['search_notes']);
  });

  it('leaves out a source that is not configured', () => {
    expect(buildResearchTools({ searchNotes: deps.searchNotes }, 'owner_only').map((t) => t.def.name)).toEqual(['search_notes']);
  });

  it('caps note text and limits, and passes the period and instruction through', async () => {
    const notes = buildResearchTools(deps, 'guests')[0]!;
    const out = (await notes.run({ query: ' yesterday work ', limit: 99 })) as { results: Array<{ text: string; date: string }>; period: unknown; instruction: string };
    expect(deps.searchNotes).toHaveBeenCalledWith('yesterday work', 12);
    expect(out.results[0]!.text.length).toBe(1800);
    expect(out.results[0]!.date).toBe('2026-11-13');
    expect(out.period).toEqual({ label: 'yesterday' });
    expect(out.instruction).toBe('say so');
    await expect(notes.run({ query: '  ' })).rejects.toThrow('query is required');
  });
});

describe('searchEmail', () => {
  it('lists, then reads headers and the snippet only', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[3] === 'list') return { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] };
      return { snippet: 'Hi David, '.repeat(60), payload: { headers: [{ name: 'From', value: 'Pat <pat@example.com>' }, { name: 'Subject', value: 'Launch' }, { name: 'Date', value: 'Fri, 13 Nov 2026' }] } };
    });
    const found = await searchEmail(run, 'from:jc', 2);
    expect(found.count).toBe(2);
    expect(found.messages[0]).toMatchObject({ from: 'Pat <pat@example.com>', subject: 'Launch', to: '' });
    expect(found.messages[0]!.snippet.length).toBe(300);
    expect(JSON.parse(run.mock.calls[0]![0][5]!)).toEqual({ userId: 'me', q: 'from:jc', maxResults: 2 });
    expect(JSON.parse(run.mock.calls[1]![0][5]!).format).toBe('metadata');
  });
});
