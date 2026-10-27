// Slack (docs/alert-channels.md, "Slack, Discord and Google Chat"). An incoming webhook URL is the login. It answers a
// plain `200 ok`, or 400 invalid_payload, 403, 404 no_service, 410 channel_is_archived: a rotated or removed webhook is
// a 404, which is final.
import { z } from 'zod';
import { parts, cut, slackEscape, urlField, failure, ok, field, freeze } from './common.js';

const webhook = urlField({
  label: 'webhook URL',
  check: url => {
    if (url.hostname !== 'hooks.slack.com') return 'Paste the webhook URL from Slack. It starts with https://hooks.slack.com/services/.';
    if (!/^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(url.pathname) || url.search) return 'This is not a Slack incoming webhook URL. It looks like https://hooks.slack.com/services/T.../B.../...';
    return null;
  },
  keep: url => `${url.origin}${url.pathname}`,
});

export default freeze({
  id: 'slack', label: 'Slack', icon: 'brand-slack', group: 'common',
  fields: freeze([field({ key: 'url', label: 'Webhook URL', type: 'url', secret: true, required: true, help: 'Create an Incoming Webhook for your workspace and paste its URL.' })]),
  secretSchema: z.object({ url: webhook }).strict(),
  settingsSchema: z.object({}).strict(),
  destination: freeze(['url']),
  host: freeze(['url']),
  target: () => ({ hosts: ['hooks.slack.com'] }),
  // Slack's only escapes are & < > (they also stop <!channel> and <@user> mentions); the title is bold, the link is <url|text>.
  format: (message, values) => {
    const { title, where, reason, url } = parts(message);
    return { method: 'POST', url: values.url, json: { text: cut([`*${slackEscape(title)}*`, where && slackEscape(where), reason && slackEscape(reason), url && `<${url}|Open job>`].filter(Boolean).join('\n'), 3500) } };
  },
  explain: (status, _body, { text = '' } = {}) => {
    if (ok(status)) return null;
    if (status === 410) return { message: 'This Slack channel is archived. Unarchive it or create a new webhook.', final: true };
    if (status === 400 && /invalid_payload|no_text/.test(text)) return { message: 'Slack refused the message.', final: true };
    return failure('Slack', status, { login: [401, 403, 404], loginText: 'Slack does not accept this webhook. Create a new one and paste it again.', otherText: 'Slack refused the message.' });
  },
  unreachable: 'Slack could not be reached.',
});
