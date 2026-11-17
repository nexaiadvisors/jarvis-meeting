import { describe, expect, it } from 'vitest';
import { chatWakeRequest } from './wake-gate.js';
import { SoulFrontMatter, toSoul } from '../soul/schema.js';

describe('chatWakeRequest', () => {
  const names = ['', 'Jarvis', 'Sidekick'];

  it('returns the request when the text starts with a name', () => {
    expect(chatWakeRequest('Jarvis, start a doc for this plan', names)).toBe('start a doc for this plan');
    expect(chatWakeRequest('  jarvis what did we decide?', names)).toBe('what did we decide?');
    expect(chatWakeRequest('@Jarvis: put this on a whiteboard', names)).toBe('put this on a whiteboard');
    expect(chatWakeRequest('hey sidekick - summarize', names)).toBe('summarize');
  });

  it('returns undefined when the name is not first, is part of a longer word, or nothing follows', () => {
    expect(chatWakeRequest('I asked Jarvis already', names)).toBeUndefined();
    expect(chatWakeRequest('Jarvising around', names)).toBeUndefined();
    expect(chatWakeRequest('Jarvis!', names)).toBeUndefined();
    expect(chatWakeRequest('hello', names)).toBeUndefined();
    expect(chatWakeRequest('anything', [])).toBeUndefined();
  });

  it('treats a name with regex characters literally', () => {
    expect(chatWakeRequest('A.I. help me', ['A.I.'])).toBe('help me');
    expect(chatWakeRequest('AXIX help me', ['A.I.'])).toBeUndefined();
  });
});

describe('SOUL reply_mode', () => {
  it('defaults to voice and accepts chat', () => {
    expect(toSoul(SoulFrontMatter.parse({ name: 'J' }), '').replyMode).toBe('voice');
    expect(toSoul(SoulFrontMatter.parse({ name: 'J', reply_mode: 'chat' }), '').replyMode).toBe('chat');
    expect(() => SoulFrontMatter.parse({ name: 'J', reply_mode: 'email' })).toThrow();
  });
});
