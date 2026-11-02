// Safe Edit read model (docs/safe-edit.md, "API"): the detail of one edit and the per-site history. Field names, env
// key names and file hashes only; never a value, a payload or a helper message.
import { z } from 'zod';
import { db } from '../db.js';
import { LABELS, cancellable } from './state.js';
import { loadEdit, loadSteps } from './engine.js';

const actorName = userId => db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name ?? null;
const restoreActive = edit => { const jobId = edit.progress?.restoreJobId; return !!jobId && ['queued', 'running'].includes(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId)?.status); };

export function summaryOf(edit) {
  return {
    id: edit.id, siteId: edit.site_id, state: edit.state, result: edit.result, failedStep: edit.failed_step, reason: edit.reason,
    tabs: edit.changes?.tabs ?? [], changed: edit.changes?.changed ?? [], env: edit.changes?.env ?? { added: [], replaced: [], removed: [] },
    imageChanged: !!edit.changes?.imageChanged, dataRollback: !!edit.data_rollback, healthSeconds: edit.health_seconds,
    createdBy: { id: edit.created_by, name: actorName(edit.created_by) }, createdAt: edit.created_at, startedAt: edit.started_at, finishedAt: edit.finished_at,
  };
}

// `admin`: whether the viewer may act. Operators see the same detail read-only.
export function detailOf(editId, { admin = false } = {}) {
  const edit = loadEdit(editId);
  if (!edit) return null;
  const restoring = restoreActive(edit);
  return {
    ...summaryOf(edit), serverId: edit.server_id, backupId: edit.backup_id, timeLimitSeconds: edit.time_limit_seconds, files: edit.changes?.files ?? [], cancelRequested: edit.cancel_requested,
    // The maintenance page is on from apply until finish, and stays on after Restore backup (the owner checks first).
    maintenance: (edit.result === null ? !!edit.progress.applyStarted : !!edit.progress.restoredBackup) ? 'on' : 'off',
    restore: edit.progress.restoreJobId ? { jobId: edit.progress.restoreJobId, running: restoring } : null,
    steps: loadSteps(edit.id).map(step => ({ step: step.step, label: LABELS[step.step], state: step.state, startedAt: step.started_at, finishedAt: step.finished_at, detail: step.detail })),
    actions: {
      cancel: admin && cancellable(edit) && !edit.cancel_requested,
      retry: admin && edit.state === 'needs_attention' && !restoring,
      restoreBackup: admin && edit.state === 'needs_attention' && !!edit.backup_id && !restoring,
    },
  };
}

// Keyset paging on (created_at, id), newest first, like the other histories.
const cursor = z.string().max(512).transform((value, context) => { try { return z.tuple([z.string().min(1).max(64), z.string().min(1).max(128)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); } catch { context.addIssue({ code: 'custom', message: 'Invalid pagination cursor.' }); return z.NEVER; } });
export const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: cursor.optional() });
export function historyOf(siteId, { limit, cursor: after }) {
  const rows = db.prepare(`SELECT id,created_at FROM site_edits WHERE site_id=? ${after ? 'AND (created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(siteId, ...(after ?? []), limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return { items: page.map(row => summaryOf(loadEdit(row.id))), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url') : null };
}
