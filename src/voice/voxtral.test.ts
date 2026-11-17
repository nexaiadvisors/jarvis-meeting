import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  VOXTRAL_REALTIME_ASR_MODEL,
  VOXTRAL_TTS_MODEL,
  buildVoxtralRealtimeSessionUpdate,
  formatVoxtralAudioAppendFrame,
  parseVoxtralRealtimeEvent,
  getActiveVoiceProvider,
  setActiveVoiceProvider,
  synthesizeVoxtralSpeech,
  __resetVoiceProviderForTests,
} from './voxtral.js';
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

describe('Phase 4 — Mistral Voxtral 3 Integration', () => {
  beforeEach(() => {
    __resetVoiceProviderForTests();
    __clearRegistry();
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    global.fetch = savedFetch;
    vi.restoreAllMocks();
  });

  it('builds a Voxtral 3 Realtime ASR session config with semantic_vad, context_bias, and diarize: false', () => {
    const update = buildVoxtralRealtimeSessionUpdate({
      agentName: 'Jarvis',
      wakeWord: 'Jarvis',
      extraBiasTerms: ['Voxtral'],
    });
    expect(update.type).toBe('transcription.session.update');
    expect(update.session.model).toBe(VOXTRAL_REALTIME_ASR_MODEL);
    expect(update.session.input_audio_format).toEqual({
      encoding: 'pcm_s16le',
      sample_rate: 16000,
    });
    expect(update.session.turn_detection.type).toBe('semantic_vad');
    // Enforce mutual exclusion: diarize is never true when turn_detection is set
    expect(update.session.diarize).toBe(false);
    expect(update.session.context_bias).toContain('OpenBrain');
    expect(update.session.context_bias).toContain('Voxtral');

    const append = formatVoxtralAudioAppendFrame('AAECAw==');
    expect(append).toEqual({ type: 'input_audio.append', audio: 'AAECAw==' });
  });

  it('parses Voxtral 3 Realtime delta, completed, and error frames', () => {
    expect(parseVoxtralRealtimeEvent({ type: 'transcription.text.delta', delta: 'Hey Jar' })).toEqual({
      kind: 'delta',
      text: 'Hey Jar',
    });
    expect(
      parseVoxtralRealtimeEvent({ type: 'transcription.done', text: 'Hey Jarvis, what is the status?' }),
    ).toEqual({
      kind: 'completed',
      text: 'Hey Jarvis, what is the status?',
    });
    expect(
      parseVoxtralRealtimeEvent({
        type: 'error',
        error: { message: 'Diarization is not compatible with turn detection' },
      }),
    ).toEqual({
      kind: 'error',
      message: 'Diarization is not compatible with turn detection',
    });
  });

  it('synthesizes PCM16 @ 24kHz audio via Voxtral Speech 3 (voxtral-mini-tts-3-0)', async () => {
    process.env['MISTRAL_API_KEY'] = 'mistral-test-key';
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ audio_data: 'UENNMTZBVURJTw==' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await synthesizeVoxtralSpeech({
      text: 'Here is the latest update from OpenBrain.',
      voiceId: 'marin',
    });
    expect(res.model).toBe(VOXTRAL_TTS_MODEL);
    expect(res.sampleRateHz).toBe(24000);
    expect(res.audioBase64).toBe('UENNMTZBVURJTw==');
  });

  it('switches voice provider via /api/owner/voice-provider and mints /api/meetings/:id/voxtral-session', async () => {
    const config = makeTestConfig();
    const app = createApp(config);
    registerMeeting({ meetingId: 'm-vx', teammate: 'david', persona: 'ai', title: 'Voxtral Demo' });

    const setRes = await app.request('/api/owner/voice-provider', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-secret-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ voiceProvider: 'voxtral' }),
    });
    expect(setRes.status).toBe(200);
    expect(getActiveVoiceProvider()).toBe('voxtral');

    const sessionToken = mintMeetingSessionToken(config, { meetingId: 'm-vx', teammate: 'david' });
    const vxSessionRes = await app.request('/api/meetings/m-vx/voxtral-session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(vxSessionRes.status).toBe(200);
    const vxBody = (await vxSessionRes.json()) as {
      voiceProvider: string;
      asrModel: string;
      ttsModel: string;
    };
    expect(vxBody.voiceProvider).toBe('voxtral');
    expect(vxBody.asrModel).toBe('voxtral-mini-transcribe-realtime-3-0');
    expect(vxBody.ttsModel).toBe('voxtral-mini-tts-3-0');
  });
});
