// The spoken "yes" that a Buzz send needs.
//
// A model saying "the owner confirmed" is not proof. The service hears the owner itself:
// Recall delivers each spoken line with the participant who said it, and lines from the
// participant bound as the owner are kept here for a short time. A send goes ahead only
// if the newest thing the owner said after the read-back is a yes.

interface Utterance {
  text: string;
  atMs: number;
}

const KEEP_MS = 5 * 60_000;
const utterances = new Map<string, Utterance[]>();

/** Record one line the owner said in a meeting. */
export function recordOwnerUtterance(meetingId: string, text: string, nowMs: number = Date.now()): void {
  const clean = text.trim();
  if (clean === '') return;
  const kept = (utterances.get(meetingId) ?? []).filter((u) => nowMs - u.atMs < KEEP_MS);
  kept.push({ text: clean, atMs: nowMs });
  utterances.set(meetingId, kept);
}

const NO_RE = /\b(no|nope|don't|do not|wait|stop|cancel|hold on|not yet|never mind|nevermind|change|edit|instead|scrap)\b/i;
// The owner has to say that it should be SENT. A bare "yes" or "okay" could be an answer
// to something else said in the same half minute, so it does not count.
const SEND_RE = /\b(send it|send that|send this|send the message|send it off|yes,? send|go ahead and send|please send)\b/i;

export type Confirmation = 'yes' | 'no' | 'none';

/** What one spoken line means as an answer to "say send it to confirm". A "no" word wins. */
export function classifyAnswer(text: string): Confirmation {
  const words = text.trim().split(/\s+/).filter(Boolean);
  // A long line is talk about something else, not an answer.
  if (words.length === 0 || words.length > 14) return 'none';
  if (NO_RE.test(text)) return 'no';
  return SEND_RE.test(text) ? 'yes' : 'none';
}

/**
 * The owner's answer inside a window: the newest line, said after `fromMs` and no later
 * than `untilMs`, that is a yes or a no. Lines that are neither are skipped. The window
 * opens when the service's own read-back of the draft has finished, so nothing said
 * before or during the read-back can confirm it.
 */
export function ownerAnswerBetween(meetingId: string, fromMs: number, untilMs: number): Confirmation {
  const inWindow = (utterances.get(meetingId) ?? []).filter((u) => u.atMs > fromMs && u.atMs <= untilMs);
  for (let i = inWindow.length - 1; i >= 0; i -= 1) {
    const answer = classifyAnswer(inWindow[i]!.text);
    if (answer !== 'none') return answer;
  }
  return 'none';
}

/** Forget what the owner said in a meeting (listening was paused, or the meeting ended). */
export function clearOwnerUtterances(meetingId: string): void {
  utterances.delete(meetingId);
  spoken.delete(meetingId);
}

// What the agent itself actually said, as reported by its page from the audio transcript.
// The read-back is spoken by a language model that was told to say it word for word; this
// is how the service knows it did, before any confirmation can count.
const spoken = new Map<string, Utterance[]>();

function normalizeSpoken(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Record one thing the agent said in a meeting. */
export function recordAgentSpoken(meetingId: string, text: string, nowMs: number = Date.now()): void {
  const clean = text.trim();
  if (clean === '') return;
  const kept = (spoken.get(meetingId) ?? []).filter((u) => nowMs - u.atMs < KEEP_MS);
  kept.push({ text: clean.slice(0, 4000), atMs: nowMs });
  spoken.set(meetingId, kept);
}

/**
 * True when, since `sinceMs`, the agent said something that contains every one of
 * `parts` (compared without case or punctuation). Used to check that the read-back
 * David heard carried the stored channel and the stored text, unchanged.
 */
export function agentSaidSince(meetingId: string, sinceMs: number, parts: string[]): boolean {
  const wanted = parts.map(normalizeSpoken);
  // A required part with nothing checkable in it cannot be confirmed: refuse.
  if (wanted.length === 0 || wanted.some((part) => part === '')) return false;
  return (spoken.get(meetingId) ?? []).some((u) => {
    if (u.atMs < sinceMs) return false;
    const said = ` ${normalizeSpoken(u.text)} `;
    return wanted.every((part) => said.includes(` ${part} `));
  });
}

export function __clearOwnerUtterancesForTests(): void {
  utterances.clear();
  spoken.clear();
}
