// Linked apps (docs/linked-apps.md): which apps on one server depend on each other, computed from the container facts of
// the last discovery scan. Pure and deterministic: the same facts, owners and database rule give the same answer, so
// links are never stored and follow every app change at once. Read-only: links only feed the Map and warnings.
//
// Inputs:
// - facts: [{name, image, project, service, networks, volumes, binds, links, dependsOn}], cleaned by the server
//   (src/server-links.js).
// - containerOwner(name): {siteId, name} of the app that backs the container up, or null.
// - isDatabase(fact): whether the container is a database (shared/database-image.js).
// Output: {links, unowned, hubs, partial}.
// - links: one per pair of apps, labelled with the strongest kind; `warns` is false for a network-only link, which the
//   Map shows but no warning uses.
// - unowned: containers no app backs up that an app depends on (it links to them, shares data with them, or reaches them
//   as its database).
// - hubs: networks more than HUB_APPS apps share, such as a reverse proxy network, listed once instead of as pairs.
// - partial: the work budget ran out, so some links may be missing.
//
// Work is per app, not per container pair: each shared volume, folder or network is split into its apps and its
// unowned containers, so a server with many containers on one network stays cheap.

// Strongest first.
export const LINK_KINDS = Object.freeze(['volume', 'link', 'database', 'network']);
export const HUB_APPS = 4, MAX_GROUP = 200, MAX_EVIDENCE = 20000;
const rank = kind => LINK_KINDS.indexOf(kind);
const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none']);
// Bind sources that unrelated containers share without depending on each other: system files, logs, devices, Docker's
// own data and the engine socket.
const SYSTEM_BIND = /^\/(?:proc|sys|dev|run|var\/run|var\/lib\/docker|var\/log|lib\/modules|usr\/share\/zoneinfo)(?:\/|$)|^\/etc\/(?:localtime|timezone|hosts|resolv\.conf|machine-id|passwd|group|os-release|ssl|ca-certificates|pki)(?:\/|$)/;
const trimSlash = path => path.replace(/\/+$/, '') || '/';
const sharedBind = path => path !== '/' && !SYSTEM_BIND.test(path);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pairs = list => list.flatMap((first, index) => list.slice(index + 1).map(second => [first, second]));
const names = containers => containers.map(container => container.name);

// The outermost bind folder of the scan that holds `path`, so /srv and /srv/media count as one shared folder, /srv.
function bindRoot(path, all) {
  const parts = path.split('/');
  for (let length = 2; length < parts.length; length++) {
    const prefix = parts.slice(0, length).join('/');
    if (all.has(prefix)) return prefix;
  }
  return path;
}

// Containers grouped by a key they share, in key order.
function groupBy(containers, keysOf) {
  const groups = new Map();
  for (const container of containers) for (const key of new Set(keysOf(container))) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(container);
  }
  return [...groups].sort(([a], [b]) => byText(a, b));
}

// Collects reasons per pair of apps and per unowned container. `pair` and `free` return false once the work budget is
// spent; the caller then stops and the result is partial.
function collector() {
  const links = new Map(), unowned = new Map();
  let evidence = 0, partial = false;
  const spend = () => { if (evidence >= MAX_EVIDENCE) { partial = true; return false; } evidence += 1; return true; };
  const add = (entries, key, create, kind, via, containers) => {
    if (!entries.has(key)) entries.set(key, create());
    const entry = entries.get(key), detail = kind + '\n' + via;
    if (!entry.details.has(detail)) entry.details.set(detail, { kind, via, containers: new Set() });
    for (const name of containers) entry.details.get(detail).containers.add(name);
    return entry;
  };
  const finish = entry => {
    const details = [...entry.details.values()].map(detail => ({ kind: detail.kind, via: detail.via, containers: [...detail.containers].sort(byText) }))
      .sort((a, b) => rank(a.kind) - rank(b.kind) || byText(a.via, b.via));
    return { kind: details[0].kind, via: details[0].via, details };
  };
  return {
    pair(first, second, kind, via, containers) {
      if (!spend()) return false;
      const appIds = [first, second].sort(byText);
      add(links, appIds.join('\n'), () => ({ appIds, details: new Map() }), kind, via, containers);
      return true;
    },
    free(container, appId, kind, via, containers) {
      if (!spend()) return false;
      add(unowned, container, () => ({ container, appIds: new Set(), details: new Map() }), kind, via, containers).appIds.add(appId);
      return true;
    },
    skip() { partial = true; },
    result(hubs) {
      return {
        links: [...links.values()].map(entry => { const { kind, via, details } = finish(entry); return { appIds: entry.appIds, kind, via, warns: kind !== 'network', details }; })
          .sort((a, b) => byText(a.appIds.join('\n'), b.appIds.join('\n'))),
        unowned: [...unowned.values()].map(entry => ({ container: entry.container, appIds: [...entry.appIds].sort(byText), ...finish(entry) })).sort((a, b) => byText(a.container, b.container)),
        hubs: hubs.sort((a, b) => byText(a.network, b.network)),
        partial,
      };
    },
  };
}

// One shared key's containers, split into [app id, its containers] in id order and the unowned ones. A group with more
// members than MAX_GROUP is beyond the budget: the result is marked partial and null comes back.
function members(group, ownerOf, collect) {
  const apps = new Map(), free = [];
  for (const container of group) {
    const appId = ownerOf.get(container);
    if (!appId) { free.push(container); continue; }
    if (!apps.has(appId)) apps.set(appId, []);
    apps.get(appId).push(container);
  }
  if (apps.size + free.length > MAX_GROUP) { collect.skip(); return null; }
  return { apps: [...apps].sort(([a], [b]) => byText(a, b)), free };
}

// Named volumes and bind folders: every two apps that mount one, and every unowned container that mounts it with an app.
function volumes(containers, ownerOf, collect) {
  const shared = container => container.binds.map(trimSlash).filter(sharedBind);
  const binds = new Set(containers.flatMap(shared));
  for (const [via, group] of groupBy(containers, container => [...container.volumes, ...shared(container).map(path => bindRoot(path, binds))])) {
    const parts = members(group, ownerOf, collect);
    if (!parts) continue;
    for (const [[first, a], [second, b]] of pairs(parts.apps)) if (!collect.pair(first, second, 'volume', via, names([...a, ...b]))) return;
    for (const [appId, owned] of parts.apps) for (const free of parts.free) if (!collect.free(free.name, appId, 'volume', via, names([...owned, free]))) return;
  }
}

// Legacy links by container name (any project) and Compose depends_on by service (same project only).
function dependencies(containers, ownerOf, collect) {
  const byContainer = new Map(containers.map(container => [container.name, container]));
  const byService = new Map(containers.filter(container => container.project && container.service).map(container => [container.project + '\n' + container.service, container]));
  for (const container of containers) {
    const appId = ownerOf.get(container);
    if (!appId) continue;
    const services = container.project ? container.dependsOn.map(service => byService.get(container.project + '\n' + service)) : [];
    for (const target of new Set([...container.links.map(name => byContainer.get(name)), ...services])) {
      if (!target || target === container) continue;
      const other = ownerOf.get(target), tied = [container.name, target.name];
      if (other === appId) continue;
      if (!(other ? collect.pair(appId, other, 'link', target.name, tied) : collect.free(target.name, appId, 'link', target.name, tied))) return;
    }
  }
}

// User-defined networks. A database link needs a database on one side and a container that is not one on the other;
// otherwise two apps on a network share only the network. A network more than HUB_APPS apps share is a hub: it gives
// no links, only one hub entry.
function networks(containers, ownerOf, isDatabase, collect) {
  const hubs = [];
  const side = owned => ({ databases: owned.filter(isDatabase).map(container => container.name).sort(byText), clients: owned.some(container => !isDatabase(container)) });
  for (const [network, group] of groupBy(containers, container => container.networks.filter(name => !DEFAULT_NETWORKS.has(name)))) {
    const parts = members(group, ownerOf, collect);
    if (!parts) continue;
    if (parts.apps.length > HUB_APPS) { hubs.push({ network, appIds: parts.apps.map(([appId]) => appId) }); continue; }
    for (const [[first, a], [second, b]] of pairs(parts.apps)) {
      const left = side(a), right = side(b), tied = names([...a, ...b]);
      const reached = [...(right.clients ? left.databases : []), ...(left.clients ? right.databases : [])].sort(byText);
      if (!(reached.length ? collect.pair(first, second, 'database', reached[0], tied) : collect.pair(first, second, 'network', network, tied))) return hubs;
    }
    for (const [appId, owned] of parts.apps) {
      if (!side(owned).clients) continue;
      for (const free of parts.free.filter(isDatabase)) if (!collect.free(free.name, appId, 'database', free.name, names([...owned, free]))) return hubs;
    }
  }
  return hubs;
}

export function computeAppLinks(facts, containerOwner, isDatabase) {
  const containers = (Array.isArray(facts) ? facts : []).slice().sort((a, b) => byText(a.name, b.name));
  const ownerOf = new Map(containers.map(container => [container, containerOwner(container.name)?.siteId ?? null]));
  const databases = new Set(containers.filter(container => isDatabase(container)));
  const collect = collector();
  volumes(containers, ownerOf, collect);
  dependencies(containers, ownerOf, collect);
  return collect.result(networks(containers, ownerOf, container => databases.has(container), collect));
}

// The links of one app, strongest first, each with the other app's id and `warns`; the containers it depends on that no
// app backs up (these always warn); and the hub networks it is on. For the Map and the Backup, Move and Restore test
// warnings.
export function linksOfApp(view, appId) {
  const links = (view?.links || []).filter(link => link.appIds.includes(appId)).map(link => ({ ...link, otherAppId: link.appIds.find(other => other !== appId) }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || byText(a.otherAppId, b.otherAppId));
  return { links, unowned: (view?.unowned || []).filter(entry => entry.appIds.includes(appId)), hubs: (view?.hubs || []).filter(hub => hub.appIds.includes(appId)) };
}
