// Alert channels and rules (docs/alerts.md). A channel's whole configuration is sealed with the master key
// (src/crypto.js, like SSH keys and the Cloudflare token), opened only to send a message, and never returned: views carry
// the harmless fields and "set" flags for secrets. Nothing here logs or audits a secret.
import { z } from 'zod';
import { db, id, audit } from '../db.js';
import { seal, open } from '../crypto.js';
import { EVENTS } from './events.js';
import { mailbox } from './smtp.js';

export const limits = Object.freeze({ channels: 20, rules: 200 });
export const httpError = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

const hostname = z.string().trim().min(1).max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[?[0-9A-Fa-f:.]+\]?$/, 'Enter the mail server name, for example smtp.example.com.');
const address = z.string().trim().max(254).refine(value => mailbox(value), 'Enter a plain email address, for example alerts@example.com.');
export const telegramConfig = z.object({ token: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/, 'Paste the bot token exactly as BotFather shows it.'), chatId: z.string().trim().regex(/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/, 'Enter the chat ID (a number) or the @name of a public channel.') }).strict();
export const emailConfig = z.object({
  host: hostname, port: z.number().int().min(1).max(65535), security: z.enum(['starttls', 'tls']),
  username: z.string().max(254).default(''), password: z.string().max(512).default(''),
  from: address, to: z.array(address).min(1).max(5),
}).strict().refine(value => !value.username === !value.password, { message: 'Enter both the user name and the password, or leave both empty.', path: ['password'] });
const configSchemas = { telegram: telegramConfig, email: emailConfig };
const name = z.string().trim().min(1).max(80);
export const channelCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('telegram'), name, config: telegramConfig }).strict(),
  z.object({ kind: z.literal('email'), name, config: emailConfig }).strict(),
]);

const fail = error => { throw httpError(400, error.issues?.[0]?.message ?? 'The settings are not valid.'); };
const parseConfig = (kind, value) => { const result = configSchemas[kind].safeParse(value); if (!result.success) fail(result.error); return result.data; };

export function channelConfig(row) { return JSON.parse(open(row.config)); }
// Display form: never the token or the password.
function configView(kind, config) {
  return kind === 'telegram'
    ? { chatId: config.chatId, tokenSet: Boolean(config.token) }
    : { host: config.host, port: config.port, security: config.security, username: config.username, passwordSet: Boolean(config.password), from: config.from, to: config.to };
}
export function channelView(row) {
  let config; try { config = configView(row.kind, channelConfig(row)); } catch { config = null; }
  return { id: row.id, kind: row.kind, name: row.name, config, configReadable: config !== null, createdAt: row.created_at, updatedAt: row.updated_at, lastResult: row.last_result, lastResultAt: row.last_result_at, lastError: row.last_error };
}
export const listChannels = () => db.prepare('SELECT * FROM alert_channels ORDER BY created_at,id').all().map(channelView);
export const getChannel = channelId => db.prepare('SELECT * FROM alert_channels WHERE id=?').get(channelId) ?? null;
const mustChannel = channelId => getChannel(channelId) ?? (() => { throw httpError(404, 'This channel does not exist.'); })();

export function createChannel(input, actor) {
  const data = channelCreate.safeParse(input); if (!data.success) fail(data.error);
  if (db.prepare('SELECT COUNT(*) AS n FROM alert_channels').get().n >= limits.channels) throw httpError(409, `You can have up to ${limits.channels} alert channels.`);
  const channelId = id(), at = now();
  db.prepare('INSERT INTO alert_channels(id,kind,name,config,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(channelId, data.data.kind, data.data.name, seal(JSON.stringify(data.data.config)), at, at);
  audit(actor, 'alert.channel.create', channelId, { kind: data.data.kind });
  return channelView(getChannel(channelId));
}
// Secrets left out of `config` keep their saved value. Changing the mail server, port or encryption requires typing the
// password again, so a saved password can never be redirected by editing those alone.
export function updateChannel(channelId, input, actor) {
  const row = mustChannel(channelId);
  const patch = z.object({ name: name.optional(), config: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(input); if (!patch.success) fail(patch.error);
  let current; try { current = channelConfig(row); } catch { current = {}; }
  const incoming = patch.data.config ?? {};
  const merged = { ...current, ...Object.fromEntries(Object.entries(incoming).filter(([key, value]) => !(['token', 'password'].includes(key) && (value === undefined || value === '')))) };
  if (row.kind === 'email' && 'username' in incoming && !incoming.username) merged.password = '';
  if (row.kind === 'email' && merged.password && !incoming.password && ['host', 'port', 'security'].some(key => key in incoming && incoming[key] !== current[key])) throw httpError(400, 'Enter the password again when you change the mail server, port or encryption.');
  const config = parseConfig(row.kind, merged);
  db.prepare('UPDATE alert_channels SET name=?,config=?,updated_at=?,last_result=NULL,last_result_at=NULL,last_error=NULL WHERE id=?').run(patch.data.name ?? row.name, seal(JSON.stringify(config)), now(), channelId);
  audit(actor, 'alert.channel.update', channelId, { kind: row.kind, fields: Object.keys(incoming).slice(0, 12) }); // field names only, never values
  return channelView(getChannel(channelId));
}
export function deleteChannel(channelId, actor) {
  const row = mustChannel(channelId);
  db.prepare('DELETE FROM alert_channels WHERE id=?').run(channelId);
  audit(actor, 'alert.channel.delete', channelId, { kind: row.kind });
  return { deleted: true };
}
export function recordResult(channelId, ok, error = null) {
  db.prepare('UPDATE alert_channels SET last_result=?,last_result_at=?,last_error=? WHERE id=?').run(ok ? 'ok' : 'failed', now(), ok ? null : String(error ?? 'The message could not be sent.').slice(0, 200), channelId);
}

// ---- Rules -------------------------------------------------------------------------------------------------------
const events = z.array(z.enum(EVENTS)).min(1).max(EVENTS.length).transform(list => [...new Set(list)]);
export const ruleCreate = z.object({ channelId: z.uuid(), sourceKind: z.enum(['docknest', 'server', 'site']), sourceId: z.uuid().nullable().default(null), events, enabled: z.boolean().default(true) }).strict();
export const ruleUpdate = z.object({ events: events.optional(), enabled: z.boolean().optional() }).strict();
export function ruleView(row) { return { id: row.id, channelId: row.channel_id, sourceKind: row.source_kind, sourceId: row.source_id, events: JSON.parse(row.events), enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at }; }
export const listRules = () => db.prepare('SELECT * FROM alert_rules ORDER BY created_at,id').all().map(ruleView);
export function enabledRules() { return db.prepare('SELECT * FROM alert_rules WHERE enabled=1').all().map(row => ({ ...row, enabled: true, events: JSON.parse(row.events) })); }

export function createRule(input, actor) {
  const data = ruleCreate.safeParse(input); if (!data.success) fail(data.error);
  const { channelId, sourceKind, sourceId } = data.data;
  mustChannel(channelId);
  if ((sourceKind === 'docknest') !== (sourceId === null)) throw httpError(400, sourceKind === 'docknest' ? 'A DockNest line has no source id.' : 'Choose the server or site for this line.');
  if (sourceKind === 'server' && !db.prepare('SELECT 1 FROM servers WHERE id=?').get(sourceId)) throw httpError(404, 'This server does not exist.');
  if (sourceKind === 'site' && !db.prepare('SELECT 1 FROM sites WHERE id=?').get(sourceId)) throw httpError(404, 'This site does not exist.');
  if (db.prepare('SELECT COUNT(*) AS n FROM alert_rules').get().n >= limits.rules) throw httpError(409, `You can have up to ${limits.rules} alert lines.`);
  if (db.prepare('SELECT 1 FROM alert_rules WHERE channel_id=? AND source_kind=? AND source_id IS ?').get(channelId, sourceKind, sourceId)) throw httpError(409, 'This source already has a line to this channel. Edit that line instead.');
  const ruleId = id(), at = now();
  db.prepare('INSERT INTO alert_rules(id,channel_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(ruleId, channelId, sourceKind, sourceId, JSON.stringify(data.data.events), data.data.enabled ? 1 : 0, at, at);
  audit(actor, 'alert.rule.create', ruleId, { channelId, sourceKind, sourceId, events: data.data.events });
  return ruleView(db.prepare('SELECT * FROM alert_rules WHERE id=?').get(ruleId));
}
export function updateRule(ruleId, input, actor) {
  const row = db.prepare('SELECT * FROM alert_rules WHERE id=?').get(ruleId); if (!row) throw httpError(404, 'This line does not exist.');
  const data = ruleUpdate.safeParse(input); if (!data.success) fail(data.error);
  db.prepare('UPDATE alert_rules SET events=?,enabled=?,updated_at=? WHERE id=?').run(JSON.stringify(data.data.events ?? JSON.parse(row.events)), (data.data.enabled ?? row.enabled === 1) ? 1 : 0, now(), ruleId);
  audit(actor, 'alert.rule.update', ruleId, { events: data.data.events, enabled: data.data.enabled });
  return ruleView(db.prepare('SELECT * FROM alert_rules WHERE id=?').get(ruleId));
}
export function deleteRule(ruleId, actor) {
  if (!db.prepare('SELECT 1 FROM alert_rules WHERE id=?').get(ruleId)) throw httpError(404, 'This line does not exist.');
  db.prepare('DELETE FROM alert_rules WHERE id=?').run(ruleId);
  audit(actor, 'alert.rule.delete', ruleId, {});
  return { deleted: true };
}
