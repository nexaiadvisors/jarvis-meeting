// End-to-end smoke test for the Claude Meetings parity work.
//
// It boots the real app (createApp with the config loadConfig builds from the
// environment) in this process, with a temporary working directory as its data dir and a
// fake Recall behind global fetch. Then it drives one whole meeting through the public
// surfaces: /mcp, the Recall webhook, and the share-token pages. Every assertion is on an
// HTTP response body or on a request the app sent to the fake Recall.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const OWNER = 'smoke-owner-token';
const RECALL = 'https://recall.smoke.test/api/v1';
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
let workDir: string;
let app: Hono;
let client: Client;
let call: (client: Client, name: string, args?: Record<string, unknown>) => Promise<{ data: Record<string, any>; isError: boolean }>;

/** Every request the app made to the fake Recall. */
const recall: { method: string; path: string; body: Record<string, any> }[] = [];
const chatPosts = () => recall.filter((r) => r.path.endsWith('/send_chat_message/')).map((r) => r.body['message'] as string);

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'jm-smoke-'));
  mkdirSync(join(workDir, 'soul'));
  // brain: external, so the test can answer a request as an outside MCP agent.
  writeFileSync(
    join(workDir, 'soul', 'david.md'),
    '---\nname: Sidekick\nowner: david\nwake_word: jarvis\npersona_mode: first_person\nbrain: external\n---\nprose\n',
  );
  // Modules resolve <cwd>/.data when they load, so the working directory changes first.
  process.chdir(workDir);
  for (const key of ['WEBHOOK_SECRET', 'JARVIS_TOKENS', 'JARVIS_API_TOKEN', 'CALENDAR_AUTO_JOIN', 'KNOWLEDGE_SOURCE', 'EXTERNAL_GUEST_POLICY']) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    RECALL_API_KEY: 'smoke-recall-key',
    RECALL_API_BASE: RECALL,
    PUBLIC_BASE_URL: 'http://localhost:8790',
    OWNER_TOKEN: OWNER,
    DEFAULT_TEAMMATE: 'david',
    SOUL_DIR: join(workDir, 'soul'),
    JARVIS_BOT_NAME: 'Jarvis',
  });

  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(RECALL)) throw new Error(`smoke test: unexpected outbound request to ${url}`);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, any>) : {};
    recall.push({ method: init?.method ?? 'GET', path: url.slice(RECALL.length), body });
    return new Response(JSON.stringify(url.endsWith('/bot/') ? { id: 'bot-smoke-1' } : {}), { status: 200 });
  }) as typeof fetch;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);

  const { loadConfig } = await import('../src/config.js');
  const { createApp } = await import('../src/app.js');
  const helpers = await import('./helpers/mcp.js');
  call = helpers.call;
  app = createApp(loadConfig());
  client = await helpers.connect(app, OWNER);
});

afterAll(async () => {
  const { __clearRequests } = await import('../src/meeting/requests.js');
  const { __clearRegistry } = await import('../src/meeting/registry.js');
  __clearRequests();
  __clearRegistry();
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const webhook = (event: string, data: Record<string, unknown>) =>
  app.fetch(new Request('http://localhost:8790/webhooks/recall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, data: { ...data, bot: { id: 'bot-smoke-1', metadata: {} } } }) }));
const get = (pathAndQuery: string) => app.fetch(new Request(`http://localhost:8790${pathAndQuery}`));

describe('parity smoke: one meeting, end to end', () => {
  it('joins, takes a typed request, answers as an outside brain, builds a doc, shows the meeting page, and leaves', async () => {
    // 0. No token, no tools.
    const anonymous = await app.fetch(new Request('http://localhost:8790/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
    expect(anonymous.status).toBe(401);

    // 1. An MCP agent sends the bot into a meeting.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['join_meeting', 'get_transcript', 'say', 'post_chat', 'create_artifact', 'wait_for_request', 'respond', 'leave_meeting']) {
      expect(tools).toContain(name);
    }
    const joined = await call(client, 'join_meeting', { meeting_url: 'https://meet.google.com/abc-defg-hij', title: 'Customer event planning' });
    expect(joined.isError).toBe(false);
    const meetingId = joined.data['meetingId'] as string;
    expect(recall[0]).toMatchObject({ method: 'POST', path: '/bot/', body: { meeting_url: 'https://meet.google.com/abc-defg-hij', bot_name: 'Jarvis' } });
    expect(recall[0]!.body['recording_config']['realtime_endpoints'][0]['events']).toContain('participant_events.chat_message');

    // 2. Recall admits the bot: it announces itself in chat with the meeting page link.
    expect((await webhook('bot.in_call_recording', {})).status).toBe(200);
    await vi.waitFor(() => expect(chatPosts()).toHaveLength(1));
    const notice = chatPosts()[0]!;
    expect(notice).toContain('Jarvis is an AI note-taker');
    const pageLink = /Meeting page: (http:\/\/localhost:8790(\/m\/[^\s]+))/.exec(notice);
    expect(pageLink).not.toBeNull();
    const pagePath = pageLink![2]!;
    const shareQuery = pagePath.slice(pagePath.indexOf('?'));

    // 3. People talk, and someone types a request that starts with the wake word.
    await webhook('transcript.data', { data: { participant: { name: 'Nick' }, words: [{ text: 'Last' }, { text: 'year' }, { text: 'we' }, { text: 'spent' }, { text: 'a' }, { text: 'lot' }] } });
    await webhook('participant_events.chat_message', { data: { participant: { name: 'Robin' }, timestamp: { absolute: new Date().toISOString() }, data: { text: 'Jarvis, what did last year’s event cost?', to: 'everyone' } } });

    // 4. The outside brain collects the request and answers it in chat.
    const waited = await call(client, 'wait_for_request', { meeting_id: meetingId, timeout_seconds: 0 });
    expect(waited.data['request']).toMatchObject({ text: 'what did last year’s event cost?', from: 'Robin', source: 'chat' });
    expect(waited.data['recent_transcript'].map((l: { speaker: string }) => l.speaker)).toEqual(expect.arrayContaining(['Nick', 'Robin']));
    const answered = await call(client, 'respond', { request_id: waited.data['request'].id, text: 'Last year’s event cost 38,000 dollars.' });
    expect(answered.data).toMatchObject({ answered: true, via: 'chat' });
    expect(chatPosts()).toContain('Last year’s event cost 38,000 dollars.');

    // 5. The agent builds a doc and shares its link in chat.
    const doc = await call(client, 'create_artifact', { meeting_id: meetingId, kind: 'doc', title: 'Event plan', content: '# Event plan\n\n- Budget: 40k' });
    expect(doc.data).toMatchObject({ kind: 'doc', title: 'Event plan', version: 1 });
    expect((await call(client, 'post_chat', { meeting_id: meetingId, text: `Doc: Event plan ${doc.data['url']}` })).data).toEqual({ posted: true });
    const docPath = (doc.data['url'] as string).replace('http://localhost:8790', '');

    // 6. A person opens the doc page from the chat link and saves an edit.
    const docPage = await get(docPath);
    expect(docPage.status).toBe(200);
    expect(await docPage.text()).toContain('/artifact-assets/main.js');
    const apiPath = docPath.replace('/a/', '/api/artifacts/');
    const saved = await app.fetch(new Request(`http://localhost:8790${apiPath}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '# Event plan\n\n- Budget: 40k\n- Venue: TBD', version: 1 }) }));
    expect(((await saved.json()) as { artifact: { version: number } }).artifact.version).toBe(2);
    expect((await call(client, 'get_artifact', { meeting_id: meetingId, artifact_id: doc.data['id'] })).data['content']).toContain('Venue: TBD');
    // Without the share token the page and the data do not exist.
    expect((await get(docPath.split('?')[0]!)).status).toBe(404);
    expect((await get(apiPath.split('?')[0]!)).status).toBe(404);
    expect((await get(`${pagePath.split('?')[0]}?t=wrong-token`)).status).toBe(404);
    expect((await get(`/api/meeting-page/${meetingId}`)).status).toBe(404);

    // 7. The meeting page shows the conversation, the chat lines and the doc.
    expect((await get(pagePath)).status).toBe(200);
    const page = (await (await get(`/api/meeting-page/${meetingId}${shareQuery}`)).json()) as Record<string, any>;
    expect(page['meeting']).toMatchObject({ title: 'Customer event planning', status: 'live' });
    const lines = (page['transcript'] as { speaker: string; text: string; kind?: string }[]).map((l) => `${l.speaker}${l.kind ? ' (chat)' : ''}: ${l.text}`);
    expect(lines).toEqual(
      expect.arrayContaining([
        'Nick: Last year we spent a lot',
        'Robin (chat): Jarvis, what did last year’s event cost?',
        'Jarvis (chat): Last year’s event cost 38,000 dollars.',
      ]),
    );
    expect(page['artifacts']).toEqual([expect.objectContaining({ id: doc.data['id'], kind: 'doc', title: 'Event plan' })]);
    // The stored transcript and the page data never carry the share token.
    expect(JSON.stringify(page)).not.toContain(shareQuery.slice(3));
    expect(JSON.stringify(page)).not.toContain(OWNER);

    // 8. The agent reads the transcript over MCP, then takes the bot out.
    const transcript = await call(client, 'get_transcript', { meeting_id: meetingId });
    expect(transcript.data['total']).toBeGreaterThanOrEqual(5);
    const left = await call(client, 'leave_meeting', { meeting_id: meetingId });
    expect(left.data).toEqual({ left: true, alreadyGone: false });
    expect(recall.at(-1)).toMatchObject({ method: 'POST', path: '/bot/bot-smoke-1/leave_call/' });
    expect((await call(client, 'get_meeting', { meeting_id: meetingId })).data).toMatchObject({ status: 'completed', inCall: false });
    expect((await call(client, 'post_chat', { meeting_id: meetingId, text: 'too late' })).isError).toBe(true);
  });
});
