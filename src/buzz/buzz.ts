// Buzz (block.xyz chat) through the `buzz` CLI: read a channel, and send one message.
//
// Sending is never decided by a model alone. The route keeps a draft on the server, the
// agent reads it back, and the send runs only after the owner has said yes out loud
// (src/buzz/confirm.ts). This module only talks to the CLI.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Runs the CLI with these arguments and returns its parsed JSON output. */
export type BuzzJson = (args: string[]) => Promise<unknown>;

export interface BuzzChannel {
  id: string;
  name: string;
}

export interface BuzzMember {
  pubkey: string;
  name: string;
}

export interface BuzzMessage {
  id: string;
  from: string;
  at: string;
  text: string;
}

/**
 * The CLI runner. The private key is handed to the CLI process only, through its
 * environment; it is never an argument and never logged.
 */
export function buzzRunner(options: { bin: string; privateKey: string; relayUrl: string }): BuzzJson {
  return async (args) => {
    const home = process.env['HOME'] ?? '';
    const { stdout } = await execFileAsync(options.bin, args, {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: `/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin:/usr/bin:/bin`,
        HOME: home,
        BUZZ_PRIVATE_KEY: options.privateKey,
        BUZZ_RELAY_URL: options.relayUrl,
      },
    });
    return JSON.parse(stdout) as unknown;
  };
}

/** Channels the identity can see. Direct-message threads (all named "DM") are left out. */
export async function listChannels(run: BuzzJson): Promise<BuzzChannel[]> {
  const rows = (await run(['--format', 'compact', 'channels', 'list'])) as Array<Record<string, unknown>>;
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ id: String(row['channel_id'] ?? ''), name: String(row['name'] ?? '') }))
    .filter((channel) => channel.id !== '' && channel.name !== '' && channel.name.toLowerCase() !== 'dm');
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/^#/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The one channel a spoken name means. An exact name wins; otherwise a single channel
 * whose name contains the words. No match or more than one returns the candidates, so
 * the agent asks instead of guessing where a message goes.
 */
export function matchChannel(channels: BuzzChannel[], spoken: string): { channel: BuzzChannel } | { candidates: string[] } {
  const want = normalize(spoken);
  if (want === '') return { candidates: channels.map((c) => c.name) };
  const exact = channels.filter((c) => normalize(c.name) === want);
  if (exact.length === 1) return { channel: exact[0]! };
  const partial = channels.filter((c) => normalize(c.name).includes(want) || want.includes(normalize(c.name)));
  if (exact.length === 0 && partial.length === 1) return { channel: partial[0]! };
  return { candidates: (partial.length > 0 ? partial : channels).map((c) => c.name) };
}

/** Who is in a channel, with display names where the relay has them. */
export async function channelMembers(run: BuzzJson, channelId: string): Promise<BuzzMember[]> {
  const rows = (await run(['channels', 'members', '--channel', channelId])) as Array<Record<string, unknown>>;
  const pubkeys = (Array.isArray(rows) ? rows : []).map((row) => String(row['pubkey'] ?? '')).filter((key) => /^[0-9a-f]{64}$/.test(key));
  if (pubkeys.length === 0) return [];
  let names = new Map<string, string>();
  try {
    const users = (await run(['--format', 'compact', 'users', 'get', ...pubkeys.flatMap((key) => ['--pubkey', key])])) as Array<Record<string, unknown>>;
    names = new Map((Array.isArray(users) ? users : []).map((user) => [String(user['pubkey'] ?? ''), String(user['display_name'] ?? '')]));
  } catch {
    // Names are a convenience; the member list itself is what matters.
  }
  return pubkeys.map((pubkey) => ({ pubkey, name: names.get(pubkey)?.trim() || `member ${pubkey.slice(0, 6)}` }));
}

/** The newest messages in a channel, oldest first, with sender names. */
export async function readMessages(run: BuzzJson, channel: BuzzChannel, limit: number): Promise<BuzzMessage[]> {
  const [rows, members] = await Promise.all([
    run(['messages', 'get', '--channel', channel.id, '--limit', String(limit)]) as Promise<Array<Record<string, unknown>>>,
    channelMembers(run, channel.id),
  ]);
  const names = new Map(members.map((member) => [member.pubkey, member.name]));
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const pubkey = String(row['pubkey'] ?? '');
    const seconds = Number(row['created_at']);
    return {
      id: String(row['id'] ?? ''),
      from: names.get(pubkey) ?? `member ${pubkey.slice(0, 6)}`,
      at: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '',
      text: String(row['content'] ?? '').slice(0, 800),
    };
  });
}

/**
 * Send one message and confirm it is in the channel. The text is one argv element, never
 * part of a shell string. `verified` is true only when the channel was read back and the
 * exact text is there.
 */
export async function sendMessage(
  run: BuzzJson,
  input: { channelId: string; content: string; mentionPubkeys: string[] },
): Promise<{ accepted: boolean; eventId: string; verified: boolean }> {
  const sent = (await run([
    'messages', 'send', '--channel', input.channelId, '--content', input.content,
    ...input.mentionPubkeys.flatMap((key) => ['--mention', key]),
  ])) as Record<string, unknown>;
  const accepted = sent['accepted'] === true;
  const eventId = String(sent['event_id'] ?? '');
  if (!accepted) return { accepted: false, eventId, verified: false };
  let verified = false;
  try {
    const recent = (await run(['messages', 'get', '--channel', input.channelId, '--limit', '10'])) as Array<Record<string, unknown>>;
    verified = (Array.isArray(recent) ? recent : []).some((row) => (eventId !== '' && row['id'] === eventId) || row['content'] === input.content);
  } catch {
    verified = false;
  }
  return { accepted, eventId, verified };
}
