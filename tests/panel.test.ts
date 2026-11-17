import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { ownerCookieValue } from '../src/auth/owner.js';
import { appendNote } from '../src/meeting/notes.js';
import { __clearRegistry, getMeeting, registerMeeting } from '../src/meeting/registry.js';
import { LEAVE_BACKSTOP_DELAY_MS, createPanelRoutes } from '../src/routes/panel.js';
import { Hono } from 'hono';

const { mockLeaveBot, mockKickoffPipeline } = vi.hoisted(() => ({ mockLeaveBot: vi.fn(), mockKickoffPipeline: vi.fn() }));
vi.mock('../src/recall/leave-bot.js', () => ({ leaveBot: mockLeaveBot }));
vi.mock('../src/postmeeting/pipeline.js', () => ({ kickoffPipeline: mockKickoffPipeline }));

const OWNER = 'owner-token-for-tests';
const DATA_DIR = join(process.cwd(), '.data');
const createdNoteFiles: string[] = [];

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8790,
    publicBaseUrl: 'https://ngrok.example.com',
    jarvisBotName: 'Jarvis',
    recallApiKey: 'rk-test',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    ownerToken: OWNER,
    defaultTeammate: 'david',
    maxDurationMs: 7_200_000,
    maxConcurrentPerTeammate: 2,
    tokenRegistry: new Map([[OWNER, 'david']]),
    workScopeNamespaces: [],
    kbBackendHealthUrl: 'http://127.0.0.1:7402/healthz',
    kbBackendHealthCheckEnabled: true,
    ...overrides,
  } as unknown as Config;
}

const config = makeConfig();
const ownerCookie = { Cookie: `jm_owner=${ownerCookieValue(config)}` };
// A cookie-authenticated write must come from the panel's own origin (browsers send Origin on fetch POST).
const ownerWrite = { ...ownerCookie, Origin: config.publicBaseUrl };

interface ListedMeeting {
  id: string;
  title: string;
  status: string;
  inCall: boolean;
  muted: boolean;
  notesCount: number;
  obEntityKey: string;
  failureCode?: string;
}

function listMeetings(headers: Record<string, string> = ownerCookie): Promise<Response> {
  return Promise.resolve(createApp(config).request('/api/owner/meetings', { headers }));
}

beforeEach(() => {
  __clearRegistry();
  mockLeaveBot.mockReset();
  mockLeaveBot.mockResolvedValue({ ok: true });
  mockKickoffPipeline.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const file of createdNoteFiles.splice(0)) rmSync(file, { force: true });
  __clearRegistry();
});

describe('owner routes require the owner credential', () => {
  it('owner routes return 401 without the cookie', async () => {
    const app = createApp(config);
    registerMeeting({ meetingId: 'm1', botId: 'bot-1', teammate: 'david', persona: 'first_person', title: 'M1' });

    const responses = await Promise.all([
      app.request('/api/owner/meetings'),
      app.request('/api/owner/meetings/m1/leave', { method: 'POST' }),
      app.request('/api/owner/kb-health'),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe('OWNER_REQUIRED');
    }
    expect(mockLeaveBot).not.toHaveBeenCalled();
  });

  it('rejects a cookie with a wrong value and a bearer that is not the owner token', async () => {
    const app = createApp(config);
    const wrongCookie = await app.request('/api/owner/meetings', { headers: { Cookie: 'jm_owner=not-the-hmac' } });
    const wrongBearer = await app.request('/api/owner/meetings', { headers: { Authorization: 'Bearer nope' } });

    expect(wrongCookie.status).toBe(401);
    expect(wrongBearer.status).toBe(401);
  });

  it('accepts the owner bearer token as well as the cookie', async () => {
    const res = await createApp(config).request('/api/owner/meetings', { headers: { Authorization: `Bearer ${OWNER}` } });
    expect(res.status).toBe(200);
  });

  it('fails closed when no OWNER_TOKEN is configured', async () => {
    const open = makeConfig({ ownerToken: undefined, tokenRegistry: new Map() });
    const res = await createApp(open).request('/api/owner/meetings', { headers: { Authorization: 'Bearer anything' } });
    expect(res.status).toBe(401);
  });
});

describe('GET /panel and /panel.js are public static files', () => {
  it('serves the panel page without credentials, with no owner data in it', async () => {
    const res = await createApp(config).request('/panel');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/panel.js"');
    expect(html).toContain('width=device-width');
    expect(html).not.toContain(OWNER);
    expect(html).not.toContain(ownerCookieValue(config));
  });

  it('refuses to be framed and sniffed', async () => {
    const res = await createApp(config).request('/panel');

    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  // The bundle is a build artifact (public/, gitignored): assert it only when `npm run build` ran.
  it.skipIf(!existsSync(resolve(process.cwd(), 'public/panel.js')))(
    'serves the built bundle as JavaScript without credentials (requires npm run build)',
    async () => {
      const res = await createApp(config).request('/panel.js');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/javascript/);
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain(OWNER);
    },
  );
});

describe('GET /api/owner/meetings', () => {
  it('returns an empty list when nothing is registered', async () => {
    const res = await listMeetings();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ meetings: [] });
  });

  it('GET /api/owner/meetings lists newest first with obEntityKey meeting-<id>', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    registerMeeting({ meetingId: 'older', botId: 'bot-older', teammate: 'david', persona: 'first_person', title: 'Older call' });
    vi.setSystemTime(new Date('2026-10-16T11:00:00Z'));
    registerMeeting({ meetingId: 'newer', botId: 'bot-newer', teammate: 'david', persona: 'first_person', title: 'Newer call' });
    vi.setSystemTime(new Date('2026-10-16T11:00:00Z'));
    registerMeeting({ meetingId: 'same-ms', botId: 'bot-same', teammate: 'david', persona: 'first_person', title: 'Same ms' });
    vi.useRealTimers();

    const res = await listMeetings();
    const { meetings } = (await res.json()) as { meetings: ListedMeeting[] };

    // Equal createdAt: the one registered later comes first.
    expect(meetings.map((m) => m.id)).toEqual(['same-ms', 'newer', 'older']);
    expect(meetings.map((m) => m.obEntityKey)).toEqual(['meeting-same-ms', 'meeting-newer', 'meeting-older']);
    expect(meetings[2]).toEqual({
      id: 'older',
      title: 'Older call',
      status: 'live',
      inCall: false,
      muted: false,
      notesCount: 0,
      obEntityKey: 'meeting-older',
    });
  });

  it('reports status, inCall, muted and the saved notes count (keyed by botId)', async () => {
    const key = `bot-panel-notes-${Date.now()}`;
    registerMeeting({ meetingId: 'm-notes', botId: key, teammate: 'david', persona: 'first_person', title: 'Notes' });
    const rec = getMeeting('m-notes')!;
    rec.inCall = true;
    rec.mutedAt = Date.now();
    rec.status = 'completed';
    createdNoteFiles.push(join(DATA_DIR, `${key}.notes.jsonl`));
    appendNote(key, { kind: 'note', text: 'one', at: '2026-10-16T10:00:00Z', by: 'agent' });
    appendNote(key, { kind: 'flag', text: 'two', at: '2026-10-16T10:01:00Z', by: 'agent' });

    const { meetings } = (await (await listMeetings()).json()) as { meetings: ListedMeeting[] };

    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toMatchObject({ status: 'completed', inCall: true, muted: true, notesCount: 2 });
  });

  it('keys the notes count by meetingId when the meeting has no botId', async () => {
    const key = `panel-notes-no-bot-${Date.now()}`;
    registerMeeting({ meetingId: key, teammate: 'david', persona: 'first_person', title: 'No bot' });
    createdNoteFiles.push(join(DATA_DIR, `${key}.notes.jsonl`));
    appendNote(key, { kind: 'note', text: 'by id', at: '2026-10-16T10:00:00Z', by: 'owner' });

    const { meetings } = (await (await listMeetings()).json()) as { meetings: ListedMeeting[] };

    expect(meetings[0]?.notesCount).toBe(1);
  });

  it('after a bot.fatal webhook the meeting lists status failed with its failureCode', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = createApp(config);
    registerMeeting({ meetingId: 'm-fatal', botId: 'bot-fatal', teammate: 'david', persona: 'first_person', title: 'Fatal' });

    const hook = await app.request('/webhooks/recall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'bot.fatal',
        data: { bot: { id: 'bot-fatal' }, data: { code: 'fatal', sub_code: 'meeting_not_found' } },
      }),
    });
    expect(hook.status).toBe(200);

    const res = await app.request('/api/owner/meetings', { headers: ownerCookie });
    const { meetings } = (await res.json()) as { meetings: ListedMeeting[] };
    expect(meetings[0]).toMatchObject({ id: 'm-fatal', status: 'failed', inCall: false, failureCode: 'meeting_not_found' });
  });

  it('omits failureCode for a meeting that has not failed', async () => {
    registerMeeting({ meetingId: 'ok', botId: 'bot-ok', teammate: 'david', persona: 'first_person', title: 'Fine' });
    const { meetings } = (await (await listMeetings()).json()) as { meetings: ListedMeeting[] };
    expect(meetings[0]).not.toHaveProperty('failureCode');
  });
});

describe('POST /api/owner/meetings/:id/leave', () => {
  it('leave calls leaveBot with the botId and returns 202', async () => {
    registerMeeting({ meetingId: 'm-leave', botId: 'bot-leave', teammate: 'david', persona: 'first_person', title: 'Leave' });

    const res = await createApp(config).request('/api/owner/meetings/m-leave/leave', { method: 'POST', headers: ownerWrite });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockLeaveBot).toHaveBeenCalledTimes(1);
    expect(mockLeaveBot).toHaveBeenCalledWith(expect.objectContaining({ ownerToken: OWNER }), 'bot-leave');
  });

  it('retires the meeting like the sweep does once the leave succeeded', async () => {
    registerMeeting({ meetingId: 'm-retire', botId: 'bot-retire', teammate: 'david', persona: 'first_person', title: 'Retire' });
    getMeeting('m-retire')!.inCall = true;

    await createApp(config).request('/api/owner/meetings/m-retire/leave', { method: 'POST', headers: ownerWrite });

    expect(getMeeting('m-retire')).toMatchObject({ status: 'completed', inCall: false });
  });

  it('returns 404 for an unknown meeting without calling Recall', async () => {
    const res = await createApp(config).request('/api/owner/meetings/nope/leave', { method: 'POST', headers: ownerWrite });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('not_found');
    expect(mockLeaveBot).not.toHaveBeenCalled();
  });

  it('returns 502 LEAVE_FAILED and keeps the meeting live when Recall refuses the leave', async () => {
    registerMeeting({ meetingId: 'm-stuck', botId: 'bot-stuck', teammate: 'david', persona: 'first_person', title: 'Stuck' });
    mockLeaveBot.mockResolvedValue({ ok: false, error: 'recall leave failed (500): boom' });

    const res = await createApp(config).request('/api/owner/meetings/m-stuck/leave', { method: 'POST', headers: ownerWrite });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; code: string; error: string };
    expect(body).toMatchObject({ ok: false, code: 'LEAVE_FAILED' });
    expect(getMeeting('m-stuck')!.status).toBe('live');
  });

  it('returns 409 NO_BOT for a meeting that has no bot id yet', async () => {
    registerMeeting({ meetingId: 'm-nobot', teammate: 'david', persona: 'first_person', title: 'No bot' });

    const res = await createApp(config).request('/api/owner/meetings/m-nobot/leave', { method: 'POST', headers: ownerWrite });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('NO_BOT');
    expect(mockLeaveBot).not.toHaveBeenCalled();
  });

  it('refuses a cookie-authenticated leave from another origin or with no Origin (403 ORIGIN_MISMATCH) without calling Recall', async () => {
    registerMeeting({ meetingId: 'm-csrf', botId: 'bot-csrf', teammate: 'david', persona: 'first_person', title: 'CSRF' });
    const app = createApp(config);

    const noOrigin = await app.request('/api/owner/meetings/m-csrf/leave', { method: 'POST', headers: ownerCookie });
    const foreign = await app.request('/api/owner/meetings/m-csrf/leave', {
      method: 'POST',
      headers: { ...ownerCookie, Origin: 'https://evil.example.com' },
    });

    for (const res of [noOrigin, foreign]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('ORIGIN_MISMATCH');
    }
    expect(mockLeaveBot).not.toHaveBeenCalled();
    expect(getMeeting('m-csrf')!.status).toBe('live');
  });

  it('a bearer leave with no Origin still works (scripts and curl)', async () => {
    registerMeeting({ meetingId: 'm-bearer', botId: 'bot-bearer', teammate: 'david', persona: 'first_person', title: 'Bearer' });

    const res = await createApp(config).request('/api/owner/meetings/m-bearer/leave', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OWNER}` },
    });

    expect(res.status).toBe(202);
    expect(mockLeaveBot).toHaveBeenCalledWith(expect.anything(), 'bot-bearer');
  });
});

// ---------------------------------------------------------------------------
// Leave must always lead to the post-meeting document, even when Recall's bot.* webhook
// never arrives (the dashboard webhook is not registered, or its secret is stale), and
// even when Recall has already removed the bot.
// ---------------------------------------------------------------------------
describe('POST /api/owner/meetings/:id/leave: pipeline backstop and a bot Recall already removed', () => {
  function register(id: string, extra: { title?: string } = {}): void {
    registerMeeting({ meetingId: id, botId: `bot-${id}`, teammate: 'david', persona: 'first_person', title: extra.title ?? 'Backstop' });
    getMeeting(id)!.inCall = true;
  }

  function leave(id: string, app = createApp(config)): Promise<Response> | Response {
    return app.request(`/api/owner/meetings/${id}/leave`, { method: 'POST', headers: ownerWrite });
  }

  it('a successful Leave schedules kickoffPipeline LEAVE_BACKSTOP_DELAY_MS (90 s) later, not before', async () => {
    vi.useFakeTimers();
    expect(LEAVE_BACKSTOP_DELAY_MS).toBe(90_000);
    register('m-bs1', { title: 'Weekly sync' });

    const res = await leave('m-bs1');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockKickoffPipeline).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LEAVE_BACKSTOP_DELAY_MS - 1);
    expect(mockKickoffPipeline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
    expect(mockKickoffPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ ownerToken: OWNER }),
      { botId: 'bot-m-bs1', meetingId: 'm-bs1', meetingTitle: 'Weekly sync', teammate: 'david' },
    );
  });

  it('pressing Leave twice schedules the backstop once', async () => {
    vi.useFakeTimers();
    register('m-bs2');
    const app = createApp(config); // one app, as in the running service

    await leave('m-bs2', app);
    await leave('m-bs2', app);
    await vi.advanceTimersByTimeAsync(LEAVE_BACKSTOP_DELAY_MS);

    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
  });

  it('a failed Leave (502) schedules no backstop and keeps the meeting live', async () => {
    vi.useFakeTimers();
    register('m-bs3');
    mockLeaveBot.mockResolvedValue({ ok: false, error: 'recall leave failed (500): boom' });

    const res = await leave('m-bs3');
    await vi.advanceTimersByTimeAsync(LEAVE_BACKSTOP_DELAY_MS * 2);

    expect(res.status).toBe(502);
    expect(mockKickoffPipeline).not.toHaveBeenCalled();
    expect(getMeeting('m-bs3')!.status).toBe('live');
  });

  it('a bot Recall already removed (404/410) counts as left: 202 alreadyGone, meeting retired, backstop scheduled', async () => {
    vi.useFakeTimers();
    register('m-bs4');
    mockLeaveBot.mockResolvedValue({ ok: false, alreadyGone: true, error: 'recall leave failed (404): {"detail":"Not found."}' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await leave('m-bs4');

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, alreadyGone: true });
    expect(getMeeting('m-bs4')).toMatchObject({ status: 'completed', inCall: false });
    await vi.advanceTimersByTimeAsync(LEAVE_BACKSTOP_DELAY_MS);
    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
  });

  it('after an alreadyGone Leave the next Join is not blocked by the concurrency cap', async () => {
    register('m-bs5');
    mockLeaveBot.mockResolvedValue({ ok: false, alreadyGone: true, error: 'recall leave failed (404): gone' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await leave('m-bs5');

    const { countLiveForTeammate } = await import('../src/meeting/registry.js');
    expect(countLiveForTeammate('david')).toBe(0);
  });

  it('the delay is injectable', async () => {
    vi.useFakeTimers();
    register('m-bs6');
    const app = new Hono();
    app.route('/', createPanelRoutes(config, { backstopDelayMs: 25 }));

    const res = await leave('m-bs6', app as never);
    expect(res.status).toBe(202);
    await vi.advanceTimersByTimeAsync(24);
    expect(mockKickoffPipeline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
  });
});

describe('GET /api/owner/kb-health', () => {
  it('kb-health returns ok false when the health URL refuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    const res = await createApp(config).request('/api/owner/kb-health', { headers: ownerCookie });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('returns ok true when the health URL answers 2xx, probing only the configured URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const res = await createApp(config).request('/api/owner/kb-health', { headers: ownerCookie });

    expect(await res.json()).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:7402/healthz');
  });

  it('returns ok false when the health URL answers non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));

    const res = await createApp(config).request('/api/owner/kb-health', { headers: ownerCookie });

    expect(await res.json()).toEqual({ ok: false });
  });

  it('returns ok false without any request when no health URL is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const unset = makeConfig({ kbBackendHealthUrl: undefined, kbBackendHealthCheckEnabled: false });

    const res = await createApp(unset).request('/api/owner/kb-health', { headers: ownerCookie });

    expect(await res.json()).toEqual({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives up after 2 seconds when the health URL hangs', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    const pending = Promise.resolve(createApp(config).request('/api/owner/kb-health', { headers: ownerCookie }));
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(await res.json()).toEqual({ ok: false });
  });
});
