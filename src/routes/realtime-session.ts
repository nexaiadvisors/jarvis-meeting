// POST /api/meetings/:id/realtime-session
//
// Server-side standalone replacement for the DB-backed dashboard route. Sources
// the persona from a file SOUL (not a meetings/meeting_agents join), applies the
// owner gate, and mints the SessionConfig the agent page expects. create_response
// is false (the page's wake gate is the only thing that triggers speech).

import { getActiveAvatarProvider } from '../avatar/providers.js';
import { Hono } from 'hono';
import {
  selectToolDefs,
  buildRealtimeInstructions,
  resolveProviderConfig,
  resolveRealtimeWsBase,
  resolveRealtimeVoice,
  resolveWakeWord,
} from '../agent/realtime-config.js';
import { DEFAULT_ENGAGEMENT_WINDOW_MS } from '../agent/wake-gate.js';
import { buildFacilitatorInstructions, LOOK_AT_SCREEN_TOOL, STAY_QUIET_TOOL_DEF } from '../agent/facilitator.js';
import { buildStandInInstructions, defaultOpeningLine, loadStandInBriefing } from '../agent/stand-in.js';
import { LOOKUP_APPROVAL_INSTRUCTION } from '../agent/system-prompt.js';
import { parseRetrievalMode } from '../agent/answer-route.js';
import type { MeetingAgent } from '../agent/types.js';
import { getMeeting } from '../meeting/registry.js';
import { loadSoul } from '../soul/loader.js';
import { isDelegatePersona, delegateAllowed, DELEGATE_OWNER_REQUIRED } from '../soul/owner-gate.js';
import type { Soul } from '../soul/schema.js';
import type { Config } from '../config.js';
import { extractBearerToken, verifyMeetingSessionToken } from './session-token.js';

const PROVIDER_CLIENT_SECRET_TTL_SECONDS = 600;

/**
 * Build a MeetingAgent-shaped object from a SOUL so the ported realtime-config
 * helpers (buildRealtimeInstructions, selectToolDefs, resolveWakeWord) work
 * unchanged. behavior_mode is 'team' for the team (ai) persona and 'delegate'
 * for first_person — buildRealtimeInstructions keys its addendum off
 * persona_mode, so behavior_mode only feeds the subtitle/agent block.
 */
function soulToAgent(soul: Soul, researcher: boolean, delegate: boolean, buzz: boolean): MeetingAgent {
  return {
    knowledge_mode: researcher ? 'researcher' : 'direct',
    // Only the owner's own first-person persona hands work to his Claude Code.
    delegate_tasks: delegate && soul.personaMode === 'first_person',
    buzz_messaging: buzz && soul.personaMode === 'first_person',
    id: soul.owner,
    name: soul.name,
    role: '',
    behavior_mode: soul.personaMode === 'ai' ? 'team' : 'delegate',
    speaking_style: null,
    persona_mode: soul.personaMode,
    voice_id: soul.voice,
    confidence_threshold: 0,
    allowed_topics: null,
    denied_topics: soul.deniedTopics,
    escalation_rules: {},
    wake_word: soul.wakeWord,
    created_at: '',
    updated_at: '',
  };
}

async function mintRealtimeClientSecret(
  providerConfig: NonNullable<ReturnType<typeof resolveProviderConfig>>,
  sessionUpdate: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(providerConfig.tokenUrl, {
    method: 'POST',
    headers: {
      ...providerConfig.tokenHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: PROVIDER_CLIENT_SECRET_TTL_SECONDS },
      session: { ...sessionUpdate, model: providerConfig.model },
    }),
  });

  if (!response.ok) {
    throw new Error(`client secret mint failed (${response.status})`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body['value'] === 'string' && body['value'].trim() !== '') {
    return body['value'];
  }

  const nested = body['client_secret'];
  const nestedValue =
    nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>)['value']
      : undefined;
  if (
    typeof nestedValue === 'string' &&
    nestedValue.trim() !== ''
  ) {
    return nestedValue;
  }

  throw new Error('client secret mint response missing value');
}

/** The owner slug as a spoken name: "david" -> "David". */
function standInOwnerName(owner: string): string {
  const o = owner.trim();
  return o === '' ? 'the owner' : o.charAt(0).toUpperCase() + o.slice(1);
}

export function createRealtimeSessionRoute(config: Config): Hono {
  const app = new Hono();

  app.post('/api/meetings/:id/realtime-session', async (c) => {
    const id = c.req.param('id');
    const sessionToken = extractBearerToken(c.req.header('authorization'));
    if (!sessionToken) {
      return c.json({ error: 'unauthorized', code: 'unauthorized' }, 401);
    }

    const meeting = getMeeting(id);
    if (!meeting) {
      return c.json({ error: 'Meeting not found', code: 'not_found' }, 404);
    }
    if (!verifyMeetingSessionToken(config, sessionToken, { meetingId: id, teammate: meeting.teammate })) {
      return c.json({ error: 'unauthorized', code: 'unauthorized' }, 401);
    }
    // A reconnect must never revive a completed/failed meeting. Enforce the
    // lifecycle at mint time as well as in the browser frame so a status change
    // during the frame's polling gap cannot issue a fresh realtime session.
    // (After the token check so unauthenticated callers learn nothing.)
    if (meeting.status !== 'live') {
      return c.json({ error: 'Meeting is no longer live', code: 'meeting_not_live', status: meeting.status }, 409);
    }

    let soul: Soul;
    try {
      // The SOUL chosen at join (dispatch `soul`), else the teammate's own. Loading the
      // teammate's own here made a meeting joined as another persona speak as the teammate.
      soul = loadSoul(meeting.soulSlug ?? meeting.teammate, config.soulDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, code: 'soul_load_failed' }, 500);
    }

    // Owner gate (Gate 1): a first_person Delegate can only start on the owner's
    // deployment, for the owner's own teammate. Fails closed.
    if (isDelegatePersona(soul.personaMode) && !delegateAllowed(soul, meeting.teammate)) {
      return c.json(DELEGATE_OWNER_REQUIRED, 403);
    }

    const wsBase = resolveRealtimeWsBase();
    if (!wsBase) {
      return c.json(
        {
          error: 'No realtime provider configured. Set OPENAI_API_KEY.',
          code: 'missing_api_key',
        },
        503,
      );
    }

    const { provider, model } = wsBase;
    // The persona's own voice (SOUL `voice`). It was read from the SOUL but never used:
    // every persona spoke with the service default. OPENAI_REALTIME_VOICE still overrides
    // it for the whole service when set.
    const voice = process.env['OPENAI_REALTIME_VOICE']?.trim() || soul.voice?.trim() || resolveRealtimeVoice();
    const agent = soulToAgent(soul, config.researcherEnabled === true && Boolean(config.anthropicApiKey), config.delegateEnabled === true, Boolean(config.buzzBin && config.buzzPrivateKey && config.buzzRelayUrl));
    const providerConfig = resolveProviderConfig(agent);
    if (!providerConfig) {
      return c.json(
        {
          error: 'No realtime provider configured. Set OPENAI_API_KEY.',
          code: 'missing_api_key',
        },
        503,
      );
    }

    // Instructions = ported meeting prompt + the SOUL's prose persona + the
    // AI-disclosure line (the SOUL is the persona source here, not the DB).
    // A facilitator leads the call, so it gets its own base rules. The assistant prompt
    // ("answer and stop, never continue unprompted") would contradict the persona.
    // A stand-in speaks in the owner's place. On the page it takes turns the way a
    // facilitator does (hears every turn, may stay quiet), but it never leads.
    const standIn = soul.mode === 'stand_in';
    const facilitator = soul.mode === 'facilitator' || standIn;
    const ownerName = standInOwnerName(soul.owner);
    const openingLine = soul.openingLine || defaultOpeningLine(ownerName);
    const baseInstructions = standIn
      ? buildStandInInstructions({
          name: soul.name,
          ownerName,
          title: meeting.title,
          openingLine,
          briefing: loadStandInBriefing(config.soulDir, meeting.soulSlug ?? meeting.teammate),
          improvise: soul.improvise,
        })
      : facilitator
        ? buildFacilitatorInstructions({ name: soul.name, title: meeting.title, canSeeScreen: meeting.screenShare === true })
        : buildRealtimeInstructions({ title: meeting.title }, agent);
    const personaParts = [baseInstructions];
    if (soul.prose) personaParts.push('', soul.prose);
    if (soul.aiDisclosure) personaParts.push('', soul.aiDisclosure);
    if (!facilitator && soul.lookupApproval === 'ask') personaParts.push('', LOOKUP_APPROVAL_INSTRUCTION);
    const instructions = personaParts.join('\n');

    const vadMode = (process.env['MEETING_VAD_MODE'] ?? 'semantic_vad').trim().toLowerCase();
    const useServerVad = vadMode === 'server_vad';
    const vocabTerms = Array.from(
      new Set(
        [soul.name, soul.wakeWord, 'Jarvis', 'OpenBrain', ...(process.env['MEETING_VOCAB_TERMS'] ?? '').split(',')]
          .map((t) => t?.trim())
          .filter((t): t is string => Boolean(t)),
      ),
    ).join(', ');

    const sessionUpdate = {
      type: 'realtime',
      instructions,
      // A facilitator has a way to say nothing this turn, and, in a meeting joined with
      // screen viewing on, the tool that looks at the shared screen.
      tools: facilitator
        ? [STAY_QUIET_TOOL_DEF, ...(meeting.screenShare === true ? selectToolDefs(agent).filter((t) => t.name === LOOK_AT_SCREEN_TOOL) : [])]
        : selectToolDefs(agent),
      tool_choice: 'auto',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: {
            model: 'gpt-4o-mini-transcribe',
            prompt: vocabTerms,
          },
          turn_detection: useServerVad
            ? {
                type: 'server_vad',
                silence_duration_ms: 900,
                create_response: false,
                interrupt_response: false,
              }
            : {
                type: 'semantic_vad',
                eagerness: 'medium',
                create_response: false,
                // interrupt_response MUST stay false: VAD fires on ANY speech
                // (incl. room/background noise), and true auto-cancels the
                // in-flight answer on every onset. The client owns barge-in at
                // the TRANSCRIPTION level instead.
                interrupt_response: false,
              },
        },
        output: { voice, format: { type: 'audio/pcm', rate: 24000 } },
      },
    };

    // The browser authenticates the WebSocket with the short-lived ephemeral
    // secret over the subprotocol, so the long-lived OPENAI_API_KEY never
    // reaches it and no credential is placed in the URL.
    let providerClientSecret: string;
    try {
      providerClientSecret = await mintRealtimeClientSecret(providerConfig, sessionUpdate);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'realtime-session: client secret mint failed',
          provider,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return c.json({ error: 'Realtime provider token mint failed', code: 'provider_token_failed' }, 502);
    }
    const wsUrl = wsBase.wsUrl;
    // OpenAI Realtime GA WebSocket uses ['realtime', 'openai-insecure-api-key.<secret>'].
    // Do NOT include 'openai-beta.realtime-v1' — OpenAI disabled the Beta API shape
    // and closes the socket with code=4000 (invalid_request_error.beta_api_shape_disabled).
    const wsProtocols = [
      'realtime',
      `openai-insecure-api-key.${providerClientSecret}`,
    ];

    return c.json({
      transport: 'websocket',
      provider,
      model,
      voice,
      wsUrl,
      wsProtocols,
      sessionUpdate,
      // NOTE: participantCount is deliberately NOT included here. It changes as
      // people join/leave mid-meeting (registry rises 1->4->5 via
      // participant_events), so a one-time value minted at session start would be
      // ~1 (before anyone joins) and would wrongly treat a full room as a 1:1. The
      // agent page sources the LIVE count from the GET /api/meetings/:id lifecycle
      // poll (registry.participantCount + 1 for the bot) and keeps the wake gate's
      // participantCount fresh on every poll. See web/agent-frame/main.tsx.
      meeting: { id: meeting.meetingId, title: meeting.title },
      // Wake-triggered manual commit: when true (default), the page detects an
      // addressed complete question from streaming partial transcripts and
      // force-commits the input buffer instead of waiting for VAD silence, so a
      // noisy room can't block a wake-worded ask. Env-revertible to the pure
      // silence-gated behavior via MEETING_WAKE_COMMIT=false.
      wakeCommit: (process.env['MEETING_WAKE_COMMIT'] ?? 'true').toLowerCase() !== 'false',
      // How answers are grounded. 'model' (default): the agent answers at once and calls
      // its search tool when a question is about the work notes. 'forced': a notes search
      // runs before every answer (the behavior before 2026-11-14). MEETING_RETRIEVAL_MODE.
      retrievalMode: parseRetrievalMode(process.env['MEETING_RETRIEVAL_MODE']),
      agent: {
        knowledgeMode: agent.knowledge_mode === 'researcher' ? 'researcher' : 'direct',
        delegateTasks: agent.delegate_tasks === true,
        buzzMessaging: agent.buzz_messaging === true,
        name: soul.name,
        wakeWord: resolveWakeWord(agent) || soul.wakeWord,
        behaviorMode: agent.behavior_mode,
        personaMode: soul.personaMode,
        replyMode: soul.replyMode,
        // Sent with the session so the tile never shows the wrong avatar first.
        avatarProvider: getActiveAvatarProvider(),
        notesOnly: meeting.notesOnly === true,
        // A facilitator is always answered by the built-in voice model.
        brain: facilitator ? 'builtin' : soul.brain,
        facilitator,
        ...(standIn ? { standIn: true, openingLine } : {}),
        subtitle:
          standIn
            ? `${soul.name} - AI speaking for ${ownerName}`
            : facilitator
            ? `${soul.name} - AI session lead`
            : soul.personaMode === 'ai'
              ? `${soul.name} - AI meeting assistant`
              : soul.aiDisclosure,
      },
      engagementWindowMs: DEFAULT_ENGAGEMENT_WINDOW_MS,
    });
  });

  return app;
}
