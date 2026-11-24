// Notification centre store (docs/notifications.md). Rows are per user and are only ever read or changed through the
// user's own id. Feeding happens from alerts/delivery.js `emit` (same events as the external alerts) for every
// administrator; a repeat of the same event folds into count + last_at and is unread again.
import { db } from '../db.js';
import { messageFor, templateFor } from '../alerts/events.js';
import { profileOf, linkFor, NOTIFY_ONLY, NEEDS_ACTION, FOLD_WINDOW_MS, RETENTION_DAYS } from './catalog.js';

// Last line of defence: whatever a builder returns, no address, URL, path or long token-like string reaches a row.
export function scrub(text, max) {
  return String(text ?? '')
    .replace(/[‪-‮⁦-⁩]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, '[link]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]').replace(/\b(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4}\b/gi, '[address]')
    .replace(/(?:^|\s)(?:[A-Za-z]:)?[\\/](?:[\w.@-]+[\\/])+[\w.@-]*/g, ' [path]').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[hidden]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
// The alert sentences end with "Open DockNest to ..." because they leave the app; inside it that is noise.
const inApp = text => text.replace(/\s*Open DockNest[^.]*\.?$/, '').replace(/\s*Check certbot on the server\.$/, '').trim();

export function notificationFor(event) {
  const profile = profileOf(event); if (!profile) return null;
  const extra = NOTIFY_ONLY[event.type];
  let title, body;
  if (extra) {
    const parts = { site: scrub(event.siteName, 80) || 'an app', server: scrub(event.serverName, 80) || 'your server', when: event.when ?? '' };
    title = extra.title; body = extra.text(parts);
  } else {
    const template = templateFor(event), text = messageFor(event); if (!template || !text) return null;
    title = template.title; body = inApp(text);
  }
  return { event_key: event.type, severity: profile.severity, category: profile.category, title: scrub(title, 120), body: scrub(body, 400), link: linkFor(event) };
}

const adminIds = () => db.prepare("SELECT id FROM users WHERE role='admin' AND disabled=0").all().map(row => row.id);
// Records one event for every administrator. Returns how many rows were created or folded. Never throws: a notification
// problem must not stop an alert, a backup or the detector.
export function notify(event, { at = Date.now() } = {}) {
  try {
    const item = notificationFor(event); if (!item) return 0;
    const key = String(event.key ?? ''), dedupe = `${event.type}:${key}`.slice(0, 200), iso = new Date(at).toISOString();
    // An occurrence key ("occ:") names one thing that happened once, so a replay of it folds whenever it was first seen.
    const since = key.startsWith('occ:') ? '' : new Date(at - FOLD_WINDOW_MS).toISOString();
    let written = 0;
    for (const userId of adminIds()) {
      const existing = db.prepare('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=? AND last_at>=? ORDER BY last_at DESC,id DESC LIMIT 1').get(userId, dedupe, since);
      if (existing) db.prepare('UPDATE notifications SET count=count+1,last_at=?,read_at=NULL,archived_at=NULL,severity=?,title=?,body=?,link=? WHERE id=?').run(iso, item.severity, item.title, item.body, item.link, existing.id);
      else db.prepare('INSERT INTO notifications(user_id,event_key,dedupe_key,severity,category,title,body,link,count,first_at,last_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)').run(userId, item.event_key, dedupe, item.severity, item.category, item.title, item.body, item.link, iso, iso);
      written++;
    }
    return written;
  } catch (error) { console.error(`Notifications: skipped (${error.code ?? error.name})`); return 0; }
}

export const view = row => ({ id: row.id, event: row.event_key, severity: row.severity, category: row.category, title: row.title, body: row.body, link: row.link, count: row.count, firstAt: row.first_at, lastAt: row.last_at, read: row.read_at !== null, archived: row.archived_at !== null });
export const TABS = Object.freeze(['all', 'needs_action', 'backups', 'storage', 'system', 'archived']);
const tabSql = {
  all: 'archived_at IS NULL', needs_action: `archived_at IS NULL AND severity IN (${NEEDS_ACTION.map(s => `'${s}'`).join(',')})`,
  backups: "archived_at IS NULL AND category IN ('backups','restore_tests')", storage: "archived_at IS NULL AND category='storage'", system: "archived_at IS NULL AND category='system'", archived: 'archived_at IS NOT NULL',
};
export function list(userId, { tab = 'all', severity = null, unread = false, limit = 25, offset = 0 } = {}) {
  const where = ['user_id=?', tabSql[tab] ?? tabSql.all], args = [userId];
  if (severity) { where.push('severity=?'); args.push(severity); }
  if (unread) where.push('read_at IS NULL');
  const sql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${sql}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM notifications WHERE ${sql} ORDER BY last_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(view);
  return { items, total, limit, offset };
}
// Tab counts: `unread` per tab for the badges, `total` per tab for the empty states.
export function counts(userId) {
  const one = (tab, extra = '') => db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND ${tabSql[tab]}${extra}`).get(userId).n;
  return { unread: Object.fromEntries(TABS.map(tab => [tab, one(tab, tab === 'archived' ? '' : ' AND read_at IS NULL')])), total: Object.fromEntries(TABS.map(tab => [tab, one(tab)])) };
}
export const unreadCount = userId => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND archived_at IS NULL AND read_at IS NULL').get(userId).n;
// The small summary that rides on /api/state (read by the existing 5 s poll): unread count, the newest id and the newest
// four rows for the bell and the toasts.
export function summary(userId) {
  const recent = db.prepare('SELECT * FROM notifications WHERE user_id=? AND archived_at IS NULL ORDER BY last_at DESC,id DESC LIMIT 4').all(userId).map(view);
  return { unread: unreadCount(userId), newestId: db.prepare('SELECT MAX(id) AS id FROM notifications WHERE user_id=?').get(userId).id ?? 0, recent };
}
const now = () => new Date().toISOString();
const inList = ids => ids.map(() => '?').join(',');
export const markRead = (userId, ids) => ids.length ? db.prepare(`UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND id IN (${inList(ids)})`).run(now(), userId, ...ids).changes : 0;
export const markAllRead = userId => db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL AND archived_at IS NULL').run(now(), userId).changes;
export const archive = (userId, ids) => ids.length ? db.prepare(`UPDATE notifications SET archived_at=?,read_at=COALESCE(read_at,?) WHERE user_id=? AND archived_at IS NULL AND id IN (${inList(ids)})`).run(now(), now(), userId, ...ids).changes : 0;
export const unarchive = (userId, ids) => ids.length ? db.prepare(`UPDATE notifications SET archived_at=NULL WHERE user_id=? AND archived_at IS NOT NULL AND id IN (${inList(ids)})`).run(userId, ...ids).changes : 0;
// 90 days after the last occurrence. Called from the worker's existing maintenance pass; no timer of its own.
export const purge = (at = Date.now()) => db.prepare('DELETE FROM notifications WHERE last_at<?').run(new Date(at - RETENTION_DAYS * 86400_000).toISOString()).changes;
