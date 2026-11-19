// Linked apps (docs/linked-apps.md): which apps on one server depend on each other, computed from the container facts of
// the last discovery scan. Pure and deterministic: the same facts, owners and database rule give the same answer, so
// links are never stored and follow every app change at once. Read-only: links only feed warnings.
//
// Inputs:
// - facts: [{name, image, project, service, networks: [{name, aliases}], volumes, binds, links, dependsOn}], cleaned by
//   the server (src/server-links.js).
// - containerOwner(name): {siteId, name} of the app that backs the container up, or null.
// - isDatabase(fact): whether the container is a database (shared/database-image.js).
// Output: {links, unowned}. One link per pair of apps, labelled with the strongest kind; `unowned` lists containers no app
// backs up that an app depends on (it links to them, shares data with them, or reaches them as its database).

// Strongest first.
export const LINK_KINDS = Object.freeze(['volume', 'link', 'database', 'network']);
const rank = kind => LINK_KINDS.indexOf(kind);
const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none']);
// Bind sources that unrelated containers share without depending on each other: system files, devices, the engine socket.
const SYSTEM_BIND = /^\/(?:proc|sys|dev|run|var\/run|lib\/modules|usr\/share\/zoneinfo)(?:\/|$)|^\/etc\/(?:localtime|timezone|hosts|resolv\.conf|machine-id|ssl|ca-certificates|pki)(?:\/|$)/;
const sharedBind = source => source !== '/' && !SYSTEM_BIND.test(source);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pairs = list => list.flatMap((first, index) => list.slice(index + 1).map(second => [first, second]));

// Containers grouped by a key they share (a volume, a bind source, a network), in name order.
function groupBy(containers, keysOf) {
  const groups = new Map();
  for (const container of containers) for (const key of new Set(keysOf(container))) groups.set(key, [...(groups.get(key) || []), container]);
  return [...groups].sort(([a], [b]) => byText(a, b));
}

// Every reason two containers are tied, as {kind, via, containers: [a, b], target}. `target` is the side the other one
// depends on; a container no app backs up is reported only when it is that side.
function evidence(containers, isDatabase) {
  const found = [], byName = new Map(containers.map(container => [container.name, container]));
  for (const [via, group] of groupBy(containers, container => [...container.volumes, ...container.binds.filter(sharedBind)])) {
    for (const [a, b] of pairs(group)) found.push({ kind: 'volume', via, containers: [a, b], target: null });
  }
  for (const container of containers) {
    const services = new Set(container.dependsOn);
    const targets = [...container.links.map(name => byName.get(name)),
      ...containers.filter(other => container.project && other.project === container.project && services.has(other.service))];
    for (const target of new Set(targets)) if (target && target !== container) found.push({ kind: 'link', via: target.name, containers: [container, target], target });
  }
  for (const [network, group] of groupBy(containers, container => container.networks.map(item => item.name).filter(name => !DEFAULT_NETWORKS.has(name)))) {
    for (const [a, b] of pairs(group)) {
      const database = isDatabase(b) ? b : isDatabase(a) ? a : null;
      found.push(database ? { kind: 'database', via: database.name, containers: [a, b], target: database } : { kind: 'network', via: network, containers: [a, b], target: null });
    }
  }
  return found;
}

// Adds one reason to an entry, merging the containers of the same kind and name.
function addDetail(entry, kind, via, names) {
  const key = kind + '\n' + via, detail = entry.details.get(key) || { kind, via, containers: new Set() };
  for (const name of names) detail.containers.add(name);
  entry.details.set(key, detail);
}
function finish(entry) {
  const details = [...entry.details.values()].map(detail => ({ kind: detail.kind, via: detail.via, containers: [...detail.containers].sort(byText) }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || byText(a.via, b.via));
  return { kind: details[0].kind, via: details[0].via, details };
}

export function computeAppLinks(facts, containerOwner, isDatabase) {
  const containers = (Array.isArray(facts) ? facts : []).slice().sort((a, b) => byText(a.name, b.name));
  const databases = new Set(containers.filter(container => isDatabase(container)));
  const links = new Map(), unowned = new Map();
  for (const { kind, via, containers: [a, b], target } of evidence(containers, container => databases.has(container))) {
    const owners = [containerOwner(a.name), containerOwner(b.name)];
    if (owners[0] && owners[1]) {
      if (owners[0].siteId === owners[1].siteId) continue;
      const appIds = owners.map(owner => owner.siteId).sort(byText), key = appIds.join('\n');
      const entry = links.get(key) || { appIds, details: new Map() };
      addDetail(entry, kind, via, [a.name, b.name]); links.set(key, entry);
      continue;
    }
    const free = owners[0] ? b : owners[1] ? a : null, user = owners[0] || owners[1];
    if (!free || kind === 'network' || (target && target !== free)) continue;
    const entry = unowned.get(free.name) || { container: free.name, appIds: new Set(), details: new Map() };
    entry.appIds.add(user.siteId); addDetail(entry, kind, via, [a.name, b.name]); unowned.set(free.name, entry);
  }
  return {
    links: [...links.values()].map(entry => ({ appIds: entry.appIds, ...finish(entry) })).sort((a, b) => byText(a.appIds.join('\n'), b.appIds.join('\n'))),
    unowned: [...unowned.values()].map(entry => ({ container: entry.container, appIds: [...entry.appIds].sort(byText), ...finish(entry) })).sort((a, b) => byText(a.container, b.container)),
  };
}

// The links of one app, strongest first, each with the other app's id, and the containers it depends on that no app backs
// up. For the Backup, Move and Restore test warnings.
export function linksOfApp(view, appId) {
  const links = (view?.links || []).filter(link => link.appIds.includes(appId)).map(link => ({ ...link, otherAppId: link.appIds.find(other => other !== appId) }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || byText(a.otherAppId, b.otherAppId));
  return { links, unowned: (view?.unowned || []).filter(entry => entry.appIds.includes(appId)) };
}
