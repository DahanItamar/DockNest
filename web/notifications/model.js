// Notification centre, pure logic (docs/notifications.md). No React and no network here, so the toast stack, the "what is
// new since the last poll" rule and the link and tab helpers are tested directly (tests/notifications-ui.test.js).
export const SEVERITY_LABEL = Object.freeze({ error: 'Error', warning: 'Warning', info: 'Info', success: 'Success' });
export const SEVERITIES = Object.freeze(Object.keys(SEVERITY_LABEL));
export const MAX_VISIBLE = 3;
const MAX_KEPT = 50;
// Errors stay until dismissed. Success clears after 5 s, the quieter kinds after 8 s.
export const ttlFor = severity => severity === 'error' ? null : severity === 'success' ? 5000 : 8000;

// A toast: { key, severity, title, body?, actions?: [{ label, onClick }], notificationId? }. The same key replaces the
// toast and moves it to the bottom, so a repeat never stacks two of the same thing.
export function pushToast(list, toast) {
  const item = { severity: 'info', ...toast, severity: SEVERITIES.includes(toast.severity) ? toast.severity : 'info' };
  if (!item.key || !item.title) return list;
  return [...list.filter(existing => existing.key !== item.key), item].slice(-MAX_KEPT);
}
export const dismissToast = (list, key) => list.some(item => item.key === key) ? list.filter(item => item.key !== key) : list;
// Newest at the bottom: the last MAX_VISIBLE are shown, the older ones are counted in "+N more".
export function visibleToasts(list, max = MAX_VISIBLE) {
  const shown = list.slice(-max);
  return { shown, hidden: list.length - shown.length };
}
// What the poll found that the owner has not been told about yet. `seen` maps id -> count last announced; null means the
// first load of this session, which seeds the map and announces nothing (the bell already shows the unread count).
export function freshSince(seen, recent) {
  const next = { ...(seen ?? {}) }, fresh = [];
  for (const item of [...recent].reverse()) { // oldest first, so the newest ends at the bottom of the stack
    const before = next[item.id];
    if (seen !== null && !item.read && !item.archived && (before === undefined || item.count > before)) fresh.push(item);
    next[item.id] = Math.max(before ?? 0, item.count);
  }
  return { fresh, seen: next };
}
export const toastOf = item => ({ key: 'n:' + item.id, severity: item.severity, title: item.title, body: item.count > 1 ? `${item.body} (${item.count} times)` : item.body, notificationId: item.id, link: item.link });

// "job:<id>" opens the job, "route:<page>" opens the page. Anything else is ignored, never followed.
export function linkTarget(link) {
  if (typeof link !== 'string') return null;
  const job = /^job:([A-Za-z0-9-]{8,64})$/.exec(link); if (job) return { type: 'job', id: job[1], label: 'View job' };
  const route = /^route:([A-Za-z &]{3,32})$/.exec(link); if (route) return { type: 'route', name: route[1], label: route[1] === 'Update Center' ? 'Open Update Center' : 'Open ' + route[1] };
  return null;
}
export const TABS = Object.freeze([['all', 'All'], ['needs_action', 'Needs action'], ['backups', 'Backups & restores'], ['storage', 'Storage'], ['system', 'System'], ['archived', 'Archived']]);
export const tabCount = (counts, tab) => counts?.unread?.[tab] ?? 0;
// "99+" keeps the bell badge a fixed width.
export const badgeText = count => count > 9 ? '9+' : String(Math.max(0, count | 0));
// The page reloads its list when this changes; it comes from the state the app already polls.
export const signature = summary => summary ? `${summary.unread}:${summary.newestId}:${summary.recent?.[0]?.lastAt ?? ''}:${summary.recent?.[0]?.count ?? ''}` : '';
