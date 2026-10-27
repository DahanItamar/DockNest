// Pushover (docs/alert-channels.md, "Providers"). Fixed host api.pushover.net; the application token and the user key are
// both secret. Priority 1 (high) for failures, 0 otherwise; never 2, which needs retry and expire handling. Pushover
// answers a refused login with 400 and the offending field, so those are read from the body but never echoed.
import { z } from 'zod';
import { parts, plainText, cut, urgent, failure, ok, field, freeze } from './common.js';

const key = label => z.string().trim().regex(/^[A-Za-z0-9]{30}$/, `Paste the ${label} exactly as Pushover shows it (30 letters and digits).`);

export default freeze({
  id: 'pushover', label: 'Pushover', icon: 'device-mobile', group: 'common',
  fields: freeze([
    field({ key: 'token', label: 'Application token', type: 'password', secret: true, required: true, help: 'Create an application at pushover.net and copy its API token.' }),
    field({ key: 'user', label: 'User key', type: 'password', secret: true, required: true, help: 'Shown on your Pushover dashboard.' }),
  ]),
  secretSchema: z.object({ token: key('application token'), user: key('user key') }).strict(),
  settingsSchema: z.object({}).strict(),
  destination: freeze(['user']),
  host: freeze([]),
  target: () => ({ hosts: ['api.pushover.net'], base: 'https://api.pushover.net' }),
  format: (message, values) => {
    const { title, url } = parts(message);
    return { method: 'POST', path: '/1/messages.json', json: { token: values.token, user: values.user, title: cut(title, 250), message: cut(plainText(message, { title: false, link: '' }).replace(/\n?: ?https?:\/\/\S+$/, '') || title, 1024), priority: urgent(message) ? 1 : 0, ...(url && url.length <= 512 ? { url, url_title: 'Open job' } : {}) } };
  },
  explain: (status, body) => {
    if (ok(status)) return body?.status === 0 ? { message: 'Pushover refused the message.', final: true } : null;
    if (status === 400 && (body?.token === 'invalid' || body?.user === 'invalid')) return { message: 'Pushover does not accept this application token or user key.', final: true };
    return failure('Pushover', status, { login: [401, 403], loginText: 'Pushover does not accept this application token or user key.', otherText: 'Pushover refused the message.' });
  },
  unreachable: 'Pushover could not be reached.',
});
