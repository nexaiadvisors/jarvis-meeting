// Builds the Hono app: every route mount lives here so tests and index.ts see the
// same surface. index.ts keeps only server start, the cost-control sweep, logging
// and shutdown.

import { Hono } from 'hono';
import type { Config } from './config.js';
import { createDispatchRoute } from './routes/dispatch.js';
import { createWebhookRoute } from './routes/webhook.js';
import { createRealtimeSessionRoute } from './routes/realtime-session.js';
import { createVoiceRoutes } from './routes/voice.js';
import { createMeetingStateRoutes } from './routes/meeting-state.js';
import { createAgentFrameRoute } from './routes/agent-frame.js';
import { createPanelAuthRoutes } from './routes/panel-auth.js';
import { createPanelRoutes } from './routes/panel.js';
import { createTranscriptSearchRoutes } from './routes/transcript-search.js';
import { createCommandRoutes } from './routes/commands.js';
import { createAvatarRoutes } from './routes/avatar.js';
import { createVoxtralRoutes } from './routes/voxtral.js';
import { createMcpRoute } from './routes/mcp.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import { createMeetingPageRoutes } from './routes/meeting-page.js';
import { listLive } from './meeting/registry.js';

export function createApp(config: Config): Hono {
  const app = new Hono();

  // Health probes. /healthz is PUBLIC (it sits behind the ngrok URL), so it reports
  // only a count, never meeting ids. The count still lets the join preflight
  // (scripts/join-meeting.sh) CHECK freshness before dispatching: a non-zero
  // liveCount means stale/leftover entries that the in-memory registry won't shed
  // on its own (up.sh is idempotent), so the caller restarts to clear them. See
  // lessons/2026-06-25-restart-meeting-service-for-fresh-state.
  app.get('/healthz', (c) => c.json({ ok: true, liveCount: listLive().length }));
  app.get('/readyz', (c) =>
    c.json({
      ok: true,
      bot_name: config.jarvisBotName,
      recall_base: config.recallApiBase,
    }),
  );

  // Routes
  app.route('/', createDispatchRoute(config));
  app.route('/', createWebhookRoute(config));
  app.route('/', createRealtimeSessionRoute(config));
  app.route('/', createVoiceRoutes(config));
  app.route('/', createMeetingStateRoutes(config));
  app.route('/', createTranscriptSearchRoutes(config));
  app.route('/', createCommandRoutes(config));
  app.route('/', createAvatarRoutes(config));
  app.route('/', createVoxtralRoutes(config));
  app.route('/', createMcpRoute(config));
  app.route('/', createArtifactRoutes(config));
  app.route('/', createMeetingPageRoutes(config));
  app.route('/', createAgentFrameRoute(config));
  app.route('/', createPanelAuthRoutes(config));
  app.route('/', createPanelRoutes(config));

  return app;
}
