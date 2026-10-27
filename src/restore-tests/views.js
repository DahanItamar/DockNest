// Read model for the restore test API (docs/restore-tests.md, "API contract"): the site card, the test detail for the
// Jobs timeline, and each backup's tested state. Only names, states, times and plain sentences leave here; the engine
// state (`progress`) and job details stay inside.
import { z } from 'zod';
import { db } from '../db.js';
import { loadTest, loadSteps, testState, LABELS } from './engine.js';
import { settingsRow, settingsView } from './settings.js';

const PAGE = 20;
const serverName = serverId => db.prepare('SELECT name FROM servers WHERE id=?').get(serverId)?.name ?? null;
const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
const cursorSchema = z.string().max(512).transform((value, context) => {
  try { return z.tuple([z.string().min(1).max(64), z.string().min(1).max(64)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid pagination cursor.' }); return z.NEVER; }
});
export const cardQuery = z.object({ cursor: cursorSchema.optional(), backupId: z.uuid().optional() });

export function cardFor(siteId, { cursor, backupId } = {}) {
  const last = db.prepare('SELECT * FROM restore_tests WHERE site_id=? AND result IS NOT NULL ORDER BY finished_at DESC,id DESC LIMIT 1').get(siteId);
  const active = db.prepare("SELECT * FROM restore_tests WHERE site_id=? AND (result IS NULL OR cleanup='pending') ORDER BY created_at DESC,id DESC LIMIT 1").get(siteId);
  const where = ['site_id=?'], params = [siteId];
  if (backupId) { where.push('backup_id=?'); params.push(backupId); }
  if (cursor) { where.push('(created_at,id)<(?,?)'); params.push(...cursor); }
  const rows = db.prepare(`SELECT id,backup_id,backup_captured_at,trigger,result,finished_at,restore_seconds,created_at FROM restore_tests WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params, PAGE + 1);
  const page = rows.slice(0, PAGE), end = page.at(-1);
  return {
    settings: settingsView(settingsRow(siteId)),
    last: last ? { id: last.id, result: last.result, finishedAt: last.finished_at, restoreSeconds: last.restore_seconds, internet: !!parse(last.limits, {}).internet, failedStep: last.failed_step, reason: last.reason, serverName: serverName(last.server_id) } : null,
    active: active ? { id: active.id, state: testState(active), step: active.step ?? 'check_space' } : null,
    items: page.map(row => ({ id: row.id, backupId: row.backup_id, backupCapturedAt: row.backup_captured_at, trigger: row.trigger, result: row.result, finishedAt: row.finished_at, restoreSeconds: row.restore_seconds })),
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
