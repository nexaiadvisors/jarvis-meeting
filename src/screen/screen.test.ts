import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __clearRegistry, registerMeeting, setStatus } from '../meeting/registry.js';
import {
  __clearScreenFrames,
  latestScreenFrame,
  recordScreenFrame,
  SCREEN_FRAME_FRESH_MS,
  SCREEN_FRAME_MAX_CHARS,
} from './frames.js';
import { handleScreenMessage, mayOpenScreenSocket, screenSocketUrl, SCREEN_SOCKET_PATH } from './socket.js';
import { createVoiceRoutes, SCREEN_NOT_SHARED_REFUSAL, SCREEN_OFF_REFUSAL } from '../routes/voice.js';
import { joinNotice } from '../meeting/chat.js';
import { sessionHeader } from '../../tests/helpers/session.js';
import type { Config } from '../config.js';

function event(over: { type?: string; botId?: string; buffer?: unknown; event?: string } = {}): string {
  return JSON.stringify({
    event: over.event ?? 'video_separate_png.data',
    data: {
      data: {
        buffer: 'buffer' in over ? over.buffer : 'UE5H',
        type: over.type ?? 'screenshare',
        participant: { id: 3, name: 'Pat' },
        timestamp: { absolute: '2026-11-16T22:00:00Z', relative: 1 },
      },
      bot: { id: over.botId ?? 'bot-on' },
    },
  });
}

beforeEach(() => {
  __clearRegistry();
  __clearScreenFrames();
  registerMeeting({ meetingId: 'on', botId: 'bot-on', teammate: 'example', persona: 'ai', title: 'On', screenShare: true });
  registerMeeting({ meetingId: 'off', botId: 'bot-off', teammate: 'example', persona: 'ai', title: 'Off' });
});

describe('shared-screen frames', () => {
  it('keeps a shared-screen frame for a meeting with screen viewing on', () => {
    expect(handleScreenMessage(event(), 1_000)).toBe('stored');
    expect(latestScreenFrame('on', 2_000)).toEqual({ pngBase64: 'UE5H', sharedBy: 'Pat', atMs: 1_000 });
  });

  it('drops frames for a meeting that did not ask for screen viewing', () => {
    expect(handleScreenMessage(event({ botId: 'bot-off' }), 1_000)).toBe('ignored');
    expect(latestScreenFrame('off', 1_000)).toBeUndefined();
  });

  it('drops camera frames, other events, unknown bots, ended meetings and bad input', () => {
    expect(handleScreenMessage(event({ type: 'webcam' }), 1)).toBe('ignored');
    expect(handleScreenMessage(event({ event: 'transcript.data' }), 1)).toBe('ignored');
    expect(handleScreenMessage(event({ botId: 'nobody' }), 1)).toBe('ignored');
    expect(handleScreenMessage(event({ buffer: 42 }), 1)).toBe('ignored');
    expect(handleScreenMessage('not json', 1)).toBe('ignored');
    setStatus('on', 'completed');
    expect(handleScreenMessage(event(), 1)).toBe('ignored');
    expect(latestScreenFrame('on', 1)).toBeUndefined();
  });

  it('treats an old frame as nobody sharing, and refuses an oversized one', () => {
    recordScreenFrame('on', { pngBase64: 'UE5H', atMs: 1_000 });
    expect(latestScreenFrame('on', 1_000 + SCREEN_FRAME_FRESH_MS)).toBeDefined();
    expect(latestScreenFrame('on', 1_001 + SCREEN_FRAME_FRESH_MS)).toBeUndefined();
    expect(recordScreenFrame('on', { pngBase64: 'x'.repeat(SCREEN_FRAME_MAX_CHARS + 1), atMs: 5_000 })).toBe(false);
  });
});

describe('screen socket access', () => {
  it('builds a wss URL that carries the webhook secret', () => {
    expect(screenSocketUrl({ publicBaseUrl: 'https://x.example', webhookSecret: 'a b' })).toBe(`wss://x.example${SCREEN_SOCKET_PATH}?s=a%20b`);
    expect(screenSocketUrl({ publicBaseUrl: 'http://localhost:8790', webhookSecret: undefined })).toBe(`ws://localhost:8790${SCREEN_SOCKET_PATH}`);
  });

  it('opens only on the right path with the right secret', () => {
    const cfg = { webhookSecret: 'sekret' };
    expect(mayOpenScreenSocket(`${SCREEN_SOCKET_PATH}?s=sekret`, cfg)).toBe(true);
    expect(mayOpenScreenSocket(`${SCREEN_SOCKET_PATH}?s=wrong!`, cfg)).toBe(false);
    expect(mayOpenScreenSocket(SCREEN_SOCKET_PATH, cfg)).toBe(false);
    expect(mayOpenScreenSocket('/ws/other?s=sekret', cfg)).toBe(false);
    expect(mayOpenScreenSocket(undefined, cfg)).toBe(false);
  });
});

describe('look_at_screen route', () => {
  const soulDir = mkdtempSync(join(tmpdir(), 'screen-soul-'));
  writeFileSync(join(soulDir, 'example.md'), '---\nowner: example\nname: Jarvis\npersona_mode: ai\n---\nJarvis.');
  const config = {
    port: 8787,
    recallApiKey: 'k',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    maxConcurrentPerTeammate: 2,
    idleTimeoutMs: 600000,
    maxDurationMs: 7200000,
    sweepIntervalMs: 60000,
    publicBaseUrl: 'https://ngrok.example.com',
    soulDir,
    jarvisBotName: 'Jarvis',
    defaultTeammate: 'example',
    webhookSecret: 'whsec',
    ownerToken: 'owner-token',
    tokenRegistry: new Map<string, string>(),
    anthropicApiKey: undefined,
    anthropicModel: 'm',
    workScopeNamespaces: [],
    meetingEmailDefaultRecipients: [],
  } as unknown as Config;
  const seen: Array<{ png: string; question: string }> = [];
  const app = new Hono();
  app.route(
    '/',
    createVoiceRoutes(config, {
      screenDescriber: async (frame, question) => {
        seen.push({ png: frame.pngBase64, question });
        return 'A pricing slide with three plans.';
      },
    }),
  );
  const ask = async (meetingId: string, question?: string): Promise<Record<string, unknown>> => {
    const res = await app.fetch(
      new Request('http://x/api/voice/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sessionHeader(config, meetingId, 'example') },
        body: JSON.stringify({ meetingId, ...(question !== undefined ? { question } : {}) }),
      }),
    );
    return (await res.json()) as Record<string, unknown>;
  };

  it('refuses in a meeting without screen viewing and never calls the model', async () => {
    recordScreenFrame('off', { pngBase64: 'UE5H', atMs: Date.now() });
    seen.length = 0;
    expect(await ask('off', 'what is shown?')).toEqual({ available: false, instruction: SCREEN_OFF_REFUSAL });
    expect(seen).toEqual([]);
  });

  it('says nobody is sharing when there is no fresh frame', async () => {
    expect(await ask('on', 'what is shown?')).toEqual({ available: false, instruction: SCREEN_NOT_SHARED_REFUSAL });
  });

  it('describes the newest frame when screen viewing is on', async () => {
    handleScreenMessage(event());
    seen.length = 0;
    const out = await ask('on', 'What plans are on the slide?');
    expect(out).toMatchObject({ available: true, description: 'A pricing slide with three plans.', shared_by: 'Pat' });
    expect(seen).toEqual([{ png: 'UE5H', question: 'What plans are on the slide?' }]);
  });

  it('needs the meeting session: no header, no answer', async () => {
    handleScreenMessage(event());
    const res = await app.fetch(
      new Request('http://x/api/voice/screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId: 'on' }) }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('join notice', () => {
  it('mentions the screen only when screen viewing is on', () => {
    expect(joinNotice('Jarvis', undefined, true)).toContain('look at the shared screen');
    expect(joinNotice('Jarvis')).not.toContain('screen');
  });
});
