// Synology DSM and Unraid support are built but not yet tested on real hardware, so each is off. `NAS_DEFAULTS` is the
// default; an administrator can opt in per system under Settings, which stores 'synology_enabled' / 'unraid_enabled' in the
// settings table (no row means the default, so older installs need no migration). The code behind it stays so it can
// be turned on for everyone later. TrueNAS SCALE is not gated.
export const GATED_KINDS = Object.freeze(['synology', 'unraid']);
export const NAS_DEFAULTS = Object.freeze({ synology: false, unraid: false });
export const SYNOLOGY_ENABLED = NAS_DEFAULTS.synology;
export const gateSetting = kind => `${kind}_enabled`;
export const NAS_TITLES = Object.freeze({ synology: 'Synology', unraid: 'Unraid' });
export const gateInfo = kind => `${NAS_TITLES[kind]} support is coming in a later update. You can still connect it as a normal Linux server with Docker.`;
export const SYNOLOGY_INFO = gateInfo('synology');
export const UNRAID_INFO = gateInfo('unraid');
// A non-identifying system tag for problem reports.
export const NAS_REPORT_TAGS = GATED_KINDS;
const known = kind => GATED_KINDS.includes(kind);

// Is a gated system on? Kinds that are not gated (TrueNAS) are always on. Any read error means the default (off).
export function nasEnabled(kind, database) {
  if (!known(kind)) return true;
  try {
    const row = database.prepare('SELECT value FROM settings WHERE key=?').get(gateSetting(kind));
    return row ? row.value === '1' : NAS_DEFAULTS[kind];
  } catch { return NAS_DEFAULTS[kind]; }
}
export const nasGates = database => Object.fromEntries(GATED_KINDS.map(kind => [kind, nasEnabled(kind, database)]));
export function setNasEnabled(kind, enabled, database) {
  if (!known(kind)) throw new Error('Not a gated system.');
  database.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(gateSetting(kind), enabled ? '1' : '0');
  return Boolean(enabled);
}
export const synologyEnabled = database => nasEnabled('synology', database);
export const setSynologyEnabled = (enabled, database) => setNasEnabled('synology', enabled, database);
// Discovery answers from a helper are filtered here, so a gated system never shows its own facts while it is off.
const MANAGERS = Object.freeze({ synology: ['synology-project'], unraid: ['unraid-template', 'unraid-compose-manager'] });
export function withoutGated(result, gates) {
  const kind = result?.nas?.kind;
  if (!result || !known(kind) || gates?.[kind]) return result;
  const { nas: _nas, ...rest } = result;
  const containers = Array.isArray(rest.containers) ? rest.containers.map(({ nasApp, ...container }) => (nasApp && !MANAGERS[kind].includes(nasApp.manager) ? { ...container, nasApp } : container)) : rest.containers;
  return { ...rest, containers };
}
