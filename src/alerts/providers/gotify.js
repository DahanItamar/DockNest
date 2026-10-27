// Gotify (docs/alert-channels.md, "Providers"). The user's own server; the application token is the secret. `POST /message`
// with `X-Gotify-Key`; the link rides in `extras` as a click action. Priority 8 for failures, 5 otherwise.
import { z } from 'zod';
import { parts, plainText, cut, urgent, serverUrl, failure, field, freeze } from './common.js';

const token = z.string().trim().regex(/^[A-Za-z0-9_.-]{8,128}$/, 'Paste the application token exactly as Gotify shows it.');

export default freeze({
  id: 'gotify', label: 'Gotify', icon: 'bell', group: 'common',
  fields: freeze([
    field({ key: 'server', label: 'Server', type: 'url', required: true, help: 'The address of your Gotify server. A server on your own network needs "Allow private network" in Connections settings.' }),
    field({ key: 'token', label: 'Application token', type: 'password', secret: true, required: true, help: 'Apps, Create application, then copy its token.' }),
  ]),
  secretSchema: z.object({ token }).strict(),
  settingsSchema: z.object({ server: serverUrl('server address') }).strict(),
  destination: freeze(['server']),
  host: freeze(['server']),
  target: values => ({ hosts: 'user', base: values?.server }),
  format: (message, values) => {
    const { title, url } = parts(message);
    return { method: 'POST', path: '/message', headers: { 'X-Gotify-Key': values.token }, json: { title: cut(title, 250), message: cut(plainText(message, { title: false, link: null }) || title, 4000), priority: urgent(message) ? 8 : 5, ...(url ? { extras: { 'client::notification': { click: { url } } } } : {}) } };
  },
  explain: status => failure('Gotify', status, { login: [401, 403], loginText: 'Gotify does not accept this application token.', gone: [404, 410], goneText: 'Gotify was not found at this server address.', otherText: 'Gotify refused the message.' }),
  unreachable: 'The Gotify server could not be reached.',
});
