// Notification centre catalogue (docs/notifications.md). The same events the alerts use (src/alerts/events.js), each with a
// severity, a category, an optional app link and the "Needs action" flag. Titles and bodies come from the alert builders
// (templateFor / messageFor), so they carry only names the owner typed, never hosts, addresses, paths or errors.
export const SEVERITIES = Object.freeze(['error', 'warning', 'info', 'success']);
export const CATEGORIES = Object.freeze(['backups', 'restore_tests', 'storage', 'system']);
// Events only the notification centre shows (no external alert): a restore finishing, a restore test that passed without
// recovering from a failure, and a recovery-time proof that went stale.
export const NOTIFY_ONLY = Object.freeze({
  'restore.succeeded': { title: 'Restore finished', severity: 'success', category: 'backups', text: ({ site, server }) => `${site} on ${server}` },
  'restore.failed': { title: 'Restore failed', severity: 'error', category: 'backups', text: ({ site, server }) => `${site} on ${server}` },
  'restore_test.passed': { title: 'Restore test passed', severity: 'success', category: 'restore_tests', text: ({ site, server }) => `${site} on ${server}` },
  'recovery_time.stale': { title: 'Recovery time is out of date', severity: 'warning', category: 'restore_tests', text: ({ site }) => `${site}: run a new restore test.` },
});
const S = 'success', E = 'error', W = 'warning', I = 'info';
// type -> [severity, category]. A function picks the severity from the event's code or detail.
const RULES = {
  'backup.failed': [E, 'backups'], 'backup.succeeded': [S, 'backups'],
  'move.finished': [event => event.detail === 'failed' ? E : event.detail === 'rolled_back' ? W : S, 'backups'], 'move.needs_you': [W, 'backups'],
  'server.unreachable': [E, 'system'], 'server.disk_low': [W, 'storage'], 'update.available': [I, 'system'],
  'restore_test.failed': [E, 'restore_tests'], 'restore_test.couldnt_run': [W, 'restore_tests'], 'restore_test.recovered': [S, 'restore_tests'], 'restore_test.needs_you': [W, 'restore_tests'],
  'backup.copy_failed': [W, 'storage'], 'backup.copy_recovered': [S, 'storage'], 'backup.copy_gave_up': [E, 'storage'],
  'certificate.expiring': [event => event.code === 'expired' ? E : W, 'system'], 'certificate.renewal_failed': [E, 'system'],
  'edit.rolled_back': [W, 'system'], 'edit.needs_you': [E, 'system'],
  'self_heal.restarted': [event => event.code === 'failed' ? W : I, 'system'], 'self_heal.gave_up': [W, 'system'],
  'launch.needs_you': [W, 'system'], 'selfbackup.kit_check_failed': [E, 'system'], 'emergency.key_changed': [W, 'system'],
  'config.changed': [W, 'system'], 'runbook.outdated': [W, 'system'], 'storage.reconnect_needed': [E, 'storage'], 'report.failed': [E, 'system'],
};
for (const [type, meta] of Object.entries(NOTIFY_ONLY)) RULES[type] = [meta.severity, meta.category];
export const profileOf = event => { const rule = RULES[event.type]; return rule ? { severity: typeof rule[0] === 'function' ? rule[0](event) : rule[0], category: rule[1] } : null; };
// Where "Open" leads: a job (the existing deep link) or an app page. Only these two shapes are ever stored.
export const ROUTES = Object.freeze(['Overview', 'Map', 'Servers', 'Apps & Schedules', 'Backups', 'Jobs', 'Storage', 'Self Backup', 'Recovery Guide', 'Clients', 'Update Center', 'Maintenance']);
const PAGE = {
  'backup.copy_failed': 'Storage', 'backup.copy_recovered': 'Storage', 'backup.copy_gave_up': 'Storage', 'storage.reconnect_needed': 'Storage', 'server.disk_low': 'Servers', 'server.unreachable': 'Servers',
  'update.available': 'Update Center', 'report.failed': 'Clients', 'runbook.outdated': 'Recovery Guide', 'selfbackup.kit_check_failed': 'Self Backup', 'emergency.key_changed': 'Self Backup',
  'move.finished': 'Map', 'move.needs_you': 'Map', 'launch.needs_you': 'Servers', 'restore_test.needs_you': 'Servers',
  'certificate.expiring': 'Apps & Schedules', 'certificate.renewal_failed': 'Apps & Schedules', 'edit.rolled_back': 'Apps & Schedules', 'edit.needs_you': 'Apps & Schedules', 'self_heal.restarted': 'Apps & Schedules', 'self_heal.gave_up': 'Apps & Schedules', 'config.changed': 'Apps & Schedules',
  'recovery_time.stale': 'Apps & Schedules', 'restore_test.failed': 'Jobs', 'restore_test.couldnt_run': 'Jobs', 'restore_test.recovered': 'Jobs', 'restore_test.passed': 'Jobs',
};
export function linkFor(event) {
  if (/^[A-Za-z0-9-]{8,64}$/.test(String(event.jobId ?? ''))) return `job:${event.jobId}`;
  const page = PAGE[event.type] ?? (event.type.startsWith('backup') || event.type.startsWith('restore') ? 'Jobs' : null);
  return page ? `route:${page}` : null;
}
export const validLink = link => link === null || /^job:[A-Za-z0-9-]{8,64}$/.test(link) || (/^route:/.test(link) && ROUTES.includes(link.slice(6)));
// What the owner can act on: errors and warnings. The Needs action tab uses this.
export const NEEDS_ACTION = Object.freeze(['error', 'warning']);
// How long a repeat of a state-like event (same dedupe key) folds into one row. An occurrence key ("occ:") never expires.
export const FOLD_WINDOW_MS = 24 * 3600_000;
export const RETENTION_DAYS = 90;
