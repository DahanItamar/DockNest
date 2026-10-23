// Pure rules for "Install on server" (docs/moving-sites.md): which packages DockNest may install where, and the line a
// person would run themselves. No I/O, so the move preflight can use it. What actually runs is decided in
// remote/helper.py (INSTALL_PLAN_JSON); tests/server-install.test.js keeps the two package tables identical.
export const INSTALL_PACKAGES = Object.freeze(['nginx', 'docker', 'compose', 'certbot']);
const LABELS = { nginx: 'nginx', docker: 'Docker', compose: 'Docker Compose', certbot: 'certbot' };
export const installLabel = name => LABELS[name];

// Distro packages only: no curl|sh, no third-party repositories. Keep identical to INSTALL_PLAN_JSON in
// remote/helper.py; tests/server-install.test.js compares the two.
export const PACKAGE_MAP = Object.freeze({
  apt: { nginx: ['nginx'], certbot: ['certbot', 'python3-certbot-nginx'], docker: ['docker.io'], compose: ['docker-compose-v2'] },
  dnf: { nginx: ['nginx'], certbot: ['certbot', 'python3-certbot-nginx'], docker: ['moby-engine'], compose: [] },
});
const APT_IDS = ['debian', 'ubuntu'], DNF_IDS = ['fedora', 'rhel', 'rocky', 'almalinux'];
const idText = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function versionAtLeast(text, major, minor) {
  const match = /^(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!match) return false;
  const have = [Number(match[1]), Number(match[2] ?? 0)];
  return have[0] > major || (have[0] === major && have[1] >= minor);
}

// Whether DockNest itself may install the package here. Anything not listed is unsupported (fail closed).
export function installSupported(manager, osId, versionId, name) {
  const packages = PACKAGE_MAP[manager]?.[name];
  if (!packages?.length) return false;
  if (manager === 'apt') {
    if (!APT_IDS.includes(osId)) return false;
    return name === 'compose' ? osId === 'ubuntu' && versionAtLeast(versionId, 22, 4) : true;
  }
  if (manager === 'dnf') {
    if (!DNF_IDS.includes(osId)) return false;
    return name === 'nginx' || (osId === 'fedora' && (name === 'certbot' || name === 'docker'));
  }
  return false;
}

// The exact line a person would run. Only for display. Empty when there is no sensible distro-package line.
export function installCommand(manager, osId, name) {
  const packages = PACKAGE_MAP[manager]?.[name];
  if (!packages?.length) return '';
  if (manager === 'apt' && APT_IDS.includes(osId)) return `sudo apt-get update && sudo apt-get install -y --no-install-recommends ${packages.join(' ')}`;
  if (manager === 'dnf' && DNF_IDS.includes(osId)) {
    // RHEL, Rocky and Alma do not ship these in their own repositories (they need EPEL or a vendor repository).
    if (osId !== 'fedora' && name !== 'nginx') return '';
    return `sudo dnf install -y ${packages.join(' ')}`;
  }
  return '';
}

// Normalises what the helper reports about the operating system; anything odd becomes "unknown".
export function osFacts(facts) {
  const osId = String(facts?.os?.id ?? ''), versionId = String(facts?.os?.versionId ?? '');
  return { id: idText.test(osId) ? osId : '', versionId: /^[0-9][0-9.]{0,19}$/.test(versionId) ? versionId : '', manager: ['apt', 'dnf'].includes(facts?.packageManager) ? facts.packageManager : null };
}

/** @returns {{ package: string, command: string, supported: boolean }} */
export function installInfo(facts, name) {
  const os = osFacts(facts);
  return { package: name, command: installCommand(os.manager, os.id, name), supported: installSupported(os.manager, os.id, os.versionId, name) };
}
