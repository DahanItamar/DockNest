// Update check (docs/update-center.md section 5, threat model section 8). The worker's daily tick and "Check now" in
// the API run this same module. Nothing here contacts anything unless update_preferences says yes: consent is read
// before every outbound request, so turning checks off also stops a check that is already running.
// Advisory only: every value is display data. The broker and upgrade.sh verify again before anything changes.
import { readFileSync } from 'node:fs';

export const REPOSITORY = 'DahanItamar/DockNest';
// Fixed in code (F19). The full list, never /releases/latest: the "latest" mark can be moved to an older release (T4).
export const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
// The only hosts the manifest download may be redirected to, compared exactly (no suffix matching).
export const ASSET_HOSTS = Object.freeze(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export const limits = Object.freeze({ timeoutMs: 10_000, releasesBytes: 1024 * 1024, manifestBytes: 64 * 1024, notesBytes: 64 * 1024, nameChars: 120, releases: 30, releasesJson: 16384, etag: 256, manualIntervalMs: 60_000, claimMs: 60_000, jitterMs: 120 * 60_000 });
export const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const HOUR = 3_600_000, DAY = 24 * HOUR, BACKOFF_HOURS = [1, 2, 4, 8, 24];
const FINAL_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// C0, DEL, C1, zero-width and bidirectional controls: a release name is one line of plain text that reads as it is.
const NAME_CONTROLS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
// Notes keep tabs and newlines (Markdown) and lose every other control and the bidirectional overrides.
const NOTES_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

export const finalTag = tag => typeof tag === 'string' && tag.length <= 32 && FINAL_TAG.test(tag);
export const releaseUrl = tag => finalTag(tag) ? `https://github.com/${REPOSITORY}/releases/tag/${tag}` : null;
export function manifestUrl(tag) {
  if (!finalTag(tag)) throw new TypeError('The manifest URL is built from a validated final tag only.');
  return `https://github.com/${REPOSITORY}/releases/download/${tag}/docknest-release.json`;
}
export function parseSemver(value) {
  const match = typeof value === 'string' && value.length <= 64 && SEMVER.exec(value);
  return match ? { core: match.slice(1, 4).map(BigInt), pre: match[4] ? match[4].split('.') : [] } : null;
}
// SemVer 2.0.0 precedence: build metadata ignored, a pre-release sorts below its final release, numeric identifiers
// compare as numbers and below alphanumeric ones. BigInt, so long numeric parts never lose precision.
export function compareSemver(a, b) {
  const left = parseSemver(a), right = parseSemver(b);
  if (!left || !right) throw new TypeError('Not a SemVer version.');
  for (let index = 0; index < 3; index++) if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let index = 0; ; index++) {
    const x = left.pre[index], y = right.pre[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
}
const newer = (tag, version) => { try { return compareSemver(tag, version) > 0; } catch { return false; } };

export function releaseName(value) {
  if (typeof value !== 'string') return '';
  let name = value.replace(NAME_CONTROLS, '').trim().slice(0, limits.nameChars);
  if (/[\ud800-\udbff]$/.test(name)) name = name.slice(0, -1);
  return name;
}
function capUtf8(text, bytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
// Unverified display text (D20): only the fallback when there is no updater, never used for a decision.
export const releaseNotes = value => typeof value === 'string' ? capUtf8(value.replace(/\r\n?/g, '\n').replace(NOTES_CONTROLS, ''), limits.notesBytes) : null;
const publishedAt = value => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
const validEtag = value => typeof value === 'string' && value.length <= limits.etag && /^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(value) ? value : null;
// Display-only chips (D21): typed keys only, anything else ignored, nothing valid means no chips.
export function highlights(value) {
  if (!isObject(value)) return null;
  const result = {};
  if (typeof value.security === 'boolean') result.security = value.security;
  for (const key of ['features', 'improvements', 'fixes']) if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 99) result[key] = value[key];
  return Object.keys(result).length ? result : null;
}

// Fixed messages only: never response text, headers or a redirect URL (it carries signed query parameters).
const MESSAGES = {
  network: 'Could not reach GitHub.', timeout: 'GitHub did not answer within 10 seconds.', redirect: 'GitHub answered the release list with a redirect, which DockNest does not follow.',
  http: 'GitHub answered with an unexpected HTTP status.', 'too-large': 'The answer from GitHub was larger than DockNest accepts.', invalid: 'GitHub returned data DockNest could not read.',
  'manifest-redirect': 'The release manifest redirected to a host DockNest does not accept.', 'manifest-http': 'The release manifest could not be downloaded.', 'manifest-mismatch': 'The release manifest does not match its release.',
};
export class CheckError extends Error {
  constructor(code, { status = null, retryAt = null } = {}) {
    super(code === 'rate-limited' ? `GitHub rate limit reached. DockNest tries again at ${new Date(retryAt).toISOString()}.` : code === 'http' && status ? `GitHub answered with HTTP ${status}.` : MESSAGES[code]);
    Object.assign(this, { name: 'CheckError', code, retryAt });
  }
}
const discard = response => response.body?.cancel().catch(() => {});
async function get(fetchImpl, url, headers, signal) {
  // redirect: 'manual' always. No cookies, token or install id; fetch adds no credentials of its own here.
  try { return await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal }); }
  catch { throw new CheckError(signal.aborted ? 'timeout' : 'network'); }
}
// Reads the body as a stream and stops at the cap, so a huge or endless answer never fills memory.
async function readCapped(response, bytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > bytes) { await discard(response); throw new CheckError('too-large'); }
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = [];
  let size = 0, onAbort;
  const aborted = new Promise((_resolve, reject) => { onAbort = () => reject(new CheckError('timeout')); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); });
  aborted.catch(() => {});
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > bytes) throw new CheckError('too-large');
      chunks.push(value);
    }
  } catch (error) { reader.cancel().catch(() => {}); throw error instanceof CheckError ? error : new CheckError(signal.aborted ? 'timeout' : 'network'); }
  finally { signal.removeEventListener('abort', onAbort); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new CheckError('invalid'); }
}
const parseJson = text => { try { return JSON.parse(text); } catch { throw new CheckError('invalid'); } };
function retryAt(headers, now) {
  const after = headers.get('retry-after')?.trim(), reset = headers.get('x-ratelimit-reset')?.trim();
  let at = null;
  if (after && /^\d{1,6}$/.test(after)) at = now + Number(after) * 1000;
  else if (after && !Number.isNaN(Date.parse(after))) at = Date.parse(after);
  else if (reset && /^\d{1,12}$/.test(reset)) at = Number(reset) * 1000;
  return at === null ? null : Math.min(Math.max(at, now + 60_000), now + DAY);
}
const userAgent = version => `DockNest/${parseSemver(version) ? version : 'unknown'}`;

export async function fetchReleases({ fetch: fetchImpl, etag = null, version = packageVersion, signal, now = Date.now() }) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': userAgent(version) };
  if (validEtag(etag)) headers['If-None-Match'] = etag;
  const response = await get(fetchImpl, RELEASES_URL, headers, signal);
  if (response.status === 304) { await discard(response); return { notModified: true }; }
  if (response.status >= 300 && response.status < 400) { await discard(response); throw new CheckError('redirect'); }
  if (response.status === 403 || response.status === 429) {
    const at = retryAt(response.headers, now); await discard(response);
    throw at ? new CheckError('rate-limited', { retryAt: at }) : new CheckError('http', { status: response.status });
  }
  if (response.status !== 200) { await discard(response); throw new CheckError('http', { status: response.status }); }
  if (!/^application\/(?:[\w.+-]*\+)?json\s*(?:;|$)/i.test(response.headers.get('content-type') || '')) { await discard(response); throw new CheckError('invalid'); }
  const list = parseJson(await readCapped(response, limits.releasesBytes, signal));
  if (!Array.isArray(list)) throw new CheckError('invalid');
  return { notModified: false, etag: validEtag(response.headers.get('etag')), list };
}
// The highest final version, computed here: drafts, pre-releases (by flag and by tag) and malformed tags are dropped.
// Only tag_name, draft, prerelease, published_at, name (display) and the latest release's body (fallback notes) are read.
export function summarizeReleases(list) {
  const seen = new Set(), finals = [];
  for (const entry of list) {
    if (!isObject(entry) || entry.draft !== false || entry.prerelease !== false || !finalTag(entry.tag_name) || seen.has(entry.tag_name)) continue;
    seen.add(entry.tag_name); finals.push(entry);
  }
  finals.sort((a, b) => compareSemver(b.tag_name, a.tag_name));
  const releases = finals.slice(0, limits.releases).map(entry => ({ tag: entry.tag_name, name: releaseName(entry.name), publishedAt: publishedAt(entry.published_at) }));
  while (JSON.stringify(releases).length > limits.releasesJson) releases.pop();
  const [latest] = finals;
  return { latest: latest ? { tag: latest.tag_name, publishedAt: publishedAt(latest.published_at), notes: releaseNotes(latest.body) } : null, releases };
}
// A redirect target for the manifest download: parsed with new URL(), then exact fields only (threat model section 8).
export function assetRedirect(location) {
  if (typeof location !== 'string' || location.length > 8192) return null;
  let url;
  try { url = new URL(location); } catch { return null; }
  return url.protocol === 'https:' && (url.port === '' || url.port === '443') && ASSET_HOSTS.includes(url.hostname) && url.username === '' && url.password === '' ? url : null;
}
export function manifestFields(value, tag) {
  if (!isObject(value) || value.tag !== tag || value.version !== tag.slice(1)) throw new CheckError('manifest-mismatch');
  return {
    version: value.version, tag,
    minUpgradeFrom: typeof value.minUpgradeFrom === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value.minUpgradeFrom) ? value.minUpgradeFrom : null,
    schemaVersion: Number.isSafeInteger(value.schemaVersion) && value.schemaVersion >= 0 ? value.schemaVersion : null,
    highlights: highlights(value.highlights),
  };
}
// Advisory manifest (D12): URL from the validated tag only, at most one redirect followed by hand, 64 KiB, JSON only.
export async function fetchManifest({ fetch: fetchImpl, tag, version = packageVersion, signal }) {
  const headers = { Accept: 'application/json, application/octet-stream;q=0.9', 'User-Agent': userAgent(version) };
  let response = await get(fetchImpl, manifestUrl(tag), headers, signal);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const target = assetRedirect(response.headers.get('location'));
    await discard(response);
    if (!target) throw new CheckError('manifest-redirect');
    response = await get(fetchImpl, target.href, headers, signal);
  }
  if (response.status !== 200) { await discard(response); throw new CheckError('manifest-http'); }
  return manifestFields(parseJson(await readCapped(response, limits.manifestBytes, signal)), tag);
}

export const checksEnabled = db => db.prepare('SELECT check_enabled FROM update_preferences WHERE id=1').get()?.check_enabled === 1;
// The single cache row, created when consent first becomes yes. The migration writes no rows.
export const ensureCheckRow = (db, now = Date.now()) => db.prepare("INSERT OR IGNORE INTO update_checks(id,status,checked_at,next_check_at) VALUES(1,'ok',?,?)").run(new Date(now).toISOString(), now);
// Atomic claim, so the worker and the API never run two checks at once. checked_at is the start of the last attempt;
// the lease in next_check_at covers a process that dies mid-check. A manual check may also run once a minute.
export function claimCheck(db, { manual = false, now = Date.now() } = {}) {
  if (!checksEnabled(db)) return false;
  ensureCheckRow(db, now);
  const at = new Date(now).toISOString(), lease = now + limits.claimMs;
  const sql = manual ? 'UPDATE update_checks SET checked_at=?,next_check_at=? WHERE id=1 AND (next_check_at<=? OR checked_at<=?)' : 'UPDATE update_checks SET checked_at=?,next_check_at=? WHERE id=1 AND next_check_at<=?';
  return db.prepare(sql).run(...[at, lease, now, ...(manual ? [new Date(now - limits.manualIntervalMs).toISOString()] : [])]).changes === 1;
}
export const nextAfterSuccess = (now, random = Math.random) => now + DAY + Math.min(Math.floor(Math.max(random(), 0) * (limits.jitterMs + 1)), limits.jitterMs);
export const nextAfterFailure = (now, failures, retry = null) => retry ?? now + BACKOFF_HOURS[Math.min(Math.max(failures, 1), BACKOFF_HOURS.length) - 1] * HOUR;
const defaultFetch = (...args) => globalThis.fetch(...args);
const phaseSignal = (signal, timeoutMs) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

// One check of a claimed row. Never throws for network or data problems: they become a failed row with a fixed
// message and the back-off. Returns { skipped: true } and writes nothing when consent is not (or no longer) yes.
export async function runCheck({ db, fetch: fetchImpl = defaultFetch, version = packageVersion, now = Date.now, random = Math.random, signal, timeoutMs = limits.timeoutMs }) {
  const row = db.prepare('SELECT * FROM update_checks WHERE id=1').get();
  if (!row || !checksEnabled(db)) return { skipped: true };
  try {
    const answer = await fetchReleases({ fetch: fetchImpl, etag: row.etag, version, signal: phaseSignal(signal, timeoutMs), now: now() });
    let cachedManifest = null;
    try { cachedManifest = row.manifest ? JSON.parse(row.manifest) : null; } catch { /* A damaged cache is fetched again. */ }
    let summary;
    if (answer.notModified) summary = { latest: row.latest_version ? { tag: row.latest_version, publishedAt: row.published_at, notes: row.release_notes } : null, releases: row.releases, etag: row.etag };
    else { const { latest, releases } = summarizeReleases(answer.list); summary = { latest, releases: JSON.stringify(releases), etag: answer.etag }; }
    const tag = summary.latest?.tag;
    let manifest = finalTag(tag) && cachedManifest?.tag === tag && answer.notModified ? cachedManifest : null;
    // At most one manifest fetch per check, only for a release newer than this one, and only while consent is still yes.
    if (finalTag(tag) && !manifest && newer(tag, version) && checksEnabled(db)) {
      try { manifest = await fetchManifest({ fetch: fetchImpl, tag, version, signal: phaseSignal(signal, timeoutMs) }); } catch { manifest = null; }
    }
    if (!checksEnabled(db)) return { skipped: true };
    const at = now();
    db.prepare("UPDATE update_checks SET status='ok',checked_at=?,last_success_at=?,next_check_at=?,failures=0,latest_version=?,published_at=?,manifest=?,release_notes=?,releases=?,etag=?,error=NULL WHERE id=1")
      .run(new Date(at).toISOString(), new Date(at).toISOString(), nextAfterSuccess(at, random), tag || null, summary.latest?.publishedAt || null, manifest ? JSON.stringify(manifest) : null, summary.latest?.notes ?? null, summary.releases ?? null, summary.etag || null);
    return { ok: true, notModified: answer.notModified, latest: tag || null, manifest };
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    if (!checksEnabled(db)) return { skipped: true };
    const at = now(), failures = (db.prepare('SELECT failures FROM update_checks WHERE id=1').get()?.failures || 0) + 1;
    db.prepare("UPDATE update_checks SET status='failed',checked_at=?,failures=?,next_check_at=?,error=? WHERE id=1").run(new Date(at).toISOString(), failures, nextAfterFailure(at, failures, error.retryAt), error.message.slice(0, 2048));
    return { ok: false, code: error.code, error: error.message };
  }
}

// In-process guard on top of the database claim, so one process never stacks checks.
let inFlight = null;
export const pendingCheck = () => inFlight;
function track(promise) { inFlight = promise.finally(() => { inFlight = null; }); return inFlight; }
// "Check now": at most once a minute (otherwise the cached row stays), within the caller's budget.
// A check this process is already running is awaited instead of starting a second one.
export async function checkNow(options) {
  if (inFlight) { await inFlight; return { claimed: false }; }
  if (!claimCheck(options.db, { manual: true, now: (options.now || Date.now)() })) return { claimed: false };
  return { claimed: true, ...(await track(runCheck(options))) };
}
// Background check after "Yes" or after turning checks on; the response does not wait for it.
export function startCheck(options, log = message => console.warn(message)) {
  if (inFlight || !claimCheck(options.db, { manual: true, now: (options.now || Date.now)() })) return null;
  return track(runCheck(options).catch(error => { log(`Update check stopped: ${error.message}`); return { ok: false }; }));
}
// Worker tick: claims a due check (24 h plus 0 to 120 min jitter after success, back-off after failure) and runs it
// without blocking job claims. Never throws into the worker loop.
export function tickUpdateCheck(options, log = message => console.warn(message)) {
  try {
    if (inFlight || !claimCheck(options.db, { now: (options.now || Date.now)() })) return null;
    return track(runCheck(options).then(result => { if (result.ok === false) log(`Update check failed: ${result.error}`); return result; }, error => { log(`Update check stopped: ${error.message}`); return { ok: false }; }));
  } catch (error) { log(`Update check skipped: ${error.message}`); return null; }
}
