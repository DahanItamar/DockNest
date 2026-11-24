// Synology DSM support is built but not yet tested on real hardware, so it is off. `SYNOLOGY_ENABLED` is the default;
// an administrator can opt in under Settings, which stores 'synology_enabled' in the settings table (no row means the
// default, so older installs need no migration). The code behind it stays so it can be turned on for everyone later.
export const SYNOLOGY_ENABLED = false;
export const SYNOLOGY_SETTING = 'synology_enabled';
export const SYNOLOGY_INFO = 'Synology support is coming in a later update. You can still connect it as a normal Linux server with Docker.';
export const SYNOLOGY_TAG = 'synology';

export function synologyEnabled(database) {
  try {
    const row = database.prepare('SELECT value FROM settings WHERE key=?').get(SYNOLOGY_SETTING);
    return row ? row.value === '1' : SYNOLOGY_ENABLED;
  } catch { return SYNOLOGY_ENABLED; }
}
export function setSynologyEnabled(enabled, database) {
  database.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SYNOLOGY_SETTING, enabled ? '1' : '0');
  return Boolean(enabled);
}
// Discovery answers from a helper are filtered here, so a Synology server never shows Synology-only facts while the gate is off.
export function withoutSynology(result) {
  if (!result || result.nas?.kind !== 'synology') return result;
  const { nas: _nas, ...rest } = result;
  const containers = Array.isArray(rest.containers) ? rest.containers.map(({ nasApp, ...container }) => (nasApp?.manager === 'synology-project' ? container : { ...container, ...(nasApp ? { nasApp } : {}) })) : rest.containers;
  return { ...rest, containers };
}
