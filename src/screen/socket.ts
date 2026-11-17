// WebSocket endpoint that receives shared-screen frames from Recall.
//
// Recall delivers real-time video only over a websocket (never a webhook). A bot created
// with screen viewing on (recall/create-bot.ts) connects to SCREEN_SOCKET_PATH and sends
// `video_separate_png.data` events: one base64 PNG per frame, for every camera and every
// shared screen. Only shared-screen frames of a live meeting that has screen viewing on
// are kept (screen/frames.ts); camera frames are dropped unread.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { Config } from '../config.js';
import { getMeetingByBotId } from '../meeting/registry.js';
import { recordScreenFrame } from './frames.js';

export const SCREEN_SOCKET_PATH = '/ws/recall/screen';

/** The wss:// URL a Recall bot is told to send frames to. */
export function screenSocketUrl(config: Pick<Config, 'publicBaseUrl' | 'webhookSecret'>): string {
  const base = config.publicBaseUrl.replace(/^http/i, 'ws');
  return `${base}${SCREEN_SOCKET_PATH}${config.webhookSecret ? `?s=${encodeURIComponent(config.webhookSecret)}` : ''}`;
}

function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the upgrade request may open the frame socket: the right path and the webhook secret. */
export function mayOpenScreenSocket(url: string | undefined, config: Pick<Config, 'webhookSecret'>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '', 'http://localhost');
  } catch {
    return false;
  }
  if (parsed.pathname !== SCREEN_SOCKET_PATH) return false;
  // No secret configured is only possible on a localhost install (config.ts enforces it).
  if (!config.webhookSecret) return true;
  return secretMatches(parsed.searchParams.get('s') ?? '', config.webhookSecret);
}

export type ScreenMessageResult = 'stored' | 'ignored';

/**
 * Handle one message from Recall. Keeps the frame only when all of these hold: the event
 * is video_separate_png.data, the stream is a shared screen, the bot belongs to a live
 * meeting, and that meeting has screen viewing on. Anything else is ignored.
 */
export function handleScreenMessage(raw: string, nowMs: number = Date.now()): ScreenMessageResult {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return 'ignored';
  }
  const top = msg as { event?: unknown; data?: { data?: Record<string, unknown>; bot?: { id?: unknown } } };
  if (top.event !== 'video_separate_png.data') return 'ignored';
  const inner = top.data?.data;
  const botId = top.data?.bot?.id;
  if (inner === undefined || typeof botId !== 'string') return 'ignored';
  if (inner['type'] !== 'screenshare') return 'ignored';
  const buffer = inner['buffer'];
  if (typeof buffer !== 'string') return 'ignored';
  const meeting = getMeetingByBotId(botId);
  if (!meeting || meeting.status !== 'live' || meeting.screenShare !== true) return 'ignored';
  const participant = inner['participant'] as { name?: unknown } | undefined;
  const stored = recordScreenFrame(meeting.meetingId, {
    pngBase64: buffer,
    ...(typeof participant?.name === 'string' && participant.name !== '' ? { sharedBy: participant.name } : {}),
    atMs: nowMs,
  });
  return stored ? 'stored' : 'ignored';
}

/**
 * Accept Recall's frame socket on the service's HTTP server. Other upgrade requests are
 * refused. Returns a function that closes the socket server.
 */
export function attachScreenSocket(server: Server, config: Config): () => void {
  // 16 MB: one base64 PNG frame plus its JSON envelope, with room to spare.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  wss.on('connection', (socket) => {
    console.log(JSON.stringify({ level: 'info', msg: 'screen socket: connected' }));
    let stored = 0;
    socket.on('message', (data) => {
      if (handleScreenMessage(data.toString()) === 'stored') {
        stored += 1;
        // Log the first frame only: proof that frames arrive, without a line per frame.
        if (stored === 1) console.log(JSON.stringify({ level: 'info', msg: 'screen socket: first shared-screen frame stored' }));
      }
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => console.log(JSON.stringify({ level: 'info', msg: 'screen socket: closed', framesStored: stored })));
  });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!mayOpenScreenSocket(req.url, config)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);
  return () => {
    server.off('upgrade', onUpgrade);
    wss.close();
  };
}
