// Runtime configuration — all env-var parsing lives here so the rest of the
// codebase receives a typed Config object and never reads process.env directly.

import { mergePersonalDenyTerms } from './agent/work-scope.js';

export interface Config {
  port: number;
  recallApiKey: string;
  recallApiBase: string;
  publicBaseUrl: string;
  teamKbAnswerEndpoint: string | undefined;
  teamKbAnswerApiToken: string | undefined;
  teamKbFallbackUrl: string;
  jarvisBotName: string;
  jarvisApiToken: string | undefined;
  /**
   * Optional shared secret Recall must present on the webhook URL (`?s=...`).
   * When set, POST /webhooks/recall rejects any request without the matching
   * secret — this authenticates the spoof-proof `bot.metadata` attribution path
   * (teammate/soul_slug) that drives auto-ingest + delivery. Unset = dev-mode allow.
   */
  webhookSecret: string | undefined;
  /**
   * Owner credential (OWNER_TOKEN) for the private owner panel and its API. Sent
   * as a bearer token, or exchanged at POST /panel/login for the `jm_owner`
   * cookie. Unset = no owner access (only allowed on a localhost
   * PUBLIC_BASE_URL; loadConfig refuses to start publicly without it).
   */
  ownerToken: string | undefined;
  /**
   * Per-teammate dispatch token registry, parsed from JARVIS_TOKENS
   * (`token1:teammate1,token2:teammate2`). The token identifies the teammate;
   * the request body can never override it (anti-spoof). The legacy
   * JARVIS_API_TOKEN and OWNER_TOKEN, when set, are folded in mapping to
   * defaultTeammate (unless JARVIS_TOKENS already claims that exact token).
   */
  tokenRegistry: Map<string, string>;

  // Recall cost controls (Increment 3b). web_4_core is expensive, so these
  // bound spend: a per-teammate concurrency cap plus an idle/max-duration sweep
  // that auto-leaves abandoned or runaway calls.
  /** Max simultaneous live meetings per teammate. Default: 2. */
  maxConcurrentPerTeammate: number;
  /** Idle threshold (ms) with no transcript activity before auto-leave. Default: 600000 (10m). */
  idleTimeoutMs: number;
  /**
   * Hard max meeting duration (ms) before auto-leave regardless of activity.
   * Default: 14400000 (4h). MUST stay above MEETING_IDLE_TIMEOUT_MS — when the
   * idle timeout was bumped to 2h, the old 2h max-duration DEFAULT silently
   * shadowed it (every call hit max_duration at 2h before idle could matter).
   */
  maxDurationMs: number;
  /** Cost-control sweep interval (ms). Default: 60000 (1m). */
  sweepIntervalMs: number;
  /**
   * How long after the owner leaves a call the bot leaves too (OWNER_LEFT_GRACE_MS).
   * Default 60000. 0 turns the rule off. Needs OWNER_PARTICIPANT_NAMES.
   */
  ownerLeftGraceMs?: number;
  /**
   * Screen viewing for meetings that do not say (SCREEN_SHARE_DEFAULT). Default false:
   * the bot sees a shared screen only in a meeting joined with screen_share: true.
   */
  screenShareDefault?: boolean;

  // Knowledge-backend resilience (observe-and-report only).
  /**
   * Optional health URL for the knowledge backend (the OpenBrain kb-server, e.g.
   * http://127.0.0.1:7401/healthz). When set, the cost-control sweep probes it on
   * each tick and logs a single structured warning if the backend is down while a
   * meeting is live — so a silently-dead backend (which makes delegate answers
   * ungrounded) is noticed. FAIL-OPEN: the probe never throws and never restarts
   * anything; restart authority belongs to the OS-level supervisor. Unset = the
   * health-check is a no-op (no behavior change for existing users).
   */
  kbBackendHealthUrl: string | undefined;
  /** Derived: true when kbBackendHealthUrl is configured. */
  kbBackendHealthCheckEnabled: boolean;
  /**
   * Bearer token the bot presents to the knowledge backend (KB_BACKEND_TOKEN).
   * Unset = requests carry no Authorization header.
   */
  kbBackendToken: string | undefined;
  /**
   * Namespaces the bot may speak from wholesale (WORK_SCOPE_NAMESPACES, comma
   * list). Default [] = no namespace is allowed wholesale.
   */
  workScopeNamespaces: string[];
  /**
   * Personal-life terms in force: the default stems (src/agent/work-scope.ts) PLUS any
   * configured PERSONAL_DENY_TERMS (comma list). Configured terms add to the defaults and
   * never replace them. A document whose entity_key or content has one of these at the
   * start of a word, case-insensitively, is never spoken.
   */
  personalDenyTerms: string[];

  // SOUL-based serving layer (file-driven persona, no DB).
  /** Directory holding teammate SOUL.md files. Default: <cwd>/soul. */
  soulDir: string;
  /** Company-knowledge /search base for the team-KB lane. Optional. */
  teamKbEndpoint: string | undefined;
  /** Teammate slug used when dispatch does not specify one. Default: 'example'. */
  defaultTeammate: string;

  // Phase 2: Azure Blob Storage for audio artifacts.
  // All three must be set together; if any is absent, artifact upload is skipped.
  azureStorageAccountName: string | undefined;
  azureStorageAccountKey: string | undefined;
  azureStorageBlobContainer: string | undefined;
  /** SAS token TTL in hours. Default: 168 (7 days). */
  artifactSasTtlHours: number;

  // Phase 3a: Anthropic for structured summary.
  anthropicApiKey: string | undefined;
  /** Anthropic model to use for summary. Default: claude-sonnet-5-5. */
  anthropicModel: string;
  /**
   * Model for the ONE retry after the summary model refuses or returns no structured
   * output (ANTHROPIC_FALLBACK_MODEL). Default: claude-opus-5-5.
   */
  anthropicFallbackModel: string;
  /** Maximum Anthropic output tokens for a meeting summary. Default: 4096. */
  meetingSummaryMaxTokens: number;
  /** Maximum transcript characters sent to the summary model. Default: 400000. */
  meetingSummaryInputCharCap: number;
  /** Deadline for one OpenBrain meeting-ingest request. Default: 120000ms. */
  meetingIngestTimeoutMs: number;

  // Phase 3b: Microsoft Graph sendMail for post-meeting email.
  graphTenantId: string | undefined;
  graphClientId: string | undefined;
  graphClientSecret: string | undefined;
  /** The service mailbox that sendMail is sent from. */
  meetingEmailSender: string | undefined;
  /** Default recipients when caller does not pass explicit recipient list. */
  meetingEmailDefaultRecipients: string[];

  // Phase 4: Slack delivery (optional). Bot token for chat.postMessage and a
  // default channel for soul.delivery 'slack'. Best-effort — never blocks.
  slackBotToken: string | undefined;
  meetingSlackIncludeTranscript?: boolean;
  meetingSlackChannel: string | undefined;

  /**
   * Where the delegate route reads OpenBrain knowledge. 'kb' (default) is the SOUL's own
   * kb-server; 'ob-mcp' is the OpenBrain MCP gateway at obMcpUrl with the bearer in
   * obMcpTokenFile. The work-scope filter applies to both.
   */
  /**
   * Also email the recap to the calendar invitees whose address is in internalDomains.
   * Default false: the recap goes only to meetingEmailDefaultRecipients.
   */
  recapToInvitees?: boolean;
  /**
   * The owner's display names in a call (OWNER_PARTICIPANT_NAMES, lowercase). When set, a
   * call where the owner is the only person present searches a wider set of notes
   * (isOwnerOnly). Unset: every call uses the guest scope.
   */
  ownerParticipantNames?: string[];
  /** Email domains that count as inside the company (lowercase, no "@"). */
  internalDomains?: string[];
  /**
   * What the calendar auto-join does when an invitee is outside internalDomains:
   * 'allow' (default) joins as usual; 'notes_only' joins but never answers or posts
   * (except the join notice); 'stay_out' does not join.
   */
  externalGuestPolicy?: 'allow' | 'notes_only' | 'stay_out';
  knowledgeSource?: 'kb' | 'ob-mcp';
  obMcpUrl?: string;
  obMcpTokenFile?: string;

  // Phase 5: Google Calendar Auto-Join Watcher (optional; default off).
  calendarAutoJoin?: boolean;
  calendarPollIntervalMs?: number;
  calendarLeadTimeMs?: number;
  calendarPrimaryAccount?: string;
  calendarOptInAccounts?: string[];
  /** IANA time zone the owner's calendar day is read in. */
  calendarTimeZone?: string;
  gwsSaBin?: string;
  /**
   * RESEARCHER=on: the voice model hands every knowledge question to a Claude researcher
   * (src/researcher) instead of searching the notes itself. Needs ANTHROPIC_API_KEY.
   */
  researcherEnabled?: boolean;
  researcherModel?: string;
  researcherEffort?: string;
  /** RESEARCHER_SPEED=fast: fast mode, on models that support it. */
  researcherSpeed?: string;
  /** RESEARCHER_WEB_SEARCH=on: the researcher may search the web (billed per search). */
  researcherWebSearch?: boolean;
  /** GH_BIN: the gh CLI, for the researcher's read-only GitHub lookups. Empty: off. */
  ghBin?: string;
  /**
   * DELEGATE_CLAUDE_CODE=on: in an owner-only call the agent may hand a task to Claude
   * Code on this machine (src/delegate). Each run costs money and takes up to minutes.
   */
  delegateEnabled?: boolean;
  claudeCodeBin?: string;
  claudeCodeCwd?: string;
  claudeCodeTimeoutMs?: number;
  claudeCodeMaxBudgetUsd?: number;
  /** CLAUDE_CODE_DISALLOWED_TOOLS, raw. Parsed by parseDisallowedTools. */
  claudeCodeDisallowedTools?: string;
  /**
   * Buzz (block.xyz chat). Set BUZZ_BIN, BUZZ_PRIVATE_KEY and BUZZ_RELAY_URL to let the
   * agent read channels and, after a spoken yes, send one message, in an owner-only call.
   */
  buzzBin?: string;
  buzzPrivateKey?: string | undefined;
  buzzRelayUrl?: string;
  /** BUZZ_DRY_RUN=on: go through the whole send flow but never call the CLI's send. */
  buzzDryRun?: boolean;
}

/**
 * Parse the per-teammate token registry. Format: `token1:teammate1,token2:teammate2`.
 * Whitespace around tokens/teammates is trimmed; malformed pairs (missing colon,
 * empty token, or empty teammate) are skipped. The legacy JARVIS_API_TOKEN, when
 * present, is added last mapping to `defaultTeammate` (back-compat) — but only if
 * that exact token is not already claimed by an explicit JARVIS_TOKENS entry.
 */
function parseTokenRegistry(
  raw: string | undefined,
  legacyToken: string | undefined,
  defaultTeammate: string,
): Map<string, string> {
  const registry = new Map<string, string>();
  if (raw && raw.trim() !== '') {
    for (const pair of raw.split(',')) {
      const trimmed = pair.trim();
      if (trimmed === '') continue;
      const idx = trimmed.indexOf(':');
      if (idx <= 0) continue; // no colon, or colon at start (empty token)
      const token = trimmed.slice(0, idx).trim();
      const teammate = trimmed.slice(idx + 1).trim();
      if (token === '' || teammate === '') continue;
      if (registry.has(token) && registry.get(token) !== teammate) {
        // Misconfiguration guard: a token mapped to two teammates is a silent
        // cross-identity bug. Warn loudly; last-write-wins is preserved.
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'config: duplicate JARVIS_TOKENS token maps to multiple teammates (last wins)',
            teammate,
          }),
        );
      }
      registry.set(token, teammate);
    }
  }
  if (legacyToken && legacyToken.trim() !== '' && !registry.has(legacyToken)) {
    registry.set(legacyToken, defaultTeammate);
  }
  return registry;
}

/**
 * Resolve a bearer token to a teammate slug via a token registry.
 * Returns undefined when the token is unknown.
 */
export function resolveTeammate(
  registry: Map<string, string>,
  token: string,
): string | undefined {
  return registry.get(token);
}

/**
 * Team-KB /search endpoint for the knowledge-client team-KB lane. Prefers an
 * explicit TEAM_KB_RETRIEVAL_URL; otherwise derives from TEAM_KB_ANSWER_ENDPOINT
 * (its base hosts /search too). Undefined when neither is set.
 */
function resolveTeamKbEndpoint(): string | undefined {
  const explicit = process.env['TEAM_KB_RETRIEVAL_URL'];
  if (explicit && explicit.trim() !== '') return explicit.trim().replace(/\/+$/, '');
  const answer = process.env['TEAM_KB_ANSWER_ENDPOINT'];
  if (answer && answer.trim() !== '') return answer.trim().replace(/\/+$/, '');
  return undefined;
}

/**
 * True when the URL's hostname is a loopback host (localhost, 127.0.0.1, ::1).
 * Anything else — including lookalikes such as `localhost.evil.example` and URLs
 * that fail to parse — counts as public, so the safety check fails closed.
 */
function isLocalhostUrl(raw: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    return false;
  }
  // WHATWG URL keeps the brackets on IPv6 hosts ("[::1]").
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function loadConfig(): Config {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v || v.trim() === '') {
      throw new Error(`missing required env var: ${name}`);
    }
    return v;
  };

  const optional = (name: string, fallback: string): string =>
    process.env[name] && process.env[name]!.trim() !== ''
      ? process.env[name]!
      : fallback;

  const optionalMaybe = (name: string): string | undefined => {
    const v = process.env[name];
    return v && v.trim() !== '' ? v : undefined;
  };

  const optionalList = (name: string): string[] => {
    const v = process.env[name];
    if (!v || v.trim() === '') return [];
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const jarvisApiToken = optionalMaybe('JARVIS_API_TOKEN');
  const personalDenyTerms = optionalList('PERSONAL_DENY_TERMS');
  const defaultTeammate = optional('DEFAULT_TEAMMATE', 'example');
  const kbBackendHealthUrl = optionalMaybe('KB_BACKEND_HEALTH_URL');
  const ownerToken = optionalMaybe('OWNER_TOKEN');
  const webhookSecret = optionalMaybe('WEBHOOK_SECRET');
  const recallApiKey = required('RECALL_API_KEY');
  const publicBaseUrl = required('PUBLIC_BASE_URL');

  // Fail closed: the owner panel and the Recall webhook are reachable on the
  // public URL, so refuse to start there without both secrets. Only the names of
  // the missing variables go in the message, never a value.
  if (!isLocalhostUrl(publicBaseUrl)) {
    const missing = [
      ...(ownerToken === undefined ? ['OWNER_TOKEN'] : []),
      ...(webhookSecret === undefined ? ['WEBHOOK_SECRET'] : []),
    ];
    if (missing.length > 0) {
      throw new Error(
        `PUBLIC_BASE_URL is not localhost, so ${missing.join(' and ')} must be set (refusing to start unauthenticated on a public URL)`,
      );
    }
  }

  const tokenRegistry = parseTokenRegistry(
    optionalMaybe('JARVIS_TOKENS'),
    jarvisApiToken,
    defaultTeammate,
  );
  if (ownerToken !== undefined && !tokenRegistry.has(ownerToken)) {
    tokenRegistry.set(ownerToken, defaultTeammate);
  }

  return {
    port: Number.parseInt(optional('PORT', '8790'), 10),
    recallApiKey,
    recallApiBase: optional('RECALL_API_BASE', 'https://us-east-1.recall.ai/api/v1'),
    publicBaseUrl,
    teamKbAnswerEndpoint: optionalMaybe('TEAM_KB_ANSWER_ENDPOINT'),
    teamKbAnswerApiToken: optionalMaybe('TEAM_KB_ANSWER_API_TOKEN'),
    teamKbFallbackUrl: optional('TEAM_KB_FALLBACK_URL', 'http://localhost:3031'),
    jarvisBotName: optional('JARVIS_BOT_NAME', 'Jarvis'),
    jarvisApiToken,
    webhookSecret,
    ownerToken,
    tokenRegistry,

    // Recall cost controls
    maxConcurrentPerTeammate: Number.parseInt(optional('MAX_CONCURRENT_PER_TEAMMATE', '2'), 10),
    idleTimeoutMs: Number.parseInt(optional('MEETING_IDLE_TIMEOUT_MS', '600000'), 10),
    maxDurationMs: Number.parseInt(optional('MEETING_MAX_DURATION_MS', '14400000'), 10),
    sweepIntervalMs: Number.parseInt(optional('SWEEP_INTERVAL_MS', '60000'), 10),
    screenShareDefault: optional('SCREEN_SHARE_DEFAULT', 'false').toLowerCase() === 'true',
    ownerLeftGraceMs: Math.max(0, Number.parseInt(optional('OWNER_LEFT_GRACE_MS', '60000'), 10) || 0),

    // Knowledge-backend resilience (observe-and-report only)
    kbBackendHealthUrl,
    kbBackendHealthCheckEnabled: kbBackendHealthUrl !== undefined,
    kbBackendToken: optionalMaybe('KB_BACKEND_TOKEN'),
    workScopeNamespaces: optionalList('WORK_SCOPE_NAMESPACES'),
    personalDenyTerms: mergePersonalDenyTerms(personalDenyTerms),

    // SOUL serving layer
    soulDir: optional('SOUL_DIR', `${process.cwd()}/soul`),
    teamKbEndpoint: resolveTeamKbEndpoint(),
    defaultTeammate,

    // Azure Blob Storage (optional infra)
    azureStorageAccountName: optionalMaybe('AZURE_STORAGE_ACCOUNT_NAME'),
    azureStorageAccountKey: optionalMaybe('AZURE_STORAGE_ACCOUNT_KEY'),
    azureStorageBlobContainer: optionalMaybe('AZURE_STORAGE_BLOB_CONTAINER'),
    artifactSasTtlHours: Number.parseInt(optional('ARTIFACT_SAS_TTL_HOURS', '168'), 10),

    // Anthropic (optional infra)
    anthropicApiKey: optionalMaybe('ANTHROPIC_API_KEY'),
    anthropicModel: optional('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    anthropicFallbackModel: optional('ANTHROPIC_FALLBACK_MODEL', 'claude-opus-5-5'),
    meetingSummaryMaxTokens: Number.parseInt(optional('MEETING_SUMMARY_MAX_TOKENS', '4096'), 10),
    meetingSummaryInputCharCap: Number.parseInt(optional('MEETING_SUMMARY_INPUT_CHAR_CAP', '400000'), 10),
    meetingIngestTimeoutMs: Number.parseInt(optional('MEETING_INGEST_TIMEOUT_MS', '120000'), 10),

    // Microsoft Graph (optional infra)
    graphTenantId: optionalMaybe('GRAPH_TENANT_ID'),
    graphClientId: optionalMaybe('GRAPH_CLIENT_ID'),
    graphClientSecret: optionalMaybe('GRAPH_CLIENT_SECRET'),
    meetingEmailSender: optionalMaybe('MEETING_EMAIL_SENDER'),
    meetingEmailDefaultRecipients: optionalList('MEETING_EMAIL_DEFAULT_RECIPIENTS'),

    // Slack delivery (optional infra)
    slackBotToken: optionalMaybe('SLACK_BOT_TOKEN'),
  // Post the full chunked transcript to Slack after the summary. Default OFF:
  // summary-only in Slack, full transcript lives in OpenBrain (per David,
  // 2026-07-14 - a 2h meeting is ~20 chunk messages of channel noise).
  meetingSlackIncludeTranscript: optional('MEETING_SLACK_INCLUDE_TRANSCRIPT', 'false') === 'true',
    meetingSlackChannel: optionalMaybe('MEETING_SLACK_CHANNEL'),

    recapToInvitees: optional('RECAP_TO_INVITEES', 'false') === 'true',
    ownerParticipantNames: optionalList('OWNER_PARTICIPANT_NAMES').map((n) => n.toLowerCase()),
    internalDomains: optionalList('INTERNAL_DOMAINS').map((d) => d.toLowerCase().replace(/^@/, '')),
    externalGuestPolicy: ((v) => (v === 'notes_only' || v === 'stay_out' ? v : 'allow'))(
      optional('EXTERNAL_GUEST_POLICY', 'allow'),
    ),
    knowledgeSource: optional('KNOWLEDGE_SOURCE', 'kb') === 'ob-mcp' ? 'ob-mcp' : 'kb',
    obMcpUrl: optional('OB_MCP_URL', 'http://127.0.0.1:7410/mcp'),
    ...(optionalMaybe('OB_MCP_TOKEN_FILE') !== undefined ? { obMcpTokenFile: optionalMaybe('OB_MCP_TOKEN_FILE')! } : {}),

    // Google Calendar Auto-Join Watcher
    calendarAutoJoin: optional('CALENDAR_AUTO_JOIN', 'false') === 'true',
    calendarPollIntervalMs: Number.parseInt(optional('CALENDAR_POLL_INTERVAL_MS', '60000'), 10),
    calendarLeadTimeMs: Number.parseInt(optional('CALENDAR_LEAD_TIME_MS', '120000'), 10),
    calendarPrimaryAccount: optional('CALENDAR_PRIMARY_ACCOUNT', 'owner@example.com'),
    calendarTimeZone: optional('CALENDAR_TIME_ZONE', 'America/New_York'),
    calendarOptInAccounts:
      process.env['CALENDAR_OPT_IN_ACCOUNTS'] !== undefined
        ? optionalList('CALENDAR_OPT_IN_ACCOUNTS')
        : ['owner.personal@example.com'],
    gwsSaBin: optional('GWS_SA_BIN', 'gws-sa'),
    researcherEnabled: optional('RESEARCHER', 'off').trim().toLowerCase() === 'on',
    researcherModel: optional('RESEARCHER_MODEL', 'claude-opus-5-5'),
    researcherEffort: optional('RESEARCHER_EFFORT', 'low'),
    researcherSpeed: optional('RESEARCHER_SPEED', 'standard').trim().toLowerCase(),
    researcherWebSearch: optional('RESEARCHER_WEB_SEARCH', 'off').trim().toLowerCase() === 'on',
    ghBin: optional('GH_BIN', '').trim(),
    delegateEnabled: optional('DELEGATE_CLAUDE_CODE', 'off').trim().toLowerCase() === 'on',
    claudeCodeBin: optional('CLAUDE_CODE_BIN', `${process.env['HOME'] ?? ''}/.local/bin/claude`),
    claudeCodeCwd: optional('CLAUDE_CODE_CWD', `${process.env['HOME'] ?? ''}/Work`),
    claudeCodeTimeoutMs: Number.parseInt(optional('CLAUDE_CODE_TIMEOUT_MS', '300000'), 10),
    claudeCodeMaxBudgetUsd: Number.parseFloat(optional('CLAUDE_CODE_MAX_BUDGET_USD', '2')),
    claudeCodeDisallowedTools: optional('CLAUDE_CODE_DISALLOWED_TOOLS', ''),
    buzzBin: optional('BUZZ_BIN', '').trim(),
    buzzPrivateKey: optionalMaybe('BUZZ_PRIVATE_KEY'),
    buzzRelayUrl: optional('BUZZ_RELAY_URL', '').trim(),
    buzzDryRun: optional('BUZZ_DRY_RUN', 'off').trim().toLowerCase() === 'on',
  };
}
