// Read model for the restore test API (docs/restore-tests.md, "API contract"): the site card, the test detail for the
// Jobs timeline, and each backup's tested state. Only names, states, times and plain sentences leave here; the engine
// state (`progress`) and job details stay inside.
import { z } from 'zod';
import { db } from '../db.js';
import { loadTest, loadSteps, testState, LABELS } from './engine.js';
import { settingsRow, settingsView } from './settings.js';
import { recoveryTime } from '../../shared/recovery-time.js';
import { siteCopyTargets, targetSummary } from '../site-storage.js';

const PAGE = 20;
const serverName = serverId => db.prepare('SELECT name FROM servers WHERE id=?').get(serverId)?.name ?? null;
const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
const cursorSchema = z.string().max(512).transform((value, context) => {
  try { return z.tuple([z.string().min(1).max(64), z.string().min(1).max(64)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid pagination cursor.' }); return z.NEVER; }
});
export const cardQuery = z.object({ cursor: cursorSchema.optional(), backupId: z.uuid().optional() });

// What a test read (docs/restore-tests.md, "Testing a copy"): the source Copy backup recorded, or, before that step, the
// copy the test was asked to use. null for tests that read the main package before 3.0.0 recorded sources.
const destinationName = targetId => targetSummary(targetId)?.name ?? 'Removed destination';
export function sourceOf(limits, progress) {
  const chosen = typeof limits?.sourceTargetId === 'string' ? limits.sourceTargetId : null, used = progress?.source;
  if (used && ['main', 'copy'].includes(used.role)) return { role: used.role, name: used.name || destinationName(used.targetId), chosen: !!chosen };
  return chosen ? { role: 'copy', name: destinationName(chosen), chosen: true } : null;
}
// The settings sheet's "Test from" choices: the app's copy destinations, in the owner's order, then the saved choice
// when the app no longer copies there (it stays selectable until the owner changes it).
function copyChoices(siteId, saved) {
  const ids = siteCopyTargets(siteId).map(row => row.target_id);
  if (saved && !ids.includes(saved)) ids.push(saved);
  return ids.map(targetId => { const target = targetSummary(targetId); return { targetId, name: target?.name ?? 'Removed destination', mode: target?.mode ?? null }; });
}

export function cardFor(siteId, { cursor, backupId } = {}) {
  const last = db.prepare('SELECT * FROM restore_tests WHERE site_id=? AND result IS NOT NULL ORDER BY finished_at DESC,id DESC LIMIT 1').get(siteId);
  const active = db.prepare("SELECT * FROM restore_tests WHERE site_id=? AND (result IS NULL OR cleanup='pending') ORDER BY created_at DESC,id DESC LIMIT 1").get(siteId);
  const where = ['site_id=?'], params = [siteId];
  if (backupId) { where.push('backup_id=?'); params.push(backupId); }
  if (cursor) { where.push('(created_at,id)<(?,?)'); params.push(...cursor); }
  const rows = db.prepare(`SELECT id,backup_id,backup_captured_at,trigger,result,finished_at,restore_seconds,created_at FROM restore_tests WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params, PAGE + 1);
  const page = rows.slice(0, PAGE), end = page.at(-1), settings = settingsView(settingsRow(siteId));
  const recovery = recoverySecondsOf(page);
  return {
    settings,
    copyTargets: copyChoices(siteId, settings.sourceTargetId),
    last: last ? { id: last.id, result: last.result, finishedAt: last.finished_at, restoreSeconds: last.restore_seconds, recovery: recoveryBySite(siteId).get(siteId) ?? null, internet: !!parse(last.limits, {}).internet, failedStep: last.failed_step, reason: last.reason, serverName: serverName(last.server_id), source: sourceOf(parse(last.limits, {}), parse(last.progress, {})) } : null,
    active: active ? { id: active.id, state: testState(active), step: active.step ?? 'check_space' } : null,
    items: page.map(row => ({ recoverySeconds: recovery.get(row.id) ?? null, id: row.id, backupId: row.backup_id, backupCapturedAt: row.backup_captured_at, trigger: row.trigger, result: row.result, finishedAt: row.finished_at, restoreSeconds: row.restore_seconds })),
    next: rows.length > PAGE ? Buffer.from(JSON.stringify([end.created_at, end.id])).toString('base64url') : null,
  };
}

export function detailFor(testId) {
  const test = loadTest(testId);
  if (!test) return null;
  return {
    id: test.id, siteId: test.site_id, backupId: test.backup_id, backupCapturedAt: test.backup_captured_at, serverId: test.server_id,
    serverName: serverName(test.server_id), trigger: test.trigger, state: testState(test),
    result: test.result, failedStep: test.failed_step, reason: test.reason, restoreSeconds: test.restore_seconds, totalSeconds: test.total_seconds,
    createdAt: test.created_at, startedAt: test.started_at, finishedAt: test.finished_at, deadlineAt: test.deadline_at, cancelRequested: test.cancel_requested,
    cleanup: test.cleanup,
    limits: { memoryMb: test.limits.memoryMb, cpus: test.limits.cpus, timeLimitMinutes: test.limits.timeLimitMinutes, internet: !!test.limits.internet },
    source: sourceOf(test.limits, test.progress),
    steps: loadSteps(test.id).map(step => ({ step: step.step, label: LABELS[step.step], state: step.state, startedAt: step.started_at, finishedAt: step.finished_at, detail: step.detail })),
    checks: (Array.isArray(test.checks) ? test.checks : []).map(check => ({ name: check.name, kind: check.kind, target: check.target ?? null, status: check.status, detail: check.detail ?? null })),
  };
}

// backup.restoreTest: the newest passed or failed test of each backup. couldnt_run and cancelled say nothing about it.
export function backupTestStates(backupIds) {
  const states = new Map();
  for (let index = 0; index < backupIds.length; index += 500) {
    const chunk = backupIds.slice(index, index + 500);
    if (!chunk.length) continue;
    const rows = db.prepare(`SELECT backup_id,id,result,finished_at FROM restore_tests WHERE backup_id IN (${chunk.map(() => '?').join(',')}) AND result IN ('passed','failed') ORDER BY finished_at DESC,id DESC`).all(...chunk);
    for (const row of rows) if (!states.has(row.backup_id)) states.set(row.backup_id, { status: row.result, testId: row.id, testedAt: row.finished_at });
  }
  return states;
}
export const notTested = Object.freeze({ status: 'not-tested', testId: null, testedAt: null });

// Measured recovery time (docs/recovery-time-adr.md): the newest passed test per site, from a fixed number of queries
// whatever the site count. siteId limits it to one app. Sites without a passed test are absent from the map.
const PASSED_NEWEST = `SELECT t.* FROM restore_tests t WHERE t.result='passed' AND t.id=(SELECT p.id FROM restore_tests p WHERE p.site_id=t.site_id AND p.result='passed' ORDER BY p.finished_at DESC,p.id DESC LIMIT 1)`;
export function recoveryBySite(siteId = null, now = Date.now()) {
  const scope = siteId ? ' AND t.site_id=?' : '', args = siteId ? [siteId] : [];
  const tests = db.prepare(PASSED_NEWEST.replace('LIMIT 1)', `LIMIT 1)${scope}`)).all(...args);
  if (!tests.length) return new Map();
  const steps = new Map();
  for (const row of db.prepare(`SELECT s.* FROM restore_test_steps s JOIN (${PASSED_NEWEST.replace('LIMIT 1)', `LIMIT 1)${scope}`)}) t ON t.id=s.test_id`).all(...args)) {
    if (!steps.has(row.test_id)) steps.set(row.test_id, []);
    steps.get(row.test_id).push(row);
  }
  const latest = new Map(db.prepare(`SELECT b.site_id,b.size FROM backups b WHERE b.id=(SELECT n.id FROM backups n WHERE n.site_id=b.site_id ORDER BY n.captured_at DESC,n.id DESC LIMIT 1)${siteId ? ' AND b.site_id=?' : ''}`).all(...args).map(row => [row.site_id, row]));
  const sizes = new Map(db.prepare('SELECT id,size FROM backups').all().map(row => [row.id, row]));
  const cadences = new Map(db.prepare('SELECT site_id,cadence FROM restore_test_settings').all().map(row => [row.site_id, row.cadence]));
  const out = new Map();
  for (const test of tests) {
    const value = recoveryTime(steps.get(test.id) ?? [], test, latest.get(test.site_id), cadences.get(test.site_id) ?? null, now, sizes.get(test.backup_id));
    if (value) out.set(test.site_id, value);
  }
  return out;
}
// The compact form for site summaries in /api/state.
export const recoverySummary = value => value ? { seconds: value.seconds, provenAt: value.provenAt, stale: value.stale, mayBeLow: value.mayBeLow } : null;

// Recovery seconds of each listed passed test (history row), one query for all.
function recoverySecondsOf(rows) {
  const ids = rows.filter(row => row.result === 'passed').map(row => row.id), out = new Map();
  if (!ids.length) return out;
  const steps = new Map();
  for (const row of db.prepare(`SELECT * FROM restore_test_steps WHERE test_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
    if (!steps.has(row.test_id)) steps.set(row.test_id, []);
    steps.get(row.test_id).push(row);
  }
  for (const row of rows) { const value = recoveryTime(steps.get(row.id) ?? [], row); if (value) out.set(row.id, value.seconds); }
  return out;
}
