// Jarvis Meeting — control plane entrypoint.
// Loads config, builds the app (src/app.ts), starts the Hono server and the sweep.

import { DEFAULT_PERSONAL_DENY_TERMS } from './agent/work-scope.js';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { startCostControlSweep } from './lifecycle/sweep.js';
import { enableRegistryPersistence } from './meeting/registry.js';
import { startCalendarAutoJoinWatcher } from './calendar/watcher.js';
import { attachScreenSocket } from './screen/socket.js';
import type { Server } from 'node:http';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.personalDenyTerms.every((t) => DEFAULT_PERSONAL_DENY_TERMS.includes(t))) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'PERSONAL_DENY_TERMS is empty: only the generic privacy stems apply. Add your family names and private projects before the bot joins a call with guests.' }));
  }

  // Persist and rehydrate meeting registry across daemon restarts.
  enableRegistryPersistence(undefined, { maxLiveAgeMs: config.maxDurationMs });

  const app = createApp(config);

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  // Shared-screen frames from Recall arrive on a websocket (screen viewing, off by default).
  const stopScreenSocket = attachScreenSocket(server as unknown as Server, config);

  // Recall cost controls: periodically auto-leave idle / runaway meetings.
  const stopSweep = startCostControlSweep(config);

  // Google Calendar auto-join watcher (active when CALENDAR_AUTO_JOIN=true).
  const stopCalendarWatcher = startCalendarAutoJoinWatcher(config);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    stopCalendarWatcher();
    stopSweep();
    stopScreenSocket();
    server.close(() => process.exit(0));
    // Drop keep-alive/idle connections immediately so close() resolves and the
    // listener RELEASES THE PORT promptly. Without this, a lingering keep-alive
    // (ngrok, a bot WS) holds the port until the fallback timeout below — long
    // enough that an idempotent restart (up.sh's `lsof` guard, or any supervisor)
    // sees the port still LISTENing, skips the relaunch, and silently preserves
    // the stale in-memory registry. Makes EVERY restart path safe, not just
    // scripts/join-meeting.sh. See
    // lessons/2026-06-25-restart-meeting-service-for-fresh-state.
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'jarvis-meeting listening',
      port: config.port,
      bot_name: config.jarvisBotName,
      recall_base: config.recallApiBase,
      public_base: config.publicBaseUrl,
      team_kb_mode:
        config.teamKbAnswerEndpoint ? 'hosted' : 'local-fallback',
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: 'jarvis-meeting failed to start',
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }),
  );
  process.exit(1);
});
