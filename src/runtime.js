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
