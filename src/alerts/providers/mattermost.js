// Mattermost (docs/alert-channels.md, "Providers"). An incoming webhook URL on the user's own server is the login. The host is
// the user's, so it is checked at every send by outbound.js: public by default, a private address only for a Connection
// an administrator saved while "Allow private network" is on.
import { z } from 'zod';
import { parts, cut, markdownEscape, urlField, failure, field, freeze } from './common.js';

const webhook = urlField({
  label: 'webhook URL', allowHttp: true,
  check: url => (/^(?:\/[A-Za-z0-9._~-]+)*\/hooks\/[A-Za-z0-9]{20,40}$/.test(url.pathname) && !url.search ? null : 'This is not a Mattermost incoming webhook URL. It looks like https://chat.example.com/hooks/<id>.'),
});

export default freeze({
  id: 'mattermost', label: 'Mattermost', icon: 'message', group: 'common',
  fields: freeze([field({ key: 'url', label: 'Webhook URL', type: 'url', secret: true, required: true, help: 'Integrations, Incoming Webhooks. A server on your own network needs "Allow private network" in Connections settings.' })]),
  secretSchema: z.object({ url: webhook }).strict(),
  settingsSchema: z.object({}).strict(),
  destination: freeze(['url']),
  host: freeze(['url']),
  target: () => ({ hosts: 'user' }),
  format: (message, values) => {
    const { title, where, reason, url } = parts(message);
    return { method: 'POST', url: values.url, json: { text: cut([`**${markdownEscape(title)}**`, where && markdownEscape(where), reason && markdownEscape(reason), url && `[Open job](${url})`].filter(Boolean).join('\n\n'), 15000) } };
  },
  explain: status => failure('Mattermost', status, { login: [401, 403, 404, 410], loginText: 'Mattermost does not accept this webhook. Create a new one and paste it again.', otherText: 'Mattermost refused the message.' }),
  unreachable: 'Mattermost could not be reached.',
});
