import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Config } from '../src/config.js';

// ------------------------------------------------------------------
// Mock the pipeline so webhook tests don't run real Azure/Anthropic calls.
// ------------------------------------------------------------------
const mockKickoffPipeline = vi.fn();
vi.mock('../src/postmeeting/pipeline.js', () => ({
  kickoffPipeline: mockKickoffPipeline,
}));

const { createWebhookRoute } = await import('../src/routes/webhook.js');
const { registerMeeting, getMeeting, __clearRegistry } = await import('../src/meeting/registry.js');

const BASE_CONFIG: Config = {
  port: 8787,
  recallApiKey: 'rk',
  recallApiBase: 'https://us-east-1.recall.ai/api/v1',
  maxConcurrentPerTeammate: 2,
  idleTimeoutMs: 600000,
  maxDurationMs: 7200000,
  sweepIntervalMs: 60000,
  publicBaseUrl: 'https://ngrok.example.com',
  teamKbAnswerEndpoint: undefined,
  teamKbAnswerApiToken: undefined,
  teamKbFallbackUrl: 'http://localhost:3031',
  jarvisBotName: 'Jarvis',
  jarvisApiToken: undefined,
  webhookSecret: undefined,
  azureStorageAccountName: undefined,
  azureStorageAccountKey: undefined,
  azureStorageBlobContainer: undefined,
  artifactSasTtlHours: 168,
  anthropicApiKey: undefined,
  anthropicModel: 'claude-sonnet-4-6',
  graphTenantId: undefined,
  graphClientId: undefined,
  graphClientSecret: undefined,
  meetingEmailSender: undefined,
  meetingEmailDefaultRecipients: [],
  tokenRegistry: new Map<string, string>(),
  slackBotToken: undefined,
  meetingSlackChannel: undefined,
};

function makeApp(): Hono {
  const app = new Hono();
  app.route('/', createWebhookRoute(BASE_CONFIG));
  return app;
}

async function postEvent(app: Hono, body: unknown): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/webhooks/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearRegistry();
  // bot.in_call_recording posts the join notice through Recall; no test may reach the network.
  global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A bot this service created: a registry entry for it (as dispatch makes). */
function ownBot(botId: string, meetingId = `m-${botId}`, teammate = 'a'): void {
  registerMeeting({ meetingId, botId, teammate, persona: 'ai', title: 'Own meeting' });
}

// ---------------------------------------------------------------------------
// Transcript parsing — new Recall format
// ---------------------------------------------------------------------------
describe('webhook transcript.data — new format', () => {
  it('parses speaker from data.data.participant.name', async () => {
    const app = makeApp();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await postEvent(app, {
      event: 'transcript.data',
      data: {
        bot: { id: 'bot-new' },
        data: {
          participant: { name: 'Alice' },
          words: [{ text: 'Hello' }, { text: 'world' }],
        },
      },
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"speaker":"Alice"'),
    );
  });

  it('joins words[].text into a single string', async () => {
    const app = makeApp();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await postEvent(app, {
      event: 'transcript.data',
      data: {
        bot: { id: 'bot-new2' },
        data: {
          participant: { name: 'Bob' },
          words: [{ text: 'One' }, { text: 'two' }, { text: 'three' }],
        },
      },
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"chars":13'),
    );
  });
});

// ---------------------------------------------------------------------------
// Transcript parsing — legacy format fallback
// ---------------------------------------------------------------------------
describe('webhook transcript.data — legacy format fallback', () => {
  it('falls back to data.transcript.speaker', async () => {
    const app = makeApp();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await postEvent(app, {
      event: 'transcript.data',
      data: {
        bot_id: 'bot-legacy',
        transcript: {
          speaker: 'Carol',
          words: [{ text: 'legacy' }, { text: 'text' }],
        },
      },
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"speaker":"Carol"'),
    );
  });
});

// ---------------------------------------------------------------------------
// bot.done triggers the pipeline exactly once (idempotency is in pipeline.ts,
// but the webhook must call kickoffPipeline on every bot.done it sees).
// ---------------------------------------------------------------------------
describe('webhook bot.done', () => {
  it('calls kickoffPipeline on bot.done', async () => {
    ownBot('bot-done');
    const app = makeApp();
    await postEvent(app, {
      event: 'bot.done',
      data: { bot: { id: 'bot-done', bot_name: 'Jarvis' } },
    });

    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
    expect(mockKickoffPipeline).toHaveBeenCalledWith(
      BASE_CONFIG,
      expect.objectContaining({ botId: 'bot-done' }),
    );
  });

  it('calls kickoffPipeline on bot.call_ended', async () => {
    ownBot('bot-ended');
    const app = makeApp();
    await postEvent(app, {
      event: 'bot.call_ended',
      data: { bot: { id: 'bot-ended' } },
    });

    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
  });

  it('recovers meeting_id, teammate, and soul_slug from bot.metadata', async () => {
    const app = makeApp();
    await postEvent(app, {
      event: 'bot.done',
      data: {
        bot: {
          id: 'bot-meta',
          metadata: { meeting_id: 'mtg-xyz', teammate: 'david', soul_slug: 'jarvis' },
        },
      },
    });

    expect(mockKickoffPipeline).toHaveBeenCalledWith(
      BASE_CONFIG,
      expect.objectContaining({
        botId: 'bot-meta',
        meetingId: 'mtg-xyz',
        teammate: 'david',
        soulSlug: 'jarvis',
      }),
    );
  });

  it('falls back to external_id for meetingId and defaultTeammate for teammate when metadata absent', async () => {
    ownBot('bot-fb', 'registered-under-another-id');
    const app = makeApp();
    const cfg: Config = { ...BASE_CONFIG, defaultTeammate: 'fallback-mate' };
    const localApp = new Hono();
    localApp.route('/', createWebhookRoute(cfg));

    await postEvent(localApp, {
      event: 'bot.done',
      data: { bot: { id: 'bot-fb', external_id: 'mtg-from-extid' } },
    });

    expect(mockKickoffPipeline).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({
        botId: 'bot-fb',
        meetingId: 'mtg-from-extid',
        teammate: 'fallback-mate',
      }),
    );
  });

  it('falls back to botId for meetingId when neither metadata nor external_id present', async () => {
    ownBot('bot-only', 'registered-under-another-id');
    const app = makeApp();
    await postEvent(app, {
      event: 'bot.done',
      data: { bot: { id: 'bot-only' } },
    });

    expect(mockKickoffPipeline).toHaveBeenCalledWith(
      BASE_CONFIG,
      expect.objectContaining({ botId: 'bot-only', meetingId: 'bot-only' }),
    );
  });

  it('always returns 200 even for bot.done (fire-and-forget)', async () => {
    ownBot('bot-200');
    const app = makeApp();
    const resp = await postEvent(app, {
      event: 'bot.done',
      data: { bot: { id: 'bot-200' } },
    });

    expect(resp.status).toBe(200);
  });

  it('does NOT call kickoffPipeline for transcript.data events', async () => {
    const app = makeApp();
    await postEvent(app, {
      event: 'transcript.data',
      data: {
        bot: { id: 'bot-tx' },
        data: { participant: { name: 'Dave' }, words: [{ text: 'hi' }] },
      },
    });

    expect(mockKickoffPipeline).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('webhook edge cases', () => {
  it('returns 400 on invalid JSON body', async () => {
    const app = makeApp();
    const resp = await app.fetch(
      new Request('http://localhost/webhooks/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(resp.status).toBe(400);
  });

  it('returns 200 for unknown events (unhandled)', async () => {
    const app = makeApp();
    const resp = await postEvent(app, { event: 'bot.something_new', data: {} });
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Webhook auth via WEBHOOK_SECRET (protects the metadata attribution path)
// ---------------------------------------------------------------------------
describe('webhook auth via WEBHOOK_SECRET', () => {
  const SECURED: Config = { ...BASE_CONFIG, webhookSecret: 'whsec-test' };

  async function postWithQuery(cfg: Config, query: string, body: unknown): Promise<Response> {
    const app = new Hono();
    app.route('/', createWebhookRoute(cfg));
    return app.fetch(
      new Request(`http://localhost/webhooks/recall${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  const evt = { event: 'transcript.data', data: { bot: { id: 'b' }, data: { participant: { name: 'A' }, words: [{ text: 'hi' }] } } };

  it('accepts a request carrying the correct ?s= secret', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await postWithQuery(SECURED, '?s=whsec-test', evt);
    expect(res.status).toBe(200);
  });

  it('rejects a wrong secret with 401', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await postWithQuery(SECURED, '?s=nope', { event: 'bot.done', data: { bot: { id: 'b', metadata: { meeting_id: 'm', teammate: 'attacker' } } } });
    expect(res.status).toBe(401);
  });

  it('rejects a missing secret with 401 when one is configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await postWithQuery(SECURED, '', evt);
    expect(res.status).toBe(401);
  });

  it('allows any request when no secret is configured (dev mode)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await postWithQuery(BASE_CONFIG, '', evt);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Cost-control hooks: transcript.data touches activity; bot.done completes.
// ---------------------------------------------------------------------------
describe('webhook cost-control registry hooks', () => {
  beforeEach(() => {
    __clearRegistry();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('transcript.data advances lastActivityAt for the meeting owning the bot', async () => {
    const rec = registerMeeting({ meetingId: 'm-active', botId: 'bot-active', teammate: 'a', persona: 'ai', title: 't' });
    const seeded = rec.lastActivityAt;

    await postEvent(makeApp(), {
      event: 'transcript.data',
      data: { bot: { id: 'bot-active' }, data: { participant: { name: 'A' }, words: [{ text: 'hi' }] } },
    });

    expect(getMeeting('m-active')!.lastActivityAt).toBeGreaterThanOrEqual(seeded);
  });

  it('bot.done marks the meeting completed', async () => {
    registerMeeting({ meetingId: 'm-done', botId: 'bot-complete', teammate: 'a', persona: 'ai', title: 't' });

    await postEvent(makeApp(), {
      event: 'bot.done',
      data: { bot: { id: 'bot-complete', metadata: { meeting_id: 'm-done', teammate: 'a' } } },
    });

    expect(getMeeting('m-done')!.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// bot.fatal: the owner panel shows why a bot failed.
// ---------------------------------------------------------------------------
describe('webhook bot.fatal records the failure reason', () => {
  beforeEach(() => {
    __clearRegistry();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function fatal(botId: string, statusData: Record<string, unknown>): unknown {
    return { event: 'bot.fatal', data: { bot: { id: botId }, data: statusData } };
  }

  it('stores sub_code as failureCode and marks the meeting failed and out of the call', async () => {
    registerMeeting({ meetingId: 'm-fatal', botId: 'bot-fatal', teammate: 'a', persona: 'ai', title: 't' });
    getMeeting('m-fatal')!.inCall = true;

    await postEvent(makeApp(), fatal('bot-fatal', { code: 'fatal', sub_code: 'meeting_not_found' }));

    expect(getMeeting('m-fatal')).toMatchObject({ status: 'failed', inCall: false, failureCode: 'meeting_not_found' });
  });

  it('falls back to code when there is no sub_code', async () => {
    registerMeeting({ meetingId: 'm-fatal2', botId: 'bot-fatal2', teammate: 'a', persona: 'ai', title: 't' });

    await postEvent(makeApp(), fatal('bot-fatal2', { code: 'fatal' }));

    expect(getMeeting('m-fatal2')).toMatchObject({ status: 'failed', failureCode: 'fatal' });
  });

  it('marks the meeting failed without a failureCode when Recall sent neither', async () => {
    registerMeeting({ meetingId: 'm-fatal3', botId: 'bot-fatal3', teammate: 'a', persona: 'ai', title: 't' });

    await postEvent(makeApp(), fatal('bot-fatal3', {}));

    const rec = getMeeting('m-fatal3')!;
    expect(rec.status).toBe('failed');
    expect(rec).not.toHaveProperty('failureCode');
  });
});

// ---------------------------------------------------------------------------
// The account-level Recall webhook delivers EVERY bot's status events. A bot this
// service did not create is ignored: no pipeline, no DEFAULT_TEAMMATE attribution.
// ---------------------------------------------------------------------------
describe('webhook ignores bots this service did not create', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const STATUS_EVENTS = ['bot.done', 'bot.call_ended', 'bot.in_call_recording', 'bot.fatal'] as const;

  it.each(STATUS_EVENTS)('%s for an unknown bot with no metadata.meeting_id: 200, no pipeline, one info line', async (event) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await postEvent(makeApp(), { event, data: { bot: { id: 'bot-foreign', metadata: { owner: 'someone-else' } } } });

    expect(res.status).toBe(200);
    expect(mockKickoffPipeline).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      level: 'info',
      msg: 'ignored foreign bot',
      botId: 'bot-foreign',
    });
  });

  it('a foreign bot.done never falls back to DEFAULT_TEAMMATE and never touches the registry', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    ownBot('bot-mine', 'm-mine', 'david');

    await postEvent(makeApp(), { event: 'bot.done', data: { bot: { id: 'bot-foreign', external_id: 'm-mine' } } });

    expect(mockKickoffPipeline).not.toHaveBeenCalled();
    expect(getMeeting('m-mine')).toMatchObject({ status: 'live' });
  });

  it('a bot with no registry entry but metadata.meeting_id is ours (the service restarted): still processed', async () => {
    const res = await postEvent(makeApp(), {
      event: 'bot.done',
      data: { bot: { id: 'bot-after-restart', metadata: { meeting_id: 'm-restart', teammate: 'david' } } },
    });

    expect(res.status).toBe(200);
    expect(mockKickoffPipeline).toHaveBeenCalledWith(
      BASE_CONFIG,
      expect.objectContaining({ botId: 'bot-after-restart', meetingId: 'm-restart', teammate: 'david' }),
    );
  });

  it('a bot with a registry entry but no metadata is ours: still processed', async () => {
    ownBot('bot-registered', 'm-registered', 'david');

    await postEvent(makeApp(), { event: 'bot.call_ended', data: { bot: { id: 'bot-registered' } } });

    expect(mockKickoffPipeline).toHaveBeenCalledOnce();
  });

  it('an own bot.fatal and bot.in_call_recording still update the registry', async () => {
    ownBot('bot-own', 'm-own');

    await postEvent(makeApp(), { event: 'bot.in_call_recording', data: { bot: { id: 'bot-own' } } });
    expect(getMeeting('m-own')).toMatchObject({ inCall: true });

    await postEvent(makeApp(), { event: 'bot.fatal', data: { bot: { id: 'bot-own' }, data: { sub_code: 'meeting_not_found' } } });
    expect(getMeeting('m-own')).toMatchObject({ status: 'failed', inCall: false });
  });
});

// ---------------------------------------------------------------------------
// A rejected request must be visible in service.log: a wrong or stale secret in the
// Recall dashboard URL otherwise fails silently and no bot.done ever arrives.
// ---------------------------------------------------------------------------
describe('webhook logs a rejected request', () => {
  const SECURED: Config = { ...BASE_CONFIG, webhookSecret: 'whsec-test-secret' };

  async function rejected(query: string, body: string): Promise<{ status: number; warns: string[]; all: string }> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const app = new Hono();
    app.route('/', createWebhookRoute(SECURED));
    const res = await app.fetch(
      new Request(`http://localhost/webhooks/recall${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    );
    const lines = (spy: typeof warn) => spy.mock.calls.map((c) => String(c[0]));
    return { status: res.status, warns: lines(warn), all: [...lines(warn), ...lines(log), ...lines(info)].join('\n') };
  }

  it('wrong secret: 401 plus one warn line with the event type and the path', async () => {
    const out = await rejected('?s=stale-secret', JSON.stringify({ event: 'bot.done', data: { bot: { id: 'b' } } }));

    expect(out.status).toBe(401);
    expect(out.warns).toHaveLength(1);
    expect(JSON.parse(out.warns[0]!)).toMatchObject({ level: 'warn', event: 'bot.done', path: '/webhooks/recall' });
  });

  it('missing secret: 401 plus a warn line', async () => {
    const out = await rejected('', JSON.stringify({ event: 'transcript.data', data: {} }));

    expect(out.status).toBe(401);
    expect(out.warns).toHaveLength(1);
    expect(JSON.parse(out.warns[0]!)).toMatchObject({ event: 'transcript.data', path: '/webhooks/recall' });
  });

  it('an unparseable body is still logged, without an event', async () => {
    const out = await rejected('?s=x', 'not-json');

    expect(out.status).toBe(401);
    expect(out.warns).toHaveLength(1);
    const line = JSON.parse(out.warns[0]!) as Record<string, unknown>;
    expect(line['path']).toBe('/webhooks/recall');
    expect(line).not.toHaveProperty('event');
  });

  it('never logs the configured secret, the presented secret or the query string', async () => {
    const out = await rejected('?s=presented-wrong-value&extra=1', JSON.stringify({ event: 'bot.done', data: {} }));

    expect(out.all).not.toContain('whsec-test-secret');
    expect(out.all).not.toContain('presented-wrong-value');
    expect(out.all).not.toContain('extra=1');
    expect(out.all).not.toContain('?');
  });
});

describe('webhook tracks who is in the call (owner-only retrieval scope)', () => {
  const ownerConfig: Config = { ...BASE_CONFIG, ownerParticipantNames: ['david'] };
  const ownerApp = (): Hono => {
    const app = new Hono();
    app.route('/', createWebhookRoute(ownerConfig));
    return app;
  };
  const who = (name: string | undefined, is_host?: boolean, id?: number) => ({
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(is_host === undefined ? {} : { is_host }),
  });
  const presence = (event: string) => (name: string | undefined, is_host?: boolean, id?: number) => ({
    event,
    data: { bot: { id: 'bot-own' }, data: { participant: who(name, is_host, id) } },
  });
  const join = presence('participant_events.join');
  const leave = presence('participant_events.leave');
  const said = (name: string, is_host?: boolean, id?: number) => ({
    event: 'transcript.data',
    data: { bot: { id: 'bot-own' }, data: { participant: who(name, is_host, id), words: [{ text: 'hi' }] } },
  });

  beforeEach(() => {
    __clearRegistry();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerMeeting({ meetingId: 'm-own', botId: 'bot-own', teammate: 'a', persona: 'first_person', title: 't' });
  });

  it('the owner joining and speaking marks the owner seen and no outsider', async () => {
    const app = ownerApp();
    await postEvent(app, join('David', true, 7));
    await postEvent(app, said('David', undefined, 7));
    await postEvent(app, said('Jarvis'));
    const rec = getMeeting('m-own')!;
    expect(rec.ownerSeenAt).toBeTypeOf('number');
    expect(rec.outsiderSeenAt).toBeUndefined();
    expect(rec.participantCount).toBe(1);
  });

  it('a transcript line from anyone else marks an outsider, with no join event needed', async () => {
    const app = ownerApp();
    await postEvent(app, join('David', true, 7));
    await postEvent(app, said('Pat Lee'));
    expect(getMeeting('m-own')!.outsiderSeenAt).toBeTypeOf('number');
  });

  it('an owner name that is not the confirmed host marks an outsider', async () => {
    const app = ownerApp();
    await postEvent(app, join('David', true, 7));
    await postEvent(app, said('David', undefined, 9));
    expect(getMeeting('m-own')!.outsiderSeenAt).toBeTypeOf('number');
  });

  it('the owner leaving is recorded', async () => {
    const app = ownerApp();
    await postEvent(app, join('David', true, 7));
    expect(getMeeting('m-own')!.ownerSeenAt).toBeTypeOf('number');
    await postEvent(app, leave('David', undefined, 7));
    expect(getMeeting('m-own')!.ownerLeftAt).toBeTypeOf('number');
  });

  it('a join with no name marks an outsider', async () => {
    await postEvent(ownerApp(), join(undefined));
    expect(getMeeting('m-own')!.outsiderSeenAt).toBeTypeOf('number');
  });

  it('with no owner names configured everyone is an outsider', async () => {
    await postEvent(makeApp(), join('David', true));
    const rec = getMeeting('m-own')!;
    expect(rec.ownerSeenAt).toBeUndefined();
    expect(rec.outsiderSeenAt).toBeTypeOf('number');
  });
});
