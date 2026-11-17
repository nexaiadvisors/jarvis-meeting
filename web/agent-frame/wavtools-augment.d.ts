// wavtools ships a stale/inaccurate dist/*.d.ts: it types WavStreamPlayer's
// interrupt() as synchronous and WavRecorder's chunk `mono`/`raw` as Int16Array.
// The real runtime (the contract this page — ported verbatim from the proven
// OpenBrain dashboard build — was written against) returns a Promise from
// interrupt() and delivers `mono` as a raw ArrayBuffer. This augmentation
// corrects the published types to the runtime reality so the page type-checks
// without `any`/`@ts-ignore` and without altering the page logic.

import 'wavtools'

declare module 'wavtools' {
  interface WavStreamPlayer {
    interrupt(): Promise<{ trackId: string | null; offset: number; currentTime: number } | null>
  }
  interface WavRecorder {
    record(chunkProcessor?: (data: { mono: ArrayBuffer; raw: ArrayBuffer }) => unknown, chunkSize?: number): Promise<true>
  }
}
