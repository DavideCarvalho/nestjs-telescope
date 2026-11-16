// packages/core/test/alerts/integrations/chat.spec.ts
import { describe, expect, it } from 'vitest';
import {
  discordChannel,
  googleChatChannel,
  teamsChannel,
  telegramChannel,
} from '../../../src/alerts/integrations/chat.js';
import { type AlertEmailMessage, emailChannel } from '../../../src/alerts/integrations/email.js';
import { exceptionAlert, fakeSleep, metricAlert, mockFetch } from './helpers.js';

describe('discordChannel', () => {
  it('posts a native embed coloured by severity, with no mentions', async () => {
    const { fetch, calls } = mockFetch();
    await discordChannel({
      url: 'https://discord.com/api/webhooks/1/x',
      username: 'Telescope',
      fetch,
    }).send(exceptionAlert());
    const body = calls[0]?.json as Record<string, any>;
    expect(body.username).toBe('Telescope');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const embed = body.embeds[0];
    expect(embed.title).toContain('TypeError: cannot read <x> & y (POST /checkout)');
    expect(embed.url).toBe('https://telescope.example#/entries/view/ex-1');
    expect(embed.color).toBe(0xf04438);
    expect(embed.fields).toContainEqual({ name: 'Occurrences', value: '3', inline: true });
    expect(embed.description).toContain('at a');
  });

  it('turns green on resolve', async () => {
    const { fetch, calls } = mockFetch();
    await discordChannel({ url: 'https://d.example', fetch }).send(metricAlert('resolved'));
    expect((calls[0]!.json as any).embeds[0].color).toBe(0x12b76a);
  });
});

describe('discordMessage limits', () => {
  it("keeps the whole embed within Discord's 6000-character total", async () => {
    const { fetch, calls } = mockFetch();
    const base = exceptionAlert();
    const alert = {
      ...base,
      app: 'a'.repeat(900),
      diagnosis: 'd'.repeat(5000),
      exception: {
        ...base.exception!,
        stack: 's'.repeat(5000),
        route: `/${'r'.repeat(2000)}`,
        user: 'u'.repeat(2000),
      },
    };
    await discordChannel({ url: 'https://d.example', fetch }).send(alert);
    const embed = (calls[0]!.json as any).embeds[0];
    const total =
      embed.title.length +
      (embed.description?.length ?? 0) +
      embed.fields.reduce((n: number, f: any) => n + f.name.length + f.value.length, 0) +
      embed.footer.text.length;
    expect(total).toBeLessThanOrEqual(6000);
    expect(embed.fields.every((f: any) => f.value.length >= 1)).toBe(true);
  });
});

describe('teamsChannel', () => {
  it('posts an Adaptive Card attachment with facts and a link', async () => {
    const { fetch, calls } = mockFetch();
    await teamsChannel({ url: 'https://prod.workflows.example/x', fetch }).send(metricAlert());
    const body = calls[0]?.json as Record<string, any>;
    expect(body.type).toBe('message');
    const card = body.attachments[0];
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.type).toBe('AdaptiveCard');
    expect(card.content.body[1].facts).toContainEqual({ title: 'Value', value: '812.5' });
    expect(card.content.actions[0]).toMatchObject({ type: 'Action.OpenUrl' });
  });
});

describe('telegramChannel', () => {
  it('sends HTML-escaped text to the chat', async () => {
    const { fetch, calls } = mockFetch();
    await telegramChannel({ botToken: '123:ABC', chatId: -100, messageThreadId: 7, fetch }).send(
      exceptionAlert(),
    );
    expect(calls[0]?.url).toBe('https://api.telegram.org/bot123:ABC/sendMessage');
    const body = calls[0]?.json as Record<string, any>;
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBe(7);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('cannot read &lt;x&gt; &amp; y');
  });

  it('escapes quotes so a dashboard URL cannot break the href', async () => {
    const { fetch, calls } = mockFetch();
    const alert = { ...exceptionAlert(), dashboardUrl: 'https://t.example/"><b>x' };
    await telegramChannel({ botToken: 't', chatId: 1, fetch }).send(alert);
    const text = (calls[0]!.json as any).text as string;
    expect(text).toContain('<a href="https://t.example/&quot;&gt;&lt;b&gt;x#/entries/view/ex-1">');
  });

  it('never leaks the bot token in a failure', async () => {
    const { fetch } = mockFetch([new Error('getaddrinfo api.telegram.org/bot123:ABC')]);
    const { sleep } = fakeSleep();
    const error = await telegramChannel({ botToken: '123:ABC', chatId: 1, fetch, sleep })
      .send(metricAlert())
      .catch((e: Error) => e);
    expect((error as Error).message).not.toContain('123:ABC');
  });
});

describe('googleChatChannel', () => {
  it('threads by app + rule and sends a card', async () => {
    const { fetch, calls } = mockFetch();
    await googleChatChannel({
      url: 'https://chat.googleapis.com/v1/spaces/S/messages?key=K',
      fetch,
    }).send(metricAlert());
    expect(calls[0]?.url).toBe(
      'https://chat.googleapis.com/v1/spaces/S/messages?key=K&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    );
    const body = calls[0]?.json as Record<string, any>;
    expect(body.thread).toEqual({ threadKey: 'telescope-web-1-metric-threshold' });
    expect(body.cardsV2[0].card.header.title).toContain('request-p99-ms');
  });
});

describe('emailChannel', () => {
  it('sends through a nodemailer-style transport', async () => {
    const sent: AlertEmailMessage[] = [];
    const transport = {
      async sendMail(message: AlertEmailMessage) {
        sent.push(message);
        return { messageId: '1' };
      },
    };
    const channel = emailChannel({
      to: ['a@example.com', 'b@example.com'],
      from: 'alerts@example.com',
      transport,
    });
    await channel.send(exceptionAlert());
    expect(channel.name).toBe('email');
    expect(channel.acceptsResolved).toBe(true);
    expect(sent[0]?.to).toEqual(['a@example.com', 'b@example.com']);
    expect(sent[0]?.from).toBe('alerts@example.com');
    expect(sent[0]?.subject).toMatch(/^\[Telescope\] \[error\] web-1: TypeError/);
    expect(sent[0]?.text).toContain('Occurrences in window: 3');
    expect(sent[0]?.html).toContain('cannot read &lt;x&gt; &amp; y');
  });

  it('accepts a send function and escapes quotes in the HTML link', async () => {
    const sent: AlertEmailMessage[] = [];
    await emailChannel({
      to: 'a@b.c',
      subjectPrefix: '[prod]',
      transport: async (message) => {
        sent.push(message);
      },
    }).send({ ...metricAlert(), dashboardUrl: 'https://t.example/"x' });
    expect(sent[0]?.to).toEqual(['a@b.c']);
    expect(sent[0]?.from).toBeUndefined();
    expect(sent[0]?.subject).toMatch(/^\[prod\] /);
    expect(sent[0]?.html).toContain('<a href="https://t.example/&quot;x">');
  });

  it('rejects when the transport fails (the alerter isolates it)', async () => {
    const channel = emailChannel({
      to: 'a@b.c',
      transport: { sendMail: async () => Promise.reject(new Error('SMTP 550')) },
    });
    await expect(channel.send(metricAlert())).rejects.toThrow('SMTP 550');
  });

  it('fails closed at boot without recipients or a transport', () => {
    expect(() => emailChannel({ to: [], transport: async () => {} })).toThrow('missing to');
    expect(() =>
      emailChannel({ to: 'a@b.c', transport: undefined as unknown as () => Promise<void> }),
    ).toThrow('missing transport');
  });
});

describe('chat channel options', () => {
  it('fails closed on a missing url without echoing anything secret', () => {
    expect(() => discordChannel({ url: '' })).toThrow(
      "Telescope alert channel 'discord': missing url",
    );
    expect(() => telegramChannel({ botToken: '', chatId: 1 })).toThrow('missing botToken');
  });

  it('can opt out of resolved notifications and carries name/minSeverity', () => {
    const channel = teamsChannel({
      url: 'https://t.example',
      name: 'teams-ops',
      minSeverity: 'error',
      notifyResolved: false,
    });
    expect(channel).toMatchObject({
      name: 'teams-ops',
      minSeverity: 'error',
      acceptsResolved: false,
    });
  });
});
