import { describe, it, expect } from 'vitest';
import {
  evaluateWakeGate,
  evaluateWakeGateStitched,
  markAgentSpoke,
  type WakeGateConfig,
} from './wake-gate.js';

const multipartyCfg: WakeGateConfig = {
  wakeWord: 'Jarvis',
  behaviorMode: 'team',
  engagementWindowMs: 45_000,
  correctionFollowupWindowMs: 12_000,
  participantCount: 4, // multi-party (>2)
  overlappingSpeech: false,
};

describe('Phase 1 — Multi-Party Speaker-Locked Conversation Intelligence', () => {
  it('captures engagedSpeaker when woken in a multi-party room and allows wake-word-free follow-ups from the SAME speaker', () => {
    const t0 = 1_000_000;
    const d1 = evaluateWakeGate({ engagedUntil: 0 }, 'Hey Jarvis, what is the status of Sideshop?', multipartyCfg, 'David', t0);
    expect(d1.activate).toBe(true);
    expect(d1.state.engagedSpeaker).toBe('David');

    // Agent speaks and refreshes engagement window preserving David
    const afterSpoke = markAgentSpoke(multipartyCfg, t0 + 3_000, d1.state.engagedSpeaker);
    expect(afterSpoke.engagedSpeaker).toBe('David');

    // David asks a wake-word-free follow-up within the engagement window -> activates!
    const d2 = evaluateWakeGate(
      afterSpoke,
      'And what did we decide about the Stripe invoice?',
      multipartyCfg,
      'David',
      t0 + 8_000,
    );
    expect(d2.activate).toBe(true);
    expect(d2.reason).toContain('speaker-locked follow-up question');
    expect(d2.state.engagedSpeaker).toBe('David');
  });

  it('rejects wake-word-free follow-ups from a DIFFERENT speaker in a multi-party room', () => {
    const t0 = 1_000_000;
    const afterSpoke = markAgentSpoke(multipartyCfg, t0, 'David');

    // Alice speaks to Bob without wake word -> ignored
    const dAlice = evaluateWakeGate(
      afterSpoke,
      'What did we decide about the Stripe invoice?',
      multipartyCfg,
      'Alice',
      t0 + 4_000,
    );
    expect(dAlice.activate).toBe(false);
    expect(dAlice.reason).toContain('not addressed');
  });

  it('suppresses wake-word-free follow-ups during overlapping cross-talk even if engagedSpeaker is set', () => {
    const t0 = 1_000_000;
    const afterSpoke = markAgentSpoke(multipartyCfg, t0, 'David');
    const overlappingCfg: WakeGateConfig = { ...multipartyCfg, overlappingSpeech: true };

    const dOverlap = evaluateWakeGate(
      afterSpoke,
      'What did we decide about the Stripe invoice?',
      overlappingCfg,
      'David',
      t0 + 4_000,
    );
    expect(dOverlap.activate).toBe(false);
  });

  it('stitches multi-party VAD-split follow-up fragments when the engaged speaker continues without overlap', () => {
    const t0 = 1_000_000;
    const afterSpoke = markAgentSpoke(multipartyCfg, t0, 'David');
    const f1 = evaluateWakeGateStitched(
      afterSpoke,
      'what about the latest status',
      multipartyCfg,
      null,
      'David',
      t0 + 1_000,
    );
    // "what about the latest status" is 5 tokens -> activates or if shorter:
    const fShort1 = evaluateWakeGateStitched(
      afterSpoke,
      'what about',
      multipartyCfg,
      null,
      'David',
      t0 + 1_000,
    );
    expect(fShort1.activate).toBe(false);

    const fShort2 = evaluateWakeGateStitched(
      fShort1.state,
      'the latest status on Sideshop',
      multipartyCfg,
      { text: fShort1.effectiveUtterance, at: t0 + 1_000, speaker: 'David' },
      'David',
      t0 + 2_500,
    );
    expect(fShort2.activate).toBe(true);
    expect(fShort2.stitched).toBe(true);
    expect(fShort2.effectiveUtterance).toBe('what about the latest status on Sideshop');
  });
});
