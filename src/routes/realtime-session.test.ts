import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealtimeSessionRoute } from './realtime-session.js';
import { mintMeetingSessionToken } from './session-token.js';
import { registerMeeting, setStatus, __clearRegistry } from '../meeting/registry.js';
import type { Config } from '../config.js';

let dir: string;
const savedEnv = { ...process.env };
const savedFetch = global.fetch;

function makeConfig(soulDir: string): Config {
  return {
    port: 8787,
    recallApiKey: 'k',
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
    tokenRegistry: new Map<string, string>(),
    soulDir,
    teamKbEndpoint: undefined,
    defaultTeammate: 'example',
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
    slackBotToken: undefined,
    meetingSlackChannel: undefined,
  };
}

const JARVIS_SOUL = `---
owner: example
name: Jarvis
wake_word: Jarvis
persona_mode: ai
voice: marin
knowledge_backend:
  type: openbrain
  endpoint: http://localhost:3031
  route: jarvis
ai_disclosure: Jarvis - AI meeting assistant
---
You are Jarvis.`;

const DELEGATE_NO_OWNER = `---
owner: ""
name: Delegate
persona_mode: first_person
voice: cedar
knowledge_backend:
  type: openbrain
  endpoint: http://localhost:9000
  route: delegate
ai_disclosure: AI representative for David
---
You are the delegate.`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rt-soul-'));
  __clearRegistry();
  delete process.env['AZURE_OPENAI_ENDPOINT'];
  delete process.env['AZURE_OPENAI_API_KEY'];
  delete process.env['AZURE_OPENAI_REALTIME_DEPLOYMENT'];
  process.env['OPENAI_API_KEY'] = 'sk-test';
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ value: 'ek-test-client-secret', expires_at: 123 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
  global.fetch = savedFetch;
  vi.restoreAllMocks();
});

function mount(soulDir: string): Hono {
  const app = new Hono();
  app.route('/', createRealtimeSessionRoute(makeConfig(soulDir)));
  return app;
}

function authedRequest(meetingId: string, teammate = 'example'): Request {
  const token = mintMeetingSessionToken(makeConfig(dir), { meetingId, teammate });
  return new Request(`http://x/api/meetings/${meetingId}/realtime-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('POST /api/meetings/:id/realtime-session', () => {
  it('returns 200 with a valid SessionConfig for a jarvis SOUL', async () => {
    writeFileSync(join(dir, 'example.md'), JARVIS_SOUL, 'utf8');
    registerMeeting({ meetingId: 'm1', teammate: 'example', persona: 'ai', title: 'Standup' });

    const res = await mount(dir).fetch(authedRequest('m1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['transport']).toBe('websocket');
    expect(body['provider']).toBe('openai');
    expect(body['voice']).toBe('marin');
    expect(String(body['wsUrl'])).toContain('wss://api.openai.com/v1/realtime');
    expect(body['wsProtocols']).toContain('openai-insecure-api-key.ek-test-client-secret');
    expect(body['wsProtocols']).not.toContain('openai-beta.realtime-v1');
    expect(JSON.stringify(body)).not.toContain('sk-test');

    const session = body['sessionUpdate'] as Record<string, unknown>;
    const audio = session['audio'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(audio['input']!['turn_detection']!['create_response']).toBe(false);
    expect(audio['input']!['turn_detection']!['type']).toBe('semantic_vad');
    expect(audio['input']!['turn_detection']!['eagerness']).toBe('medium');
    expect(String(audio['input']!['transcription']!['prompt'])).toContain('OpenBrain');
    expect(Array.isArray(session['tools'])).toBe(true);
    expect((session['tools'] as unknown[]).length).toBeGreaterThan(0);

    const agent = body['agent'] as Record<string, unknown>;
    expect(agent['name']).toBe('Jarvis');
    expect(agent['subtitle']).toBe('Jarvis - AI meeting assistant');
    expect(body['meeting']).toEqual({ id: 'm1', title: 'Standup' });
  });

  it('speaks with the voice the SOUL names, not the service default', async () => {
    writeFileSync(join(dir, 'example.md'), JARVIS_SOUL.replace('voice: marin', 'voice: cedar'), 'utf8');
    registerMeeting({ meetingId: 'm1', teammate: 'example', persona: 'ai', title: 'Standup' });

    const res = await mount(dir).fetch(authedRequest('m1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['transport']).toBe('websocket');
    expect(body['provider']).toBe('openai');
    expect(body['voice']).toBe('cedar');
    expect(JSON.stringify(body['sessionUpdate'])).toContain('"voice":"cedar"');
    expect((body['agent'] as Record<string, unknown>)['avatarProvider']).toBe('google-live-avatar');
    expect(String(body['wsUrl'])).toContain('wss://api.openai.com/v1/realtime');
    expect(body['wsProtocols']).toContain('openai-insecure-api-key.ek-test-client-secret');
    expect(body['wsProtocols']).not.toContain('openai-beta.realtime-v1');
    expect(JSON.stringify(body)).not.toContain('sk-test');

    const session = body['sessionUpdate'] as Record<string, unknown>;
    const audio = session['audio'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(audio['input']!['turn_detection']!['create_response']).toBe(false);
    expect(audio['input']!['turn_detection']!['type']).toBe('semantic_vad');
    expect(audio['input']!['turn_detection']!['eagerness']).toBe('medium');
    expect(String(audio['input']!['transcription']!['prompt'])).toContain('OpenBrain');
    expect(Array.isArray(session['tools'])).toBe(true);
    expect((session['tools'] as unknown[]).length).toBeGreaterThan(0);

    const agent = body['agent'] as Record<string, unknown>;
    expect(agent['name']).toBe('Jarvis');
    expect(agent['subtitle']).toBe('Jarvis - AI meeting assistant');
    expect(body['meeting']).toEqual({ id: 'm1', title: 'Standup' });
  });

  it('returns 401 for an unauthenticated ai-persona POST', async () => {
    writeFileSync(join(dir, 'example.md'), JARVIS_SOUL, 'utf8');
    registerMeeting({ meetingId: 'm-ai', teammate: 'example', persona: 'ai', title: 'M' });

    const res = await mount(dir).fetch(
      new Request('http://x/api/meetings/m-ai/realtime-session', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('unauthorized');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('realtime-session response never contains "api-key="', async () => {
    // Azure fully configured next to a working OpenAI key. The Azure path is
    // gone, so the response must come from OpenAI and carry no long-lived key in
    // the WS URL (the old Azure branch appended `&api-key=<AZURE key>`).
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://myres.openai.azure.com';
    process.env['AZURE_OPENAI_API_KEY'] = 'az-long-lived-key';
    process.env['AZURE_OPENAI_REALTIME_DEPLOYMENT'] = 'gpt-realtime-mini';
    process.env['REALTIME_PROVIDER'] = 'azure';
    writeFileSync(join(dir, 'example.md'), JARVIS_SOUL, 'utf8');
    registerMeeting({ meetingId: 'm-az', teammate: 'example', persona: 'ai', title: 'M' });

    const res = await mount(dir).fetch(authedRequest('m-az'));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('api-key=');
    expect(raw).not.toContain('az-long-lived-key');
    expect(raw).not.toContain('sk-test');
    expect(raw).not.toContain('myres.openai.azure.com');

    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body['provider']).toBe('openai');
    expect(String(body['wsUrl'])).toMatch(/^wss:\/\/api\.openai\.com\/v1\/realtime\?model=[^&]+$/);
    // The only credential handed to the browser is the minted ephemeral secret.
    expect(body['wsProtocols']).toContain('openai-insecure-api-key.ek-test-client-secret');
    // The ephemeral secret was minted against OpenAI, never against the Azure resource.
    const mintUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(mintUrl).toBe('https://api.openai.com/v1/realtime/client_secrets');
  });

  it('returns 503 missing_api_key, with no key in the body, when only the Azure env is set', async () => {
    delete process.env['OPENAI_API_KEY'];
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://myres.openai.azure.com';
    process.env['AZURE_OPENAI_API_KEY'] = 'az-long-lived-key';
    process.env['AZURE_OPENAI_REALTIME_DEPLOYMENT'] = 'gpt-realtime-mini';
    writeFileSync(join(dir, 'example.md'), JARVIS_SOUL, 'utf8');
    registerMeeting({ meetingId: 'm-az-only', teammate: 'example', persona: 'ai', title: 'M' });

    const res = await mount(dir).fetch(authedRequest('m-az-only'));
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect((JSON.parse(raw) as Record<string, unknown>)['code']).toBe('missing_api_key');
    expect(raw).not.toContain('api-key=');
    expect(raw).not.toContain('az-long-lived-key');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns 403 DELEGATE_OWNER_REQUIRED for a first_person SOUL with empty owner', async () => {
    writeFileSync(join(dir, 'example.md'), DELEGATE_NO_OWNER, 'utf8');
    registerMeeting({ meetingId: 'm2', teammate: 'example', persona: 'first_person', title: 'M' });

    const res = await mount(dir).fetch(authedRequest('m2'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('DELEGATE_OWNER_REQUIRED');
  });

  it('returns 404 for an unknown meeting', async () => {
    writeFileSync(join(dir, 'example.md'), JARVIS_SOUL, 'utf8');
    const res = await mount(dir).fetch(authedRequest('nope'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('not_found');
  });

  it('refuses to mint a realtime session after the meeting is terminal', async () => {
    writeFileSync(join(dir, 'example.md'), JARVIS_SOUL, 'utf8');
    registerMeeting({ meetingId: 'm-terminal', teammate: 'example', persona: 'ai', title: 'M' });
    setStatus('m-terminal', 'completed');

    // Authenticated on purpose: the 409 lifecycle guard sits BEHIND the SUP-18
    // token gate, so an unauthenticated probe would see 401, not 409.
    const res = await mount(dir).fetch(authedRequest('m-terminal'));
    expect(res.status).toBe(409);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      error: 'Meeting is no longer live',
      code: 'meeting_not_live',
      status: 'completed',
    });
  });

  it('returns 503 missing_api_key when no provider env is set', async () => {
    delete process.env['OPENAI_API_KEY'];
    writeFileSync(join(dir, 'example.md'), JARVIS_SOUL, 'utf8');
    registerMeeting({ meetingId: 'm3', teammate: 'example', persona: 'ai', title: 'M' });

    const res = await mount(dir).fetch(authedRequest('m3'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('missing_api_key');
  });
});
