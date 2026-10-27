// Alert API (docs/alert-channels.md, "API" and "Who may do what"). Two routers:
// - /api/connections: Connections (a login plus its destination), the provider list and the alert settings;
// - /api/alerts: the Map's alert nodes and lines, and one summary for the Map.
// Who: administrators always; operators only while an administrator has "Operators can manage alerts" on (off by default).
// The role is read from the session at every request, so turning the setting off applies to the operator's next request.
// Otherwise operators get 403 ALERTS_ADMIN_REQUIRED and no alert data. Admin-only: "Other (webhook URL)" writes and the
// alert settings. Creating, replacing or deleting a Connection, and any change of a secret, host or destination field,
// needs a recent re-verification (REAUTH_REQUIRED). Every write is audited with the actor's role and field names only.
// The 2.8 routes (/api/alerts/credentials, /api/alerts/channels) are gone: the Map uses these routes now.
// Tests: 10 per 10 minutes per user (shared by every kind of test). A failed operator test always answers with one fixed
// sentence exactly `operatorPolicy.failMs` (the 10 second request limit) after the request arrived, whatever the cause,
// so neither the words nor the answer time say anything about the network behind the address.
import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { recentlyVerified, requireAdmin, requireRecentAuth } from '../auth.js';
import { EVENTS, SOURCE_KINDS, DISK_USED_PERCENT, DISK_FREE_BYTES } from './events.js';
import { listRules, createRule, updateRule, deleteRule } from './store.js';
import { canManageAlerts, alertSettings, setAllowPrivateNetwork, setOperatorsManage, legacyChangedSinceImport, connectionLimits } from './connections.js';
import { providerList } from './providers/index.js';
import { listConnectionViews, createConnection, updateConnection, deleteConnection, testConnection, testValues, listNodes, createNode, updateNode, deleteNode, testNode, OPERATOR_TEST_FAILED } from './manage.js';
import { outboundLimits } from './outbound.js';

// Tests shorten failMs; nothing else changes it.
export const operatorPolicy = { failMs: outboundLimits.totalMs };
const uuid = z.uuid();
const wait = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const role = req => req.user.role; // always the session's role, never the body's
const context = req => ({ role: role(req), recent: recentlyVerified(req) });

// Errors: zod and store errors become their plain sentence and status; a field name lets the dialog mark that field.
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message ?? 'The request is not valid.' });
    if (error.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.nodes ? { nodes: error.nodes } : {}), ...(error.field ? { field: error.field } : {}) });
    next(error);
  }
};
// Administrators, or operators while the admin setting is on.
function gate(req, res, next) {
  if (canManageAlerts(req.user)) return next();
  return res.status(403).json({ error: 'Alerts are managed by an administrator.', code: 'ALERTS_ADMIN_REQUIRED' });
}
// Per user, not per address: people behind one proxy must not share one budget.
function perUser(scope, limit, windowMs) {
  return (req, res, next) => {
    const key = `${scope}:user:${req.user.id}`, now = Date.now(), previous = db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
    if (previous && previous.reset_at > now && previous.attempts >= limit) { res.set('Retry-After', String(Math.ceil((previous.reset_at - now) / 1000))); return res.status(429).json({ error: 'Too many tests. Try again in a few minutes.' }); }
    db.prepare('INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,reset_at=excluded.reset_at').run(key, previous && previous.reset_at > now ? previous.attempts + 1 : 1, previous && previous.reset_at > now ? previous.reset_at : now + windowMs);
    next();
  };
}
export const alertRateLimits = Object.freeze({ tests: 10, testWindowMs: 10 * 60_000, writes: 120, writeWindowMs: 10 * 60_000 });
const testLimit = perUser('alert-test', alertRateLimits.tests, alertRateLimits.testWindowMs), writeLimit = perUser('alert-write', alertRateLimits.writes, alertRateLimits.writeWindowMs);
// A test: administrators get the answer as it comes. An operator's failure, of any kind, answers one fixed sentence at a
// fixed time after the request arrived.
const testing = fn => handle(async (req, res) => {
  const started = Date.now();
  try { res.json(await fn(req)); }
  catch (error) {
    if (req.user.role === 'admin' || error.code !== 'TEST_FAILED') throw error;
    await wait(operatorPolicy.failMs - (Date.now() - started));
    res.status(502).json({ error: OPERATOR_TEST_FAILED, code: 'TEST_FAILED' });
  }
});

// ---- /api/connections --------------------------------------------------------------------------------------------
export const connectionRoutes = express.Router();
connectionRoutes.use(gate);
connectionRoutes.get('/', handle((req, res) => res.json({ connections: listConnectionViews(role(req)), settings: alertSettings(), legacyChanged: legacyChangedSinceImport(), limits: connectionLimits, role: role(req) })));
connectionRoutes.get('/providers', handle((_req, res) => res.json({ providers: providerList() })));
// Admin-only, decided by the session alone: requireAdmin, then the re-verification, then the setters (which check the
// role again and audit it).
const settingsBody = z.object({ allowPrivateNetwork: z.boolean().optional(), operatorsManage: z.boolean().optional() }).strict().refine(body => Object.keys(body).length > 0, 'Choose a setting to change.');
connectionRoutes.put('/settings', requireAdmin, requireRecentAuth, writeLimit, handle((req, res) => {
  const body = settingsBody.parse(req.body);
  if (body.allowPrivateNetwork !== undefined) setAllowPrivateNetwork(body.allowPrivateNetwork, req.user.id, req.user.role);
  if (body.operatorsManage !== undefined) setOperatorsManage(body.operatorsManage, req.user.id, req.user.role);
  res.json({ settings: alertSettings() });
}));
connectionRoutes.post('/test', testLimit, testing(req => testValues(req.body, req.user.id, context(req))));
connectionRoutes.post('/', writeLimit, handle((req, res) => res.status(201).json(createConnection(req.body, req.user.id, context(req)))));
connectionRoutes.patch('/:id', writeLimit, handle((req, res) => res.json(updateConnection(uuid.parse(req.params.id), req.body, req.user.id, context(req)))));
connectionRoutes.delete('/:id', writeLimit, handle((req, res) => res.json(deleteConnection(uuid.parse(req.params.id), req.user.id, context(req)))));
connectionRoutes.post('/:id/test', testLimit, testing(req => testConnection(uuid.parse(req.params.id), req.user.id, context(req))));

// ---- /api/alerts -------------------------------------------------------------------------------------------------
export const alertRoutes = express.Router();
alertRoutes.use(gate);
// The Map's one summary: nodes, lines, the Connections it can pick (no secrets) and the provider list.
alertRoutes.get('/', handle((req, res) => res.json({ nodes: listNodes(), rules: listRules(), connections: listConnectionViews(role(req)), providers: providerList(), events: EVENTS, sourceKinds: SOURCE_KINDS, diskLow: { usedPercent: DISK_USED_PERCENT, freeBytes: DISK_FREE_BYTES }, limits: connectionLimits, settings: alertSettings(), role: role(req) })));
alertRoutes.get('/nodes', handle((_req, res) => res.json({ nodes: listNodes() })));
alertRoutes.post('/nodes', writeLimit, handle((req, res) => res.status(201).json(createNode(req.body, req.user.id, context(req)))));
alertRoutes.patch('/nodes/:id', writeLimit, handle((req, res) => res.json(updateNode(uuid.parse(req.params.id), req.body, req.user.id, context(req)))));
alertRoutes.delete('/nodes/:id', writeLimit, handle((req, res) => res.json(deleteNode(uuid.parse(req.params.id), req.user.id, context(req)))));
alertRoutes.post('/nodes/:id/test', testLimit, testing(req => testNode(uuid.parse(req.params.id), req.user.id, context(req))));

// Lines. `nodeId` names the node; the 2.8 name `channelId` is still accepted for one release.
const withNode = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { nodeId, ...rest } = body;
  return nodeId !== undefined && rest.channelId === undefined ? { ...rest, channelId: nodeId } : rest;
};
alertRoutes.get('/rules', handle((_req, res) => res.json({ rules: listRules() })));
alertRoutes.post('/rules', writeLimit, handle((req, res) => res.status(201).json(createRule(withNode(req.body), req.user.id, { role: role(req) }))));
alertRoutes.patch('/rules/:id', writeLimit, handle((req, res) => res.json(updateRule(uuid.parse(req.params.id), req.body, req.user.id, { role: role(req) }))));
alertRoutes.delete('/rules/:id', writeLimit, handle((req, res) => res.json(deleteRule(uuid.parse(req.params.id), req.user.id, { role: role(req) }))));
