import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockConfigState = vi.hoisted(() => ({
  webhookSecret: undefined as string | undefined,
}));

// Stub config before importing createBot so it doesn't call loadConfig eagerly.
vi.mock('../src/config.js', () => ({
  loadConfig: () => ({
    port: 8787,
    recallApiKey: 'test-key',
    recallApiBase: 'https://us-east-1.recall.ai/api/v1',
    publicBaseUrl: 'https://ngrok.example.com',
    teamKbAnswerEndpoint: undefined,
    teamKbAnswerApiToken: undefined,
    teamKbFallbackUrl: 'http://localhost:3031',
    jarvisBotName: 'Jarvis',
    jarvisApiToken: 'tok',
    webhookSecret: mockConfigState.webhookSecret,
  }),
}));

const { createBot } = await import('../src/recall/create-bot.js');

describe('createBot body shape', () => {
  let capturedRequest: Request | undefined;

  beforeEach(() => {
    capturedRequest = undefined;
    mockConfigState.webhookSecret = undefined;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest = new Request(input as string, init);
      return new Response(JSON.stringify({ id: 'bot-abc-123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts to the regional recall base URL', async () => {
    await createBot({ meetingUrl: 'https://meet.google.com/abc', botName: 'Jarvis', meetingId: 'mtg-1' });
    expect(capturedRequest?.url).toBe('https://us-east-1.recall.ai/api/v1/bot/');
  });

  it('sets variant web_4_core for zoom, google_meet, and microsoft_teams', async () => {
    await createBot({ meetingUrl: 'https://meet.google.com/abc', botName: 'Jarvis', meetingId: 'mtg-1' });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const variant = body['variant'] as Record<string, string>;
    expect(variant['zoom']).toBe('web_4_core');
    expect(variant['google_meet']).toBe('web_4_core');
    expect(variant['microsoft_teams']).toBe('web_4_core');
  });

  it('builds the output_media camera URL from publicBaseUrl (self-hosted agent-frame)', async () => {
    await createBot({ meetingUrl: 'https://meet.google.com/abc', botName: 'Jarvis', meetingId: 'mtg-xyz' });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const outputMedia = body['output_media'] as Record<string, unknown>;
    const camera = outputMedia['camera'] as Record<string, unknown>;
    const cameraConfig = camera['config'] as Record<string, string>;
    expect(cameraConfig['url']).toBe('https://ngrok.example.com/meetings/agent-frame/mtg-xyz');
  });

  it('adds the short-lived session token to the agent-frame URL when provided', async () => {
    await createBot({
      meetingUrl: 'https://meet.google.com/abc',
      botName: 'Jarvis',
      meetingId: 'mtg-xyz',
      sessionToken: 'tok value/1',
    });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const outputMedia = body['output_media'] as Record<string, unknown>;
    const camera = outputMedia['camera'] as Record<string, unknown>;
    const cameraConfig = camera['config'] as Record<string, string>;
    expect(cameraConfig['url']).toBe(
      'https://ngrok.example.com/meetings/agent-frame/mtg-xyz?session_token=tok%20value%2F1',
    );
  });

  it('sets output_media camera kind to webpage', async () => {
    await createBot({ meetingUrl: 'https://meet.google.com/abc', botName: 'Jarvis', meetingId: 'mtg-1' });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const camera = (body['output_media'] as Record<string, unknown>)['camera'] as Record<string, unknown>;
    expect(camera['kind']).toBe('webpage');
  });

  it('uses transcript.data webhook event on the public base URL', async () => {
    await createBot({ meetingUrl: 'https://meet.google.com/abc', botName: 'Jarvis', meetingId: 'mtg-1' });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const rc = body['recording_config'] as Record<string, unknown>;
    const endpoints = rc['realtime_endpoints'] as Array<Record<string, unknown>>;
    expect(endpoints[0]?.['type']).toBe('webhook');
    expect(endpoints[0]?.['url']).toBe('https://ngrok.example.com/webhooks/recall');
    expect(endpoints[0]?.['events']).toContain('transcript.data');
    expect(endpoints[0]?.['events']).toContain('participant_events.chat_message');
  });

  it('adds the webhook secret to the Recall callback URL when configured', async () => {
    mockConfigState.webhookSecret = 'secret value/1';
    await createBot({
      meetingUrl: 'https://meet.google.com/abc',
      botName: 'Jarvis',
      meetingId: 'mtg-1',
    });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const rc = body['recording_config'] as Record<string, unknown>;
    const endpoints = rc['realtime_endpoints'] as Array<Record<string, unknown>>;
    expect(endpoints[0]?.['url']).toBe(
      'https://ngrok.example.com/webhooks/recall?s=secret%20value%2F1',
    );
  });

  it('sets top-level metadata { meeting_id } from the meetingId', async () => {
    await createBot({ meetingUrl: 'https://meet.google.com/abc', botName: 'Jarvis', meetingId: 'mtg-meta' });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const metadata = body['metadata'] as Record<string, unknown>;
    expect(metadata['meeting_id']).toBe('mtg-meta');
  });

  it('includes teammate, persona, and soul_slug in metadata when provided', async () => {
    await createBot({
      meetingUrl: 'https://meet.google.com/abc',
      botName: 'Jarvis',
      meetingId: 'mtg-meta2',
      teammate: 'david',
      persona: 'first_person',
      soulSlug: 'jarvis',
    });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const metadata = body['metadata'] as Record<string, unknown>;
    expect(metadata['meeting_id']).toBe('mtg-meta2');
    expect(metadata['teammate']).toBe('david');
    expect(metadata['persona']).toBe('first_person');
    expect(metadata['soul_slug']).toBe('jarvis');
  });

  it('omits optional metadata fields when not provided', async () => {
    await createBot({ meetingUrl: 'https://meet.google.com/abc', botName: 'Jarvis', meetingId: 'mtg-meta3' });
    const body = JSON.parse(await capturedRequest!.text()) as Record<string, unknown>;
    const metadata = body['metadata'] as Record<string, unknown>;
    expect('teammate' in metadata).toBe(false);
    expect('persona' in metadata).toBe(false);
    expect('soul_slug' in metadata).toBe(false);
  });

  it('returns the bot id from the Recall response', async () => {
    const result = await createBot({ meetingUrl: 'https://zoom.us/j/123', botName: 'Jarvis', meetingId: 'mtg-2' });
    expect(result.botId).toBe('bot-abc-123');
  });

  it('throws on non-2xx Recall response', async () => {
    global.fetch = vi.fn(async () => new Response('Bad Request', { status: 400 }));
    await expect(
      createBot({ meetingUrl: 'https://zoom.us/j/123', botName: 'Jarvis', meetingId: 'mtg-3' }),
    ).rejects.toThrow('400');
  });
});
