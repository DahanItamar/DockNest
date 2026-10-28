// What the Update Center offers (docs/update-center.md section 6). A pure function from inputs to state and offer: no files,
// no network, no database. The first matching row wins; the broker and upgrade.sh decide again from their own records.
import { compareSemver } from './check.js';

export const messages = Object.freeze({
  blocked: 'The last update needs manual action on the DockNest host. Updates stay blocked until the server operator resolves it: first the release command from the rollback hint, then `sudo scripts/install-updater.sh --ack`. The acknowledgement alone does not release the hold.',
  repeated: 'The update failed twice and DockNest returned to the previous version both times. A server administrator should look at the DockNest host; updates to this version stay blocked until they run `sudo scripts/install-updater.sh --ack`.',
  mismatch: 'DockNest cannot confirm which version is installed: package.json, the release tag and the running image disagree. Nothing was changed. Check the server (git status, git describe --tags --exact-match, docker compose images).',
  pinMissing: 'The host updater has not verified the installed version yet, so it refused the update. Nothing was changed. This usually happens after an update from the command line. On the DockNest host, run `sudo scripts/install-updater.sh --repair`, then try the update again.',
  hold: 'New work is on hold on the DockNest host. Updates start again once the hold is released.',
  recovery: 'Resolve recovery review first. The update cannot start until then.',
});
const newer = (a, b) => { try { return compareSemver(a, b) > 0; } catch { return false; } };

export function eligibility({ base, current, latest = null, minUpgradeFrom = null, updater, active = null, lastRequest = null, hold = false, recoveryPending = false }) {
  const none = { update: null, cli: null, blocked: null };
  if (active && ['submitted', 'running'].includes(active.state)) return { state: 'update-in-progress', offer: none, canStart: false };
  const offered = latest && newer(latest.version, current) ? latest : null;
  const repeated = offered && (updater.consecutiveExit4?.[offered.version] ?? 0) >= 2;
  if (active?.state === 'needs_action' || updater.blocked || repeated) {
    const again = repeated || updater.blockedReason === 'repeated-rollback';
    return { state: 'updater-blocked', offer: { ...none, blocked: { code: 'UPDATER_BLOCKED', message: again ? messages.repeated : messages.blocked } }, canStart: false };
  }
  // reason 'repaired': install-updater.sh recorded this version afterwards (2.11.1), so the refusal no longer applies.
  const mismatch = lastRequest?.state === 'refused' && lastRequest.refusal === 'state-mismatch' && lastRequest.from_version === current && lastRequest.reason !== 'repaired';
  // 2.11.1: a refusal the broker marked pin-missing is fixed on the host with --repair, which this API cannot see. It
  // does not block: the offer stays with a notice, and the next request is checked by the broker again.
  const pinMissing = mismatch && lastRequest.reason === 'pin-missing';
  if (mismatch && !pinMissing) {
    return { state: 'updater-state-mismatch', offer: { ...none, blocked: { code: 'UPDATER_STATE_MISMATCH', message: messages.mismatch } }, canStart: false };
  }
  if (['consent-pending', 'checks-off'].includes(base)) return { state: base, offer: none, canStart: false };
  if (!offered) return { state: base === 'check-failed' ? 'check-failed' : latest ? 'up-to-date' : base, offer: none, canStart: false };
  // A failed check with a cached result keeps the cached offer and says check-failed.
  const shown = state => base === 'check-failed' ? 'check-failed' : state;
  if (minUpgradeFrom && newer(minUpgradeFrom, current)) return { state: shown('update-available'), offer: { ...none, cli: { reason: 'min-upgrade-from', command: null } }, canStart: false };
  if (!updater.present) return { state: shown('updater-not-installed'), offer: { ...none, cli: { reason: 'updater-not-installed', command: 'scripts/upgrade.sh' } }, canStart: false };
  if (!updater.supported) return { state: shown('updater-not-installed'), offer: { ...none, cli: { reason: 'updater-outdated', command: 'sudo scripts/install-updater.sh' } }, canStart: false };
  const blocked = recoveryPending ? { code: 'RECOVERY_REVIEW_REQUIRED', message: messages.recovery } : hold ? { code: 'UPDATE_ON_HOLD', message: messages.hold } : null;
  const notice = pinMissing ? { notice: { code: 'UPDATER_PIN_MISSING', message: messages.pinMissing } } : {};
  return { state: shown('update-available'), offer: { update: { version: offered.version, releaseUrl: offered.releaseUrl }, cli: null, blocked, ...notice }, canStart: !blocked };
}
