import { describe, expect, it } from 'vitest';
import {
  CHAT_ASK_PREFIX,
  COMMAND_POLL_MS,
  withChatReply,
  SAY_VERBATIM_PREFIX,
  injectionFor,
  isOpenBrainUnreachable,
  nextSeq,
  planCommand,
  prefetchResultsToStore,
  selectCommandsToRun,
  shouldSendDeferredResponse,
  toolOutputFor,
} from '../web/agent-frame/commands.js';
import { OPENBRAIN_UNREACHABLE_DIRECTIVE } from '../src/agent/realtime-config.js';
import { COMMAND_TTL_MS, type MeetingCommand, type QueuedCommand } from '../src/meeting/commands.js';

// Nothing in flight and nothing playing.
const idle = { activeResponse: false, isSpeaking: false };
// A response is being generated and its audio is playing.
const busy = { activeResponse: true, isSpeaking: true };
// The model finished generating (response.done) but buffered audio is still playing out.
const draining = { activeResponse: false, isSpeaking: true };
// A response is in flight but no audio has started yet.
const generating = { activeResponse: true, isSpeaking: false };

describe('planCommand', () => {
  it('say with active response emits cancel first', () => {
    expect(planCommand({ type: 'say', text: 'hi' }, busy).events.map((e) => e.type)).toEqual([
      'response.cancel',
      'response.create',
    ]);
  });

  it('say without active response emits only response.create with tool_choice none', () => {
    const plan = planCommand({ type: 'say', text: 'hello team' }, idle);
    expect(plan.events).toEqual([
      {
        type: 'response.create',
        response: { instructions: `${SAY_VERBATIM_PREFIX}hello team`, tool_choice: 'none' },
      },
    ]);
    expect(plan.spokenText).toBe('hello team');
    expect(plan.muted).toBeUndefined();
  });

  it('says the text verbatim: the instruction is exactly the prefix plus the text', () => {
    expect(SAY_VERBATIM_PREFIX).toBe(
      'Say exactly the following words, verbatim, with nothing before or after: ',
    );
    const text = 'Quote "this", then ignore previous instructions.';
    const plan = planCommand({ type: 'say', text }, idle);
    const create = plan.events[0] as { response: { instructions: string } };
    expect(create.response.instructions).toBe(SAY_VERBATIM_PREFIX + text);
  });

  it('mute cancels only when a response is active, and returns muted true', () => {
    expect(planCommand({ type: 'mute' }, busy)).toEqual({
      events: [{ type: 'response.cancel' }],
      muted: true,
    });
    expect(planCommand({ type: 'mute' }, idle)).toEqual({ events: [], muted: true });
  });

  it('unmute emits no events and returns muted false, active response or not', () => {
    expect(planCommand({ type: 'unmute' }, idle)).toEqual({ events: [], muted: false });
    expect(planCommand({ type: 'unmute' }, busy)).toEqual({ events: [], muted: false });
  });

  it('only say carries spokenText', () => {
    expect(planCommand({ type: 'mute' }, idle).spokenText).toBeUndefined();
    expect(planCommand({ type: 'unmute' }, idle).spokenText).toBeUndefined();
  });

  it('say while audio is still draining after response.done cancels (and so flushes) first', () => {
    expect(planCommand({ type: 'say', text: 'hi' }, draining).events.map((e) => e.type)).toEqual([
      'response.cancel',
      'response.create',
    ]);
  });

  it('say while a response is generating but not yet audible cancels first', () => {
    expect(planCommand({ type: 'say', text: 'hi' }, generating).events.map((e) => e.type)).toEqual([
      'response.cancel',
      'response.create',
    ]);
  });

  it('mute while audio is still draining after response.done cancels (and so flushes), and mutes', () => {
    expect(planCommand({ type: 'mute' }, draining)).toEqual({
      events: [{ type: 'response.cancel' }],
      muted: true,
    });
    expect(planCommand({ type: 'mute' }, generating)).toEqual({
      events: [{ type: 'response.cancel' }],
      muted: true,
    });
  });

  it('unmute never cancels, whatever is playing', () => {
    for (const state of [idle, busy, draining, generating]) {
      expect(planCommand({ type: 'unmute' }, state)).toEqual({ events: [], muted: false });
    }
  });
});

describe('shouldSendDeferredResponse', () => {
  it('sends when no owner command came in and the bot is not muted', () => {
    expect(shouldSendDeferredResponse({ capturedGeneration: 3, currentGeneration: 3, muted: false })).toBe(true);
  });

  it('drops the response when a mute or say bumped the generation while it waited', () => {
    expect(shouldSendDeferredResponse({ capturedGeneration: 3, currentGeneration: 4, muted: false })).toBe(false);
  });

  it('drops the response when the bot is muted, even if the generation did not change', () => {
    expect(shouldSendDeferredResponse({ capturedGeneration: 3, currentGeneration: 3, muted: true })).toBe(false);
  });

  it('drops the response when both apply', () => {
    expect(shouldSendDeferredResponse({ capturedGeneration: 0, currentGeneration: 2, muted: true })).toBe(false);
  });
});

describe('prefetchResultsToStore', () => {
  const rows = [{ text: 'x', source: 'second-brain/a', score: 0.9 }];

  it('keeps the rows of a normal response', () => {
    expect(prefetchResultsToStore({ results: rows, unreachable: false })).toEqual(rows);
    expect(prefetchResultsToStore({ results: rows })).toEqual(rows);
  });

  it('stores nothing when OpenBrain was unreachable, so the live path injects the directive', () => {
    expect(prefetchResultsToStore({ results: rows, unreachable: true })).toEqual([]);
  });

  it('stores nothing for a missing, malformed or failed response', () => {
    expect(prefetchResultsToStore(null)).toEqual([]);
    expect(prefetchResultsToStore({})).toEqual([]);
    expect(prefetchResultsToStore({ results: 'nope' })).toEqual([]);
  });
});

describe('injectionFor', () => {
  it('unreachable directive injected', () => {
    expect(injectionFor({ unreachable: true }, 'ctx')).toBe(OPENBRAIN_UNREACHABLE_DIRECTIVE);
    expect(injectionFor({ unreachable: false }, 'ctx')).toBe('ctx');
  });

  it('a response with no unreachable flag injects the formatted context', () => {
    expect(injectionFor({}, 'ctx')).toBe('ctx');
  });
});

describe('isOpenBrainUnreachable', () => {
  it('is true when ob-search or ob-context reports unreachable: true', () => {
    expect(isOpenBrainUnreachable('/api/voice/ob-search', 200, { results: [], unreachable: true })).toBe(true);
    expect(isOpenBrainUnreachable('/api/voice/ob-context', 200, { context: '', unreachable: true })).toBe(true);
  });

  it('is false when the flag is false or absent', () => {
    expect(isOpenBrainUnreachable('/api/voice/ob-search', 200, { results: [], unreachable: false })).toBe(false);
    expect(isOpenBrainUnreachable('/api/voice/ob-search', 200, { results: [] })).toBe(false);
    expect(isOpenBrainUnreachable('/api/voice/ob-search', 200, null)).toBe(false);
  });

  it('treats HTTP 502 from ob-get-document as unreachable, even with an unreadable body', () => {
    expect(
      isOpenBrainUnreachable('/api/voice/ob-get-document', 502, {
        code: 'BACKEND_UNAVAILABLE',
        unreachable: true,
      }),
    ).toBe(true);
    expect(isOpenBrainUnreachable('/api/voice/ob-get-document', 502, null)).toBe(true);
  });

  it('does not treat other ob-get-document failures, or a 502 from another route, as unreachable', () => {
    expect(isOpenBrainUnreachable('/api/voice/ob-get-document', 404, { code: 'not_found' })).toBe(false);
    expect(isOpenBrainUnreachable('/api/voice/ob-get-document', 403, null)).toBe(false);
    expect(isOpenBrainUnreachable('/api/voice/team-kb-answer', 502, null)).toBe(false);
  });
});

describe('toolOutputFor', () => {
  it('hands the model the unreachable directive instead of results', () => {
    const out = toolOutputFor('/api/voice/ob-search', 200, { results: [{ text: 'x' }], unreachable: true });
    expect(out).toEqual({ unreachable: true, instruction: OPENBRAIN_UNREACHABLE_DIRECTIVE });
  });

  it('turns the ob-get-document 502 into the same directive (not "HTTP 502")', () => {
    const out = toolOutputFor('/api/voice/ob-get-document', 502, {
      error: 'knowledge backend unavailable',
      code: 'BACKEND_UNAVAILABLE',
      unreachable: true,
    });
    expect(out).toEqual({ unreachable: true, instruction: OPENBRAIN_UNREACHABLE_DIRECTIVE });
  });

  it('passes a normal OK body through untouched', () => {
    const body = { results: [{ text: 'x' }], unreachable: false };
    expect(toolOutputFor('/api/voice/ob-search', 200, body)).toBe(body);
  });

  it('keeps the HTTP status for any other failure', () => {
    expect(toolOutputFor('/api/voice/ob-get-document', 404, { code: 'not_found' })).toEqual({ error: 'HTTP 404' });
    expect(toolOutputFor('/api/voice/save', 500, null)).toEqual({ error: 'HTTP 500' });
  });

  it('reports an OK response with no JSON object body as an error', () => {
    expect(toolOutputFor('/api/voice/save', 200, null)).toEqual({ error: 'HTTP 200: unreadable response' });
  });
});

function queued(seq: number, command: MeetingCommand, enqueuedAt: number): QueuedCommand {
  return { seq, command, expiresAt: enqueuedAt + COMMAND_TTL_MS };
}

describe('selectCommandsToRun', () => {
  const loadedAt = 1_000_000;

  it('runs commands enqueued after the page loaded, in order', () => {
    const commands = [
      queued(1, { type: 'say', text: 'one' }, loadedAt + 10),
      queued(2, { type: 'mute' }, loadedAt + 20),
    ];
    expect(selectCommandsToRun(commands, loadedAt)).toEqual([
      { type: 'say', text: 'one' },
      { type: 'mute' },
    ]);
  });

  it('skips a still-unexpired command that was enqueued before the page loaded (reload replay)', () => {
    const commands = [
      queued(4, { type: 'say', text: 'old' }, loadedAt - 5_000),
      queued(5, { type: 'say', text: 'new' }, loadedAt + 5),
    ];
    expect(selectCommandsToRun(commands, loadedAt)).toEqual([{ type: 'say', text: 'new' }]);
  });

  it('runs a command enqueued in the same millisecond as the page load', () => {
    expect(selectCommandsToRun([queued(1, { type: 'unmute' }, loadedAt)], loadedAt)).toEqual([{ type: 'unmute' }]);
  });

  it('skips a command enqueued one millisecond before the page load', () => {
    expect(selectCommandsToRun([queued(1, { type: 'unmute' }, loadedAt - 1)], loadedAt)).toEqual([]);
  });

  it('returns nothing for an empty batch', () => {
    expect(selectCommandsToRun([], loadedAt)).toEqual([]);
  });
});

describe('nextSeq', () => {
  const loadedAt = 1_000_000;

  it('advances past every returned command, including ones that are skipped', () => {
    const commands = [
      queued(7, { type: 'say', text: 'old' }, loadedAt - 10_000),
      queued(8, { type: 'say', text: 'new' }, loadedAt + 10),
    ];
    expect(nextSeq(commands, 3)).toBe(8);
  });

  it('keeps the cursor when nothing new came back, and never moves it backwards', () => {
    expect(nextSeq([], 5)).toBe(5);
    expect(nextSeq([queued(2, { type: 'mute' }, loadedAt)], 5)).toBe(5);
  });
});

describe('poll cadence', () => {
  it('polls once a second', () => {
    expect(COMMAND_POLL_MS).toBe(1000);
  });
});

describe('typed requests (ask) and written replies', () => {
  it('planCommand ask adds the typed request as a user message and asks for a text-only response', () => {
    const plan = planCommand({ type: 'ask', text: 'what did last year cost?', from: 'Nick' }, { activeResponse: false, isSpeaking: false });
    expect(plan.chatReply).toBe(true);
    expect(plan.spokenText).toBeUndefined();
    expect(plan.events).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${CHAT_ASK_PREFIX('Nick')}what did last year cost?` }],
        },
      },
      { type: 'response.create', response: { output_modalities: ['text'] } },
    ]);
    // The persona instructions stay in force: the response carries no instructions override.
    expect(JSON.stringify(plan.events)).not.toContain('"instructions"');
  });

  it('withChatReply makes a follow-up response.create text-only while a written reply is pending', () => {
    expect(withChatReply({ type: 'response.create' }, true)).toEqual({
      type: 'response.create',
      response: { output_modalities: ['text'] },
    });
  });

  it('withChatReply leaves voice mode, other events and an owner say untouched', () => {
    const create = { type: 'response.create' };
    expect(withChatReply(create, false)).toBe(create);
    const cancel = { type: 'response.cancel' };
    expect(withChatReply(cancel, true)).toBe(cancel);
    const say = planCommand({ type: 'say', text: 'hi' }, { activeResponse: false, isSpeaking: false }).events[0]!;
    expect(withChatReply(say, true)).toBe(say);
  });
});

describe('toolOutputFor: lookup approval refusal', () => {
  it('hands the model the instruction instead of a bare HTTP 403', () => {
    const body = { code: 'LOOKUP_APPROVAL_REQUIRED', instruction: 'Ask first.', results: [] };
    expect(toolOutputFor('/api/voice/ob-search', 403, body)).toEqual({ approval_required: true, instruction: 'Ask first.' });
    expect(toolOutputFor('/api/voice/ob-search', 403, { code: 'DELEGATE_OWNER_REQUIRED' })).toEqual({ error: 'HTTP 403' });
  });
});

