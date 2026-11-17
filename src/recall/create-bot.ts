// Create a Recall.ai Output-Media speaking bot for a meeting.
//
// The bot renders the agent-frame webpage as its camera and streams that
// page's audio (GPT-Realtime speech) into the call, while simultaneously
// receiving a low-latency Recall transcript webhook for persistence + RAG.
//
// NOTE: Slack Huddles are NOT supported by this Output-Media speaking-bot path.
// Recall's Huddle integration uses the Desktop Recording SDK which is
// record-only — the Output Media camera + audio path is unavailable there.
// Huddle support is a record-only fast-follow, out of scope for this service.

import { loadConfig } from '../config.js';
import { screenSocketUrl } from '../screen/socket.js';

export interface CreateBotParams {
  meetingUrl: string;
  botName: string;
  meetingId: string;
  languageCode?: string;
  /** Teammate slug whose SOUL drives this meeting (resolved from the dispatch token). */
  teammate?: string;
  /** Persona mode the agent runs under. */
  persona?: string;
  /** SOUL slug actually loaded (may differ from teammate when body.soul is set). */
  soulSlug?: string;
  /** Short-lived token the agent-frame page presents to mint realtime config. */
  sessionToken?: string;
  /** Ask Recall for still frames of the shared screen (sent to screen/socket.ts). Off by default. */
  screenShare?: boolean;
}

export interface CreateBotResult {
  botId: string;
}

export async function createBot(params: CreateBotParams): Promise<CreateBotResult> {
  const config = loadConfig();
  const { meetingUrl, botName, meetingId, languageCode = 'en', teammate, persona, soulSlug, sessionToken, screenShare = false } = params;
  const agentFrameUrl = `${config.publicBaseUrl}/meetings/agent-frame/${meetingId}${
    sessionToken ? `?session_token=${encodeURIComponent(sessionToken)}` : ''
  }`;

  const body = {
    meeting_url: meetingUrl,
    bot_name: botName,
    // Recall echoes `metadata` back on the bot object (bot.done webhook), giving
    // the post-meeting pipeline a durable, spoof-proof attribution path that does
    // not depend on the in-memory registry surviving a restart.
    metadata: {
      meeting_id: meetingId,
      ...(teammate !== undefined ? { teammate } : {}),
      ...(persona !== undefined ? { persona } : {}),
      ...(soulSlug !== undefined ? { soul_slug: soulSlug } : {}),
    },
    // Recall's DEFAULT everyone_left_timeout is { timeout: 2, activate_after: 0 } —
    // the bot leaves just 2s after it momentarily reads "alone in the call" (e.g.
    // the human's tab backgrounds, or a brief 0-other-participants blip right after
    // they admit it). That dropped a live test 42s after admission (call_ended /
    // sub_code timeout_exceeded_everyone_left). Retune so the bot leaves ~2 min
    // after it is TRULY alone, while surviving transient 0-other-participant blips:
    //   - activate_after: 30 — only arm the timer once the bot has been alone for
    //     30 continuous seconds, so a momentary participant-count dip doesn't count.
    //   - timeout: 120 — then wait 2 more minutes before leaving.
    // (Our own cost-control idle sweep — MEETING_IDLE_TIMEOUT_MS — plus the
    // presence-aware sweep is the cheaper backstop for the still-but-occupied case.)
    automatic_leave: {
      // Google Meet caps the waiting room at ~10 min and it CANNOT be disabled, so
      // for GMeet this value is effectively advisory beyond ~10 min — rely on the
      // presence + service idle logic (participant_events + the cost-control sweep),
      // not this waiting_room_timeout, to keep a quietly-admitted bot alive.
      waiting_room_timeout: 1800,
      everyone_left_timeout: { timeout: 120, activate_after: 30 },
    },
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
            mode: 'prioritize_low_latency',
            language_code: languageCode,
          },
        },
        diarization: {
          use_separate_streams_when_available: true,
        },
      },
      realtime_endpoints: [
        {
          type: 'webhook',
          // Carry the shared webhook secret as a query param when configured, so
          // the webhook route can reject forged bot.done/transcript posts that
          // would otherwise spoof the metadata-based attribution. Recall calls the
          // exact URL we register here, preserving the param.
          url: `${config.publicBaseUrl}/webhooks/recall${
            config.webhookSecret ? `?s=${encodeURIComponent(config.webhookSecret)}` : ''
          }`,
          // We subscribe to transcript.data for content AND participant_events.*
          // for true presence. We are otherwise blind to bot state: Recall's
          // status_changes API is unreliable, so PRESENCE (join/leave) and speech
          // gates are what keep a present-but-quiet bot from being idle-killed.
          // These five event types ARE valid on realtime_endpoints.
          events: [
            'transcript.data',
            'participant_events.join',
            'participant_events.leave',
            'participant_events.speech_on',
            'participant_events.speech_off',
            // Meeting chat: typed requests and the written record (Zoom, Meet, Teams).
            'participant_events.chat_message',
          ],
        },
        // Screen viewing: Recall sends real-time video only over a websocket. Frames are
        // PNG stills (about 2 a second) for each camera and each shared screen; the
        // socket keeps shared-screen frames only.
        ...(screenShare
          ? [{ type: 'websocket', url: screenSocketUrl(config), events: ['video_separate_png.data'] }]
          : []),
      ],
      // Separate video needs the gallery_view_v2 layout (Recall docs).
      ...(screenShare ? { video_mixed_layout: 'gallery_view_v2', video_separate_png: {} } : {}),
    },
    output_media: {
      camera: {
        kind: 'webpage',
        config: {
          // The agent-frame page is served by THIS service (GET
          // /meetings/agent-frame/:id, see src/routes/agent-frame.ts), so the
          // bot's camera renders our own self-contained page off PUBLIC_BASE_URL.
          url: agentFrameUrl,
        },
      },
    },
    // web_4_core = 2250m CPU / 5250MB RAM. The default `web` variant gets
    // 250 millicores which starves the renderer's audio thread and garbles
    // ALL audio in both directions (verified with a 440 Hz sine discriminator).
    // Recall Output Media FAQ: "choppy output => upgrade the instance".
    variant: {
      zoom: 'web_4_core',
      google_meet: 'web_4_core',
      microsoft_teams: 'web_4_core',
    },
  };

  const response = await fetch(`${config.recallApiBase}/bot/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.recallApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '(could not read body)');
    throw new Error(
      `Recall.ai bot creation failed (${response.status}): ${errText}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const botId =
    typeof data['id'] === 'string'
      ? data['id']
      : typeof data['bot_id'] === 'string'
        ? data['bot_id']
        : null;

  if (!botId) {
    throw new Error(
      `Recall.ai response missing bot id: ${JSON.stringify(data)}`,
    );
  }

  return { botId };
}
