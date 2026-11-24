// NAS facts as the screens show them (docs/nas-servers.md). Pure helpers: labels, grouping text and error titles.
// Everything here comes from the server's own answers; the WebUI text of an Unraid template is untrusted and is only ever
// shown as plain text (React escapes it), never as a link or markup.
export const NAS_NAMES = Object.freeze({ unraid: 'Unraid NAS', synology: 'Synology NAS', truenas: 'TrueNAS NAS' });
export const nasName = kind => (Object.hasOwn(NAS_NAMES, kind) ? NAS_NAMES[kind] : null);
// What the system itself is called in the connect wizard.
export const NAS_TYPES = Object.freeze([['', 'Linux server'], ['unraid', 'Unraid'], ['synology', 'Synology DSM'], ['truenas', 'TrueNAS SCALE']]);

export const MANAGER_LABELS = Object.freeze({
  'unraid-template': 'Unraid template',
  'unraid-compose-manager': 'Compose Manager project',
  'synology-project': 'Container Manager project',
  'truenas-app': 'TrueNAS app',
});
export const MANAGER_NOTES = Object.freeze({
  'unraid-template': 'the Docker page keeps managing it',
  'unraid-compose-manager': 'managed by the Compose Manager plugin',
  'synology-project': 'managed by Container Manager',
  'truenas-app': 'managed by the TrueNAS Apps page',
});
// The manager of a group of discovered containers: the first one that reports an app manager.
export function groupManager(containers) {
  for (const container of containers || []) { const manager = container?.nasApp?.manager; if (Object.hasOwn(MANAGER_LABELS, manager)) return manager; }
  return null;
}
// Group headings in Discover: shown only when the groups come from two or more managers.
export const MANAGER_HEADINGS = Object.freeze({ 'unraid-template': 'Unraid templates', 'unraid-compose-manager': 'Compose Manager', 'synology-project': 'Container Manager projects', 'truenas-app': 'TrueNAS apps', other: 'Other apps' });
export const headingKey = group => (Object.hasOwn(MANAGER_LABELS, group?.nasManager) ? group.nasManager : 'other');
export const managerCount = groups => new Set((groups || []).map(headingKey)).size;
// The heading to print before groups[at], or null. `all` is every group of the list, so a page never decides alone.
export const headingBefore = (groups, at, all = groups) => (managerCount(all) >= 2 && (at === 0 || headingKey(groups[at - 1]) !== headingKey(groups[at])) ? MANAGER_HEADINGS[headingKey(groups[at])] : null);
export const managerCaption = manager => (manager ? `${MANAGER_LABELS[manager]} · ${MANAGER_NOTES[manager]}` : '');
// Plain text of the WebUI field, shortened. It is shown as text only.
export const webUiText = container => { const value = container?.nasApp?.webUi; return typeof value === 'string' && value ? value.slice(0, 200) : ''; };

export const TRUENAS_OLD = /^TrueNAS apps before 24\.10 run on Kubernetes/;
// A discovery error gets a plain title for the one case the NAS support defines.
export const discoveryErrorTitle = message => (TRUENAS_OLD.test(String(message ?? '')) ? 'This TrueNAS version is not supported' : 'Containers could not be found');

// Readiness checks: status ok | warn | fail, with the fix when there is one. The identity row says which SSH identity runs.
export const CHECK_ORDER = Object.freeze(['nas-version', 'identity', 'runtime', 'staging', 'hard-links', 'docker', 'key-persistence']);
export function sortChecks(checks) {
  const rank = id => { const at = CHECK_ORDER.indexOf(id); return at < 0 ? CHECK_ORDER.length : at; };
  return [...(checks || [])].filter(check => check && ['ok', 'warn', 'fail'].includes(check.status) && typeof check.message === 'string').sort((a, b) => rank(a.id) - rank(b.id));
}
export function runtimeTitle(result) {
  if (result?.helperRuntime === 'container') return 'Helper runtime: Container (no Python on host)';
  if (result?.helperRuntime === 'host') return 'Helper runtime: Python on the server';
  return 'Helper runtime';
}
export const identityText = identity => (identity === 'sudo' ? 'Connected as a user with passwordless sudo' : identity === 'root' ? 'Connected as root' : '');
