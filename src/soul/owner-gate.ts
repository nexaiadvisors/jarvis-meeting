// Owner gate for the Delegate (first_person) persona — generalized from the
// dashboard's delegate-access.ts to be SOUL-driven instead of env-driven.
//
// The Delegate speaks AS its owner and reads the owner's full knowledge backend,
// so it is gated to the owner. The team "Jarvis" (persona_mode 'ai') reads only
// the team knowledge base and is always allowed. The gate fails CLOSED: a
// first_person SOUL with no owner can never run.

import type { Soul } from './schema.js';

/** True when the persona is the owner-only Delegate (first_person). */
export function isDelegatePersona(personaMode: string): boolean {
  return personaMode === 'first_person';
}

/** Machine-readable error payload for a blocked Delegate access (owner-only). */
export const DELEGATE_OWNER_REQUIRED = {
  error:
    'The Delegate (first-person) persona is owner-only. Set `owner` in the SOUL and dispatch with the owner as teammate, or use a team (ai) persona, which uses company knowledge only.',
  code: 'DELEGATE_OWNER_REQUIRED',
} as const;

/**
 * Whether delegate-scoped access is allowed for this SOUL + request.
 *
 * - A team (ai) persona is ALWAYS allowed (team-KB-only, shareable).
 * - A first_person (Delegate) persona is allowed only when the SOUL has a
 *   non-empty owner AND, if a requestTeammate is provided, it matches the owner.
 *
 * Fails CLOSED: no owner => denied.
 */
export function delegateAllowed(soul: Soul, requestTeammate?: string): boolean {
  if (!isDelegatePersona(soul.personaMode)) return true; // Jarvis (ai) always ok
  if (!soul.owner || soul.owner.trim() === '') return false; // fail closed
  if (requestTeammate !== undefined && requestTeammate !== soul.owner) return false;
  return true;
}
