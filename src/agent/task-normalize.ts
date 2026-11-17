export type VoiceTaskRecord = Record<string, unknown>

export function normalizeVoiceTask(payload: unknown): VoiceTaskRecord {
  const candidate = Array.isArray(payload) ? payload[0] : payload
  return candidate && typeof candidate === 'object'
    ? candidate as VoiceTaskRecord
    : {}
}

export function voiceTaskString(
  task: VoiceTaskRecord,
  key: string,
  fallback = '',
): string {
  const value = task[key]
  return typeof value === 'string' ? value : fallback
}
