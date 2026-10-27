// ntfy (docs/alert-channels.md, "Providers"). The public ntfy.sh or the user's own server; the topic is the destination and
// the access token (optional) is the secret. JSON publish: POST to the server root with `topic`, `title`, `message`,
// `click` and `priority` (4, "high", for failures). No tags, so no emoji.
import { z } from 'zod';
import { parts, plainText, cutBytes, urgent, serverUrl, topicName, failure, field, freeze } from './common.js';

const token = z.string().trim().max(256).regex(/^[A-Za-z0-9_-]*$/, 'Paste the access token exactly as ntfy shows it.').default('');

export default freeze({
  id: 'ntfy', label: 'ntfy', icon: 'bell-ringing', group: 'common',
  fields: freeze([
    field({ key: 'server', label: 'Server', type: 'url', required: true, default: 'https://ntfy.sh', help: 'https://ntfy.sh, or your own server. A server on your own network needs "Allow private network" in Connections settings.' }),
    field({ key: 'topic', label: 'Topic', type: 'text', required: true, help: 'Pick a long topic that is hard to guess, or use a token. On ntfy.sh anyone who knows a topic can read it.' }),
    field({ key: 'token', label: 'Access token', type: 'password', secret: true, help: 'Optional. For a protected topic.' }),
  ]),
  secretSchema: z.object({ token }).strict(),
  settingsSchema: z.object({ server: serverUrl('server address').default('https://ntfy.sh'), topic: topicName }).strict(),
  destination: freeze(['server', 'topic']),
  host: freeze(['server']),
  target: values => ({ hosts: 'user', base: values?.server }),
  format: (message, values) => {
    const { title, url } = parts(message);
    return { method: 'POST', path: '/', headers: values.token ? { Authorization: `Bearer ${values.token}` } : {}, json: { topic: values.topic, title: cutBytes(title, 250), message: cutBytes(plainText(message, { title: false, link: null }) || title, 4000), ...(url ? { click: url } : {}), ...(urgent(message) ? { priority: 4 } : {}) } };
  },
  explain: status => failure('ntfy', status, { login: [401, 403], loginText: 'ntfy does not accept this token, or the topic is protected.', gone: [404, 410], goneText: 'ntfy was not found at this server address.', otherText: 'ntfy refused the message.' }),
  unreachable: 'The ntfy server could not be reached.',
});
