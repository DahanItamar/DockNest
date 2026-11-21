// The owner's own login notes per app (docs/recovery-guide.md "Login notes"): how to sign in to the app itself, for the
// person who restores it. Sealed with the master key like every other secret; written only by an administrator who
// re-verified; never returned by the API, logged or audited (the audit entry names the app only). They appear only in a
// PDF made with login details, inside its "Contains secrets" marking. Each note is sealed to its app id, so a row moved
// to another app does not open.
import { db, audit, transaction } from '../db.js';
import { seal, open } from '../crypto.js';

export const MAX_NOTE = 4000;
const aad = siteId => `app-login-note:${siteId}`;
export function saveLoginNote(siteId, note, actor) {
  const text = note.trim();
  transaction(() => {
    if (text) db.prepare('INSERT INTO app_login_notes(site_id,sealed,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET sealed=excluded.sealed,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(siteId, seal(text, aad(siteId)), new Date().toISOString(), actor);
    else db.prepare('DELETE FROM app_login_notes WHERE site_id=?').run(siteId);
    audit(actor, 'runbook.login_note', siteId, { cleared: !text });
  });
  return { saved: true, hasLoginNote: Boolean(text) };
}
export const appsWithLoginNotes = () => new Set(db.prepare('SELECT site_id FROM app_login_notes').all().map(row => row.site_id));
export const openLoginNotes = () => new Map(db.prepare('SELECT site_id,sealed FROM app_login_notes').all().map(row => [row.site_id, open(row.sealed, aad(row.site_id))]));
