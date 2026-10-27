// Discord (docs/alert-channels.md, "Slack, Discord and Google Chat"). The webhook URL is the login, so it is the secret.
// Fixed hosts only. A thread webhook keeps its `?thread_id=`; `?wait=true` makes Discord answer with the created message
// (200) instead of an empty 204, so a refused body shows up as an error.
import { z } from 'zod';
import { parts, cut, markdownEscape, urgent, urlField, failure, ok, field, freeze } from './common.js';

export const DISCORD_HOSTS = freeze(['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com']);
const webhook = urlField({
  label: 'webhook URL',
  check: url => {
    if (!DISCORD_HOSTS.includes(url.hostname)) return 'Paste the webhook URL from Discord (Server settings, Integrations, Webhooks).';
    if (!/^\/api\/webhooks\/\d{15,25}\/[A-Za-z0-9_-]{20,100}$/.test(url.pathname)) return 'This is not a Discord webhook URL. It looks like https://discord.com/api/webhooks/.../...';
    if ([...url.searchParams.keys()].some(key => key !== 'thread_id') || (url.searchParams.has('thread_id') && !/^\d{15,25}$/.test(url.searchParams.get('thread_id')))) return 'Only ?thread_id=<number> may follow a Discord webhook URL.';
    return null;
  },
  keep: url => `${url.origin}${url.pathname}${url.searchParams.has('thread_id') ? `?thread_id=${url.searchParams.get('thread_id')}` : ''}`,
});

export default freeze({
  id: 'discord', label: 'Discord', icon: 'brand-discord', group: 'common',
  fields: freeze([field({ key: 'url', label: 'Webhook URL', type: 'url', secret: true, required: true, help: 'Server settings, Integrations, Webhooks. A thread webhook (with ?thread_id=) works too.' })]),
  secretSchema: z.object({ url: webhook }).strict(),
  settingsSchema: z.object({}).strict(),
  destination: freeze(['url']),
  host: freeze(['url']),
  target: () => ({ hosts: DISCORD_HOSTS }),
  format: (message, values) => {
    const { title, where, reason, url } = parts(message), body = [`**${markdownEscape(title)}**`, where && markdownEscape(where), reason && markdownEscape(reason), url && `<${url}>`].filter(Boolean).join('\n');
    return { method: 'POST', url: `${values.url}${values.url.includes('?') ? '&' : '?'}wait=true`, json: { content: cut(body, 2000), allowed_mentions: { parse: [] } } };
  },
  explain: (status, body) => {
    if (ok(status)) return body && typeof body.code === 'number' ? { message: 'Discord refused the message.', final: true } : null;
    return failure('Discord', status, { login: [401, 403, 404, 410], loginText: 'Discord does not accept this webhook. Create a new one and paste it again.', otherText: 'Discord refused the message.' });
  },
  unreachable: 'Discord could not be reached.',
});
