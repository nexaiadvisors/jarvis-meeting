// Mistral Voxtral 3 Integration:
//   - Voxtral Mini Transcribe Realtime 3.0 (`voxtral-mini-transcribe-realtime-3-0`)
//     WebSocket streaming ASR with semantic end-of-turn detection and context_bias.
//     CRITICAL CONSTRAINT: Mistral's Realtime API forbids combining `diarize: true`
//     with `turn_detection` ("Diarization is not compatible with turn detection").
//     Speaker attribution comes from Recall's `use_separate_streams_when_available`
//     + `participant_events.speech_on/off` + `transcript.data`.
//   - Voxtral Speech 3 (`voxtral-mini-tts-3-0`)
//     Expressive streaming PCM16 TTS with optional zero-shot voice cloning (`ref_audio`).

export const VOICE_PROVIDER_IDS = ['openai', 'voxtral', 'hybrid-voxtral-asr'] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

export const VOXTRAL_REALTIME_ASR_MODEL = 'voxtral-mini-transcribe-realtime-3-0';
export const VOXTRAL_TTS_MODEL = 'voxtral-mini-tts-3-0';
export const VOXTRAL_REALTIME_WS_URL = `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=${VOXTRAL_REALTIME_ASR_MODEL}`;
export const VOXTRAL_TTS_HTTP_URL = 'https://api.mistral.ai/v1/audio/speech';

let activeVoiceProviderOverride: VoiceProviderId | null = null;

export function isValidVoiceProviderId(value: unknown): value is VoiceProviderId {
  return typeof value === 'string' && (VOICE_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getActiveVoiceProvider(): VoiceProviderId {
  if (activeVoiceProviderOverride) return activeVoiceProviderOverride;
  const fromEnv = (process.env['VOICE_PROVIDER'] ?? '').trim().toLowerCase();
  if (isValidVoiceProviderId(fromEnv)) return fromEnv;
  return 'openai';
}

export function setActiveVoiceProvider(provider: VoiceProviderId): VoiceProviderId {
  activeVoiceProviderOverride = provider;
  return activeVoiceProviderOverride;
}

export function __resetVoiceProviderForTests(): void {
  activeVoiceProviderOverride = null;
}

export interface VoxtralAsrSessionConfig {
  type: 'transcription.session.update';
  session: {
    model: string;
    input_audio_format: {
      encoding: 'pcm_s16le';
      sample_rate: 16000;
    };
    language: string;
    context_bias: string[];
    turn_detection: {
      type: 'semantic_vad';
      silence_duration_ms: number;
    };
    // Explicitly never set diarize: true when turn_detection is present
    diarize?: false;
  };
}

/**
 * Builds the initial `transcription.session.update` frame for Mistral's
 * `voxtral-mini-transcribe-realtime-3-0` WebSocket. Enforces the mutual
 * exclusion between `turn_detection` and `diarize: true`.
 */
export function buildVoxtralRealtimeSessionUpdate(opts?: {
  wakeWord?: string;
  agentName?: string;
  extraBiasTerms?: string[];
  silenceDurationMs?: number;
}): VoxtralAsrSessionConfig {
  const biasTerms = Array.from(
    new Set(
      [
        opts?.agentName,
        opts?.wakeWord,
        'Jarvis',
        'OpenBrain',
        ...(process.env['MEETING_VOCAB_TERMS'] ?? '').split(','),
        ...(opts?.extraBiasTerms ?? []),
      ]
        .map((t) => t?.trim())
        .filter((t): t is string => Boolean(t)),
    ),
  );

  return {
    type: 'transcription.session.update',
    session: {
      model: VOXTRAL_REALTIME_ASR_MODEL,
      input_audio_format: {
        encoding: 'pcm_s16le',
        sample_rate: 16000,
      },
      language: 'en',
      context_bias: biasTerms,
      turn_detection: {
        type: 'semantic_vad',
        silence_duration_ms: opts?.silenceDurationMs ?? 850,
      },
      diarize: false,
    },
  };
}

export function formatVoxtralAudioAppendFrame(pcm16Base64: string): {
  type: 'input_audio.append';
  audio: string;
} {
  return {
    type: 'input_audio.append',
    audio: pcm16Base64,
  };
}

export type ParsedVoxtralEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'completed'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'ignore'; rawType: string };

/**
 * Normalizes incoming Mistral Voxtral 3 Realtime WebSocket frames into the same
 * delta / completed lifecycle used by the Jarvis wake gate.
 */
export function parseVoxtralRealtimeEvent(raw: Record<string, unknown>): ParsedVoxtralEvent {
  const type = String(raw['type'] ?? '');
  if (type === 'transcription.text.delta') {
    return { kind: 'delta', text: String(raw['delta'] ?? raw['text'] ?? '') };
  }
  if (type === 'transcription.done' || type === 'transcription.segment') {
    const text = String(raw['text'] ?? raw['transcript'] ?? '').trim();
    if (text) return { kind: 'completed', text };
    return { kind: 'ignore', rawType: type };
  }
  if (type === 'error') {
    const errObj = raw['error'] as Record<string, unknown> | undefined;
    return {
      kind: 'error',
      message: String(errObj?.['message'] ?? raw['message'] ?? 'voxtral realtime error'),
    };
  }
  return { kind: 'ignore', rawType: type };
}

export interface VoxtralTtsOptions {
  text: string;
  voiceId?: string;
  refAudioBase64?: string;
  apiKey?: string;
}

export interface VoxtralTtsResult {
  model: string;
  sampleRateHz: 24000;
  audioBase64: string;
}

/**
 * Synthesizes expressive PCM16 @ 24kHz speech using Mistral's Voxtral Speech 3
 * (`voxtral-mini-tts-3-0`), supporting preset voice IDs or zero-shot voice cloning.
 */
export async function synthesizeVoxtralSpeech(opts: VoxtralTtsOptions): Promise<VoxtralTtsResult> {
  const apiKey = (opts.apiKey ?? process.env['MISTRAL_API_KEY'] ?? '').trim();
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY is not configured');
  }
  const voiceId = (opts.voiceId ?? process.env['VOXTRAL_VOICE_ID'] ?? 'marin').trim();
  const refAudio = opts.refAudioBase64 ?? process.env['VOXTRAL_REF_AUDIO_BASE64']?.trim();

  const response = await fetch(VOXTRAL_TTS_HTTP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VOXTRAL_TTS_MODEL,
      input: opts.text,
      voice_id: voiceId,
      response_format: 'pcm_24000',
      ...(refAudio ? { ref_audio: refAudio } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Voxtral TTS failed (${response.status})`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await response.json()) as Record<string, unknown>;
    const b64 = String(body['audio_data'] ?? body['audio'] ?? '');
    if (!b64) throw new Error('Voxtral TTS response missing audio_data');
    return {
      model: VOXTRAL_TTS_MODEL,
      sampleRateHz: 24000,
      audioBase64: b64,
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
  return {
    model: VOXTRAL_TTS_MODEL,
    sampleRateHz: 24000,
    audioBase64,
  };
}
