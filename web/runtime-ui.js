// Container engines in the UI (docs/podman-rootless.md). Pure helpers: what to call an engine, how discovered containers group
// by engine, and the one-fix sentences shown when an engine cannot do something yet. The API checks everything again.
const ROOTFUL = Object.freeze({ engine: 'docker', rootless: false });
const NAME = { docker: 'Docker', podman: 'Podman' };

export const isRootful = runtime => !runtime || (runtime.engine === 'docker' && runtime.rootless === false);
export const runtimeOf = container => (container?.runtime && NAME[container.runtime.engine] ? container.runtime : ROOTFUL);
const same = (a, b) => a.engine === b.engine && Boolean(a.rootless) === Boolean(b.rootless) && (a.user ?? null) === (b.user ?? null) && (a.uid ?? null) === (b.uid ?? null);

// "Docker", "Podman", "Docker rootless, user app", "Podman rootless, user svc".
export function engineLabel(runtime) {
  const value = runtime && NAME[runtime.engine] ? runtime : ROOTFUL;
  return NAME[value.engine] + (value.rootless ? ' rootless' + (value.user ? ', user ' + value.user : '') : '');
}
// The runtime a set of containers shares, or the reason they cannot be one app. Rootful Docker is { engine, rootless: false }.
export function sharedRuntime(containers) {
  const found = [];
  for (const container of containers) { const runtime = runtimeOf(container); if (!found.some(known => same(known, runtime))) found.push(runtime); }
  return found.length > 1 ? { conflict: found } : { runtime: found[0] ?? ROOTFUL };
}
export const oneEngineMessage = name => `${name}'s containers run in two engines. Make two apps.`;
// The config fragment a saved app carries: nothing for rootful Docker, exactly as before.
export function runtimeConfig(containers) {
  const { runtime } = sharedRuntime(containers);
  if (!runtime || isRootful(runtime)) return {};
  return { runtime: { engine: runtime.engine, rootless: Boolean(runtime.rootless), ...(runtime.rootless ? { user: runtime.user, uid: runtime.uid } : {}) } };
}
// Rootful Docker first, then by name, so the list reads the same on every visit.
export function sortByEngine(groups, runtimeOfGroup) {
  // Stable: inside one engine the incoming order (NAS grouping, then name) is kept.
  return [...groups].sort((a, b) => engineLabel(runtimeOfGroup(a)).localeCompare(engineLabel(runtimeOfGroup(b)), 'en', { sensitivity: 'base' }));
}
export const groupRuntime = group => { const shared = sharedRuntime(group.containers ?? []); return shared.runtime ?? shared.conflict[0]; };

export const engineList = server => (Array.isArray(server?.capabilities?.engines) ? server.capabilities.engines : []);
// A server with no usable Docker but another engine (a Podman-only server): the connection works, and says so.
export const podmanOnly = server => Boolean(server?.capabilities) && server.capabilities.docker == null && engineList(server).length > 0;

// Why a restore test on this server cannot run this app, or '' (the helper refuses it too, with the same reason).
export function testServerProblem(site, server) {
  const runtime = site?.config?.runtime;
  if (!runtime || isRootful(runtime) || !server) return '';
  const found = engineList(server).find(engine => same(engine, runtime));
  if (!found) return `${server.name} does not run ${engineLabel(runtime)}. Pick a server that does, or run Test connection on ${server.name} first.`;
  if (runtime.rootless && found.cgroupDelegated !== true) return `This server cannot limit memory for user apps, so DockNest will not test there. Turn on memory and CPU delegation for user ${runtime.user} on ${server.name}, or pick another test server.`;
  return '';
}
// One sentence for what is not available yet for an app in another engine. Nothing for rootful Docker.
export const UNSUPPORTED_NOW = 'Self-heal, Safe Edit and moves are not available for this engine yet.';
