// `jarvis-meeting onboard` — guided fresh setup for a teammate.
//
// A colleague's coding agent runs this to go from nothing to dispatch-ready:
//   1. env preflight — report which keys are set / missing, with fill guidance
//   2. brain detection — probe an existing second-brain /search (e.g. OpenBrain);
//      if none, fall back to the folder-of-docs connector (the default brain)
//   3. interview — bot name (= wake word = display name), persona, role/goals
//      (-> SOUL prose), denied topics, optional Slack transcript delivery
//   4. write the SOUL.md + patch .env.local (JARVIS_BOT_NAME, the knowledge
//      endpoint for the chosen persona's route, Slack token + self-DM channel)
//
// The POLICY is pure functions (envChecklist / buildSoulDoc / envPatchForAnswers
// / upsertEnv / brainProbeVerdict) so onboarding decisions are unit-testable
// without prompting or a live brain. cmdOnboard is the thin interactive shell.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as yaml from 'js-yaml';
import { SoulFrontMatter, type PersonaMode, type KbType } from '../soul/schema.js';
import { soulPath } from '../soul/loader.js';
import { ENV_TEMPLATE } from './setup.js';

// --------------------------------------------------------------------------
// Env preflight
// --------------------------------------------------------------------------

export type EnvTier = 'required' | 'realtime' | 'feature';
export type EnvStatus = 'set' | 'missing';

export interface EnvCheckItem {
  key: string;
  tier: EnvTier;
  status: EnvStatus;
  hint: string;
}

type EnvMap = Record<string, string | undefined>;

function isSet(env: EnvMap, key: string): boolean {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Categorized env checklist for a fresh setup. `required` keys block any
 * meeting; `realtime` is satisfied by an OpenAI key; `feature` keys unlock
 * optional post-meeting lanes (summary/ingest, Slack).
 * PUBLIC_BASE_URL is intentionally NOT flagged here — `up`/ngrok resolves it at
 * boot — so onboarding doesn't nag about a value that is set at launch.
 */
export function envChecklist(env: EnvMap): EnvCheckItem[] {
  const items: EnvCheckItem[] = [];

  items.push({
    key: 'RECALL_API_KEY',
    tier: 'required',
    status: isSet(env, 'RECALL_API_KEY') ? 'set' : 'missing',
    hint: 'Recall.ai API key (region-bound — set RECALL_API_BASE to match, e.g. us-west-2).',
  });

  items.push({
    key: 'OPENAI_API_KEY',
    tier: 'realtime',
    status: isSet(env, 'OPENAI_API_KEY') ? 'set' : 'missing',
    hint: 'Realtime voice (gpt-realtime-mini).',
  });

  items.push({
    key: 'ANTHROPIC_API_KEY',
    tier: 'feature',
    status: isSet(env, 'ANTHROPIC_API_KEY') ? 'set' : 'missing',
    hint: 'Post-meeting AI summary + transcript ingest. Without it, no summary and no auto-ingest (in-meeting Q&A still works).',
  });

  const slackReady = isSet(env, 'SLACK_BOT_TOKEN') && isSet(env, 'MEETING_SLACK_CHANNEL');
  items.push({
    key: 'SLACK_BOT_TOKEN + MEETING_SLACK_CHANNEL',
    tier: 'feature',
    status: slackReady ? 'set' : 'missing',
    hint: 'Post-meeting Slack delivery (summary + transcript) to your own DM. Channel = your Slack user ID.',
  });

  return items;
}

export function formatEnvChecklist(items: EnvCheckItem[]): string {
  const icon = (s: EnvStatus): string => (s === 'set' ? '[set]' : '[MISSING]');
  const lines = items.map((i) => `${icon(i.status)} (${i.tier}) ${i.key}\n        ${i.hint}`);
  const missingRequired = items.filter((i) => i.tier === 'required' && i.status === 'missing').length;
  const missingRealtime = items.some((i) => i.tier === 'realtime' && i.status === 'missing');
  lines.push('');
  if (missingRequired > 0 || missingRealtime) {
    lines.push('-> Fill the MISSING required + realtime keys in .env.local before a meeting can run.');
  } else {
    lines.push('-> Required + realtime keys are set. Missing feature keys only disable optional lanes.');
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Brain detection
// --------------------------------------------------------------------------

export interface BrainVerdict {
  status: 'reachable' | 'unreachable' | 'none';
  message: string;
}

/** Pure verdict from a probe outcome, so the decision is testable without fetch. */
export function brainProbeVerdict(endpoint: string | undefined, healthzOk: boolean | undefined): BrainVerdict {
  if (!endpoint || endpoint.trim() === '') {
    return { status: 'none', message: 'no brain endpoint given — will set up a folder-of-docs brain' };
  }
  if (healthzOk === true) {
    return { status: 'reachable', message: `brain reachable at ${endpoint}` };
  }
  return { status: 'unreachable', message: `no /healthz or /search at ${endpoint} — start your connector or use the folder fallback` };
}

/** Probe a connector: GET /healthz, else POST /search ping. Never throws. */
export async function probeBrain(endpoint: string): Promise<boolean> {
  const base = endpoint.replace(/\/+$/, '');
  const tryOne = async (url: string, init: RequestInit): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  if (await tryOne(`${base}/healthz`, { method: 'GET' })) return true;
  return tryOne(`${base}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'ping', k: 1 }),
  });
}

// --------------------------------------------------------------------------
// SOUL + env synthesis from interview answers
// --------------------------------------------------------------------------

export interface OnboardAnswers {
  /** Bot name = display name = wake word. Must be distinct per person. */
  botName: string;
  /** 'ai' = generic team assistant (route jarvis); 'first_person' = your delegate (route delegate). */
  persona: PersonaMode;
  /** Owner slug (teammate). */
  owner: string;
  /** One-liner role, e.g. "Staff engineer on the data platform". */
  role?: string;
  /** Free-text work goals / what it should help with. */
  goals?: string;
  deniedTopics?: string[];
  /** The brain's base URL (connector). Empty => folder fallback to be wired later. */
  knowledgeEndpoint?: string;
  /** Backend kind for the generated SOUL (labels the knowledge_backend). */
  backendType?: KbType;
  /** Send the transcript to Slack after the meeting. */
  slack?: boolean;
  ingest?: boolean;
}

/** Build the validated SOUL front-matter + prose body from interview answers. */
export function buildSoulDoc(a: OnboardAnswers): { frontMatter: Record<string, unknown>; prose: string } {
  const overrides: Record<string, unknown> = {
    owner: a.owner,
    name: a.botName,
    wake_word: a.botName,
    persona_mode: a.persona,
    knowledge_backend: { type: a.backendType ?? 'openbrain', endpoint: a.knowledgeEndpoint ?? '' },
    delivery: a.slack ? ['ob', 'slack'] : ['ob'],
    ingest: a.ingest ?? true,
    denied_topics: a.deniedTopics ?? [],
    ai_disclosure: a.persona === 'ai' ? `${a.botName} - AI meeting assistant` : '',
  };
  const frontMatter = SoulFrontMatter.parse(overrides) as unknown as Record<string, unknown>;
  return { frontMatter, prose: buildProse(a) };
}

function buildProse(a: OnboardAnswers): string {
  const role = a.role && a.role.trim() !== '' ? a.role.trim() : '';
  const goals = a.goals && a.goals.trim() !== '' ? a.goals.trim() : '';
  if (a.persona === 'ai') {
    const ctx = [role && `The team's focus: ${role}.`, goals && `Help the team with: ${goals}.`].filter(Boolean).join(' ');
    return [
      `You are ${a.botName}, a generic AI meeting assistant for the team. You are not any one person — speak as an assistant in the third person, never in the first person as a team member.`,
      ctx,
      `Answer questions grounded in the team knowledge base. Be brief but complete: lead with the answer, add only the context that matters, then stop. If the knowledge base does not cover something, say so plainly rather than guessing, and never invent a status, number, name, or commitment. Prefer the most recent source for time-sensitive facts and say when it is from. Decline denied or out-of-scope topics politely.`,
    ].filter(Boolean).join('\n\n');
  }
  const who = [role && `You are ${role}.`, goals && `Your goals: ${goals}.`].filter(Boolean).join(' ');
  return [
    `You are speaking as ${a.owner} in this meeting, in the first person, grounded in their own knowledge.`,
    who,
    `Be brief but complete: lead with the answer, add only the context that matters, then stop. If the retrieved knowledge does not cover the question, say so plainly rather than guessing — never fabricate a number, name, or commitment. Stay in work scope; decline personal-life or denied topics and offer to follow up.`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Env keys to upsert into .env.local from the answers. JARVIS_BOT_NAME drives the
 * Recall roster name (so the bot is NOT "Jarvis" for everyone). For the 'ai'
 * persona the knowledge route reads TEAM_KB_RETRIEVAL_URL; for 'first_person' the
 * SOUL endpoint is used directly, so no TEAM_KB_* is set.
 */
export function envPatchForAnswers(a: OnboardAnswers, slackToken?: string, slackChannel?: string): Record<string, string> {
  const patch: Record<string, string> = {
    JARVIS_BOT_NAME: a.botName,
    DEFAULT_TEAMMATE: a.owner,
  };
  if (a.persona === 'ai' && a.knowledgeEndpoint && a.knowledgeEndpoint.trim() !== '') {
    patch['TEAM_KB_RETRIEVAL_URL'] = a.knowledgeEndpoint.trim().replace(/\/+$/, '');
  }
  // Folder brain serves a non-default port; point `up`'s connector probe at it.
  if (a.backendType === 'folder') {
    let port = '7412';
    try {
      port = new URL(a.knowledgeEndpoint ?? '').port || '7412';
    } catch {
      port = '7412';
    }
    patch['CONNECTOR_PORT'] = port;
  }
  if (a.slack && slackToken && slackToken.trim() !== '') {
    patch['SLACK_BOT_TOKEN'] = slackToken.trim();
    if (slackChannel && slackChannel.trim() !== '') patch['MEETING_SLACK_CHANNEL'] = slackChannel.trim();
  }
  return patch;
}

/** Upsert KEY=VALUE pairs into existing .env text, preserving comments + order. */
export function upsertEnv(existing: string, patch: Record<string, string>): string {
  const lines = existing.split('\n');
  const remaining = new Map(Object.entries(patch));
  const out = lines.map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m && remaining.has(m[1]!)) {
      const key = m[1]!;
      const val = remaining.get(key)!;
      remaining.delete(key);
      // Preserve any trailing inline `# comment` hint from the template line.
      const afterEq = line.slice(key.length + 1);
      const comment = /\s+(#.*)$/.exec(afterEq);
      return comment ? `${key}=${val}   ${comment[1]}` : `${key}=${val}`;
    }
    return line;
  });
  if (remaining.size > 0) {
    if (out.length > 0 && out[out.length - 1]!.trim() !== '') out.push('');
    out.push('# --- added by jarvis-meeting onboard ---');
    for (const [k, v] of remaining) out.push(`${k}=${v}`);
  }
  return out.join('\n').replace(/\n*$/, '\n');
}

export function renderSoul(frontMatter: Record<string, unknown>, prose: string): string {
  const fm = yaml.dump(frontMatter, { lineWidth: 100 }).trimEnd();
  return `---\n${fm}\n---\n${prose}\n`;
}

export interface WriteOnboardResult {
  soulFile: string;
  envFile: string;
  envPatchKeys: string[];
}

/** Filesystem effect of onboarding: write SOUL + upsert .env.local. Pure inputs. */
export function writeOnboard(opts: {
  answers: OnboardAnswers;
  soulDir: string;
  projectDir: string;
  envPatch: Record<string, string>;
  force: boolean;
}): WriteOnboardResult {
  const { answers, soulDir, projectDir, envPatch, force } = opts;
  const soulFile = soulPath(answers.owner, soulDir);
  if (existsSync(soulFile) && !force) {
    throw new Error(`SOUL already exists at ${soulFile} (use --force to overwrite)`);
  }
  mkdirSync(soulDir, { recursive: true });
  const { frontMatter, prose } = buildSoulDoc(answers);
  writeFileSync(soulFile, renderSoul(frontMatter, prose), 'utf8');

  // Seed the full key template for a fresh setup so every fillable key is present.
  const envFile = join(projectDir, '.env.local');
  const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ENV_TEMPLATE;
  writeFileSync(envFile, upsertEnv(existing, envPatch), 'utf8');

  return { soulFile, envFile, envPatchKeys: Object.keys(envPatch) };
}

// --------------------------------------------------------------------------
// Interactive shell
// --------------------------------------------------------------------------

function isPersona(v: string | undefined): v is PersonaMode {
  return v === 'ai' || v === 'first_person';
}

/** Minimal `--key value` / `--flag` parser (mirrors index.ts parseArgs). */
function parseFlags(argv: string[]): { flags: Record<string, string>; bools: Set<string> } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      bools.add(key);
    }
  }
  return { flags, bools };
}

/**
 * Headless onboarding for a colleague's AGENT: build answers from flags, write
 * the SOUL + patch .env.local, no prompts. Requires --bot-name. Returns 0/1.
 */
export async function onboardNonInteractive(
  flags: Record<string, string>,
  bools: Set<string>,
  soulDir: string,
  projectDir: string,
  env: EnvMap,
): Promise<number> {
  const botName = (flags['bot-name'] ?? '').trim();
  if (botName === '') {
    console.error('onboard --non-interactive: --bot-name is required');
    return 1;
  }
  const owner = (flags['owner'] ?? botName.toLowerCase()).trim();
  const persona: PersonaMode = isPersona(flags['persona']) ? (flags['persona'] as PersonaMode) : 'ai';

  // Knowledge backend: explicit --endpoint, else the folder-of-docs default brain.
  let knowledgeEndpoint = (flags['endpoint'] ?? '').trim();
  let backendType: KbType = 'openbrain';
  if (knowledgeEndpoint === '') {
    const folder = (flags['kb-folder'] ?? './team-brain').trim();
    mkdirSync(folder, { recursive: true });
    knowledgeEndpoint = 'http://127.0.0.1:7412';
    backendType = 'folder';
    console.error(`No --endpoint given: using the bundled zero-infra FOLDER brain at ${folder}.`);
    console.error(`  Start it (no Postgres / no embedding key):  KB_ROOT="${folder}" npm run connector   (serves ${knowledgeEndpoint}).`);
  }
  if (persona === 'ai') {
    console.error('Note: the "ai" persona serves this brain to ALL meeting participants as TEAM knowledge — point it at shared team content, not a personal brain.');
  }

  // Slack token comes from an env var the agent exports (NOT an argv flag — argv is world-readable via ps/shell history).
  const slackToken = (env['JARVIS_SLACK_TOKEN'] ?? '').trim();
  let slackChannel = (flags['slack-channel'] ?? '').trim();
  let slack = slackToken !== '';
  if (slack && slackChannel === '') {
    slackChannel = (await resolveSlackSelf(slackToken)) ?? '';
    if (slackChannel === '') {
      console.error('Slack: could not resolve your user ID from JARVIS_SLACK_TOKEN (need a USER token, not a bot token). Pass --slack-channel <U...> or omit. Disabling Slack delivery.');
      slack = false;
    }
  }

  const answers: OnboardAnswers = {
    botName,
    owner,
    persona,
    ...(flags['role'] ? { role: flags['role'] } : {}),
    ...(flags['goals'] ? { goals: flags['goals'] } : {}),
    deniedTopics: (flags['denied'] ?? 'compensation, personal finances, legal advice').split(',').map((s) => s.trim()).filter(Boolean),
    knowledgeEndpoint,
    backendType,
    slack,
    ingest: !bools.has('no-ingest'),
  };
  const patch = envPatchForAnswers(answers, slack ? slackToken : undefined, slack ? slackChannel : undefined);
  const result = writeOnboard({ answers, soulDir, projectDir, envPatch: patch, force: bools.has('force') });
  console.log(`Wrote SOUL: ${result.soulFile}`);
  console.log(`Patched ${result.envFile} with: ${result.envPatchKeys.join(', ')}`);
  console.log(`Bot joins + wakes as "${botName}" (persona ${persona}). Next: fill missing keys, start your brain, jarvis-meeting doctor --teammate ${owner}.`);
  return 0;
}

/** Resolve a Slack user ID from a token via auth.test (for the self-DM channel). Returns undefined on failure. */
async function resolveSlackSelf(token: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; user_id?: string; bot_id?: string } | null;
    if (!data || data.ok !== true || typeof data.user_id !== 'string') return undefined;
    // A bot token's user_id is the bot itself — DMing it would not reach the human.
    if (typeof data.bot_id === 'string' && data.bot_id !== '') return undefined;
    return data.user_id;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function cmdOnboard(argv: string[], deps?: { env?: EnvMap }): Promise<number> {
  const env = deps?.env ?? process.env;
  const soulDir = process.env['SOUL_DIR'] ?? `${process.cwd()}/soul`;
  const projectDir = process.cwd();

  // 1. env preflight (always)
  const checklist = envChecklist(env);
  console.log('Environment preflight (.env.local):\n');
  console.log(formatEnvChecklist(checklist));
  console.log('');

  // Headless mode for a colleague's agent: drive everything from flags.
  const { flags, bools } = parseFlags(argv);
  if (bools.has('non-interactive')) {
    return onboardNonInteractive(flags, bools, soulDir, projectDir, env);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    // 2. interview
    const botName = (await rl.question('Bot name (also the wake word — pick something UNIQUE, not "Jarvis"): ')).trim();
    if (botName === '') {
      console.error('onboard: a bot name is required.');
      return 1;
    }
    const owner = (await rl.question(`Your slug (owner) [${botName.toLowerCase()}]: `)).trim() || botName.toLowerCase();
    const personaRaw = (await rl.question('Persona — "ai" (generic team assistant) or "first_person" (your delegate) [ai]: ')).trim();
    const persona: PersonaMode = isPersona(personaRaw) ? personaRaw : 'ai';
    const role = (await rl.question('Your role / the team focus (one line, optional): ')).trim();
    const goals = (await rl.question('What should it help with / your goals (optional): ')).trim();
    const deniedRaw = (await rl.question('Denied topics, comma-separated [compensation, personal finances, legal advice]: ')).trim();
    const deniedTopics = (deniedRaw || 'compensation, personal finances, legal advice').split(',').map((s) => s.trim()).filter(Boolean);

    // 3. brain detection
    let knowledgeEndpoint = (await rl.question('Your second-brain /search endpoint (blank = set up a folder brain): ')).trim();
    let backendType: KbType = 'openbrain';
    if (knowledgeEndpoint !== '') {
      const ok = await probeBrain(knowledgeEndpoint);
      console.log(`  ${brainProbeVerdict(knowledgeEndpoint, ok).message}`);
    } else {
      const folder = (await rl.question('Folder to use as your default brain [./team-brain]: ')).trim() || './team-brain';
      mkdirSync(folder, { recursive: true });
      knowledgeEndpoint = 'http://127.0.0.1:7412';
      backendType = 'folder';
      console.log(`  Created ${folder}. Default brain = the bundled zero-infra folder connector serving ${knowledgeEndpoint}.`);
      console.log(`  Start it (no Postgres / no embedding key):  KB_ROOT="${folder}" npm run connector`);
      console.log('  (For semantic search instead of keyword BM25, use a pgvector connector per docs/CONNECTOR.md.)');
    }
    if (persona === 'ai' && knowledgeEndpoint !== '') {
      console.log('  NOTE: the "ai" persona serves this brain to ALL meeting participants as TEAM knowledge —');
      console.log('  point it at shared team content, not a personal brain.');
    }

    // 4. optional Slack transcript delivery
    let slackToken: string | undefined;
    let slackChannel: string | undefined;
    const wantSlack = (await rl.question('Send the transcript to your Slack DM after meetings? (y/N): ')).trim().toLowerCase().startsWith('y');
    if (wantSlack) {
      slackToken = (await rl.question('  Your Slack USER token (xoxp-, not a bot token): ')).trim();
      if (slackToken !== '') {
        const self = await resolveSlackSelf(slackToken);
        if (self) {
          slackChannel = self;
          console.log(`  Resolved your Slack user ID (${self}) — transcripts will DM you.`);
        } else {
          slackChannel = (await rl.question('  Could not resolve via auth.test. Your Slack user ID (e.g. U0...): ')).trim();
        }
      }
    }

    const answers: OnboardAnswers = {
      botName,
      owner,
      persona,
      ...(role !== '' ? { role } : {}),
      ...(goals !== '' ? { goals } : {}),
      deniedTopics,
      knowledgeEndpoint,
      backendType,
      slack: wantSlack && !!slackToken,
      ingest: true,
    };
    const patch = envPatchForAnswers(answers, slackToken, slackChannel);
    const result = writeOnboard({ answers, soulDir, projectDir, envPatch: patch, force: argv.includes('--force') || bools.has('force') });

    console.log(`\nWrote SOUL: ${result.soulFile}`);
    console.log(`Patched ${result.envFile} with: ${result.envPatchKeys.join(', ')}`);
    console.log('\nNext steps:');
    console.log(`  1. Fill any [MISSING] required/realtime keys above in ${result.envFile}.`);
    console.log(`  2. Start your brain connector (if folder: the folder connector serving :7412, per the note above).`);
    console.log(`  3. jarvis-meeting doctor --teammate ${owner}   (loop until green)`);
    console.log(`  4. jarvis-meeting up   then dispatch with the meeting link.`);
    console.log(`  Your bot will join as "${botName}" and wake on "${botName}".`);
    return 0;
  } finally {
    rl.close();
  }
}
