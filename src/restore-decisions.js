// The restore check (docs/restore-check.md): each site's Ignore or Note answer to a finding of its readiness check.
// Mounted under /api after authentication and CSRF; administrators and operators may answer.
// - PUT /api/sites/:id/restore-decisions/:key {decision: 'ignore'|'note', note}
// - DELETE /api/sites/:id/restore-decisions/:key
// A finding is named by the helper's key (sha256 of kind, path and match), so an answer survives a moved line.
// "Include in backup" has no route: it adds the path to the site's configuration files through the site update, where
// the path rules and the helper's protected-path refusal apply as for any other file.
import express from 'express';
import { z } from 'zod';
import { db, audit } from './db.js';

export const restoreDecisionRoutes = express.Router();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const activeSite = siteId => {
  const site = db.prepare('SELECT id FROM sites WHERE id=?').get(siteId) || fail(404, 'App not found.');
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(site.id)) fail(409, 'This app was removed from active apps.');
  return site;
};
const findingKey = z.string().regex(/^[0-9a-f]{64}$/);
const noteText = z.string().trim().max(500).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/, 'Remove control characters from the note.');
const decisionSchema = z.object({ decision: z.enum(['ignore', 'note']), note: noteText.optional() }).strict()
  .refine(value => value.decision !== 'note' || value.note, { message: 'Write the note to keep with this finding.', path: ['note'] });

// The stored answers joined onto the helper's findings. An older helper sends no restoreGaps; it stays absent.
export function withRestoreDecisions(siteId, gaps) {
  if (!Array.isArray(gaps?.findings)) return gaps;
  const answers = new Map(db.prepare('SELECT finding_key,decision,note FROM site_restore_decisions WHERE site_id=?').all(siteId).map(row => [row.finding_key, row]));
  return { ...gaps, findings: gaps.findings.map(finding => { const answer = answers.get(finding.key); return answer ? { ...finding, decision: answer.decision, note: answer.note } : finding; }) };
}

restoreDecisionRoutes.put('/sites/:id/restore-decisions/:key', (req, res) => {
  const site = activeSite(req.params.id), key = findingKey.parse(req.params.key), { decision, note } = decisionSchema.parse(req.body);
  const decidedAt = new Date().toISOString(), text = note || null;
  db.prepare('INSERT INTO site_restore_decisions(site_id,finding_key,decision,note,decided_by,decided_at) VALUES(?,?,?,?,?,?) ON CONFLICT(site_id,finding_key) DO UPDATE SET decision=excluded.decision,note=excluded.note,decided_by=excluded.decided_by,decided_at=excluded.decided_at')
    .run(site.id, key, decision, text, req.user.id, decidedAt);
  // The note is the user's own text and may name anything: the audit trail keeps only the key and the answer.
  audit(req.user.id, 'site.restore_decision', site.id, { key, decision });
  res.json({ key, decision, note: text, decidedBy: req.user.id, decidedAt });
});
restoreDecisionRoutes.delete('/sites/:id/restore-decisions/:key', (req, res) => {
  const site = activeSite(req.params.id), key = findingKey.parse(req.params.key);
  const removed = db.prepare('DELETE FROM site_restore_decisions WHERE site_id=? AND finding_key=?').run(site.id, key).changes > 0;
  if (removed) audit(req.user.id, 'site.restore_decision_removed', site.id, { key });
  res.json({ key, removed });
});
