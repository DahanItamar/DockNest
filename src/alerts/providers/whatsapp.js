// WhatsApp, Meta WhatsApp Cloud API only (docs/alert-channels.md, "WhatsApp"). No unofficial libraries, no WhatsApp Web.
// A template message is the default: the user creates one Utility template named `docknest_alert` once, body
// "DockNest alert: {{1}}. {{2}}. {{3}} Open DockNest for details." (title, site and server, reason). Clearing the template
// name falls back to free-form text, which Meta delivers only within 24 hours of a message from the recipient.
// The send answers 200 with a message id when Meta accepts it; later delivery errors arrive through a webhook DockNest
// does not have, so a test says "Accepted by WhatsApp." and never "Delivered".
import { z } from 'zod';
import { parts, plainText, cut, ok, failure, field, freeze } from './common.js';

export const GRAPH_VERSION = 'v23.0'; // pinned, bumped on purpose
export const DEFAULT_TEMPLATE = 'docknest_alert';
const token = z.string().trim().regex(/^[A-Za-z0-9_-]{20,1024}$/, 'Paste the access token exactly as Meta shows it.');
const phoneNumberId = z.string().trim().regex(/^\d{5,20}$/, 'Enter the phone number ID (digits only) from the WhatsApp Cloud API setup page.');
const to = z.string().trim().transform(value => value.replace(/^\+/, '').replace(/[\s()-]/g, '')).refine(value => /^[1-9]\d{6,14}$/.test(value), 'Enter the number with its country code, for example +15550100.');
const template = z.string().trim().refine(value => value === '' || /^[a-z0-9_]{1,512}$/.test(value), 'Template names use lowercase letters, digits and _ only. Leave it empty to send plain messages.').default(DEFAULT_TEMPLATE);
const language = z.string().trim().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/, 'Enter a language code such as en, en_US or he.').default('en');

// Template parameter rules: no newlines or tabs, never more than 4 spaces in a row (Meta error 132018, so any run is
// one space), trimmed, at most 200 characters, never empty.
export const parameter = value => cut(String(value ?? '').replace(/\s+/g, ' ').trim(), 200) || '-';

export default freeze({
  id: 'whatsapp', label: 'WhatsApp', icon: 'brand-whatsapp', group: 'common',
  fields: freeze([
    field({ key: 'token', label: 'Access token', type: 'password', secret: true, required: true, help: 'A permanent system user token. Temporary tokens from the developer page expire after about 24 hours.' }),
    field({ key: 'phoneNumberId', label: 'Phone number ID', type: 'text', required: true, help: 'From the WhatsApp Cloud API setup page in Meta for Developers.' }),
    field({ key: 'to', label: 'Send to', type: 'text', required: true, help: 'The number that gets the alerts, with its country code.' }),
    field({ key: 'template', label: 'Template name', type: 'text', more: true, default: DEFAULT_TEMPLATE, help: 'WhatsApp delivers alerts with an approved template. Create a Utility template named docknest_alert in WhatsApp Manager. Without a template, messages arrive only within 24 hours of a message from you to the business number.' }),
    field({ key: 'language', label: 'Language', type: 'text', more: true, default: 'en', help: 'The language code of the template, for example en.' }),
  ]),
  secretSchema: z.object({ token }).strict(),
  settingsSchema: z.object({ phoneNumberId, to, template, language }).strict(),
  destination: freeze(['to', 'phoneNumberId']),
  host: freeze([]),
  target: () => ({ hosts: ['graph.facebook.com'], base: 'https://graph.facebook.com' }),
  format: (message, values) => {
    const { title, where, reason } = parts(message), path = `/${GRAPH_VERSION}/${values.phoneNumberId}/messages`, headers = { Authorization: `Bearer ${values.token}` };
    if (!values.template) return { method: 'POST', path, headers, json: { messaging_product: 'whatsapp', to: values.to, type: 'text', text: { preview_url: false, body: cut(plainText(message), 4000) } } };
    const texts = [title, where || title, reason || title].map(parameter).map(text => ({ type: 'text', text }));
    return { method: 'POST', path, headers, json: { messaging_product: 'whatsapp', to: values.to, type: 'template', template: { name: values.template, language: { code: values.language }, components: [{ type: 'body', parameters: texts }] } } };
  },
  explain: (status, body) => {
    if (ok(status)) return Array.isArray(body?.messages) || body?.error === undefined ? null : { message: 'WhatsApp refused the message.', final: true };
    const code = Number(body?.error?.code);
    if (status === 401 || code === 190 || code === 10 || code === 200) return { message: 'WhatsApp does not accept this access token. Create a permanent system user token and paste it again.', final: true };
    if (code === 132001 || code === 132000) return { message: 'WhatsApp does not know this template. Check the template name and language in WhatsApp Manager.', final: true };
    if (code === 132012 || code === 132018 || code === 132005 || code === 132007 || code === 132015 || code === 132016) return { message: 'WhatsApp rejected the template. Check that the template matches the one in WhatsApp Manager and is approved.', final: true };
    if (code === 131047) return { message: 'WhatsApp delivers plain messages only within 24 hours of a message from you. Create the docknest_alert template.', final: true };
    if (code === 131030) return { message: 'This number is not allowed to get messages yet. Add it as a recipient in Meta for Developers.', final: true };
    if (code === 133010 || code === 100) return { message: 'WhatsApp could not find this phone number ID. Check the setup page in Meta for Developers.', final: true };
    if ([4, 17, 32, 613, 80007, 130429, 131048, 131056].includes(code)) return { message: 'WhatsApp asked DockNest to slow down.', final: false };
    return failure('WhatsApp', status, { login: [401, 403], loginText: 'WhatsApp does not accept this access token.', gone: [404], goneText: 'WhatsApp could not find this phone number ID.', otherText: 'WhatsApp refused the message.' });
  },
  unreachable: 'WhatsApp could not be reached.',
  // Shown after a test. A 200 only means Meta took the message.
  testNote: 'Accepted by WhatsApp. If it does not arrive, check the template name. Plain messages arrive only within 24 hours of a message from you.',
});
