// `jarvis-meeting doctor` — preflight checks for a teammate deployment.
//
// Each check is graceful (never throws; failures are caught by runChecks) and
// returns PASS / WARN / FAIL. The check list is built by buildDoctorChecks from
// the raw env + a teammate slug, so tests can construct it with a mocked fetch
// and a temp SOUL dir without spawning a process.

import type { Check } from './checks.js';
import { loadSoul } from '../soul/loader.js';

const PROBE_TIMEOUT_MS = 3000;

export interface DoctorEnv {
  recallApiKey: string | undefined;
  recallApiBase: string;
  publicBaseUrl: string | undefined;
  openAiKey: string | undefined;
  webhookSecret: string | undefined;
  jarvisBotName: string | undefined;
  anthropicApiKey: string | undefined;
  slackBotToken: string | undefined;
  meetingSlackChannel: string | undefined;
  soulDir: string;
}

/** Read the doctor-relevant slice of env without going through loadConfig (which throws on missing required vars). */
export function doctorEnvFromProcess(): DoctorEnv {
  const get = (n: string): string | undefined => {
    const v = process.env[n];
    return v && v.trim() !== '' ? v : undefined;
  };
  return {
    recallApiKey: get('RECALL_API_KEY'),
    recallApiBase: get('RECALL_API_BASE') ?? 'https://us-east-1.recall.ai/api/v1',
    publicBaseUrl: get('PUBLIC_BASE_URL'),
    openAiKey: get('OPENAI_API_KEY'),
    webhookSecret: get('WEBHOOK_SECRET'),
    jarvisBotName: get('JARVIS_BOT_NAME'),
    anthropicApiKey: get('ANTHROPIC_API_KEY'),
    slackBotToken: get('SLACK_BOT_TOKEN'),
    meetingSlackChannel: get('MEETING_SLACK_CHANNEL'),
    soulDir: get('SOUL_DIR') ?? `${process.cwd()}/soul`,
  };
}

/** Best-effort fetch with a short timeout. Returns the Response or undefined on any error/timeout. */
async function probe(url: string, init: RequestInit): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the doctor check list. `teammate` is the SOUL slug to validate. The SOUL
 * endpoint (for the /search reachability check) is derived from the SOUL once it
 * loads.
 */
export function buildDoctorChecks(env: DoctorEnv, teammate: string): Check[] {
  return [
    {
      name: 'required-env',
      run: async () => {
        // PUBLIC_BASE_URL is resolved by `up` from ngrok at boot, so its absence is
        // a WARN (not a FAIL) — otherwise "doctor loop until green" is unsatisfiable
        // before `up` runs. RECALL_API_KEY is the only hard requirement here.
        if (!env.recallApiKey) return { status: 'FAIL', message: 'missing: RECALL_API_KEY' };
        if (!env.publicBaseUrl) {
          return { status: 'WARN', message: 'PUBLIC_BASE_URL unset — `up` resolves it from ngrok at boot; set it only for a fixed/reserved URL' };
        }
        return { status: 'PASS', message: 'RECALL_API_KEY and PUBLIC_BASE_URL are set' };
      },
    },
    {
      name: 'realtime-provider',
      run: async () => {
        // Match resolveRealtimeProvider: OpenAI is the only realtime provider.
        if (env.openAiKey) return { status: 'PASS', message: 'OpenAI realtime configured' };
        return { status: 'FAIL', message: 'no realtime provider (set OPENAI_API_KEY)' };
      },
    },
    {
      name: `soul:${teammate}`,
      run: async () => {
        try {
          const soul = loadSoul(teammate, env.soulDir);
          return { status: 'PASS', message: `loaded (persona=${soul.personaMode}, route=${soul.knowledgeBackend.route})` };
        } catch (err) {
          return { status: 'FAIL', message: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: 'knowledge-backend',
      run: async () => {
        let endpoint = '';
        try {
          endpoint = loadSoul(teammate, env.soulDir).knowledgeBackend.endpoint;
        } catch {
          return { status: 'WARN', message: 'SOUL did not load; skipping /search probe' };
        }
        if (endpoint.trim() === '') {
          return { status: 'WARN', message: 'SOUL has no knowledge_backend.endpoint; skipping /search probe' };
        }
        const res = await probe(`${endpoint.replace(/\/+$/, '')}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'ping', k: 1 }),
        });
        if (res === undefined) return { status: 'WARN', message: `unreachable: ${endpoint}/search` };
        return res.ok
          ? { status: 'PASS', message: `${endpoint}/search reachable (${res.status})` }
          : { status: 'WARN', message: `${endpoint}/search returned ${res.status}` };
      },
    },
    {
      name: 'recall-key',
      run: async () => {
        if (!env.recallApiKey) return { status: 'FAIL', message: 'RECALL_API_KEY not set' };
        const res = await probe(`${env.recallApiBase.replace(/\/+$/, '')}/bot/?limit=1`, {
          method: 'GET',
          headers: { Authorization: `Token ${env.recallApiKey}` },
        });
        if (res === undefined) return { status: 'WARN', message: 'Recall API unreachable (network)' };
        if (res.status === 401) return { status: 'FAIL', message: 'Recall rejected the key (401)' };
        if (res.ok) return { status: 'PASS', message: `Recall key valid (${res.status})` };
        return { status: 'WARN', message: `Recall returned ${res.status}` };
      },
    },
    {
      name: 'webhook-secret',
      run: async () =>
        env.webhookSecret
          ? { status: 'PASS', message: 'WEBHOOK_SECRET is set' }
          : { status: 'WARN', message: 'WEBHOOK_SECRET not set (dev only; set before exposing the webhook)' },
    },
    {
      name: 'bot-name',
      run: async () => {
        const n = env.jarvisBotName?.trim();
        if (!n) {
          return { status: 'WARN', message: 'JARVIS_BOT_NAME unset — bot joins as default "Jarvis" (collision risk if multiple bots share a meeting)' };
        }
        if (n.toLowerCase() === 'jarvis') {
          return { status: 'WARN', message: 'bot name is "Jarvis" — pick a UNIQUE name per person so multiple bots are not confused' };
        }
        return { status: 'PASS', message: `bot joins + wakes as "${n}"` };
      },
    },
    {
      name: 'ingest-readiness',
      run: async () => {
        let ingest: boolean;
        try {
          ingest = loadSoul(teammate, env.soulDir).ingest;
        } catch {
          return { status: 'WARN', message: 'SOUL did not load; skipping ingest check' };
        }
        if (!ingest) return { status: 'PASS', message: 'ingest disabled in SOUL (no transcript write-back)' };
        return env.anthropicApiKey
          ? { status: 'PASS', message: 'ingest on + ANTHROPIC_API_KEY set; verify the /store write-back with `doctor --connector <brain-url>`' }
          : { status: 'WARN', message: 'ingest on but ANTHROPIC_API_KEY missing — the summary-gated pipeline will skip ingest; set ANTHROPIC_API_KEY' };
      },
    },
    {
      name: 'slack-delivery',
      run: async () => {
        let wantsSlack: boolean;
        try {
          wantsSlack = loadSoul(teammate, env.soulDir).delivery.includes('slack');
        } catch {
          return { status: 'WARN', message: 'SOUL did not load; skipping slack check' };
        }
        if (!wantsSlack) return { status: 'PASS', message: 'slack delivery off in SOUL' };
        const missing = [!env.slackBotToken && 'SLACK_BOT_TOKEN', !env.meetingSlackChannel && 'MEETING_SLACK_CHANNEL']
          .filter(Boolean)
          .join(', ');
        return missing === ''
          ? { status: 'PASS', message: 'slack delivery configured (summary + transcript to your DM)' }
          : { status: 'WARN', message: `slack delivery on but missing: ${missing}` };
      },
    },
  ];
}
