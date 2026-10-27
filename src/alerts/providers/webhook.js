// Other (webhook URL), under Advanced (docs/alert-channels.md, "Providers"). Any URL that takes a fixed JSON body:
// { title, site, server, message, url, event, at }. The URL and the optional header are the login, so both are secret.
// The header is one line `Name: value`: `Authorization` or an `X-` name, printable ASCII, 1 KB at most, and never one that
// would change how the request is framed or routed.
import { z } from 'zod';
import { parts, line, plainLine, urlField, failure, field, freeze } from './common.js';

const REFUSED_HEADERS = /^(?:host|content-length|content-type|transfer-encoding|te|trailer|connection|keep-alive|upgrade|expect|cookie|proxy-.*|:.*)$/i;
export function readHeader(text) {
  const value = String(text ?? '');
  if (!value.trim()) return { header: null };
  if (value.length > 1024 || !/^[\x20-\x7e]+$/.test(value)) return { problem: 'The header must be one line of plain characters, up to 1 KB.' };
  const match = /^([A-Za-z0-9-]+):[ \t]*(\S.*?)[ \t]*$/.exec(value);
  if (!match) return { problem: 'Write the header as Name: value, for example Authorization: Bearer abc.' };
  if (REFUSED_HEADERS.test(match[1])) return { problem: 'DockNest sets this header itself. Use Authorization or a name that starts with X-.' };
  if (!/^authorization$/i.test(match[1]) && !/^x-/i.test(match[1])) return { problem: 'The header name must be Authorization or start with X-.' };
  return { header: { name: match[1], value: match[2] } };
}
const webhook = urlField({ label: 'webhook URL', allowHttp: true });
const header = z.string().max(1024, 'The header must be one line of plain characters, up to 1 KB.').default('').superRefine((value, ctx) => { const read = readHeader(value); if (read.problem) ctx.addIssue({ code: 'custom', message: read.problem }); });

// The exact body, also shown to the user in the dialog (PR 4).
export const body = message => { const { title, event, at, url } = parts(message); return { title, site: line(message?.site), server: line(message?.server), message: plainLine(message), url: url || null, event, at }; };

export default freeze({
  id: 'webhook', label: 'Other (webhook URL)', icon: 'webhook', group: 'advanced',
  fields: freeze([
    field({ key: 'url', label: 'Webhook URL', type: 'url', secret: true, required: true, help: 'For advanced users. DockNest sends a POST with a fixed JSON body.' }),
    field({ key: 'header', label: 'Header', type: 'password', secret: true, more: true, help: 'Optional, one line: Authorization: Bearer ... or X-Name: value.' }),
  ]),
  secretSchema: z.object({ url: webhook, header }).strict(),
  settingsSchema: z.object({}).strict(),
  destination: freeze(['url']),
  host: freeze(['url']),
  target: () => ({ hosts: 'user' }),
  body,
  format(message, values) {
    const { header: extra } = readHeader(values.header);
    return { method: 'POST', url: values.url, ...(extra ? { headers: { [extra.name]: extra.value } } : {}), json: body(message) };
  },
  explain: status => failure('The webhook', status, { login: [401, 403], loginText: 'The webhook does not accept this login. Check the header.', gone: [404, 410], goneText: 'The webhook address no longer exists. Check the URL.', otherText: 'The webhook refused the message.' }),
  unreachable: 'The webhook could not be reached.',
});
