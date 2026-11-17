// Shared-screen frames, kept in memory only.
//
// When screen viewing is on for a meeting, Recall sends still frames of the shared screen
// (src/screen/socket.ts). Only the newest frame per meeting is kept, and only for a short
// time. Nothing here is written to disk, the transcript, OpenBrain or a log.

export interface ScreenFrame {
  /** The frame as base64 PNG, as Recall sent it. */
  pngBase64: string;
  /** Display name of the participant who is sharing, when Recall sent one. */
  sharedBy?: string;
  /** Epoch ms the frame arrived. */
  atMs: number;
}

/** A frame older than this is treated as "nobody is sharing now". Recall sends about 2 frames a second while a screen is shared. */
export const SCREEN_FRAME_FRESH_MS = 15_000;
/** Frames are dropped from memory this long after they arrived. */
export const SCREEN_FRAME_KEEP_MS = 60_000;
/** A base64 frame larger than this is ignored (about 6 MB of image). */
export const SCREEN_FRAME_MAX_CHARS = 8_000_000;

const frames = new Map<string, ScreenFrame>();

function prune(nowMs: number): void {
  for (const [id, frame] of frames) {
    if (nowMs - frame.atMs > SCREEN_FRAME_KEEP_MS) frames.delete(id);
  }
}

/** Keep `frame` as the meeting's newest shared-screen frame. Returns false when it was ignored. */
export function recordScreenFrame(meetingId: string, frame: ScreenFrame): boolean {
  prune(frame.atMs);
  if (frame.pngBase64 === '' || frame.pngBase64.length > SCREEN_FRAME_MAX_CHARS) return false;
  frames.set(meetingId, frame);
  return true;
}

/** The newest frame, when one arrived within SCREEN_FRAME_FRESH_MS. */
export function latestScreenFrame(meetingId: string, nowMs: number = Date.now()): ScreenFrame | undefined {
  prune(nowMs);
  const frame = frames.get(meetingId);
  return frame !== undefined && nowMs - frame.atMs <= SCREEN_FRAME_FRESH_MS ? frame : undefined;
}

/** Forget a meeting's frame (the meeting ended). */
export function clearScreenFrame(meetingId: string): void {
  frames.delete(meetingId);
}

/** Test helper. */
export function __clearScreenFrames(): void {
  frames.clear();
}
