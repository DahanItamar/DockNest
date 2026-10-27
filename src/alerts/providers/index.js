// Provider registry (docs/alert-channels.md, "Provider registry"). One file per provider; a new one needs no migration.
// A field is `secret` (write-only, never returned), `sealed` (kept inside the sealed value but shown: Email's SMTP
// account) or plain (a setting). Secret and sealed fields are sealed together as one value with the master key.
import telegram from './telegram.js';
import email from './email.js';

export const providers = Object.freeze({ telegram, email });
export const providerIds = Object.freeze(Object.keys(providers));
export const provider = id => (typeof id === 'string' && Object.hasOwn(providers, id) ? providers[id] : null);
const sealedKeys = item => item.fields.filter(field => field.secret || field.sealed).map(field => field.key);
// Splits a full set of values into the sealed part and the plain settings, by the field list.
export function split(id, values) {
  const sealed = new Set(sealedKeys(provider(id))), secret = {}, settings = {};
  for (const [key, value] of Object.entries(values ?? {})) (sealed.has(key) ? secret : settings)[key] = value;
  return { secret, settings };
}
// What the API and the UI may see of an opened sealed value: sealed (non-secret) members, and `<key>Set` for secrets.
export function sealedView(id, secret) {
  const item = provider(id); if (item.view) return item.view(secret);
  return Object.fromEntries(item.fields.filter(field => field.secret).map(field => [`${field.key}Set`, Boolean(secret?.[field.key])]));
}
// What the UI renders from (`GET /api/connections/providers`, PR 4): no schema code, no functions.
export const providerList = () => Object.values(providers).map(({ id, label, icon, group, fields }) => ({ id, label, icon, group, fields: fields.map(field => ({ ...field })) }));
