// Phase 3b — compose and send (or dry-run) the post-meeting email.
//
// Sends via Microsoft Graph sendMail from a service mailbox.  If Graph env
// vars are absent, renders the email and writes it to .data/<botId>.email.json
// (dry-run mode) — never throws on NOT_CONFIGURED.
//
// Rules:
//  - Includes a LINK to the SAS audio URL, never an attachment.
//  - ASCII-only in all user-facing text (plain hyphens, straight quotes, ...).
//  - Includes a recording/consent disclosure footer on every email.

import { ClientSecretCredential } from '@azure/identity';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { SummaryResult } from './summary.js';

export interface EmailRecipient {
  address: string;
  name?: string;
}

export interface EmailPayload {
  subject: string;
  bodyText: string;
  recipients: EmailRecipient[];
}

const DATA_DIR = join(process.cwd(), '.data');

const CONSENT_FOOTER = [
  '',
  '---',
  'This meeting was recorded and transcribed by an AI assistant (Jarvis).',
  'A recording of the audio is linked above. By participating in this meeting',
  'you consented to its recording under applicable notice laws.',
  'To request deletion of this recording, reply to this email.',
].join('\n');

/**
 * Who gets the recap. Always the configured default recipients (or the caller's explicit
 * list). The calendar invitees are added ONLY when `recapToInvitees` is on, and then only
 * the ones whose email domain is in `internalDomains`. With the switch off, or with no
 * internal domains configured, nobody outside the default list is emailed.
 */
export function recapRecipients(
  base: EmailRecipient[],
  attendees: string[] | undefined,
  opts: { recapToInvitees?: boolean | undefined; internalDomains?: string[] | undefined },
): EmailRecipient[] {
  if (opts.recapToInvitees !== true || !attendees || !opts.internalDomains?.length) return base;
  const domains = new Set(opts.internalDomains.map((d) => d.toLowerCase()));
  const seen = new Set(base.map((r) => r.address.toLowerCase()));
  const out = [...base];
  for (const raw of attendees) {
    const address = raw.trim().toLowerCase();
    const domain = address.slice(address.lastIndexOf('@') + 1);
    // Exactly one "@" and no spaces: one malformed address must not sink the whole email.
    if (!/^[^@\s]+@[^@\s]+$/.test(address) || !domains.has(domain) || seen.has(address)) continue;
    seen.add(address);
    out.push({ address });
  }
  return out;
}

export function composeEmail(
  title: string,
  summary: SummaryResult,
  sasUrl: string | null,
  recipients: EmailRecipient[],
  /** Link to the meeting page (notes, transcript, docs and whiteboards), when there is one. */
  pageUrl?: string,
): EmailPayload {
  const lines: string[] = [];

  // BLUF first.
  lines.push(summary.bluf || 'Meeting completed.');
  lines.push('');

  if (summary.decisions.length > 0) {
    lines.push('Decisions:');
    for (const d of summary.decisions) {
      lines.push(`- ${d}`);
    }
    lines.push('');
  }

  if (summary.actionItems.length > 0) {
    lines.push('Action items:');
    for (const item of summary.actionItems) {
      const due = item.due ? ` (due: ${item.due})` : '';
      lines.push(`- ${item.owner}: ${item.task}${due}`);
    }
    lines.push('');
  }

  if (pageUrl) {
    lines.push(`Meeting page (notes, transcript, docs and whiteboards): ${pageUrl}`);
    lines.push('');
  }

  if (sasUrl) {
    lines.push(`Audio recording: ${sasUrl}`);
    lines.push('(Link expires per the configured retention period.)');
  } else {
    lines.push('(No audio recording link available.)');
  }

  lines.push(CONSENT_FOOTER);

  return {
    subject: `Meeting notes: ${title}`,
    bodyText: lines.join('\n'),
    recipients,
  };
}

function isGraphConfigured(config: Config): boolean {
  return Boolean(
    config.graphTenantId &&
      config.graphClientId &&
      config.graphClientSecret &&
      config.meetingEmailSender,
  );
}

export async function sendOrDryRunEmail(
  config: Config,
  botId: string,
  payload: EmailPayload,
): Promise<void> {
  if (!isGraphConfigured(config)) {
    // Dry-run: write to disk.
    mkdirSync(DATA_DIR, { recursive: true });
    const outFile = join(DATA_DIR, `${botId}.email.json`);
    writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'email: NOT_CONFIGURED (Graph env absent), dry-run written',
        botId,
        file: outFile,
      }),
    );
    return;
  }

  if (payload.recipients.length === 0) {
    console.log(
      JSON.stringify({ level: 'warn', msg: 'email: no recipients, skipping send', botId }),
    );
    return;
  }

  const credential = new ClientSecretCredential(
    config.graphTenantId!,
    config.graphClientId!,
    config.graphClientSecret!,
  );

  const tokenResponse = await credential.getToken('https://graph.microsoft.com/.default');
  const accessToken = tokenResponse.token;

  const graphPayload = {
    message: {
      subject: payload.subject,
      body: {
        contentType: 'Text',
        content: payload.bodyText,
      },
      toRecipients: payload.recipients.map((r) => ({
        emailAddress: { address: r.address, name: r.name ?? r.address },
      })),
    },
    saveToSentItems: true,
  };

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.meetingEmailSender!)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(graphPayload),
    },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `email: Graph sendMail failed (${resp.status}): ${body.slice(0, 300)}`,
    );
  }

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'email: sent via Graph',
      botId,
      subject: payload.subject,
      recipients: payload.recipients.map((r) => r.address),
    }),
  );
}
