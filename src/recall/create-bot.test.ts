import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBot } from './create-bot.js';

// createBot calls loadConfig() internally, which requires RECALL_API_KEY and
// PUBLIC_BASE_URL. Set the minimal env so the config loads, then mock fetch and
// inspect the POST body we send to Recall.
beforeEach(() => {
  process.env['RECALL_API_KEY'] = 'rk-test';
  // Localhost: loadConfig only allows a missing WEBHOOK_SECRET/OWNER_TOKEN there.
  process.env['PUBLIC_BASE_URL'] = 'http://localhost:8790';
  // Keep the webhook URL deterministic (no ?s= suffix) for the events assertion.
  delete process.env['WEBHOOK_SECRET'];
  delete process.env['OWNER_TOKEN'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run createBot against a mocked fetch and return the parsed request body. */
async function captureBotBody(): Promise<Record<string, any>> {
  let capturedBody: string | undefined;
  global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ id: 'bot-123' }), { status: 201 });
  }) as typeof fetch;

  await createBot({ meetingUrl: 'https://meet.example/x', botName: 'Jarvis', meetingId: 'm1' });

  expect(capturedBody).toBeDefined();
  return JSON.parse(capturedBody as string) as Record<string, any>;
}

describe('createBot POST body', () => {
  it('carries the retuned everyone_left_timeout {timeout:120, activate_after:30}', async () => {
    const body = await captureBotBody();
    expect(body.automatic_leave.everyone_left_timeout).toEqual({
      timeout: 120,
      activate_after: 30,
    });
  });

  it('keeps waiting_room_timeout at 1800', async () => {
    const body = await captureBotBody();
    expect(body.automatic_leave.waiting_room_timeout).toBe(1800);
  });

  it('subscribes to the expanded realtime events (transcript + participant presence/speech + chat)', async () => {
    const body = await captureBotBody();
    const endpoints = body.recording_config.realtime_endpoints;
    expect(Array.isArray(endpoints)).toBe(true);
    expect(endpoints[0].events).toEqual([
      'transcript.data',
      'participant_events.join',
      'participant_events.leave',
      'participant_events.speech_on',
      'participant_events.speech_off',
      'participant_events.chat_message',
    ]);
  });

  it('returns the bot id from the Recall response', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: 'bot-xyz' }), { status: 201 }),
    ) as typeof fetch;
    const result = await createBot({
      meetingUrl: 'https://meet.example/x',
      botName: 'Jarvis',
      meetingId: 'm2',
    });
    expect(result).toEqual({ botId: 'bot-xyz' });
  });
});

describe('createBot screen viewing', () => {
  async function body(screenShare?: boolean): Promise<Record<string, any>> {
    let captured: string | undefined;
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.body as string;
      return new Response(JSON.stringify({ id: 'bot-123' }), { status: 201 });
    }) as typeof fetch;
    await createBot({ meetingUrl: 'https://meet.example/x', botName: 'Jarvis', meetingId: 'm1', ...(screenShare !== undefined ? { screenShare } : {}) });
    return JSON.parse(captured as string) as Record<string, any>;
  }

  it('asks for no video by default', async () => {
    const b = await body();
    expect(b.recording_config.video_separate_png).toBeUndefined();
    expect(b.recording_config.video_mixed_layout).toBeUndefined();
    expect(b.recording_config.realtime_endpoints.map((e: any) => e.type)).toEqual(['webhook']);
  });

  it('asks for shared-screen stills over a websocket when switched on', async () => {
    const b = await body(true);
    expect(b.recording_config.video_separate_png).toEqual({});
    expect(b.recording_config.video_mixed_layout).toBe('gallery_view_v2');
    expect(b.recording_config.realtime_endpoints[1]).toEqual({
      type: 'websocket',
      url: 'ws://localhost:8790/ws/recall/screen',
      events: ['video_separate_png.data'],
    });
  });
});
