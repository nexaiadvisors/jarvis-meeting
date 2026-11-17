// Four-Option Live Animated Portrait Avatar Provider Registry & Session Minter
//
// Supports all 4 avatar options requested by David for side-by-side evaluation:
//   1. 'google-live-avatar'  — Stock Google Gemini Live Avatar / Vertex AI persona
//   2. 'simli'               — Simli Trinity-1 WebRTC audio-to-video avatar (16kHz PCM16)
//   3. 'heygen-live-avatar'  — HeyGen LiveAvatar Lite Mode WebRTC stream (24kHz PCM16)
//   4. 'alibaba-live-avatar' — Alibaba Wan2.1 14B LiveAvatar streaming bridge + portrait fallback
//
// All 4 providers enforce Split-Clock Rendering in Recall Output Media:
// WebRTC <video autoPlay playsInline muted> renders visuals only, while audio
// plays exclusively through the page-clocked WavStreamPlayer AudioWorklet.

export const AVATAR_PROVIDER_IDS = [
  'google-live-avatar',
  'simli',
  'heygen-live-avatar',
  'alibaba-live-avatar',
  'anam',
] as const;

export type AvatarProviderId = (typeof AVATAR_PROVIDER_IDS)[number];

export interface AvatarProviderMetadata {
  id: AvatarProviderId;
  name: string;
  vendor: string;
  tagline: string;
  inputSampleRateHz: 16000 | 24000;
  audioSyncOffsetMs: number;
  cloudConfigured: boolean;
  requiresKeyEnv: string;
  visualPreset: {
    primaryColor: string;
    accentColor: string;
    backdropGradient: [string, string];
    skinTone: string;
    suitColor: string;
    badgeLabel: string;
  };
}

export interface AvatarSessionDescriptor {
  meetingId: string;
  provider: AvatarProviderId;
  metadata: AvatarProviderMetadata;
  transport: 'stock-canvas-live' | 'simli-webrtc' | 'heygen-webrtc' | 'alibaba-stream' | 'anam-webrtc';
  /** The provider closes the session after this many seconds (it bills while open). */
  maxSeconds?: number;
  /**
   * Where the voice is heard from while a video face is on. 'face' (default): the
   * provider's own stream, which is locked to the lips. 'page': the page's player,
   * started the moment the face's own audio starts.
   */
  audioFrom?: 'face' | 'page';
  audioSyncOffsetMs: number;
  inputSampleRateHz: 16000 | 24000;
  credentials?: {
    sessionToken?: string;
    sessionId?: string;
    webrtcUrl?: string;
    iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
    faceId?: string;
  };
  fallbackReason?: string;
}

let activeProviderOverride: AvatarProviderId | null = null;

export function isValidAvatarProviderId(value: unknown): value is AvatarProviderId {
  return typeof value === 'string' && (AVATAR_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getActiveAvatarProvider(): AvatarProviderId {
  if (activeProviderOverride) return activeProviderOverride;
  const fromEnv = (process.env['AVATAR_PROVIDER'] ?? '').trim().toLowerCase();
  if (isValidAvatarProviderId(fromEnv)) return fromEnv;
  return 'google-live-avatar';
}

export function setActiveAvatarProvider(provider: AvatarProviderId): AvatarProviderId {
  activeProviderOverride = provider;
  return activeProviderOverride;
}

export function __resetAvatarProviderForTests(): void {
  activeProviderOverride = null;
}

export function getAvatarProviderCatalog(): AvatarProviderMetadata[] {
  const googleConfigured = true; // Stock Google Avatar works out-of-the-box + optional GEMINI_API_KEY
  const simliConfigured = Boolean(
    process.env['SIMLI_API_KEY']?.trim() && process.env['SIMLI_FACE_ID']?.trim(),
  );
  const heygenConfigured = Boolean(process.env['HEYGEN_API_KEY']?.trim());
  const alibabaConfigured = Boolean(process.env['ALIBABA_LIVE_AVATAR_URL']?.trim());
  const anamConfigured = Boolean(process.env['ANAM_API_KEY']?.trim());

  return [
    {
      id: 'google-live-avatar',
      name: 'Google Live Avatar (Stock)',
      vendor: 'Google Gemini / Vertex AI',
      tagline: 'Stock Google Live Avatar portrait with 24 FPS viseme lip-sync & zero external keys required',
      inputSampleRateHz: 24000,
      audioSyncOffsetMs: 120,
      cloudConfigured: googleConfigured,
      requiresKeyEnv: 'GEMINI_API_KEY (optional for stock avatar)',
      visualPreset: {
        primaryColor: '#4285F4',
        accentColor: '#34A853',
        backdropGradient: ['#0f172a', '#1e293b'],
        skinTone: '#e8be9e',
        suitColor: '#1e3a8a',
        badgeLabel: 'Google Live Avatar',
      },
    },
    {
      id: 'simli',
      name: 'Simli Trinity-1',
      vendor: 'Simli AI',
      tagline: 'Sub-300ms WebRTC audio-to-video avatar driven by 16kHz PCM16 chunks',
      inputSampleRateHz: 16000,
      audioSyncOffsetMs: 160,
      cloudConfigured: simliConfigured,
      requiresKeyEnv: 'SIMLI_API_KEY + SIMLI_FACE_ID',
      visualPreset: {
        primaryColor: '#8b5cf6',
        accentColor: '#c084fc',
        backdropGradient: ['#13111c', '#251b37'],
        skinTone: '#dfad8c',
        suitColor: '#312e81',
        badgeLabel: 'Simli Trinity-1',
      },
    },
    {
      id: 'heygen-live-avatar',
      name: 'HeyGen LiveAvatar (Lite)',
      vendor: 'HeyGen',
      tagline: '1080p photorealistic upper-body studio avatar via BYO-audio Lite Mode WebRTC',
      inputSampleRateHz: 24000,
      audioSyncOffsetMs: 180,
      cloudConfigured: heygenConfigured,
      requiresKeyEnv: 'HEYGEN_API_KEY',
      visualPreset: {
        primaryColor: '#06b6d4',
        accentColor: '#22d3ee',
        backdropGradient: ['#081c24', '#0f293a'],
        skinTone: '#ecc2a3',
        suitColor: '#0f172a',
        badgeLabel: 'HeyGen LiveAvatar',
      },
    },
    {
      id: 'alibaba-live-avatar',
      name: 'Alibaba LiveAvatar 14B',
      vendor: 'Alibaba Wan2.1 S2V-14B',
      tagline: 'Open-weights 14B diffusion portrait bridge with high-detail local portrait fallback',
      inputSampleRateHz: 16000,
      audioSyncOffsetMs: 150,
      cloudConfigured: alibabaConfigured,
      requiresKeyEnv: 'ALIBABA_LIVE_AVATAR_URL',
      visualPreset: {
        primaryColor: '#f97316',
        accentColor: '#fb923c',
        backdropGradient: ['#1c140d', '#2e1f14'],
        skinTone: '#e5b895',
        suitColor: '#1f2937',
        badgeLabel: 'Alibaba Wan2.1 14B',
      },
    },
    {
      id: 'anam',
      name: 'Anam (audio passthrough)',
      vendor: 'Anam',
      tagline: 'Video face that lip-syncs the agent\'s own voice; the page plays the audio, delayed to match',
      inputSampleRateHz: 24000,
      // How far Anam's video runs behind the audio it is given (measured in Gatekeeper,
      // about 0.9 s). The page delays its own playout by this much. ANAM_SYNC_MS tunes it.
      audioSyncOffsetMs: anamSyncMs(),
      cloudConfigured: anamConfigured,
      requiresKeyEnv: 'ANAM_API_KEY',
      visualPreset: {
        primaryColor: '#10b981',
        accentColor: '#34d399',
        backdropGradient: ['#0b1220', '#111827'],
        skinTone: '#e8be9e',
        suitColor: '#111827',
        badgeLabel: 'Anam',
      },
    },
  ];
}

/** No single paid face session may be asked to stay open longer than this. */
export const AVATAR_MAX_SECONDS_CAP = 1800;

function anamSyncMs(): number {
  const n = Number.parseInt(process.env['ANAM_SYNC_MS'] ?? '', 10);
  return Number.isFinite(n) && n >= 0 && n <= 3000 ? n : 900;
}

function avatarMaxSeconds(): number {
  const n = Number.parseInt(process.env['AVATAR_MAX_SECONDS'] ?? '', 10);
  // Capped: a session bills for as long as it is open.
  return Number.isFinite(n) && n >= 30 ? Math.min(n, AVATAR_MAX_SECONDS_CAP) : 600;
}

export async function mintAvatarSession(
  meetingId: string,
  requestedProvider?: AvatarProviderId,
): Promise<AvatarSessionDescriptor> {
  const providerId = requestedProvider ?? getActiveAvatarProvider();
  const catalog = getAvatarProviderCatalog();
  const metadata = catalog.find((p) => p.id === providerId) ?? catalog[0]!;

  if (providerId === 'anam') {
    const apiKey = process.env['ANAM_API_KEY']?.trim();
    const maxSeconds = avatarMaxSeconds();
    let fallbackReason = 'anam_key_not_set_using_live_preview';
    if (apiKey) {
      fallbackReason = 'anam_api_unreachable';
      try {
        // anam.ai/docs/api-reference/sessions/create-session-token (audio passthrough persona).
        const res = await fetch('https://api.anam.ai/v1/auth/session-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            personaConfig: {
              // Richard (table): a male stock avatar, to match the male voice.
              avatarId: process.env['ANAM_AVATAR_ID']?.trim() || '19d18eb0-5346-4d50-a77f-26b3723ed79d',
              avatarModel: process.env['ANAM_AVATAR_MODEL']?.trim() || 'cara-4.1-express',
              enableAudioPassthrough: true,
              maxSessionLengthSeconds: maxSeconds,
            },
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const sessionToken = typeof data['sessionToken'] === 'string' ? data['sessionToken'] : undefined;
          if (sessionToken) {
            return {
              meetingId,
              provider: providerId,
              metadata,
              transport: 'anam-webrtc',
              audioSyncOffsetMs: metadata.audioSyncOffsetMs,
              inputSampleRateHz: metadata.inputSampleRateHz,
              credentials: { sessionToken },
              maxSeconds,
              // 'face' by default: David confirmed the lips and the voice match in a live
              // call (2026-11-14). ANAM_AUDIO=page plays the voice from the page instead.
              audioFrom: process.env['ANAM_AUDIO']?.trim().toLowerCase() === 'page' ? 'page' : 'face',
            };
          }
        } else {
          fallbackReason = `anam_http_${res.status}`;
        }
      } catch {
        // Fall through to the drawn avatar with fallbackReason.
      }
    }
    return {
      meetingId,
      provider: providerId,
      metadata,
      transport: 'stock-canvas-live',
      audioSyncOffsetMs: 0,
      inputSampleRateHz: metadata.inputSampleRateHz,
      fallbackReason,
    };
  }

  if (providerId === 'simli') {
    const apiKey = process.env['SIMLI_API_KEY']?.trim();
    const faceId = process.env['SIMLI_FACE_ID']?.trim();
    if (apiKey && faceId) {
      try {
        const res = await fetch('https://api.simli.ai/startAudioToVideoSession', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey,
            faceId,
            handleSilence: true,
            maxSessionLength: avatarMaxSeconds(),
            maxIdleTime: 600,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const sessionToken = typeof data['session_token'] === 'string' ? data['session_token'] : undefined;
          if (sessionToken) {
            return {
              meetingId,
              provider: providerId,
              metadata,
              transport: 'simli-webrtc',
              audioSyncOffsetMs: metadata.audioSyncOffsetMs,
              inputSampleRateHz: metadata.inputSampleRateHz,
              credentials: { sessionToken, faceId },
            };
          }
        }
      } catch {
        // Fall through to stock canvas live preview with fallbackReason
      }
    }
    return {
      meetingId,
      provider: providerId,
      metadata,
      transport: 'stock-canvas-live',
      audioSyncOffsetMs: metadata.audioSyncOffsetMs,
      inputSampleRateHz: metadata.inputSampleRateHz,
      fallbackReason: apiKey && faceId ? 'simli_api_unreachable' : 'simli_keys_not_set_using_live_preview',
    };
  }

  if (providerId === 'heygen-live-avatar') {
    const apiKey = process.env['HEYGEN_API_KEY']?.trim();
    const avatarId = process.env['HEYGEN_AVATAR_ID']?.trim() || 'default';
    if (apiKey) {
      try {
        const res = await fetch('https://api.heygen.com/v1/streaming.create_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': apiKey,
          },
        });
        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          const inner = (data['data'] as Record<string, unknown> | undefined) ?? data;
          const token = typeof inner['token'] === 'string' ? inner['token'] : undefined;
          if (token) {
            return {
              meetingId,
              provider: providerId,
              metadata,
              transport: 'heygen-webrtc',
              audioSyncOffsetMs: metadata.audioSyncOffsetMs,
              inputSampleRateHz: metadata.inputSampleRateHz,
              credentials: { sessionToken: token, faceId: avatarId },
            };
          }
        }
      } catch {
        // Fall through to stock canvas live preview
      }
    }
    return {
      meetingId,
      provider: providerId,
      metadata,
      transport: 'stock-canvas-live',
      audioSyncOffsetMs: metadata.audioSyncOffsetMs,
      inputSampleRateHz: metadata.inputSampleRateHz,
      fallbackReason: apiKey ? 'heygen_api_unreachable' : 'heygen_key_not_set_using_live_preview',
    };
  }

  if (providerId === 'alibaba-live-avatar') {
    const streamUrl = process.env['ALIBABA_LIVE_AVATAR_URL']?.trim();
    if (streamUrl) {
      return {
        meetingId,
        provider: providerId,
        metadata,
        transport: 'alibaba-stream',
        audioSyncOffsetMs: metadata.audioSyncOffsetMs,
        inputSampleRateHz: metadata.inputSampleRateHz,
        credentials: { webrtcUrl: streamUrl },
      };
    }
    return {
      meetingId,
      provider: providerId,
      metadata,
      transport: 'stock-canvas-live',
      audioSyncOffsetMs: metadata.audioSyncOffsetMs,
      inputSampleRateHz: metadata.inputSampleRateHz,
      fallbackReason: 'alibaba_gpu_url_not_set_using_live_preview',
    };
  }

  // Default: 'google-live-avatar' (Stock Google Live Avatar)
  const googleStreamUrl = process.env['GOOGLE_LIVE_AVATAR_URL']?.trim();
  return {
    meetingId,
    provider: 'google-live-avatar',
    metadata,
    transport: 'stock-canvas-live',
    audioSyncOffsetMs: metadata.audioSyncOffsetMs,
    inputSampleRateHz: metadata.inputSampleRateHz,
    ...(googleStreamUrl ? { credentials: { webrtcUrl: googleStreamUrl } } : {}),
  };
}
