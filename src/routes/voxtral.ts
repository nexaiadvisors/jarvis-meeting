// Routes for Phase 4 — Mistral Voxtral 3 Integration:
//   GET  /api/owner/voice-provider            -> active voice provider + Voxtral 3 readiness
//   POST /api/owner/voice-provider            -> switch between 'openai', 'voxtral', 'hybrid-voxtral-asr'
//   POST /api/meetings/:id/voxtral-session    -> mint Voxtral 3 Realtime ASR session config
//   POST /api/meetings/:id/voxtral-tts        -> synthesize PCM16 @ 24kHz audio via Voxtral Speech 3

import { Hono } from 'hono';
import type { Config } from '../config.js';
import { requireOwner } from '../auth/owner.js';
import { requireMeetingAccess } from '../auth/meeting-session.js';
import { getMeeting } from '../meeting/registry.js';
import {
  VOICE_PROVIDER_IDS,
  VOXTRAL_REALTIME_ASR_MODEL,
  VOXTRAL_REALTIME_WS_URL,
  VOXTRAL_TTS_MODEL,
  buildVoxtralRealtimeSessionUpdate,
  getActiveVoiceProvider,
  isValidVoiceProviderId,
  setActiveVoiceProvider,
  synthesizeVoxtralSpeech,
} from '../voice/voxtral.js';

export function createVoxtralRoutes(config: Config): Hono {
  const app = new Hono();

  app.get('/api/owner/voice-provider', requireOwner(config), (c) => {
    const mistralConfigured = Boolean(process.env['MISTRAL_API_KEY']?.trim());
    return c.json({
      activeVoiceProvider: getActiveVoiceProvider(),
      availableProviders: VOICE_PROVIDER_IDS,
      mistralConfigured,
      models: {
        asr: VOXTRAL_REALTIME_ASR_MODEL,
        tts: VOXTRAL_TTS_MODEL,
      },
    });
  });

  app.post('/api/owner/voice-provider', requireOwner(config), async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const requested = body?.['voiceProvider'] ?? body?.['provider'];
    if (!isValidVoiceProviderId(requested)) {
      return c.json(
        {
          error: 'Invalid voice provider. Expected one of: openai, voxtral, hybrid-voxtral-asr',
          code: 'BAD_REQUEST',
        },
        400,
      );
    }
    const activeVoiceProvider = setActiveVoiceProvider(requested);
    return c.json({
      activeVoiceProvider,
      availableProviders: VOICE_PROVIDER_IDS,
      mistralConfigured: Boolean(process.env['MISTRAL_API_KEY']?.trim()),
    });
  });

  app.post('/api/meetings/:id/voxtral-session', (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id, { allowOwner: true });
    if (denied) return denied;

    const meeting = getMeeting(id);
    if (!meeting) {
      return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
    }

    const mistralConfigured = Boolean(process.env['MISTRAL_API_KEY']?.trim());
    const sessionUpdate = buildVoxtralRealtimeSessionUpdate({
      agentName: config.jarvisBotName,
      wakeWord: config.jarvisBotName,
    });

    return c.json({
      meetingId: id,
      voiceProvider: getActiveVoiceProvider(),
      mistralConfigured,
      wsUrl: VOXTRAL_REALTIME_WS_URL,
      asrModel: VOXTRAL_REALTIME_ASR_MODEL,
      ttsModel: VOXTRAL_TTS_MODEL,
      sessionUpdate,
    });
  });

  app.post('/api/meetings/:id/voxtral-tts', async (c) => {
    const id = c.req.param('id');
    const denied = requireMeetingAccess(c, config, id, { allowOwner: true });
    if (denied) return denied;

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (!text) {
      return c.json({ error: 'text is required', code: 'BAD_REQUEST' }, 400);
    }
    if (!process.env['MISTRAL_API_KEY']?.trim()) {
      return c.json({ error: 'MISTRAL_API_KEY is not configured', code: 'missing_api_key' }, 503);
    }

    try {
      const result = await synthesizeVoxtralSpeech({
        text,
        ...(typeof body['voiceId'] === 'string' ? { voiceId: body['voiceId'] } : {}),
      });
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : 'Voxtral TTS failed',
          code: 'voxtral_tts_failed',
        },
        502,
      );
    }
  });

  return app;
}
