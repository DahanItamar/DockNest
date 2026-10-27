// Matrix (docs/alert-channels.md, "Providers"). The user's homeserver (a custom port is fine on a private server; a public
// one is reached on 443 only), an access token (secret) and a room ID (never an alias, so no lookup request is ever made):
// `!opaque:server`, or the room version 12 form `!opaque` with no server part. The transaction ID is the outbox item's
// id, so a retry of the same message is the same event and never posts twice.
import { z } from 'zod';
import { parts, plainText, cut, htmlEscape, noMention, serverUrl, failure, field, freeze } from './common.js';

const token = z.string().trim().regex(/^[\x21-\x7e]{8,512}$/, 'Paste the access token exactly as your Matrix client shows it.');
const room = z.string().trim().max(255).refine(value => !/^[#@]/.test(value), 'Use the room ID that starts with !, not the room alias. In Element: Room settings, Advanced.')
  .refine(value => /^![A-Za-z0-9._~=+/-]{1,200}(?::[A-Za-z0-9.[\]:-]{1,100})?$/.test(value), 'Enter the room ID, for example !abc123:matrix.example.org.');

export default freeze({
  id: 'matrix', label: 'Matrix', icon: 'brand-matrix', group: 'common',
  fields: freeze([
    field({ key: 'server', label: 'Homeserver', type: 'url', required: true, help: 'For example https://matrix.example.org. A server on your own network needs "Allow private network" in Connections settings.' }),
    field({ key: 'room', label: 'Room ID', type: 'text', required: true, help: 'Starts with !, from Room settings, Advanced. Invite the bot user to the room first.' }),
    field({ key: 'token', label: 'Access token', type: 'password', secret: true, required: true, help: 'The access token of the account that posts the alerts.' }),
  ]),
  secretSchema: z.object({ token }).strict(),
  settingsSchema: z.object({ server: serverUrl('homeserver address'), room }).strict(),
  destination: freeze(['server', 'room']),
  host: freeze(['server']),
  target: values => ({ hosts: 'user', base: values?.server }),
  format: (message, values) => {
    const { title, where, reason, url } = parts(message), txn = String(message?.id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'docknest';
    const html = [`<b>${htmlEscape(title)}</b>`, where && htmlEscape(where), reason && htmlEscape(reason), url && `<a href="${htmlEscape(url)}">Open job</a>`].filter(Boolean).join('<br>');
    return {
      method: 'PUT', path: `/_matrix/client/v3/rooms/${encodeURIComponent(values.room).replace(/!/g, '%21')}/send/m.room.message/${encodeURIComponent(txn)}`, headers: { Authorization: `Bearer ${values.token}` },
      // `m.mentions` empty: this message mentions nobody; the zero-width space stops a legacy @room as well.
      json: { msgtype: 'm.text', body: cut(noMention(plainText(message, { link: 'Open the job' })), 8000), format: 'org.matrix.custom.html', formatted_body: cut(noMention(html), 12000), 'm.mentions': {} },
    };
  },
  // M_UNKNOWN_TOKEN (401), M_FORBIDDEN (403: not in the room, or no right to post), M_NOT_FOUND (404). The wait for a 429 is
  // `retry_after_ms` in the body, read by the core.
  explain: status => failure('Matrix', status, { login: [401], loginText: 'Matrix does not accept this access token.', gone: [403, 404, 410], goneText: 'Matrix could not post to this room. Check the room ID and that the account was invited and joined.', otherText: 'Matrix refused the message.' }),
  unreachable: 'The Matrix server could not be reached.',
});
