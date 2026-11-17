import { describe, it, expect } from 'vitest';
import { isDelegatePersona, delegateAllowed, DELEGATE_OWNER_REQUIRED } from './owner-gate.js';
import type { Soul } from './schema.js';

function soul(partial: Partial<Soul>): Soul {
  return {
    owner: 'david',
    name: 'Delegate',
    wakeWord: 'David',
    personaMode: 'first_person',
    voice: 'cedar',
    language: 'en',
    knowledgeBackend: { type: 'openbrain', endpoint: 'http://x', route: 'delegate' },
    delivery: [],
    ingest: false,
    deniedTopics: [],
    aiDisclosure: '',
    prose: '',
    ...partial,
  };
}

describe('isDelegatePersona', () => {
  it('is true only for first_person', () => {
    expect(isDelegatePersona('first_person')).toBe(true);
    expect(isDelegatePersona('ai')).toBe(false);
  });
});

describe('delegateAllowed', () => {
  it('allows a delegate with an owner and no request teammate', () => {
    expect(delegateAllowed(soul({ owner: 'david' }))).toBe(true);
  });

  it('allows a delegate when requestTeammate matches the owner', () => {
    expect(delegateAllowed(soul({ owner: 'david' }), 'david')).toBe(true);
  });

  it('blocks a delegate with an empty owner (fail closed)', () => {
    expect(delegateAllowed(soul({ owner: '' }))).toBe(false);
    expect(delegateAllowed(soul({ owner: '   ' }))).toBe(false);
  });

  it('blocks a delegate when requestTeammate does not match the owner', () => {
    expect(delegateAllowed(soul({ owner: 'david' }), 'eve')).toBe(false);
  });

  it('always allows a jarvis (ai) persona regardless of owner', () => {
    expect(delegateAllowed(soul({ personaMode: 'ai', owner: '' }))).toBe(true);
    expect(delegateAllowed(soul({ personaMode: 'ai', owner: '' }), 'anyone')).toBe(true);
  });

  it('exposes the machine-readable error payload', () => {
    expect(DELEGATE_OWNER_REQUIRED.code).toBe('DELEGATE_OWNER_REQUIRED');
  });
});
