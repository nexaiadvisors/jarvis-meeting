// Phase 3a — structured meeting summary via Anthropic.
//
// Reads the bot's .data/<botId>.jsonl transcript, calls config.anthropicModel with
// a structured-output prompt, and returns a typed summary object.
//
// Refusals: the model's safety classifiers can decline a harmless transcript (HTTP 200,
// stop_reason "refusal", no content). When the first answer is a refusal, or has no
// structured output, the request is repeated ONCE on config.anthropicFallbackModel. A
// second failure returns null; the pipeline then keeps a stub BLUF (and says the model
// refused, when it did). Only stop_reason, model and attempt are logged, never text.
//
// Config-gating: if ANTHROPIC_API_KEY is absent, logs NOT_CONFIGURED and
// returns null (skip), never throws.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { readMergedTranscript, renderTranscriptText } from '../meeting/transcript.js';

export interface SummaryResult {
  bluf: string;
  decisions: string[];
  actionItems: { owner: string; task: string; due?: string }[];
}

const DATA_DIR = join(process.cwd(), '.data');

/**
 * A log-safe description of a caught error: its class name and, for an API error, its HTTP
 * status. Never `err.message`: a JSON.parse error quotes the start of the text it could not
 * parse (model output), so the message can carry transcript-derived text.
 */
function errorFields(err: unknown): { error: string; status?: number } {
  const name = err instanceof Error ? err.name : typeof err;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? { error: name, status } : { error: name };
}

function loadTranscript(botId: string, meetingId?: string, botName: string = 'Jarvis'): string {
  if (meetingId) {
    const merged = readMergedTranscript({ meetingId, botId }, botName, DATA_DIR);
    if (merged.length > 0) {
      return renderTranscriptText(merged);
    }
  }
  const file = join(DATA_DIR, `${botId}.jsonl`);
  if (!existsSync(file)) return '';
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map((line) => {
      try {
        const entry = JSON.parse(line) as { speaker?: string; text?: string; timestamp?: string };
        return `[${entry.timestamp ?? ''}] ${entry.speaker ?? 'Unknown'}: ${entry.text ?? ''}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

const SYSTEM_PROMPT = `You are a meeting-notes assistant. Given a meeting transcript, produce a JSON object with exactly these keys:
- bluf: a one-sentence bottom-line-up-front summary of the meeting outcome.
- decisions: an array of strings, each describing a decision made.
- actionItems: an array of objects with keys owner (string), task (string), due (optional string, ISO date or plain phrase).

Respond ONLY with valid JSON. No markdown fences. No commentary. ASCII-only text.`;

/**
 * Keep summary requests bounded without sacrificing the most decision-relevant
 * part of a long meeting: its ending. Ingest retains the full transcript.
 */
function transcriptForSummary(transcript: string, inputCharCap: number): string {
  const cap = Number.isFinite(inputCharCap) ? Math.max(0, Math.floor(inputCharCap)) : 400000;
  if (transcript.length <= cap) return transcript;
  return `[Transcript truncated: retaining the most recent ${cap} characters.]

${transcript.slice(Math.max(0, transcript.length - cap))}`;
}

function parseSummary(raw: string): SummaryResult | null {
  try {
    // Strip markdown code fences if the model added them despite instructions.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const bluf = typeof parsed['bluf'] === 'string' ? parsed['bluf'] : '';
    const decisions = Array.isArray(parsed['decisions'])
      ? (parsed['decisions'] as unknown[]).filter((d) => typeof d === 'string') as string[]
      : [];
    const rawItems = Array.isArray(parsed['actionItems']) ? parsed['actionItems'] : [];
    const actionItems: SummaryResult['actionItems'] = (rawItems as unknown[]).flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const i = item as Record<string, unknown>;
      return [{
        owner: typeof i['owner'] === 'string' ? i['owner'] : 'TBD',
        task: typeof i['task'] === 'string' ? i['task'] : '',
        ...(typeof i['due'] === 'string' ? { due: i['due'] } : {}),
      }];
    });
    return { bluf, decisions, actionItems };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'summary: failed to parse Anthropic response',
        ...errorFields(err),
        chars: raw.length,
      }),
    );
    return null;
  }
}

/** Why no summary was produced. 'refused' = the last attempt ended in stop_reason "refusal". */
export type SummaryFailure = 'not_configured' | 'no_transcript' | 'refused' | 'failed';

export interface SummaryOutcome {
  summary: SummaryResult | null;
  /** Set when `summary` is null. */
  failure?: SummaryFailure;
}

type Attempt =
  | { kind: 'ok'; summary: SummaryResult }
  | { kind: 'refused' }
  | { kind: 'no_output' }
  | { kind: 'error' };

/** One request to `model`. Never throws; never logs transcript text. */
async function attemptSummary(
  client: Anthropic,
  model: string,
  config: Config,
  botId: string,
  summaryTranscript: string,
  attempt: number,
): Promise<Attempt> {
  try {
    const message = await client.messages.create({
      model,
      max_tokens: config.meetingSummaryMaxTokens,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Meeting transcript:\n\n${summaryTranscript}`,
        },
      ],
    });

    // A refusal is a normal HTTP 200; branch on stop_reason before reading content.
    if (message.stop_reason === 'refusal') {
      console.warn(
        JSON.stringify({ level: 'warn', msg: 'summary: model refused', botId, model, stop_reason: message.stop_reason, attempt }),
      );
      return { kind: 'refused' };
    }

    const textBlock = message.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      console.error(
        JSON.stringify({ level: 'error', msg: 'summary: Anthropic returned no text block', botId, model, stop_reason: message.stop_reason ?? null, attempt }),
      );
      return { kind: 'no_output' };
    }

    const result = parseSummary(textBlock.text);
    if (!result) return { kind: 'no_output' };

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'summary: generated',
        botId,
        model,
        attempt,
        decisions: result.decisions.length,
        actionItems: result.actionItems.length,
      }),
    );
    return { kind: 'ok', summary: result };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'summary: Anthropic call failed',
        botId,
        model,
        attempt,
        ...errorFields(err),
      }),
    );
    return { kind: 'error' };
  }
}

/**
 * Summarize a meeting and say why it could not be done. At most two requests: the
 * configured model, then ONE retry on the fallback model when the first answer was a
 * refusal or carried no structured output. A request that throws is not retried (the
 * SDK already retries transient errors). Never throws.
 */
export async function generateSummaryWithReason(
  config: Config,
  botId: string,
  meetingId?: string,
): Promise<SummaryOutcome> {
  if (!config.anthropicApiKey) {
    console.log(
      JSON.stringify({ level: 'warn', msg: 'summary: NOT_CONFIGURED (no ANTHROPIC_API_KEY), skipping', botId }),
    );
    return { summary: null, failure: 'not_configured' };
  }

  const transcript = loadTranscript(botId, meetingId, config.jarvisBotName);
  if (!transcript.trim()) {
    console.log(
      JSON.stringify({ level: 'warn', msg: 'summary: transcript empty, skipping', botId }),
    );
    return { summary: null, failure: 'no_transcript' };
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const summaryTranscript = transcriptForSummary(transcript, config.meetingSummaryInputCharCap);

  const first = await attemptSummary(client, config.anthropicModel, config, botId, summaryTranscript, 1);
  if (first.kind === 'ok') return { summary: first.summary };
  if (first.kind === 'error') return { summary: null, failure: 'failed' };

  const second = await attemptSummary(client, config.anthropicFallbackModel, config, botId, summaryTranscript, 2);
  if (second.kind === 'ok') return { summary: second.summary };
  return { summary: null, failure: second.kind === 'refused' ? 'refused' : 'failed' };
}

export async function generateSummary(
  config: Config,
  botId: string,
  meetingId?: string,
): Promise<SummaryResult | null> {
  return (await generateSummaryWithReason(config, botId, meetingId)).summary;
}
