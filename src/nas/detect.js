import { MIN_HOST_PYTHON } from '../../shared/helper-runtime.js';

// NAS detection from read-only facts. Every fact is read with a fixed argv (no shell, no request values), so this works
// on a server with no Python. `run(argv)` resolves { code, stdout }; tests pass a fake.
export const NAS_KINDS = Object.freeze(['unraid', 'synology', 'truenas']);
export const MIN_TRUENAS = [24, 10];
export const TRUENAS_TOO_OLD = 'TrueNAS apps before 24.10 run on Kubernetes, which DockNest does not back up. Update TrueNAS to 24.10 or newer.';
const VERSION_TEXT = /^[0-9A-Za-z._+-]{1,40}$/;

function versionOf(text) {
  const value = String(text ?? '').trim();
  return VERSION_TEXT.test(value) ? value : null;
}
export function parseUnraidVersion(text) {
  const match = /^\s*version\s*=\s*"?([^"\r\n]*)"?\s*$/m.exec(String(text ?? ''));
  return versionOf(match?.[1]);
}
export function parseSynologyVersion(text) {
  const match = /^\s*productversion\s*=\s*"?([^"\r\n]*)"?\s*$/m.exec(String(text ?? ''));
  return versionOf(match?.[1]);
}
// Same formats as the helper (remote/helper/nas.py): 'TrueNAS-SCALE-24.10.2', 'TrueNAS-SCALE 25.04', 'TrueNAS-25.10.0' or a bare '25.04.1'.
// A TrueNAS file whose version cannot be read gives 'unknown', which is refused (fail closed).
export function parseTrueNasVersion(text) {
  const value = String(text ?? '').slice(0, 256);
  if (!/^\s*(?:TrueNAS|\d{2}\.\d{2})/i.test(value)) return null;
  const match = /(?<![0-9.])(\d{2}\.\d{2}(?:\.\d{1,3}){0,2})(?!\d)/.exec(value);
  return match ? match[1] : 'unknown';
}
export function trueNasSupported(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > MIN_TRUENAS[0] || (major === MIN_TRUENAS[0] && minor >= MIN_TRUENAS[1]);
}
// Python and Docker facts. Output is "major minor" and a bare version; anything else is "not usable".
export function parsePython(text) {
  const match = /^(\d+) (\d+)\s*$/.exec(String(text ?? ''));
  return match ? [Number(match[1]), Number(match[2])] : null;
}
export const pythonUsable = version => Array.isArray(version) && (version[0] > MIN_HOST_PYTHON[0] || (version[0] === MIN_HOST_PYTHON[0] && version[1] >= MIN_HOST_PYTHON[1]));
export function parseDockerVersion(text) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?[0-9A-Za-z.+-]*\s*$/.exec(String(text ?? ''));
  return match ? { major: Number(match[1]), minor: Number(match[2]), text: match[0].trim() } : null;
}

const read = async (run, path) => { const out = await run(['cat', '--', path]).catch(() => null); return out?.code === 0 ? String(out.stdout).slice(0, 8192) : null; };

export async function looksLikeSynology(run) {
  return (await read(run, '/etc/synoinfo.conf')) !== null && (await read(run, '/etc.defaults/VERSION')) !== null;
}
export async function looksLikeUnraid(run) {
  return (await read(run, '/etc/unraid-version')) !== null;
}
// `synology` and `unraid` are the opt-in gates (src/nas/gate.js): with one off, that system is not a NAS and is handled as a normal Linux server.
export async function detectNas(run, { synology = false, unraid: unraidOn = false } = {}) {
  const unraid = await read(run, '/etc/unraid-version');
  if (unraid !== null) return unraidOn ? { kind: 'unraid', version: parseUnraidVersion(unraid) } : null;
  if (await looksLikeSynology(run)) return synology ? { kind: 'synology', version: parseSynologyVersion(await read(run, '/etc.defaults/VERSION')) } : null;
  const truenas = parseTrueNasVersion(await read(run, '/etc/version'));
  if (truenas) {
    const midclt = await run(['test', '-x', '/usr/bin/midclt']).catch(() => null);
    if (midclt?.code === 0) return { kind: 'truenas', version: truenas === 'unknown' ? null : truenas };
  }
  return null;
}

export async function pythonFacts(run) {
  const out = await run(['python3', '-c', 'import sys;print(sys.version_info[0],sys.version_info[1])']).catch(() => null);
  return out?.code === 0 ? parsePython(out.stdout) : null;
}
export async function dockerFacts(run) {
  for (const binary of ['docker', '/usr/local/bin/docker']) {
    const out = await run([binary, 'version', '--format', '{{.Server.Version}}']).catch(() => null);
    if (out?.code === 0) { const parsed = parseDockerVersion(out.stdout); if (parsed) return { ...parsed, binary }; }
  }
  return null;
}

// Staging lives on persistent storage, never in RAM (Unraid's / and /tmp are RAM). `mountEntries` lists /mnt.
export function chooseStagingBase(kind, { cache = false, volume = null, pools = [] } = {}) {
  if (kind === 'unraid') return cache ? '/mnt/cache/system/docknest' : '/mnt/user/system/docknest';
  if (kind === 'synology') return `/${/^volume\d{1,2}$/.test(volume ?? '') ? volume : 'volume1'}/@docknest`;
  if (kind === 'truenas') {
    const pool = [...pools].filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)).sort()[0];
    return pool ? `/mnt/${pool}/.docknest` : null;
  }
  return null;
}
export async function stagingFacts(run, kind) {
  if (kind === 'unraid') {
    const cache = (await run(['test', '-d', '/mnt/cache']).catch(() => null))?.code === 0;
    return chooseStagingBase(kind, { cache });
  }
  if (kind === 'synology') {
    const listing = await run(['ls', '-1', '--', '/']).catch(() => null);
    const volume = String(listing?.stdout ?? '').split('\n').map(line => line.trim()).filter(line => /^volume\d{1,2}$/.test(line)).sort()[0];
    return chooseStagingBase(kind, { volume });
  }
  if (kind === 'truenas') {
    const listing = await run(['ls', '-1', '--', '/mnt']).catch(() => null);
    return chooseStagingBase(kind, { pools: String(listing?.stdout ?? '').split('\n').map(line => line.trim()) });
  }
  return null;
}
