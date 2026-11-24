import { posix } from 'node:path';
import { identityFor, sudoPrefix } from './command.js';
import { checkMountPath, computeMounts, MountRefused, UNRAID_TEMPLATES } from './mounts.js';
import { ensureRuntimeImage } from './runtime-image.js';

// Before a helper call on a server that uses the helper runtime container: make sure the pinned image is loaded, and
// compute the folders the call may see. The folders come from DockNest's own stored facts and the request's config, plus
// the bind mounts Docker reports for the app's containers; a helper request can never add a mount of its own.
// Calls that only look (discovery, tests, readiness) skip a folder the deny-list refuses; every other call refuses
// as a whole, so a backup never silently misses a folder.
const LOOKING = new Set(['test', 'discover', 'readiness', 'plan', 'describe-containers', 'domain-routes', 'key-scan', 'list-project-files', 'nas-template-restore']);
// Bind mounts every container has and no backup holds (the host's clock and name files, the Docker socket). They are left out of
// the helper's folders on purpose: the helper never copies them, and they must not make a whole backup refuse.
export const SKIPPED_BINDS = Object.freeze(['/etc/localtime', '/etc/timezone', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/var/run/docker.sock', '/run/docker.sock']);
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CACHE_MS = 5 * 60 * 1000;
const ready = new Map(); // server id -> { runId, until }

const parent = path => (typeof path === 'string' && path.startsWith('/') ? posix.dirname(path) : null);
export function requestPaths(server, request, facts) {
  const config = request?.config && typeof request.config === 'object' ? request.config : {};
  const list = value => (Array.isArray(value) ? value : []);
  return [facts?.stagingBase, request?.stagingBase, config.stagingRoot, config.documentRoot, config.maintenance?.directory,
    ...list(config.composeFiles).map(parent), ...list(config.configFiles).map(parent)].filter(value => typeof value === 'string');
}

async function bindSources(run, lead, names) {
  const sources = [];
  for (let i = 0; i < names.length; i += 20) {
    const out = await run([...lead, 'docker', 'inspect', '--format', '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\\n"}}{{end}}{{end}}', ...names.slice(i, i + 20)]).catch(() => ({ code: 1, stdout: '' }));
    if (out.code !== 0) throw new MountRefused('The app\'s folders could not be read from Docker.');
    sources.push(...String(out.stdout).split('\n').map(line => line.trim()).filter(Boolean));
  }
  return sources;
}
async function containerNames(run, lead, request) {
  const configured = Array.isArray(request?.config?.containers) ? request.config.containers : null;
  if (configured) return configured.filter(name => typeof name === 'string' && CONTAINER_NAME.test(name)).slice(0, 100);
  if (!LOOKING.has(request?.operation)) return [];
  const out = await run([...lead, 'docker', 'ps', '-aq', '--no-trunc']).catch(() => ({ code: 1, stdout: '' }));
  return out.code === 0 ? String(out.stdout).split('\n').map(line => line.trim()).filter(line => /^[a-f0-9]{64}$/.test(line)).slice(0, 200) : [];
}

// The deny-list is checked on the path as written and again on where it really points: a link from an app folder to /etc is
// refused. realpath -e runs on the server with a fixed argv. DockNest's own staging folder may not exist yet: it is created
// (mkdir -p, owner only) and resolved again; any other folder that does not exist is refused.
async function resolvedMount(run, lead, path, { nasKind, create }) {
  let out = await run([...lead, 'realpath', '-e', '--', path]).catch(() => ({ code: 1, stdout: '' }));
  if (out.code !== 0 && create) {
    await run([...lead, 'mkdir', '-p', '-m', '700', '--', path]).catch(() => null);
    out = await run([...lead, 'realpath', '-e', '--', path]).catch(() => ({ code: 1, stdout: '' }));
  }
  if (out.code !== 0) throw new MountRefused('A folder the helper runtime needs does not exist on the server.');
  checkMountPath(String(out.stdout).trim(), { nasKind });
  return path;
}
export async function computeRuntimeMounts({ server, request, run, identity, nasKind }) {
  const lead = identity === 'sudo' ? sudoPrefix() : [];
  const facts = typeof server.capabilities === 'string' ? (() => { try { return JSON.parse(server.capabilities); } catch { return null; } })() : server.capabilities;
  const binds = (await bindSources(run, lead, await containerNames(run, lead, request))).filter(path => !SKIPPED_BINDS.includes(path));
  const wanted = [...requestPaths(server, request, facts), ...binds];
  const own = new Set([facts?.stagingBase, request?.stagingBase, request?.config?.stagingRoot].filter(value => typeof value === 'string'));
  if (nasKind === 'unraid' && ['discover', 'nas-template-restore'].includes(request?.operation)) wanted.push(UNRAID_TEMPLATES);
  const looking = LOOKING.has(request?.operation);
  const allowed = [];
  for (const path of wanted) {
    try { allowed.push(await resolvedMount(run, lead, checkMountPath(path, { nasKind }), { nasKind, create: own.has(path) && !looking })); } catch (error) { if (!looking) throw error; }
  }
  return computeMounts(allowed, { nasKind });
}

// Returns the ssh options with runtimeMounts filled in; host-runtime servers get the options back unchanged.
export async function prepareRuntime(server, request, options = {}, { connect, makeRunner }) {
  const { runtime, identity, nasKind } = identityFor(server);
  if (runtime !== 'container') return options;
  const client = await connect(server);
  try {
    const run = makeRunner(client);
    const key = server.id ?? null;
    let known = key ? ready.get(key) : null;
    if (!known || known.until < Date.now()) {
      try { known = { runId: (await ensureRuntimeImage({ client, run, identity })).runId }; } catch (error) { ready.delete(key); throw error; }
      if (key) ready.set(key, { runId: known.runId, until: Date.now() + CACHE_MS });
    }
    const withImage = { ...options, runtimeImageId: known.runId };
    if (Array.isArray(options.runtimeMounts)) return withImage;
    return { ...withImage, runtimeMounts: await computeRuntimeMounts({ server, request, run, identity, nasKind }) };
  } finally { client.end(); }
}
// Called when a server's connection details change, so the next call checks the image again.
export const forgetRuntime = serverId => ready.delete(serverId);
