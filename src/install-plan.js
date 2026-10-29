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

export const DOCKER_DOCS = 'https://docs.docker.com/engine/install/';
// Several containers are restored as a group, which needs Docker 28. One gate for move preflight and install requests.
export const MIN_DOCKER_MAJOR = 28;
export const dockerNeed = containerCount => ({ needDockerMajor: (containerCount ?? 1) > 1 ? MIN_DOCKER_MAJOR : 0 });
// Candidate version the system's own sources offer ("27.5"), validated; anything else is unknown.
export function candidateMajor(facts, name) {
  const match = /^(\d{1,3})\.(\d{1,3})$/.exec(String(facts?.candidates?.[name] ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * @param {{ needDockerMajor?: number }} [need] the Docker major version the site needs (28 for several containers).
 * @returns {{ package: string, command: string, supported: boolean, reason?: string }}
 */
export function installInfo(facts, name, need = {}) {
  const os = osFacts(facts);
  const info = { package: name, command: installCommand(os.manager, os.id, name), supported: installSupported(os.manager, os.id, os.versionId, name) };
  const needed = name === 'docker' ? need.needDockerMajor : 0, offered = candidateMajor(facts, 'docker');
  // Fail-closed: an offered version that cannot be read does not meet the need.
  if (info.supported && needed && !(offered >= needed)) {
    const shown = offered === null ? "DockNest could not read which Docker version this server's packages offer" : `This server's packages offer Docker ${facts.candidates.docker}`;
    return { package: name, supported: false, command: `# Follow Docker's official steps for your system: ${DOCKER_DOCS}`, reason: `${shown}; this site needs ${needed} or newer. Install Docker from Docker's own repository instead.` };
  }
  return info;
}

// Helper failure codes -> fixed sentences. The helper never sends free text; an unknown code gets the generic one.
const dpkgHint = ' Run "sudo dpkg --configure -a" on the server before trying again.';
const ERRORS = {
  UNKNOWN_PACKAGE: () => 'DockNest cannot install that.',
  NOT_ROOT: () => 'DockNest must sign in as root to install software.',
  LOCKED: () => 'Another install is already running on this server.',
  UNSUPPORTED: label => `DockNest cannot install ${label} on this system.`,
  ALREADY_INSTALLED: label => `${label} is already installed on this server.`,
  DOCKER_NOT_RUNNING: () => 'Docker is installed but not running. Start it, then check again.',
  PORT_80: () => 'Another program already uses port 80 on this server, so nginx could not start. Stop it, then try again.',
  PACKAGE_TOOL_BUSY: () => 'Another package tool is running on this server (for example automatic updates). Try again in a few minutes.',
  NOT_OFFERED: () => "This server's package sources do not offer that package.",
  NO_NETWORK: () => 'The server could not reach its package sources. Check its internet connection.',
  NO_SPACE: () => 'The server is out of disk space.',
  CONFLICT: label => `${label} conflicts with software already on this server, so nothing was installed. Nothing was removed.`,
  UPDATE_FAILED: () => 'The package list could not be updated. Nothing was installed.',
  INSTALL_FAILED: label => `Installing ${label} failed. Nothing else was changed by DockNest.`,
  TIMEOUT_UPDATE: () => 'Updating the package list took too long, so DockNest stopped it. Check the server before trying again.',
  TIMEOUT_INSTALL: label => `Installing ${label} took too long, so DockNest stopped it. Check the server before trying again.`,
  TIMEOUT_APT_UPDATE: () => `Updating the package list took too long, so DockNest stopped it.${dpkgHint}`,
  TIMEOUT_APT_INSTALL: label => `Installing ${label} took too long, so DockNest stopped it.${dpkgHint}`,
  SERVICE_NOT_STARTED: label => `${label} was installed, but it could not be started. Another program may be using its port. Check the server.`,
  VERIFY_FAILED: label => `${label} was installed, but it does not work yet. Check the server.`,
  GENERIC: () => 'The install could not be completed. Check the server, then try again.',
};
export const installErrorCodes = Object.freeze(Object.keys(ERRORS));
export function installErrorText(code, name) {
  const label = LABELS[name] ?? 'the software';
  return (Object.hasOwn(ERRORS, code) ? ERRORS[code] : ERRORS.GENERIC)(label);
}
