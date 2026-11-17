import { describe, expect, it } from 'vitest';
import {
  ANSWER_DIRECTLY_DEF,
  chooseAnswerRoute,
  decisionResponseEvent,
  directAnswerEvent,
  parseRetrievalMode,
  shouldInjectLookup,
} from './answer-route.js';
import { isCasualTurn } from './wake-gate.js';

const base = { wakeWord: 'jarvis', mode: 'model' as const, hasPrefetchedResults: false, meetingScoped: false };
const route = (q: string, over: Partial<typeof base> | { mode: 'forced' } = {}) => chooseAnswerRoute(q, { ...base, ...over });

describe('chooseAnswerRoute', () => {
  it('answers presence checks and small talk directly', () => {
    expect(route('Hey Jarvis')).toBe('presence');
    expect(route('Jarvis, are you there?')).toBe('presence');
    expect(route('Hey Jarvis, how are you today?')).toBe('casual');
    expect(route("Jarvis, how's your morning so far?")).toBe('casual');
    expect(route('Jarvis, how was your weekend?')).toBe('casual');
  });

  it('by default lets the model answer and decide on a lookup itself', () => {
    expect(route('Jarvis, what is the capital of France?')).toBe('model');
    expect(route('Jarvis, what do you know about the Globex website project?')).toBe('model');
    expect(route('Jarvis, how is the weather in Los Angeles?')).toBe('model');
    expect(route('Jarvis, start a doc for this plan')).toBe('model');
  });

  it('looks up first for day-scoped questions, earlier-in-meeting questions, and a finished prefetch', () => {
    expect(route('Jarvis, what did I complete today?')).toBe('lookup_first');
    // Status questions go to the model: its own search found what the widened query missed.
    expect(route('Jarvis, what is the status of Northwind?')).toBe('model');
    expect(route('Jarvis, what is the status of Northwind?', { mode: 'forced' })).toBe('lookup_first');
    expect(route('Jarvis, what was that again', { meetingScoped: true })).toBe('lookup_first');
    expect(route('Jarvis, tell me about pFrame pricing', { hasPrefetchedResults: true })).toBe('lookup_first');
  });

  it('forced mode looks up before every answer except presence and small talk', () => {
    expect(route('Jarvis, what is the capital of France?', { mode: 'forced' })).toBe('lookup_first');
    expect(route('Hey Jarvis, how are you today?', { mode: 'forced' })).toBe('casual');
  });

  it('parseRetrievalMode defaults to model', () => {
    expect(parseRetrievalMode(undefined)).toBe('model');
    expect(parseRetrievalMode('')).toBe('model');
    expect(parseRetrievalMode('FORCED ')).toBe('forced');
    expect(parseRetrievalMode('anything')).toBe('model');
  });

  it('a work question that opens like small talk is not casual', () => {
    expect(isCasualTurn("Jarvis, how's your morning going with the Northwind launch?", 'jarvis')).toBe(false);
  });

  it('an empty lookup is handed to the model only in forced mode', () => {
    expect(shouldInjectLookup('model', 0)).toBe(false);
    expect(shouldInjectLookup('model', 3)).toBe(true);
    expect(shouldInjectLookup('forced', 0)).toBe(true);
  });
});

describe('the explicit lookup decision', () => {
  it('step one forces a tool choice, is silent, and offers the session tools plus answer_directly', () => {
    const tools = [{ type: 'function', name: 'search_brain' }, { type: 'function', name: 'create_doc' }];
    const event = decisionResponseEvent(tools) as { type: string; response: { tool_choice: string; output_modalities: string[]; tools: { name: string }[] } };
    expect(event.type).toBe('response.create');
    expect(event.response.tool_choice).toBe('required');
    expect(event.response.output_modalities).toEqual(['text']);
    expect(event.response.tools.map((t) => t.name)).toEqual(['search_brain', 'create_doc', 'answer_directly']);
    // Calling it twice with its own output does not duplicate the extra tool.
    expect((decisionResponseEvent(event.response.tools) as typeof event).response.tools.filter((t) => t.name === 'answer_directly')).toHaveLength(1);
  });

  it('step two after answer_directly cannot call a tool', () => {
    expect(directAnswerEvent()).toEqual({ type: 'response.create', response: { tool_choice: 'none' } });
  });

  it('answer_directly is described as forbidden for anything about David or his work', () => {
    expect(ANSWER_DIRECTLY_DEF.description).toContain('NEVER call this for anything about David');
    expect(ANSWER_DIRECTLY_DEF.description).toContain('search_brain');
  });
});


describe('calendar questions', () => {
  const base = { wakeWord: 'Jarvis', mode: 'model' as const, hasPrefetchedResults: false, meetingScoped: false }

  it('go to the model, which has the calendar tool, even when they name a day', () => {
    for (const q of ['what is on my calendar today', 'Jarvis, am I free tomorrow afternoon?', 'what meetings do I have yesterday', 'check my schedule for today']) {
      expect(chooseAnswerRoute(q, base)).toBe('model')
    }
  })

  it('are not preceded by a notes lookup in forced mode or when a search was prefetched', () => {
    expect(chooseAnswerRoute('what is on my calendar today', { ...base, mode: 'forced' })).toBe('model')
    expect(chooseAnswerRoute('what is on my calendar today', { ...base, hasPrefetchedResults: true })).toBe('model')
  })

  it('leave other day-scoped questions on the lookup-first path', () => {
    expect(chooseAnswerRoute('what did I finish today', base)).toBe('lookup_first')
    expect(chooseAnswerRoute('what is the launch schedule for Northwind', base)).toBe('model')
  })
})
