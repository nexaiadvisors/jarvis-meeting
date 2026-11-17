import { describe, expect, it } from 'vitest';
import { isCasualTurn } from './wake-gate.js';

describe('isCasualTurn', () => {
  it('recognizes greetings, small talk and questions about the agent itself', () => {
    for (const casual of [
      'Hey Jarvis, how are you today?',
      'Jarvis, hello',
      'Good morning Jarvis',
      "Jarvis, how's it going?",
      'Thanks Jarvis',
      'Okay, thank you so much, Jarvis.',
      'Jarvis, who are you?',
      'Jarvis what can you do',
      'Jarvis, can you hear me?',
      'Jarvis, can you introduce yourself',
      'Jarvis, are you an AI?',
    ]) {
      expect(isCasualTurn(casual, 'jarvis'), casual).toBe(true);
    }
  });

  it('does not treat a real question as casual', () => {
    for (const real of [
      'Jarvis, how are you doing on the Northwind launch?',
      'Jarvis, how is the weather in Los Angeles?',
      'Jarvis, what can you tell me about Nick?',
      'Jarvis, who are the clients we signed this month?',
      'Jarvis, thanks, and what is the budget?',
      'Jarvis, can you leave?',
      'Jarvis',
      '',
    ]) {
      expect(isCasualTurn(real, 'jarvis'), real).toBe(false);
    }
  });
});
