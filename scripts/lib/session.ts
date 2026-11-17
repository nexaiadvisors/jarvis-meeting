// One text conversation with the meeting agent, without a meeting. Shared by
// scripts/converse.ts (talk to it) and scripts/eval.ts (score it).
//
// What is real: the instructions, the tool list and the session settings come from the
// same route the bot's page calls (POST /api/meetings/:id/realtime-session); the answer
// routing is src/agent/answer-route.ts; tool calls go to the same /api/voice/* routes;
// the model is the same OpenAI realtime model. What is not covered: audio in and out,
// speech recognition, the wake-word gate, and barge-in.

import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { adjustParticipantCount, recordParticipantIdentity, registerMeeting } from '../../src/meeting/registry.js';
import { loadSoul } from '../../src/soul/loader.js';
import { mintMeetingSessionToken } from '../../src/routes/session-token.js';
import {
  ANSWER_DIRECTLY_TOOL,
  chooseAnswerRoute,
  decisionResponseEvent,
  directAnswerEvent,
  parseRetrievalMode,
  shouldInjectLookup,
  type AnswerRoute,
  type RetrievalMode,
} from '../../src/agent/answer-route.js';
import {
  ASK_RESEARCHER_TOOL,
  CASUAL_TURN_DIRECTIVE,
  STATUS_QUERY_EXPANSION,
  formatRetrievalForInjection,
  isDayScopedQuestion,
  isStatusQuestion,
  selectToolRoutes,
} from '../../src/agent/realtime-config.js';
import { RESEARCHER_STARTED_OUTPUT, researcherAnswerDirective } from '../../src/agent/researcher-turn.js';
import { buildSearchQuery, type RecentTurn } from '../../src/agent/query-context.js';
import { DEFAULT_WAKE_ALIASES, stripWakeWords } from '../../src/agent/wake-gate.js';
import { toolOutputFor } from '../../web/agent-frame/commands.js';
import { recordOwnerUtterance } from '../../src/buzz/confirm.js';
import { commandsAfter } from '../../src/meeting/commands.js';

export interface TurnTool {
  name: string;
  query?: string;
  results?: number;
}

export interface Turn {
  question: string;
  route: AnswerRoute;
  tools: TurnTool[];
  firstTextMs: number | null;
  totalMs: number;
  answer: string;
  errors: string[];
}

export interface Session {
  model: string;
  mode: RetrievalMode;
  persona: string;
  knowledgeMode: 'researcher' | 'direct';
  ask: (question: string) => Promise<Turn>;
  /** POST to a service route as this meeting's page would. */
  post: (path: string, body: Record<string, unknown>) => Promise<Response>;
  close: () => void;
}

const PRESENCE_DIRECTIVE =
  'The user is just checking you are present. Reply with one brief sentence confirming you are here and listening — nothing else.';

let sessionSeq = 0;

export async function openSession(opts: { alone: boolean; mode?: RetrievalMode }): Promise<Session> {
  const config = loadConfig();
  const app = createApp(config);
  const teammate = config.defaultTeammate;
  const soul = loadSoul(teammate, config.soulDir);
  sessionSeq += 1;
  const meetingId = `converse-${Date.now()}-${sessionSeq}`;
  registerMeeting({ meetingId, teammate, persona: soul.personaMode, title: 'Text conversation test' });
  if (opts.alone) {
    // What the webhook records when the owner joins as the host and nobody else does.
    const ownerName = config.ownerParticipantNames?.[0];
    if (!ownerName) throw new Error('alone needs OWNER_PARTICIPANT_NAMES to be set');
    adjustParticipantCount(meetingId, +1);
    recordParticipantIdentity(meetingId, { id: 'owner', name: ownerName, isHost: true }, { ownerNames: config.ownerParticipantNames ?? [], botName: config.jarvisBotName });
  }
  const auth = { Authorization: `Bearer ${mintMeetingSessionToken(config, { meetingId, teammate, ttlMs: 3_600_000 })}` };
  const post = (path: string, body: Record<string, unknown>): Promise<Response> =>
    Promise.resolve(
      app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ ...body, meetingId }) })),
    );

  // The same call the bot's page makes on load.
  const sessionRes = await post(`/api/meetings/${meetingId}/realtime-session`, {});
  if (!sessionRes.ok) throw new Error(`realtime-session failed: HTTP ${sessionRes.status} ${(await sessionRes.text()).slice(0, 200)}`);
  const session = (await sessionRes.json()) as {
    wsUrl: string;
    wsProtocols: string[];
    sessionUpdate: Record<string, unknown>;
    model: string;
    retrievalMode?: string;
    agent: { wakeWord: string; personaMode: string; knowledgeMode?: string; delegateTasks?: boolean; buzzMessaging?: boolean };
  };
  const mode: RetrievalMode = opts.mode ?? parseRetrievalMode(session.retrievalMode);
  const persona = session.agent.personaMode;
  const knowledgeMode = session.agent.knowledgeMode === 'researcher' ? 'researcher' : 'direct';
  const wakeWord = session.agent.wakeWord;
  // The page derives aliases for a "jarvis" wake word; other wake words have none.
  const aliases = wakeWord.trim().toLowerCase() === 'jarvis' ? DEFAULT_WAKE_ALIASES : [];
  const toolRoutes = selectToolRoutes({ persona_mode: persona, knowledge_mode: knowledgeMode, delegate_tasks: session.agent.delegateTasks === true, buzz_messaging: session.agent.buzzMessaging === true });

  const ws = new WebSocket(session.wsUrl, session.wsProtocols);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('realtime websocket failed to open')), { once: true });
  });
  const send = (event: Record<string, unknown>): void => ws.send(JSON.stringify(event));
  send({ type: 'session.update', session: session.sessionUpdate });
  const systemText = (text: string): void =>
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
  // Text out only: this harness has no audio path.
  const textOnly = (event: Record<string, unknown>): Record<string, unknown> => ({
    ...event,
    response: { ...((event['response'] as Record<string, unknown> | undefined) ?? {}), output_modalities: ['text'] },
  });
  const respond = (): void => send(textOnly({ type: 'response.create' }));
  const sessionTools = Array.isArray(session.sessionUpdate['tools']) ? (session.sessionUpdate['tools'] as unknown[]) : [];

  let current: Turn | null = null;
  let startedAt = 0;
  let done: (() => void) | null = null;
  let pendingCalls = 0;

  ws.addEventListener('message', (message) => {
    const event = JSON.parse(String((message as MessageEvent).data)) as Record<string, any>;
    if (!current) return;
    const turn = current;
    switch (event['type']) {
      case 'response.output_text.delta':
      case 'response.text.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (turn.firstTextMs === null) turn.firstTextMs = Date.now() - startedAt;
        turn.answer += String(event['delta'] ?? '');
        break;
      case 'response.function_call_arguments.done': {
        pendingCalls += 1;
        const name = String(event['name'] ?? '');
        const callId = String(event['call_id'] ?? '');
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(event['arguments'] ?? '{}')) as Record<string, unknown>;
        } catch {
          // leave empty
        }
        const output = (value: unknown): void =>
          send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(value) } });
        if (name === ANSWER_DIRECTLY_TOOL) {
          // Same as the page: close the call, then let the model speak with tools off.
          turn.tools.push({ name: 'answer_directly' });
          output({ ok: true });
          pendingCalls -= 1;
          if (pendingCalls === 0) send(textOnly(directAnswerEvent()));
          break;
        }
        if (name === ASK_RESEARCHER_TOOL && toolRoutes[name]) {
          // Same as the page: close the call at once, then speak the answer when it lands.
          // (The page also says a short line while it waits; text has no need for one.)
          const question = typeof args['question'] === 'string' ? args['question'] : '';
          output(RESEARCHER_STARTED_OUTPUT);
          void (async () => {
            const res = await post(toolRoutes[name]!.path, { question, personaMode: persona });
            const body = toolOutputFor(toolRoutes[name]!.path, res.status, await res.json().catch(() => null));
            turn.tools.push({ name, query: question });
            for (const inner of Array.isArray(body['tool_calls']) ? (body['tool_calls'] as unknown[]) : []) {
              turn.tools.push({ name: `researcher:${String(inner)}` });
            }
            systemText(researcherAnswerDirective(question, body));
            pendingCalls -= 1;
            if (pendingCalls === 0) send(textOnly(directAnswerEvent()));
          })();
          break;
        }
        void (async () => {
          const route = toolRoutes[name];
          let result: Record<string, unknown>;
          if (!route) {
            result = { error: `Unknown tool: ${name}` };
          } else {
            const res = await post(route.path, { ...route.body(args), personaMode: persona });
            result = toolOutputFor(route.path, res.status, await res.json().catch(() => null));
          }
          const results = Array.isArray(result['results']) ? result['results'].length : undefined;
          turn.tools.push({
            name,
            ...(typeof args['query'] === 'string' ? { query: args['query'] } : {}),
            ...(results !== undefined ? { results } : {}),
          });
          // In a call the page speaks a queued read-back and reports what it said. There is
          // no page here, so the newest queued line is reported as spoken.
          if (name === 'draft_buzz_message' && result['drafted'] === true) {
            const queued = commandsAfter(meetingId, 0).map((q) => q.command).filter((cmd) => cmd.type === 'say');
            const last = queued[queued.length - 1];
            if (last && last.type === 'say') await post('/api/voice/spoken', { text: last.text, personaMode: persona });
          }
          output(result);
          pendingCalls -= 1;
          if (pendingCalls === 0) respond();
        })();
        break;
      }
      case 'response.done': {
        const outputs = (event['response']?.['output'] ?? []) as { type?: string }[];
        const calledTool = outputs.some((o) => o.type === 'function_call');
        if (event['response']?.['status'] && event['response']['status'] !== 'completed') {
          turn.errors.push(`response ${String(event['response']['status'])}: ${JSON.stringify(event['response']['status_details'] ?? {}).slice(0, 200)}`);
        }
        // A response that only called tools is followed by another one with the answer.
        if (!calledTool) done?.();
        break;
      }
      case 'error':
        turn.errors.push(JSON.stringify(event['error'] ?? event).slice(0, 300));
        break;
      default:
        break;
    }
  });

  const recentTurns: RecentTurn[] = [];
  const ask = async (question: string): Promise<Turn> => {
    const route = chooseAnswerRoute(question, {
      wakeWord,
      aliases,
      mode,
      hasPrefetchedResults: false,
      meetingScoped: false,
      researcher: knowledgeMode === 'researcher',
    });
    const turn: Turn = { question, route, tools: [], firstTextMs: null, totalMs: 0, answer: '', errors: [] };
    // In a call the service hears the owner through Recall. Here the typed line stands in
    // for that, so a spoken "yes" can confirm a Buzz send in a text test.
    if (opts.alone) recordOwnerUtterance(meetingId, question);
    current = turn;
    pendingCalls = 0;
    startedAt = Date.now();
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } });
    if (route === 'presence') systemText(PRESENCE_DIRECTIVE);
    if (route === 'casual') systemText(CASUAL_TURN_DIRECTIVE);
    if (route === 'lookup_first') {
      // The same query the page builds: wake word and filler removed, recent turns for
      // context, status questions widened; and the same result limits.
      const built = buildSearchQuery(question, recentTurns, { wakeWord, aliases }).query;
      const base = built.trim().length > 0 ? built : stripWakeWords(question, wakeWord, aliases);
      const query = isStatusQuestion(question) ? `${base} ${STATUS_QUERY_EXPANSION}` : base;
      const limit = isDayScopedQuestion(question) ? 40 : isStatusQuestion(question) ? 10 : 6;
      const res = await post('/api/voice/ob-search', { query, limit, scope: 'work', personaMode: persona, timeoutMs: 2500 });
      const data = (res.ok ? await res.json() : { results: [] }) as { results?: unknown[] };
      const results = Array.isArray(data.results) ? data.results : [];
      turn.tools.push({ name: '(lookup first)', query, results: results.length });
      if (shouldInjectLookup(mode, results.length)) {
        systemText(formatRetrievalForInjection(question, results as Parameters<typeof formatRetrievalForInjection>[1], persona));
      }
    }
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    if (route === 'model') send(decisionResponseEvent(sessionTools));
    else respond();
    await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, 60_000))]);
    turn.totalMs = Date.now() - startedAt;
    if (turn.answer.trim() === '' && turn.errors.length === 0) turn.errors.push('no answer within 60 s');
    current = null;
    recentTurns.push({ speaker: 'user', text: question, isAgent: false });
    if (turn.answer.trim() !== '') recentTurns.push({ speaker: 'Jarvis', text: turn.answer.trim(), isAgent: true });
    return turn;
  };

  return { model: session.model, mode, persona, knowledgeMode, ask, post, close: () => ws.close() };
}
