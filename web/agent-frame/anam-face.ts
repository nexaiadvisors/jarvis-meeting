// The Anam talking head for the meeting tile. Anam renders a video face that lip-syncs
// audio we send it (audio passthrough): it has no brain and no voice of its own.
//
// Ported from Gatekeeper (apps/web/services/avatar/anam.ts), where it was measured at
// about 0.9 s behind the audio it is given. The page therefore keeps playing the voice
// itself, delayed by that much, and shows Anam's video MUTED. Audio from a WebRTC track
// came out choppy in Recall's headless Chromium, which is why this page never plays one
// (see avatar-stage.tsx).

export const ANAM_VIDEO_ID = 'jarvis-anam-face'

interface AnamAudioStream {
  sendAudioChunk(chunk: Uint8Array): void
  endSequence(): void
}
interface AnamClient {
  streamToVideoElement(id: string): Promise<void>
  createAgentAudioInputStream(cfg: { encoding: 'pcm_s16le'; sampleRate: number; channels: 1 }): AnamAudioStream
  interruptPersona(): void
  stopStreaming(): Promise<void>
}

export interface AnamFace {
  /** One chunk of the agent's speech: 24 kHz mono PCM16. */
  pushAudio(pcm: Int16Array): void
  /** The agent finished the current answer. */
  endUtterance(): void
  /** Drop speech still queued: the person interrupted. */
  interrupt(): void
  stop(): Promise<void>
}

/**
 * Connect to Anam and attach the face to the <video id=ANAM_VIDEO_ID> element, which must
 * already be in the page. Resolves once the video is streaming. Throws on any failure;
 * the caller keeps the drawn avatar.
 */
export async function startAnamFace(sessionToken: string, timeoutMs = 20_000): Promise<AnamFace> {
  const { createClient } = await import('@anam-ai/js-sdk')
  const client = createClient(sessionToken, { disableInputAudio: true }) as unknown as AnamClient
  await Promise.race([
    client.streamToVideoElement(ANAM_VIDEO_ID),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`anam video did not start in ${timeoutMs} ms`)), timeoutMs)),
  ])
  // The audio input stream may only be created once the video is streaming.
  const stream = client.createAgentAudioInputStream({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 })
  let open = false
  let stopped = false
  return {
    pushAudio(pcm) {
      if (stopped) return
      open = true
      stream.sendAudioChunk(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    },
    endUtterance() {
      if (stopped || !open) return
      open = false
      stream.endSequence()
    },
    interrupt() {
      if (stopped) return
      client.interruptPersona()
      open = false
      stream.endSequence()
    },
    async stop() {
      stopped = true
      await client.stopStreaming().catch(() => undefined)
    },
  }
}
