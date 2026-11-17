import { describe, expect, it, vi } from 'vitest';
import { channelMembers, listChannels, matchChannel, readMessages, sendMessage } from './buzz.js';
import { __clearRegistry, registerMeeting, setListeningPaused } from '../meeting/registry.js';
import { __clearOwnerUtterancesForTests, agentSaidSince, classifyAnswer, clearOwnerUtterances, ownerAnswerBetween, recordAgentSpoken, recordOwnerUtterance } from './confirm.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const channels = [
  { id: 'c1', name: '3cats' },
  { id: 'c2', name: 'globex' },
  { id: 'c3', name: 'PNW Implant Site' },
  { id: 'c4', name: 'PNW Emergency Site' },
];

describe('matchChannel', () => {
  it('finds a channel by its exact name, whatever the case or a leading #', () => {
    expect(matchChannel(channels, '#Globex')).toEqual({ channel: channels[1] });
    expect(matchChannel(channels, 'pnw implant site')).toEqual({ channel: channels[2] });
  });

  it('accepts a partial name only when one channel fits', () => {
    expect(matchChannel(channels, 'implant')).toEqual({ channel: channels[2] });
    expect(matchChannel(channels, 'PNW')).toEqual({ candidates: ['PNW Implant Site', 'PNW Emergency Site'] });
  });

  it('returns every channel when nothing fits, so the agent asks', () => {
    expect(matchChannel(channels, 'marketing')).toEqual({ candidates: channels.map((c) => c.name) });
  });
});

describe('Buzz CLI calls', () => {
  it('lists channels without direct-message threads', async () => {
    const run = vi.fn(async () => [{ channel_id: 'c1', name: '3cats' }, { channel_id: 'd1', name: 'DM' }]);
    expect(await listChannels(run)).toEqual([{ id: 'c1', name: '3cats' }]);
  });

  it('names channel members, and still lists them when names cannot be read', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('members')) return [{ pubkey: KEY_A, role: 'admin' }, { pubkey: KEY_B, role: 'member' }, { pubkey: 'not-a-key' }];
      throw new Error('users unavailable');
    });
    expect(await channelMembers(run, 'c1')).toEqual([{ pubkey: KEY_A, name: 'member aaaaaa' }, { pubkey: KEY_B, name: 'member bbbbbb' }]);
  });

  it('reads messages with sender names and ISO times', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('members')) return [{ pubkey: KEY_A }];
      if (args.includes('users')) return [{ pubkey: KEY_A, display_name: 'Nick Rivera' }];
      return [{ id: 'e1', pubkey: KEY_A, created_at: 1794700000, content: 'Looks good.' }];
    });
    const messages = await readMessages(run, channels[0]!, 5);
    expect(messages).toEqual([{ id: 'e1', from: 'Nick Rivera', at: new Date(1794700000 * 1000).toISOString(), text: 'Looks good.' }]);
  });

  it('sends the text as one argument and confirms it by reading the channel back', async () => {
    const text = 'On it; $(rm -rf ~) "quotes" `ticks`';
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('send')) return { accepted: true, event_id: 'evt1', message: 'ok' };
      return [{ id: 'evt1', content: text }];
    });
    const result = await sendMessage(run, { channelId: 'c1', content: text, mentionPubkeys: [KEY_A] });
    expect(result).toEqual({ accepted: true, eventId: 'evt1', verified: true });
    const sendArgs = run.mock.calls[0]![0];
    expect(sendArgs).toEqual(['messages', 'send', '--channel', 'c1', '--content', text, '--mention', KEY_A]);
  });

  it('reports an unaccepted send, and an accepted one that is not in the channel', async () => {
    expect(await sendMessage(vi.fn(async () => ({ accepted: false })), { channelId: 'c1', content: 'x', mentionPubkeys: [] })).toMatchObject({ accepted: false, verified: false });
    const run = vi.fn(async (args: string[]) => (args.includes('send') ? { accepted: true, event_id: 'e' } : []));
    expect(await sendMessage(run, { channelId: 'c1', content: 'x', mentionPubkeys: [] })).toMatchObject({ accepted: true, verified: false });
  });
});

describe('the spoken confirmation', () => {
  it('needs the owner to say that it should be sent', () => {
    for (const yes of ['Send it.', 'yes, send it', 'Go ahead and send that', 'okay send the message']) expect(classifyAnswer(yes)).toBe('yes');
    for (const no of ['No', "don't send that", 'wait, change the last part', 'send it, but change Monday to Tuesday', 'cancel']) expect(classifyAnswer(no)).toBe('no');
    // A bare yes could be the answer to something else.
    for (const neither of ['yes', 'okay', 'sounds good', 'um', 'what time is it', 'send it '.repeat(10)]) expect(classifyAnswer(neither)).toBe('none');
  });

  it('counts only what the owner said inside the window, newest answer first', () => {
    __clearOwnerUtterancesForTests();
    recordOwnerUtterance('m', 'send it', 1000);
    expect(ownerAnswerBetween('m', 2000, 9000)).toBe('none');
    recordOwnerUtterance('m', 'send it', 3000);
    recordOwnerUtterance('m', 'um', 3500);
    expect(ownerAnswerBetween('m', 2000, 9000)).toBe('yes');
    recordOwnerUtterance('m', 'wait, stop', 4000);
    expect(ownerAnswerBetween('m', 2000, 9000)).toBe('no');
    // Too late does not count either.
    recordOwnerUtterance('m', 'send it', 20000);
    expect(ownerAnswerBetween('m', 2000, 9000)).toBe('no');
    expect(ownerAnswerBetween('other', 0, 9e15)).toBe('none');
  });

  it('forgets everything when asked to', () => {
    __clearOwnerUtterancesForTests();
    recordOwnerUtterance('m', 'send it', 3000);
    clearOwnerUtterances('m');
    expect(ownerAnswerBetween('m', 0, 9e15)).toBe('none');
  });
});

describe('stop listening', () => {
  it('forgets what the owner said when listening is paused', () => {
    __clearRegistry();
    __clearOwnerUtterancesForTests();
    registerMeeting({ meetingId: 'mp', teammate: 'david', persona: 'first_person', title: 'Pause' });
    recordOwnerUtterance('mp', 'send it', 3000);
    setListeningPaused('mp', true);
    expect(ownerAnswerBetween('mp', 0, 9e15)).toBe('none');
  });
});

describe('what the agent actually said', () => {
  it('matches the stored text without case or punctuation, and only after the given time', () => {
    __clearOwnerUtterancesForTests();
    recordAgentSpoken('m', 'Buzz draft for the 3cats channel. The message says: The homepage is LIVE!', 5000);
    expect(agentSaidSince('m', 1000, ['3cats', 'the homepage is live'])).toBe(true);
    expect(agentSaidSince('m', 6000, ['3cats', 'the homepage is live'])).toBe(false);
    expect(agentSaidSince('m', 1000, ['globex', 'the homepage is live'])).toBe(false);
    expect(agentSaidSince('m', 1000, ['3cats', 'the homepage is live now'])).toBe(false);
    expect(agentSaidSince('m', 1000, [])).toBe(false);
    // A part with nothing checkable in it refuses, rather than being skipped.
    expect(agentSaidSince('m', 1000, ['3cats', '!!!'])).toBe(false);
    recordAgentSpoken('m', 'Für das Café: Ｈｅｌｌｏ', 7000);
    expect(agentSaidSince('m', 6500, ['für das café hello'])).toBe(true);
    expect(agentSaidSince('m', 6500, ['fur das cafe hello'])).toBe(false);
  });
});
