import { describe, expect, it } from 'vitest';
import { composeEmail, recapRecipients } from './email.js';

const SUMMARY = { bluf: 'Ship Friday.', decisions: [], actionItems: [] };
const BASE = [{ address: 'owner@nexai.test' }];
const INVITEES = ['Nick@Nexai.test', 'client@outside.test', 'owner@nexai.test', 'sub@team.nexai.test', 'not-an-email'];

describe('recapRecipients', () => {
  it('returns only the base list unless the switch is on and a domain is configured', () => {
    expect(recapRecipients(BASE, INVITEES, {})).toEqual(BASE);
    expect(recapRecipients(BASE, INVITEES, { recapToInvitees: false, internalDomains: ['nexai.test'] })).toEqual(BASE);
    expect(recapRecipients(BASE, INVITEES, { recapToInvitees: true })).toEqual(BASE);
    expect(recapRecipients(BASE, INVITEES, { recapToInvitees: true, internalDomains: [] })).toEqual(BASE);
    expect(recapRecipients(BASE, undefined, { recapToInvitees: true, internalDomains: ['nexai.test'] })).toEqual(BASE);
  });

  it('adds invitees on an exact internal domain, once each, and never an outside address', () => {
    const out = recapRecipients(BASE, INVITEES, { recapToInvitees: true, internalDomains: ['nexai.test'] });
    expect(out.map((r) => r.address)).toEqual(['owner@nexai.test', 'nick@nexai.test']);
  });

  it('does not treat a lookalike or a subdomain as internal', () => {
    const out = recapRecipients([], ['a@evilnexai.test', 'b@nexai.test.evil.com', 'c@team.nexai.test', 'a@b@nexai.test', 'two words@nexai.test'], {
      recapToInvitees: true,
      internalDomains: ['nexai.test'],
    });
    expect(out).toEqual([]);
  });
});

describe('composeEmail meeting page link', () => {
  it('includes the meeting page link when given, and stays unchanged without it', () => {
    const link = 'https://jarvis.example.com/m/m1?t=abc';
    expect(composeEmail('Q2', SUMMARY, null, BASE, link).bodyText).toContain(`Meeting page (notes, transcript, docs and whiteboards): ${link}`);
    expect(composeEmail('Q2', SUMMARY, null, BASE).bodyText).not.toContain('Meeting page');
  });
});
