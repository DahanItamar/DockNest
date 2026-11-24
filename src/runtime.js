// Container engine of an app (docs/podman-rootless.md): which engine runs its containers. A missing runtime means rootful
// Docker, exactly as before. Everything here fails closed: an engine DockNest did not probe on that server is refused.
import { z } from 'zod';

const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const VERSION = /^[0-9][0-9A-Za-z.+~_-]{0,31}$/;
const MIN_UID = 1000;
const MAX_ENGINES = 32;

// The saved `config.runtime`. Strict: unknown keys are errors, never silently dropped.
export const runtimeSchema = z.object({
  engine: z.enum(['docker', 'podman']),
  rootless: z.boolean(),
  user: z.string().regex(USER).optional(),
  uid: z.number().int().min(MIN_UID).max(2 ** 31 - 1).optional()
}).strict().superRefine((value, ctx) => {
  const rootlessFields = value.user !== undefined && value.uid !== undefined;
  if (value.rootless && !rootlessFields) ctx.addIssue({ code: 'custom', message: 'A rootless engine needs its user name and numeric id.' });
  if (!value.rootless && (value.user !== undefined || value.uid !== undefined)) ctx.addIssue({ code: 'custom', message: 'A rootful engine has no user.' });
});

export const isRootfulDocker = runtime => !runtime || (runtime.engine === 'docker' && runtime.rootless === false);

const sameEngine = (a, b) => (a?.engine ?? 'docker') === (b?.engine ?? 'docker') && Boolean(a?.rootless) === Boolean(b?.rootless)
  && (a?.user ?? null) === (b?.user ?? null) && (a?.uid ?? null) === (b?.uid ?? null);

// Engines a server reported (capabilities.engines), checked again here because rootless users control parts of that
// answer. Anything not exactly in shape is dropped.
export function cleanEngines(list) {
  if (!Array.isArray(list)) return [];
  const clean = [];
  for (const item of list.slice(0, MAX_ENGINES)) {
    const parsed = runtimeSchema.safeParse(item && typeof item === 'object' ? { engine: item.engine, rootless: item.rootless, ...(item.user !== undefined ? { user: item.user } : {}), ...(item.uid !== undefined ? { uid: item.uid } : {}) } : null);
    if (!parsed.success || typeof item.version !== 'string' || !VERSION.test(item.version) || typeof item.cgroupDelegated !== 'boolean') continue;
    if (clean.some(known => sameEngine(known, parsed.data))) continue;
    clean.push({ ...parsed.data, version: item.version, cgroupDelegated: item.cgroupDelegated });
  }
  return clean;
}

// Why a saved runtime cannot be used on a server, or '' when it can. Rootful Docker (or none) is always fine.
export function runtimeRefusal(runtime, capabilities) {
  if (isRootfulDocker(runtime)) return '';
  const engines = cleanEngines(capabilities?.engines);
  if (!engines.length) return 'This server has not reported its container engines yet. Run Test connection first.';
  if (!engines.some(engine => sameEngine(engine, runtime))) return 'This server does not have that container engine running. Run Test connection and pick an engine it reports.';
  return '';
}

// One app, one engine: containers found in two engines cannot be one app. `containers` are discovery entries.
export function appRuntime(containers) {
  const runtimes = [];
  for (const container of containers) {
    const parsed = runtimeSchema.safeParse(container?.runtime ?? { engine: 'docker', rootless: false });
    if (!parsed.success) return { error: 'A container reports a container engine DockNest does not understand.' };
    if (!runtimes.some(known => sameEngine(known, parsed.data))) runtimes.push(parsed.data);
  }
  if (runtimes.length > 1) return { error: 'These containers run in two engines. Make two apps.' };
  return { runtime: runtimes[0] ?? { engine: 'docker', rootless: false } };
}

// Until backup, restore and the other operations understand other engines (docs/podman-rootless.md), every Node path that
// would act on an app's containers through rootful Docker refuses an app whose saved runtime is anything else.
export const FOREIGN_REFUSAL = 'This app runs in Podman or a rootless engine, which this release cannot do that for yet.';
export const hasForeignRuntime = config => {
  let value = config;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  const runtime = value?.runtime;
  return runtime !== undefined && runtime !== null && !isRootfulDocker(runtime);
};

const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);
const small = (object, keys, max = 4096) => Object.fromEntries(keys.flatMap(key => text(object?.[key], max) !== null ? [[key, object[key]]] : []));
const FOREIGN_LIMIT = 200;
const isPlainRootful = runtime => runtime === undefined || (runtimeSchema.safeParse(runtime).success && isRootfulDocker(runtime));
// Containers of Podman and rootless engines, from a helper answer rootless users can influence: only entries whose
// runtime this server reported are kept, and every field is rebuilt with a type and a length limit.
// Rootful Docker entries pass through untouched (they are what discovery always returned).
export function cleanDiscovered(containers, capabilities) {
  if (!Array.isArray(containers)) return containers;
  const engines = cleanEngines(capabilities?.engines), kept = [];
  let foreign = 0;
  for (const entry of containers) {
    if (!entry || typeof entry !== 'object') continue;
    if (isPlainRootful(entry.runtime)) { kept.push(entry); continue; }
    const parsed = runtimeSchema.safeParse(entry.runtime);
    if (!parsed.success || !engines.some(engine => sameEngine(engine, parsed.data)) || ++foreign > FOREIGN_LIMIT) continue;
    const name = text(entry.name, 128), id = text(entry.id, 64);
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || !id || !/^[0-9a-f]{12,64}$/.test(id)) continue;
    const labels = Object.fromEntries(Object.entries(entry.labels && typeof entry.labels === 'object' ? entry.labels : {}).filter(([key, value]) => key.length <= 256 && text(value, 1024) !== null).slice(0, 50));
    const ports = Object.fromEntries(Object.entries(entry.ports && typeof entry.ports === 'object' ? entry.ports : {}).slice(0, 50)
      .map(([port, bindings]) => [text(port, 32) ?? '', (Array.isArray(bindings) ? bindings : []).slice(0, 8).map(binding => small(binding, ['HostIp', 'HostPort'], 64))]).filter(([port]) => port));
    kept.push({
      hardening: null, links: null, runtime: parsed.data, id, name, image: text(entry.image, 512), state: text(entry.state, 32), running: entry.running === true, health: text(entry.health, 32),
      labels, mounts: (Array.isArray(entry.mounts) ? entry.mounts : []).slice(0, 100).map(mount => ({ ...small(mount, ['Type', 'Name', 'Source', 'Destination', 'Driver', 'Mode']), RW: mount?.RW !== false })),
      temporaryMemoryFolders: (Array.isArray(entry.temporaryMemoryFolders) ? entry.temporaryMemoryFolders : []).slice(0, 90).filter(folder => text(folder, 4096) !== null),
      ports, webHints: [], backupConfiguration: { composeFiles: [], configFiles: [], directory: '' }
    });
  }
  return kept;
}

// Format 3 backups (Podman and rootless apps). The helper wrote `runtime` (and `idMap` for rootless) from the app's saved
// runtime; the metadata manifest keeps them so a restore can pick a matching target. Fails closed on any mismatch.
const idRange = value => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) && value[0] >= 1 && value[1] >= 1 && value[0] + value[1] <= 2 ** 32 - 1;
export function manifestRuntime(helperManifest, savedRuntime) {
  const runtime = helperManifest?.runtime;
  if (runtime === undefined) return isRootfulDocker(savedRuntime) ? {} : { error: 'The backup did not record the container engine of this app.' };
  const parsed = runtimeSchema.safeParse(runtime);
  if (!parsed.success || isRootfulDocker(parsed.data) || helperManifest.formatVersion !== 3 || !sameEngine(parsed.data, savedRuntime)) return { error: 'The backup recorded a container engine that does not match the app.' };
  if (!parsed.data.rootless) return helperManifest.idMap === undefined ? { formatVersion: 3, runtime: parsed.data } : { error: 'The backup recorded an ID map for a rootful engine.' };
  const map = helperManifest.idMap;
  if (!map || !Number.isInteger(map.uid) || !Number.isInteger(map.gid) || map.uid < MIN_UID || map.gid < MIN_UID || !idRange(map.subuid) || !idRange(map.subgid)) return { error: 'The backup has no usable ID map.' };
  return { formatVersion: 3, runtime: parsed.data, idMap: { uid: map.uid, gid: map.gid, subuid: map.subuid, subgid: map.subgid } };
}

// Why a backup cannot restore into a target engine, or ''. Same engine kind, same rootless-ness, one container, no chain
// (docs/podman-rootless.md). Docker to Podman and rootful to rootless need a later release.
export function restoreRuntimeProblem(source, target, capabilities, { containers = 1, chainLength = 1 } = {}) {
  if (!source) return isRootfulDocker(target) ? '' : 'This backup was made from rootful Docker. Restoring it into another engine is not available yet.';
  const parsed = runtimeSchema.safeParse(target ?? source);
  if (!parsed.success) return 'The target container engine is not valid.';
  if (parsed.data.engine !== source.engine) return 'A backup restores only into the same container engine in this release.';
  if (parsed.data.rootless !== source.rootless) return 'A rootless backup restores only into a rootless engine, and a rootful one into a rootful engine, in this release.';
  if (containers !== 1) return 'Restoring an app with several containers into Podman or a rootless engine is not available yet.';
  if (chainLength !== 1) return 'Backups of Podman and rootless apps are not incremental yet.';
  return runtimeRefusal(parsed.data, capabilities);
}
