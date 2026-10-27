// Google Chat (docs/alert-channels.md, "Slack, Discord and Google Chat"). The webhook URL carries a `key` and a `token` query
// value; both are part of the secret URL. 400 means the payload was refused; 403 or 404 means the webhook or app was removed.
import { z } from 'zod';
import { parts, cut, urlField, failure, field, freeze } from './common.js';

const webhook = urlField({
  label: 'webhook URL',
  check: url => {
    if (url.hostname !== 'chat.googleapis.com') return 'Paste the webhook URL from Google Chat. It starts with https://chat.googleapis.com/.';
    if (!/^\/v1\/spaces\/[A-Za-z0-9_-]+\/messages$/.test(url.pathname) || !url.searchParams.get('key') || !url.searchParams.get('token')) return 'This is not a Google Chat webhook URL. It has /v1/spaces/.../messages and key and token values.';
    if ([...url.searchParams.keys()].some(key => !['key', 'token', 'threadKey', 'messageReplyOption'].includes(key))) return 'This Google Chat webhook URL has parts DockNest does not use.';
    return null;
  },
});
// Google Chat text: *bold*, _italic_, ~strike~, `code`. A name cannot be escaped, so a zero-width space breaks each markup
// character; < > would make a <users/all> mention.
const plain = text => String(text).replace(/[<>]/g, ' ').replace(/([*_~`])/g, '​$1');

export default freeze({
  id: 'googlechat', label: 'Google Chat', icon: 'brand-google', group: 'common',
  fields: freeze([field({ key: 'url', label: 'Webhook URL', type: 'url', secret: true, required: true, help: 'Space settings, Apps and integrations, Webhooks.' })]),
  secretSchema: z.object({ url: webhook }).strict(),
  settingsSchema: z.object({}).strict(),
  destination: freeze(['url']),
  host: freeze(['url']),
  target: () => ({ hosts: ['chat.googleapis.com'] }),
  format: (message, values) => {
    const { title, where, reason, url } = parts(message);
    return { method: 'POST', url: values.url, json: { text: cut([`*${plain(title)}*`, where && plain(where), reason && plain(reason), url && `<${url}|Open job>`].filter(Boolean).join('\n'), 4000) } };
  },
  explain: status => failure('Google Chat', status, { login: [401, 403, 404, 410], loginText: 'Google Chat does not accept this webhook. Create a new one and paste it again.', otherText: 'Google Chat refused the message.' }),
  unreachable: 'Google Chat could not be reached.',
});
