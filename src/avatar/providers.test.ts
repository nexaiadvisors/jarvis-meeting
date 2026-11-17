import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AVATAR_PROVIDER_IDS,
  getActiveAvatarProvider,
  setActiveAvatarProvider,
  getAvatarProviderCatalog,
  mintAvatarSession,
  isValidAvatarProviderId,
  __resetAvatarProviderForTests,
} from './providers.js';
import { computePcm16SpeechMetrics } from '../../web/agent-frame/avatar-stage.js';
import { createApp } from '../app.js';
import { registerMeeting, __clearRegistry } from '../meeting/registry.js';
import { mintMeetingSessionToken } from '../routes/session-token.js';
import type { Config } from '../config.js';

const savedEnv = { ...process.env };
const savedFetch = global.fetch;

function makeTestConfig(): Config {
  return {
    port: 8790,
    recallApiKey: 'test-recall',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    maxConcurrentPerTeammate: 2,
    idleTimeoutMs: 600_000,
    maxDurationMs: 7_200_000,
    sweepIntervalMs: 60_000,
    publicBaseUrl: 'https://jarvis.example.com',
    teamKbAnswerEndpoint: undefined,
    teamKbAnswerApiToken: undefined,
    teamKbFallbackUrl: 'http://localhost:7402',
    jarvisBotName: 'Jarvis',
    jarvisApiToken: undefined,
    webhookSecret: 'wh-secret',
    ownerToken: 'owner-secret-token',
    tokenRegistry: new Map<string, string>(),
    soulDir: '/tmp',
    teamKbEndpoint: undefined,
    defaultTeammate: 'david',
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

describe('Phase 3 — Four-Option Live Animated Portrait Avatar Switcher', () => {
  beforeEach(() => {
    __resetAvatarProviderForTests();
    __clearRegistry();
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    global.fetch = savedFetch;
    vi.restoreAllMocks();
  });

  it('exposes all 5 avatar providers (google-live-avatar, simli, heygen-live-avatar, alibaba-live-avatar, anam)', () => {
    const catalog = getAvatarProviderCatalog();
    expect(catalog.map((c) => c.id)).toEqual([
      'google-live-avatar',
      'simli',
      'heygen-live-avatar',
      'alibaba-live-avatar',
      'anam',
    ]);
    expect(AVATAR_PROVIDER_IDS).toHaveLength(5);
    expect(getActiveAvatarProvider()).toBe('google-live-avatar');
  });

  it('mints sessions for all 4 providers with Split-Clock audioSyncOffsetMs and graceful live preview fallbacks', async () => {
    const sGoogle = await mintAvatarSession('m1', 'google-live-avatar');
    expect(sGoogle.provider).toBe('google-live-avatar');
    expect(sGoogle.transport).toBe('stock-canvas-live');
    expect(sGoogle.audioSyncOffsetMs).toBe(120);

    // Simli with mocked API key + face ID
    process.env['SIMLI_API_KEY'] = 'simli-key';
    process.env['SIMLI_FACE_ID'] = 'face-123';
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ session_token: 'simli-tok-abc' }), { status: 200 }),
    );
    const sSimli = await mintAvatarSession('m1', 'simli');
    expect(sSimli.provider).toBe('simli');
    expect(sSimli.transport).toBe('simli-webrtc');
    expect(sSimli.credentials?.sessionToken).toBe('simli-tok-abc');
    expect(sSimli.inputSampleRateHz).toBe(16000);

    // HeyGen LiveAvatar Lite Mode with mocked API key
    process.env['HEYGEN_API_KEY'] = 'heygen-key';
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: { token: 'heygen-tok-xyz' } }), { status: 200 }),
    );
    const sHeygen = await mintAvatarSession('m1', 'heygen-live-avatar');
    expect(sHeygen.provider).toBe('heygen-live-avatar');
    expect(sHeygen.transport).toBe('heygen-webrtc');
    expect(sHeygen.credentials?.sessionToken).toBe('heygen-tok-xyz');

    // Alibaba 14B LiveAvatar with stream URL configured
    process.env['ALIBABA_LIVE_AVATAR_URL'] = 'wss://gpu.example.com/wan21-live';
    const sAlibaba = await mintAvatarSession('m1', 'alibaba-live-avatar');
    expect(sAlibaba.provider).toBe('alibaba-live-avatar');
    expect(sAlibaba.transport).toBe('alibaba-stream');
    expect(sAlibaba.credentials?.webrtcUrl).toBe('wss://gpu.example.com/wan21-live');
  });

  it('switches the active avatar provider live via /api/owner/avatar-provider and propagates to /commands?include_state=1', async () => {
    const config = makeTestConfig();
    const app = createApp(config);
    registerMeeting({ meetingId: 'm-av', teammate: 'david', persona: 'ai', title: 'Avatar Demo' });

    const setRes = await app.request('/api/owner/avatar-provider', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'heygen-live-avatar' }),
    });
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as { activeProvider: string };
    expect(setBody.activeProvider).toBe('heygen-live-avatar');
    expect(getActiveAvatarProvider()).toBe('heygen-live-avatar');

    // Verify the live meeting tile receives the updated avatarProvider on its next command poll
    const sessionToken = mintMeetingSessionToken(config, { meetingId: 'm-av', teammate: 'david' });
    const pollRes = await app.request('/api/meetings/m-av/commands?after=0&include_state=1', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(pollRes.status).toBe(200);
    const pollBody = (await pollRes.json()) as { avatarProvider?: string };
    expect(pollBody.avatarProvider).toBe('heygen-live-avatar');

    // Switch to alibaba-live-avatar
    setActiveAvatarProvider('alibaba-live-avatar');
    const pollRes2 = await app.request('/api/meetings/m-av/commands?after=0&include_state=1', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const pollBody2 = (await pollRes2.json()) as { avatarProvider?: string };
    expect(pollBody2.avatarProvider).toBe('alibaba-live-avatar');
  });

  it('computes real-time RMS and zero-crossing speech metrics from PCM16 audio chunks', () => {
    const silence = new Int16Array(480);
    const m0 = computePcm16SpeechMetrics(silence, 1000);
    expect(m0.rms).toBe(0);

    const tone = new Int16Array(480);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 12000);
    }
    const mTone = computePcm16SpeechMetrics(tone, 2000);
    expect(mTone.rms).toBeGreaterThan(0.5);
    expect(mTone.zcr).toBeGreaterThan(0.05);
  });
});

describe('anam provider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env['ANAM_API_KEY'];
    delete process.env['ANAM_SYNC_MS'];
    delete process.env['AVATAR_MAX_SECONDS'];
  });

  it('is a valid provider and is listed as not configured without a key', () => {
    expect(isValidAvatarProviderId('anam')).toBe(true);
    expect(getAvatarProviderCatalog().find((p) => p.id === 'anam')?.cloudConfigured).toBe(false);
  });

  it('falls back to the drawn avatar, with no voice delay, when the key is not set', async () => {
    const session = await mintAvatarSession('m1', 'anam');
    expect(session.transport).toBe('stock-canvas-live');
    expect(session.audioSyncOffsetMs).toBe(0);
    expect(session.fallbackReason).toBe('anam_key_not_set_using_live_preview');
  });

  it('mints an audio-passthrough session and never returns the API key', async () => {
    process.env['ANAM_API_KEY'] = 'anam-key-for-tests';
    process.env['AVATAR_MAX_SECONDS'] = '300';
    const seen: Array<{ url: string; auth: string | null; body: Record<string, any> }> = [];
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ sessionToken: 'short-lived-token' }), { status: 200 });
    }) as typeof fetch;

    const session = await mintAvatarSession('m1', 'anam');

    expect(seen[0]!.url).toBe('https://api.anam.ai/v1/auth/session-token');
    expect(seen[0]!.auth).toBe('Bearer anam-key-for-tests');
    expect(seen[0]!.body.personaConfig).toMatchObject({ enableAudioPassthrough: true, maxSessionLengthSeconds: 300 });
    expect(session.transport).toBe('anam-webrtc');
    expect(session.credentials).toEqual({ sessionToken: 'short-lived-token' });
    expect(session.maxSeconds).toBe(300);
    expect(session.audioSyncOffsetMs).toBe(900);
    // The voice comes from the face's own stream unless ANAM_AUDIO=page.
    expect(session.audioFrom).toBe('face');
    process.env['ANAM_AUDIO'] = 'page';
    expect((await mintAvatarSession('m1', 'anam')).audioFrom).toBe('page');
    delete process.env['ANAM_AUDIO'];
    expect(JSON.stringify(session)).not.toContain('anam-key-for-tests');
  });

  it('reports the HTTP status and falls back when Anam refuses', async () => {
    process.env['ANAM_API_KEY'] = 'anam-key-for-tests';
    global.fetch = (async () => new Response('{}', { status: 402 })) as typeof fetch;
    const session = await mintAvatarSession('m1', 'anam');
    expect(session.transport).toBe('stock-canvas-live');
    expect(session.fallbackReason).toBe('anam_http_402');
  });

  it('reads the sync delay from ANAM_SYNC_MS', () => {
    process.env['ANAM_SYNC_MS'] = '700';
    expect(getAvatarProviderCatalog().find((p) => p.id === 'anam')?.audioSyncOffsetMs).toBe(700);
  });
});

describe('POST /api/meetings/:id/avatar-session — paid sessions are limited', () => {
  const realFetch = global.fetch;
  let minted = 0;
  beforeEach(() => {
    __clearRegistry();
    __resetAvatarProviderForTests();
    minted = 0;
    process.env['ANAM_API_KEY'] = 'anam-key-for-tests';
    global.fetch = (async () => {
      minted += 1;
      return new Response(JSON.stringify({ sessionToken: `token-${minted}` }), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env['ANAM_API_KEY'];
    __resetAvatarProviderForTests();
    vi.useRealTimers();
  });

  const setup = () => {
    const config = makeTestConfig();
    const app = createApp(config);
    registerMeeting({ meetingId: 'm-face', teammate: 'david', persona: 'first_person', title: 'Face' });
    const token = mintMeetingSessionToken(config, { meetingId: 'm-face', teammate: 'david', ttlMs: 3_600_000 });
    const ask = () =>
      app.fetch(new Request('http://localhost/api/meetings/m-face/avatar-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider: 'anam' }),
      }));
    return { ask };
  };

  it('refuses a paid provider that the owner has not switched on, without calling it', async () => {
    const { ask } = setup();
    const res = await ask();
    expect(res.status).toBe(403);
    expect(minted).toBe(0);
  });

  it('treats every outside provider as paid, not only Anam', async () => {
    process.env['SIMLI_API_KEY'] = 'simli-key';
    process.env['SIMLI_FACE_ID'] = 'face';
    const config = makeTestConfig();
    const app = createApp(config);
    registerMeeting({ meetingId: 'm-simli', teammate: 'david', persona: 'first_person', title: 'Face' });
    const token = mintMeetingSessionToken(config, { meetingId: 'm-simli', teammate: 'david', ttlMs: 60_000 });
    const res = await app.fetch(new Request('http://localhost/api/meetings/m-simli/avatar-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: 'simli' }),
    }));
    expect(res.status).toBe(403);
    expect(minted).toBe(0);
    delete process.env['SIMLI_API_KEY'];
    delete process.env['SIMLI_FACE_ID'];
  });

  it('opens one session, then refuses another inside the minimum interval', async () => {
    setActiveAvatarProvider('anam');
    const { ask } = setup();
    const first = await ask();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { transport: string }).transport).toBe('anam-webrtc');
    const second = await ask();
    expect(second.status).toBe(429);
    expect(minted).toBe(1);
  });

  it('stops opening sessions for a meeting after the per-meeting maximum', async () => {
    vi.useFakeTimers();
    setActiveAvatarProvider('anam');
    const { ask } = setup();
    for (let i = 0; i < 20; i += 1) {
      expect((await ask()).status).toBe(200);
      vi.advanceTimersByTime(31_000);
    }
    expect((await ask()).status).toBe(429);
    expect(minted).toBe(20);
  });

  it('caps the session length that can be asked of the provider', async () => {
    process.env['AVATAR_MAX_SECONDS'] = '999999';
    const session = await mintAvatarSession('m1', 'anam');
    expect(session.maxSeconds).toBe(1800);
    delete process.env['AVATAR_MAX_SECONDS'];
  });
});
