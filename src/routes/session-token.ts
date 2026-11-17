import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';

export const MEETING_SESSION_TOKEN_TTL_MS = 30 * 60 * 1000;

interface MeetingSessionTokenPayload {
  v: 1;
  meetingId: string;
  teammate: string;
  exp: number;
  nonce: string;
}

const processLocalSigningKey = randomBytes(32).toString('base64url');

function signingSecret(config: Config): string {
  const entries = Array.from(config.tokenRegistry.entries()).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > 0) {
    return `jarvis-meeting-session:${JSON.stringify(entries)}`;
  }
  if (config.jarvisApiToken) {
    return `jarvis-meeting-session:legacy:${config.jarvisApiToken}`;
  }
  return `jarvis-meeting-session:dev:${processLocalSigningKey}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(data: string, config: Config): string {
  return createHmac('sha256', signingSecret(config)).update(data).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function isPayload(value: unknown): value is MeetingSessionTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return (
    payload['v'] === 1 &&
    typeof payload['meetingId'] === 'string' &&
    typeof payload['teammate'] === 'string' &&
    typeof payload['exp'] === 'number' &&
    typeof payload['nonce'] === 'string'
  );
}

export function extractBearerToken(header: string | undefined): string | undefined {
  const match = /^bearer\s+(.+)$/i.exec((header ?? '').trim());
  return match?.[1];
}

export function mintMeetingSessionToken(
  config: Config,
  params: { meetingId: string; teammate: string; nowMs?: number; ttlMs?: number },
): string {
  const nowMs = params.nowMs ?? Date.now();
  const payload: MeetingSessionTokenPayload = {
    v: 1,
    meetingId: params.meetingId,
    teammate: params.teammate,
    exp: nowMs + (params.ttlMs ?? MEETING_SESSION_TOKEN_TTL_MS),
    nonce: randomBytes(16).toString('base64url'),
  };
  const encoded = encodeJson(payload);
  return `${encoded}.${sign(encoded, config)}`;
}

export function verifyMeetingSessionToken(
  config: Config,
  token: string,
  params: { meetingId: string; teammate: string; nowMs?: number },
): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return false;
  if (!constantTimeEqual(signature, sign(encoded, config))) return false;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return false;
  }

  if (!isPayload(payload)) return false;
  if (payload.meetingId !== params.meetingId) return false;
  if (payload.teammate !== params.teammate) return false;
  return payload.exp > (params.nowMs ?? Date.now());
}
