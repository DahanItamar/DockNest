// The reasons catalogue (docs/alert-channels.md, "Message template"). The `reason` of an alert is one fixed sentence chosen
// by the event type and, where it helps, a failure code (the job status, the move state). Never raw error text, paths,
// hosts or log lines: those can carry secrets and say nothing a phone needs. An unknown code gives UNKNOWN_REASON.
// A reason may hold an owner-typed name (the move's target server, cleaned like every name) or a computed number (disk).
export const UNKNOWN_REASON = 'Open DockNest to see why.';
const catalogue = Object.freeze({
  'backup.failed': 'The backup did not finish. Open DockNest to see why.',
  'backup.failed:recovery_required': 'The backup stopped and the site needs recovery. Open DockNest to continue.',
  'backup.succeeded': 'The backup finished.',
  'move.finished': 'The site now runs on {target}.',
  'move.finished:rolled_back': 'The move was undone and the site is back where it was. Open DockNest for details.',
  'move.finished:failed': 'The site did not move to {target}. Open DockNest to see why.',
  'move.needs_you': 'The move needs your decision. Open DockNest to continue.',
  'move.needs_you:dns': 'Change the DNS record to point to {target}. Open DockNest for the record.',
  'move.needs_you:owner-switch': 'The site is ready on {target}. Open DockNest to switch when you are ready.',
  'server.unreachable': 'The server has not answered. Open DockNest to check it.',
  'server.disk_low': '{free} free, {used}% used. Open DockNest to review.',
  'restore_test.failed': 'The restore test failed. Open DockNest to see why.',
  'restore_test.couldnt_run': 'The restore test could not run. Open DockNest to see why.',
  'restore_test.recovered': 'The restore test passed again.',
  'restore_test.needs_you': 'A restore test could not clean up its test server. Open DockNest to check it.',
  'update.available': 'DockNest {version} is available. Open DockNest to update.',
  // Backup copies (docs/backup-copies.md). The code is the copy step's failure reason; never the raw storage error.
  'backup.copy_failed': 'The copy to {destination} did not finish. DockNest retries automatically.',
  'backup.copy_failed:space': 'There is not enough free space on {destination}. DockNest retries automatically.',
  'backup.copy_failed:conflict': 'A different file is already on {destination} where the copy goes. Open DockNest to check it.',
  'backup.copy_failed:destination_missing': '{destination} is no longer connected. Open DockNest to check the site storage.',
  'backup.copy_recovered': 'The copy to {destination} is saved now.',
  'test': 'Your alerts are connected.',
});
export const REASON_KEYS = Object.freeze(Object.keys(catalogue));
// `values`: already cleaned strings for the {placeholders}.
export function reasonFor(type, code, values = {}) {
  const own = key => (Object.hasOwn(catalogue, key) ? catalogue[key] : undefined), sentence = own(`${type}:${code}`) ?? own(type);
  if (!sentence) return UNKNOWN_REASON;
  return sentence.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? '').trim() || (key === 'target' ? 'the new server' : key === 'version' ? 'An update' : '')).replace(/\s{2,}/g, ' ');
}
