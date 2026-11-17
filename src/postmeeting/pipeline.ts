// Post-meeting pipeline orchestrator.
//
// Runs: artifacts -> summary -> email, in sequence, after returning 200 to Recall.
// Fire-and-forget with caught errors + structured logs.
// Idempotent per botId: a processed-Set + a .data/<botId>.done marker ensure
// duplicate bot.done / bot.call_ended events are no-ops.

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { uploadAudioArtifact } from './artifacts.js';
import { generateSummaryWithReason, type SummaryResult } from './summary.js';
import { writeSummary } from './summary-store.js';
import { getMeeting } from '../meeting/registry.js';
import { meetingPageUrl } from '../routes/meeting-page.js';
import { composeEmail, recapRecipients, sendOrDryRunEmail } from './email.js';
import type { EmailRecipient } from './email.js';
import { ingestToBrain } from './ingest.js';
import { readNotes } from '../meeting/notes.js';
import { readMergedTranscript, renderTranscriptText } from '../meeting/transcript.js';
import { deliverSlack, chunkForSlack } from './slack.js';
import { loadSoul } from '../soul/loader.js';
import { delegateAllowed } from '../soul/owner-gate.js';
import { kbBearerFor } from '../retrieval/kb-bearer.js';
import type { Soul } from '../soul/schema.js';

const DATA_DIR = join(process.cwd(), '.data');

/** BLUF stored when no summary could be generated (the transcript and notes are still stored). */
const SUMMARY_FAILED_BLUF = 'summary generation failed - full transcript preserved';
/** BLUF stored when the model refused the summary request on the first try and on the retry. */
const SUMMARY_REFUSED_BLUF = 'summary unavailable (model refused)';

// In-memory idempotency guard (survives restarts via the .done file on disk).
const processedBots = new Set<string>();

function doneMarkerPath(botId: string): string {
  return join(DATA_DIR, `${botId}.done`);
}

function isAlreadyProcessed(botId: string): boolean {
  if (processedBots.has(botId)) return true;
  return existsSync(doneMarkerPath(botId));
}

function markProcessed(botId: string): void {
  processedBots.add(botId);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(doneMarkerPath(botId), new Date().toISOString(), 'utf8');
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'pipeline: failed to write .done marker',
        botId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export interface PipelineInput {
  botId: string;
  meetingId: string;
  meetingTitle: string;
  recipients?: EmailRecipient[];
  /** Teammate slug whose SOUL drives delivery. Default: config.defaultTeammate. */
  teammate?: string;
  /** SOUL slug to load instead of the teammate's own (e.g. shared 'jarvis'). */
  soulSlug?: string;
}

/**
 * The whole conversation as text for the stored document: what people said (webhook file)
 * interleaved by time with what the bot said (answers and "Say this" lines), the bot's
 * lines labeled with its display name. '' when there is nothing.
 */
function loadTranscriptText(config: Config, botId: string, meetingId: string): string {
  return renderTranscriptText(readMergedTranscript({ meetingId, botId }, config.jarvisBotName));
}

/** A safe default SOUL when the teammate SOUL can't be loaded — email-only, no ingest. */
function defaultDeliverySoul(teammate: string): Soul {
  return {
    owner: teammate,
    name: teammate,
    wakeWord: '',
    personaMode: 'first_person',
    voice: 'marin',
    language: 'en',
    knowledgeBackend: { type: 'openbrain', endpoint: '', route: 'delegate' },
    delivery: ['email'],
    ingest: false,
    deniedTopics: [],
    aiDisclosure: '',
    replyMode: 'voice',
    lookupApproval: 'none',
    brain: 'builtin',
    mode: 'assistant',
    openingLine: '',
    improvise: false,
    prose: '',
  };
}

/**
 * The kb-server bearer for the /store ingest, or undefined. Only David's own
 * delegate SOUL (route 'delegate', owner matches the teammate) may carry it, and
 * only to the kb-server origin (kbBearerFor) — a team (ai) SOUL's endpoint, or any
 * other service named in a SOUL, never sees it.
 */
function ingestBearer(config: Config, soul: Soul, teammate: string): string | undefined {
  if (soul.knowledgeBackend.route !== 'delegate' || !delegateAllowed(soul, teammate)) return undefined;
  return kbBearerFor(config, soul.knowledgeBackend.endpoint);
}

async function runPipelineInternal(config: Config, input: PipelineInput): Promise<void> {
  const { botId, meetingId, meetingTitle, recipients } = input;
  const teammate = input.teammate ?? config.defaultTeammate;
  const soulSlug = input.soulSlug ?? teammate;
  const effectiveRecipients: EmailRecipient[] = recipients?.length
    ? recipients
    : config.meetingEmailDefaultRecipients.map((addr) => ({ address: addr }));

  console.log(
    JSON.stringify({ level: 'info', msg: 'pipeline: start', botId, meetingId }),
  );

  // Phase 2: audio artifact.
  let sasUrl: string | null = null;
  try {
    const artifact = await uploadAudioArtifact(config, botId, meetingId);
    sasUrl = artifact?.sasUrl ?? null;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'pipeline: artifacts phase failed',
        botId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // Non-fatal: continue to summary even without audio link.
  }

  // Phase 3a: summary.
  const { summary: generatedSummary, failure: summaryFailure } = await generateSummaryWithReason(
    config,
    botId,
    meetingId,
  );
  const summary: SummaryResult = generatedSummary ?? {
    bluf: summaryFailure === 'refused' ? SUMMARY_REFUSED_BLUF : SUMMARY_FAILED_BLUF,
    decisions: [],
    actionItems: [],
  };
  if (!generatedSummary) {
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'pipeline: no summary generated, skipping email and continuing non-email lanes',
        botId,
      }),
    );
  }

  // Keep the summary on disk so it can be read later without asking the model again.
  try {
    writeSummary(botId, summary, generatedSummary !== null && generatedSummary !== undefined, DATA_DIR);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'pipeline: failed to store summary',
        botId,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }

  // Phase 4: SOUL-driven delivery. Load the teammate SOUL; on failure log + fall
  // back to an email-only default so a missing/broken SOUL never blocks delivery.
  let soul: Soul;
  try {
    soul = loadSoul(soulSlug, config.soulDir);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'pipeline: SOUL load failed, using email-only default',
        botId,
        soulSlug,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    soul = defaultDeliverySoul(teammate);
  }

  // Each lane is independent + best-effort: one failing does not block the others.
  // A generated summary is required for email, but the failure stub preserves
  // enough context for OpenBrain and Slack to remain valuable and auditable.
  const wantEmail = generatedSummary !== null && soul.delivery.includes('email');
  const wantOb = soul.delivery.includes('ob') || soul.ingest;
  const wantSlack = soul.delivery.includes('slack');
  const transcriptText = loadTranscriptText(config, botId, meetingId);

  // Lane: email.
  if (wantEmail) {
    try {
      // The registry record carries the calendar invite list and the share token. After a
      // restart that lost the record there is no page link and no invitee recap.
      const to = recapRecipients(effectiveRecipients, getMeeting(meetingId)?.attendees, config);
      const payload = composeEmail(meetingTitle, summary, sasUrl, to, meetingPageUrl(config, meetingId));
      await sendOrDryRunEmail(config, botId, payload);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'pipeline: email phase failed',
          botId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Lane: OpenBrain ingest into the teammate's own brain (best-effort, never throws).
  if (wantOb) {
    const result = await ingestToBrain(soul, {
      meetingId,
      title: meetingTitle,
      summary,
      transcriptText,
      date: new Date().toISOString(),
      notes: readNotes(botId),
    }, config.meetingIngestTimeoutMs, ingestBearer(config, soul, teammate));
    console.log(
      JSON.stringify({ level: result.ok ? 'info' : 'warn', msg: 'pipeline: ingest lane', botId, ...result }),
    );
  }

  // Lane: Slack delivery to the owner's own DM (best-effort, never throws).
  // The channel MUST be a real Slack user/channel ID (MEETING_SLACK_CHANNEL); we
  // do NOT fall back to the teammate slug — chat.postMessage to a slug fails or
  // mis-delivers, so skip the lane and warn instead (matches the doctor WARN).
  const slackChannel = config.meetingSlackChannel?.trim() ?? '';
  if (wantSlack && slackChannel === '') {
    console.log(JSON.stringify({ level: 'warn', msg: 'pipeline: slack lane skipped — MEETING_SLACK_CHANNEL unset', botId }));
  } else if (wantSlack) {
    const channel = slackChannel;
    const lines: string[] = [`Meeting notes: ${meetingTitle}`, '', summary.bluf || 'Meeting completed.'];
    if (summary.decisions.length > 0) {
      lines.push('', 'Decisions:');
      for (const d of summary.decisions) lines.push(`- ${d}`);
    }
    if (summary.actionItems.length > 0) {
      lines.push('', 'Action items:');
      for (const item of summary.actionItems) {
        const due = item.due ? ` (due: ${item.due})` : '';
        lines.push(`- ${item.owner}: ${item.task}${due}`);
      }
    }
    const token = config.slackBotToken !== undefined ? { token: config.slackBotToken } : {};
    const result = await deliverSlack({ ...token, channel, text: lines.join('\n') });
    console.log(
      JSON.stringify({ level: result.ok ? 'info' : 'warn', msg: 'pipeline: slack lane (summary)', botId, ...result }),
    );

    // Follow the summary with the FULL transcript, chunked (Slack ~40k/msg cap).
    // Opt-in via MEETING_SLACK_INCLUDE_TRANSCRIPT: default is summary-only in
    // Slack - the durable transcript record lives in OpenBrain.
    if (result.ok && config.meetingSlackIncludeTranscript) {
      const chunks = chunkForSlack(transcriptText);
      for (let i = 0; i < chunks.length; i += 1) {
        const part = await deliverSlack({ ...token, channel, text: `Transcript (${i + 1}/${chunks.length}):\n${chunks[i]}` });
        if (!part.ok) {
          console.log(JSON.stringify({ level: 'warn', msg: 'pipeline: slack lane (transcript chunk)', botId, chunk: i + 1, ...part }));
          break;
        }
      }
    }
  }

  console.log(
    JSON.stringify({ level: 'info', msg: 'pipeline: complete', botId, meetingId }),
  );
}

/**
 * Fire-and-forget entry point.  Returns immediately; pipeline runs in the
 * background.  Safe to call from inside a Hono request handler after c.json().
 */
export function kickoffPipeline(config: Config, input: PipelineInput): void {
  const { botId } = input;

  if (isAlreadyProcessed(botId)) {
    console.log(
      JSON.stringify({ level: 'info', msg: 'pipeline: already processed, no-op', botId }),
    );
    return;
  }

  // Mark immediately to make the guard idempotent even under concurrent events.
  markProcessed(botId);

  runPipelineInternal(config, input).catch((err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'pipeline: unhandled error',
        botId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      }),
    );
  });
}
