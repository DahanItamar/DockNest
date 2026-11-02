// Self-heal event streams (docs/self-heal.md, "How the stream works" and security review items 3, 5 and 6). Worker only.
// - One held SSH exec of the helper (`health-events`) per server that has at least one enabled site, on its own SSH
//   connection (never shared with job traffic), with ssh2 transport keepalive 15 s x 3. Stdin stays open; closing it
//   (stop, worker exit, a dropped connection) ends `docker events` on the server.
// - syncStreams() runs on the worker's existing tick. It compares a fingerprint per server (address, user, pinned host
//   key, sealed key, the watched identities and settings time of its enabled sites, and the end of their latest site
//   job) with the open streams, and only then opens, closes or reopens one. So a settings change, a host-key re-pin,
//   a credential change, a server or site removal, a site move and a Safe Edit (or any site job) that may have changed
//   the services all reopen the stream, which re-resolves the watched containers on connect. No timer reads state.
// - A drop reconnects with exponential backoff and jitter (5 s to 5 minutes), scheduled by the close event. A host key
//   that does not match the pinned one fails closed: no reconnect until the server record changes.
// - Every line is validated: exactly {container, status, at, id, timeNano} with known values, a watched container
//   name, deduped on (container ID, timeNano) and throttled to one accepted event per container per 10 s. Anything else
//   is dropped; an over-long line closes the stream (and reconnects). Nothing from a line reaches a log.
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { connect } from '../ssh.js';
import { helperSource } from '../helper-bundle.js';
import { recordHealth, gaveUp, healClock } from './engine.js';
import { STREAM, CONTAINER, CONTAINER_ID, STATUSES, WATCH_PER_SERVER, backoffMs, timing } from './limits.js';

// SSH, timers and randomness; tests replace members.
export const streamTransport = {
  connect: server => connect(server, { keepaliveInterval: STREAM.keepaliveMs, keepaliveCountMax: STREAM.keepaliveMisses }),
  random: () => Math.random(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: timer => clearTimeout(timer),
};
const RUNTIME = 'self_heal_runtime';
const COMMAND = 'python3 -c "import base64,sys;exec(compile(base64.b64decode(sys.stdin.readline()),\'<docknest-helper>\',\'exec\'))"';
const streams = new Map();
const runtime = { servers: {}, sites: {} };
function persist() {
  try { db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(RUNTIME, JSON.stringify({ ...runtime, at: new Date(healClock.now()).toISOString() })); }
  catch (error) { console.error(`Self-heal stream state could not be saved: ${error.code ?? error.name}`); }
}

// Exactly the five fields the helper forwards, with known values. Returns the event or null (dropped).
export function validEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join() !== 'at,container,id,status,timeNano') return null;
  const { container, status, at, id, timeNano } = value;
  if (typeof container !== 'string' || !CONTAINER.test(container) || !STATUSES.includes(status) || typeof id !== 'string' || !CONTAINER_ID.test(id)) return null;
  // timeNano is above 2^53, so JSON gives it to the nearest representable number; that is fine for dedupe. 0 marks the
  // connect snapshot, which is never deduped.
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || typeof timeNano !== 'number' || !Number.isFinite(timeNano) || timeNano < 0) return null;
  return { container, status, at, id, timeNano };
}

// What should be open: one entry per server with an enabled, active site.
const overfull = new Set();
export function desiredStreams() {
  overfull.clear();
  const rows = db.prepare(`SELECT h.site_id,h.watched,h.updated_at,s.server_id,v.host,v.port,v.username,v.host_key,v.private_key,
      (SELECT MAX(finished_at) FROM jobs j WHERE j.site_id=s.id AND j.type NOT IN ('self-heal','restore-test')) AS last_work
    FROM self_heal_settings h JOIN sites s ON s.id=h.site_id JOIN servers v ON v.id=s.server_id
    WHERE h.enabled=1 AND s.id NOT IN (SELECT site_id FROM site_archives) ORDER BY s.server_id,h.site_id`).all();
  const desired = new Map();
  for (const row of rows) {
    let watched = []; try { watched = JSON.parse(row.watched); } catch { watched = []; }
    const entries = (Array.isArray(watched) ? watched : []).filter(item => item && CONTAINER.test(item.name ?? '')).map(item => ({ siteId: row.site_id, name: item.name, project: item.project ?? null, service: item.service ?? null }));
    if (!entries.length) continue;
    // At most WATCH_PER_SERVER containers per server (the API refuses more; a site moved onto a full server is not
    // watched and says why). Sites are taken in a stable order.
    const count = desired.get(row.server_id)?.watch.length ?? 0;
    if (count + entries.length > WATCH_PER_SERVER) { overfull.add(row.site_id); continue; }
    const item = desired.get(row.server_id) ?? { serverId: row.server_id, server: { id: row.server_id, host: row.host, port: row.port, username: row.username, host_key: row.host_key, private_key: row.private_key }, watch: [], parts: [row.host, row.port, row.username, row.host_key, createHash('sha256').update(String(row.private_key)).digest('hex')] };
    item.watch.push(...entries);
    // Identity, not the current name: a Compose name the snapshot updates never reopens the stream.
    item.parts.push([row.site_id, row.updated_at, row.last_work, entries.map(entry => entry.project ? `${entry.project}/${entry.service}` : entry.name)]);
    desired.set(row.server_id, item);
  }
  for (const item of desired.values()) item.fingerprint = createHash('sha256').update(JSON.stringify(item.parts)).digest('hex');
  return desired;
}

export class ServerStream {
  constructor({ serverId, server, watch, fingerprint }) {
    Object.assign(this, { serverId, server, watch, fingerprint });
    this.state = 'off'; this.reason = null; this.attempt = 0; this.timer = null; this.client = null; this.channel = null;
    this.stopped = false; this.connectedAt = null; this.lastAccepted = new Map(); this.seen = new Set(); this.pending = new Map(); this.flushTimers = new Map();
    this.names = new Map(watch.map(entry => [entry.name, entry]));
    this.found = null;
  }
  setState(state, reason = null) {
    if (this.state === state && this.reason === reason) return;
    this.state = state; this.reason = reason;
    runtime.servers[this.serverId] = { state, reason, since: new Date(healClock.now()).toISOString() };
    persist();
  }
  start() { this.open(); return this; }
  async open() {
    if (this.stopped) return;
    this.setState('connecting', this.reason);
    let client;
    try { client = await streamTransport.connect(this.server); }
    catch (error) {
      if (this.stopped) return;
      // Fail closed on a pin mismatch: never retried until the server record (and so the fingerprint) changes.
      if (error?.hostKeyRejected || /host-key fingerprint/.test(String(error?.message))) return this.setState('off', 'host_key');
      return this.retry('unreachable');
    }
    if (this.stopped) { try { client.end(); } catch { /* closing */ } return; }
    this.client = client;
    client.on('error', () => {}); // 'close' follows and drives the reconnect
    client.once('close', () => this.closed(client));
    client.exec(COMMAND, { pty: false }, (error, channel) => {
      if (error || this.stopped) { try { client.end(); } catch { /* closing */ } return; }
      this.channel = channel;
      let buffer = '';
      channel.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > STREAM.bufferBytes) { this.lastReason = 'docker_events'; return this.drop(); }
        let n;
        while ((n = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
          if (Buffer.byteLength(line) > STREAM.lineBytes) { this.lastReason = 'docker_events'; return this.drop(); }
          this.line(line);
        }
      });
      channel.stderr?.on('data', () => {}); // never read: Docker output may carry secrets
      channel.on('close', () => { try { client.end(); } catch { /* closing */ } });
      channel.on('error', () => {});
      // The helper and its request; stdin stays open for as long as the stream should run.
      channel.write(helperSource().toString('base64') + '\n' + JSON.stringify({ operation: 'health-events', watch: this.watch.map(({ name, project, service }) => ({ name, project, service })) }) + '\n');
    });
  }
  drop() { try { this.channel?.close(); } catch { /* closing */ } try { this.client?.end(); } catch { /* closing */ } }
  line(text) {
    let value; try { value = JSON.parse(text); } catch { return; }
    // The snapshot: one `watched` line per entry (index, current name and ID, or nulls), then `watching: <count>`.
    if (value && typeof value.watched === 'object' && value.watched !== null) {
      const index = value.watched.index;
      if (Number.isInteger(index) && index >= 0 && index < this.watch.length) (this.found ??= [])[index] = value.watched;
      return;
    }
    if (Number.isInteger(value?.watching)) { const list = this.found ?? []; this.found = null; return this.snapshot(this.watch.map((_, index) => list[index] ?? null)); }
    if (typeof value?.error === 'string') { this.lastReason = /docker events stopped/.test(value.error) ? 'stream_ended' : 'docker_events'; return; }
    const event = validEvent(value);
    if (!event) return;
    const entry = this.names.get(event.container);
    if (!entry) return;
    if (event.timeNano > 0) {
      const key = `${event.id}:${event.timeNano}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    }
    // Throttle: at most one event acted on per container per 10 s. A newer event inside the window replaces the waiting
    // one and is acted on when the window ends (latest state wins), so a flapping container costs one row per 10 s and
    // a real change is never lost.
    const now = healClock.now(), last = this.lastAccepted.get(event.container) ?? -Infinity;
    if (now - last < timing.throttleMs) {
      const waiting = this.pending.has(event.container);
      this.pending.set(event.container, { entry, event });
      if (!waiting) this.flushTimers.set(event.container, streamTransport.setTimeout(() => this.flush(event.container), last + timing.throttleMs - now));
      return;
    }
    this.act(entry, event, now);
  }
  flush(container) {
    this.flushTimers.delete(container);
    const item = this.pending.get(container); this.pending.delete(container);
    if (item && !this.stopped) this.act(item.entry, item.event, healClock.now());
  }
  act(entry, event, now) {
    this.lastAccepted.set(event.container, now);
    const site = runtime.sites[entry.siteId] ??= { missing: [] };
    if ((site.health ??= {})[event.container] !== event.status) { site.health[event.container] = event.status; persist(); }
    try { recordHealth({ siteId: entry.siteId, serverId: this.serverId, container: event.container, status: event.status, id: event.id }); }
    catch (error) { console.error(`Self-heal could not record a health event: ${error.code ?? error.name}`); }
  }
  // The helper's first line: the current container of each watched entry (same order), or null when it is gone.
  snapshot(list) {
    this.connectedAt = healClock.now(); this.lastReason = null;
    const bySite = new Map();
    this.watch.forEach((entry, index) => {
      const found = list[index];
      const name = found && typeof found.name === 'string' && CONTAINER.test(found.name) && typeof found.id === 'string' && CONTAINER_ID.test(found.id) ? found.name : null;
      const site = bySite.get(entry.siteId) ?? { missing: [], renamed: [] };
      if (!name) site.missing.push(entry.name);
      else if (name !== entry.name) { site.renamed.push([entry, name]); this.names.delete(entry.name); entry.name = name; this.names.set(name, entry); }
      bySite.set(entry.siteId, site);
    });
    for (const [siteId, site] of bySite) {
      runtime.sites[siteId] = { missing: site.missing, health: runtime.sites[siteId]?.health ?? {}, at: new Date(this.connectedAt).toISOString() };
      if (site.renamed.length) renameWatched(siteId, site.renamed);
      for (const name of site.missing) { try { gaveUp(siteId, name, 'recreated'); } catch (error) { console.error(`Self-heal could not record a missing container: ${error.code ?? error.name}`); } }
    }
    this.setState('connected');
    persist();
  }
  closed(client) {
    if (this.client === client) { this.client = null; this.channel = null; }
    this.found = null;
    if (this.stopped) return;
    if (this.connectedAt && healClock.now() - this.connectedAt >= STREAM.steadyMs) this.attempt = 0;
    this.connectedAt = null;
    this.retry(this.lastReason ?? 'stream_ended');
  }
  retry(reason) {
    if (this.stopped || this.timer) return;
    this.setState('connecting', reason);
    const delay = backoffMs(this.attempt++, streamTransport.random);
    this.timer = streamTransport.setTimeout(() => { this.timer = null; this.open(); }, delay);
  }
  stop() {
    this.stopped = true;
    if (this.timer) { streamTransport.clearTimeout(this.timer); this.timer = null; }
    for (const timer of this.flushTimers.values()) streamTransport.clearTimeout(timer);
    this.flushTimers.clear(); this.pending.clear();
    this.drop();
    delete runtime.servers[this.serverId];
    for (const entry of this.watch) delete runtime.sites[entry.siteId];
  }
}
// A Compose container that came back under another name (for example after `compose up` with a new project scale):
// the saved name follows, so the history and the restart use the current name. Identity (project, service) is unchanged.
function renameWatched(siteId, renamed) {
  const row = db.prepare('SELECT watched FROM self_heal_settings WHERE site_id=?').get(siteId);
  if (!row) return;
  let watched; try { watched = JSON.parse(row.watched); } catch { return; }
  for (const [entry, name] of renamed) for (const item of watched) if (item.project && item.project === entry.project && item.service === entry.service) item.name = name;
  const text = JSON.stringify(watched);
  if (text.length <= 4096) db.prepare('UPDATE self_heal_settings SET watched=? WHERE site_id=?').run(text, siteId);
}

// On the worker tick: open, close or reopen streams whose fingerprint changed.
export function syncStreams() {
  let desired;
  try { desired = desiredStreams(); } catch (error) { console.error(`Self-heal streams could not be read: ${error.code ?? error.name}`); return; }
  let changed = false;
  for (const [serverId, stream] of streams) {
    if (desired.get(serverId)?.fingerprint === stream.fingerprint) continue;
    stream.stop(); streams.delete(serverId); changed = true;
  }
  for (const [serverId, item] of desired) {
    if (streams.has(serverId)) continue;
    streams.set(serverId, new ServerStream(item).start()); changed = true;
  }
  // After the streams changed (stopping one clears its sites' state): sites that did not fit on their server.
  for (const siteId of overfull) if (!runtime.sites[siteId]?.tooMany) { runtime.sites[siteId] = { missing: [], tooMany: true }; changed = true; }
  for (const [siteId, site] of Object.entries(runtime.sites)) if (site.tooMany && !overfull.has(siteId)) { delete runtime.sites[siteId]; changed = true; }
  if (changed) persist();
}
export function stopStreams() {
  for (const stream of streams.values()) stream.stop();
  streams.clear();
  runtime.servers = {}; runtime.sites = {};
  persist();
}
export const openStreams = () => new Map(streams);
