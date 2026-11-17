import { describe, expect, it } from 'vitest';
import { isLeaveCommand, isLeaveRequest, isStopListeningCommand, isStopListeningRequest } from './wake-gate.js';

describe('spoken leave / stop listening (must be addressed to the agent)', () => {
  it('leaves on a directed leave phrase', () => {
    expect(isLeaveCommand('Jarvis, leave the call', 'jarvis')).toBe(true);
    expect(isLeaveCommand('Hey Jarvis you can leave now.', 'jarvis')).toBe(true);
    expect(isLeaveCommand('Travis, please leave the meeting', 'jarvis', ['travis'])).toBe(true);
  });

  it('does not leave on room talk or a near miss', () => {
    expect(isLeaveCommand('I have to leave the call in five minutes', 'jarvis')).toBe(false);
    expect(isLeaveCommand('Jarvis, when did Nick leave nowhere', 'jarvis')).toBe(false);
    expect(isLeaveCommand('Jarvis, what is the budget?', 'jarvis')).toBe(false);
    for (const ordinary of [
      'Jarvis, you can go ahead and summarize that',
      'Jarvis, please leave a note for David',
      'Jarvis, you can leave that out of the doc',
      'Jarvis, remind me I have to leave the call at three',
      'Hey Jarvis, when should I drop off the samples',
      'Jarvis, leave the budget section as it is',
      'Jarvis, remind me to drop off the contract tomorrow',
      'Jarvis, should we leave now or wait for Bob',
      'Hey Jarvis, please leave a note about the budget',
    ]) {
      expect(isLeaveCommand(ordinary, 'jarvis'), ordinary).toBe(false);
    }
    expect(isLeaveCommand('Okay Jarvis, please leave the call now, thanks', 'jarvis')).toBe(true);
    expect(isLeaveCommand('Jarvis, please leave', 'jarvis')).toBe(true);
  });

  it('stops listening only when addressed', () => {
    expect(isStopListeningCommand('Jarvis, stop listening', 'jarvis')).toBe(true);
    expect(isStopListeningCommand('Jarvis go off the record please', 'jarvis')).toBe(true);
    expect(isStopListeningCommand('nobody was listening, stop listening to him', 'jarvis')).toBe(false);
    expect(isStopListeningCommand('Jarvis, tell Abby to stop recording the demo', 'jarvis')).toBe(false);
    expect(isStopListeningCommand('Jarvis, stop recording the demo', 'jarvis')).toBe(false);
    expect(isStopListeningCommand('Jarvis, when should we stop recording the demo', 'jarvis')).toBe(false);
    expect(isStopListeningCommand('Jarvis, stop listening for a minute please', 'jarvis')).toBe(true);
  });
});

describe('typed leave / stop listening (wake word already removed)', () => {
  it('matches whole phrases', () => {
    expect(isLeaveRequest('leave the call')).toBe(true);
    expect(isLeaveRequest('please leave')).toBe(true);
    expect(isLeaveRequest('what did we leave out')).toBe(false);
    expect(isLeaveRequest('please leave a comment in the doc')).toBe(false);
    expect(isLeaveRequest('you can leave now')).toBe(true);
    expect(isLeaveRequest('you can go ahead and make the doc')).toBe(false);
    expect(isStopListeningRequest('stop taking notes for a minute')).toBe(true);
    expect(isStopListeningRequest('stop recording the demo')).toBe(false);
    expect(isStopListeningRequest('start a doc')).toBe(false);
  });
});
