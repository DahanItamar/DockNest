import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const realFetch = globalThis.fetch, fetches = [];
globalThis.fetch = async url => { fetches.push(String(url)); throw new Error('no outbound calls in this test'); };
const root = await mkdtemp(join(tmpdir(), 'docknest-update-whats-new-'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const { imageNotes, whatsNewFor } = await import('../src/updates/routes.js');
const running = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
// 0: admin from before the release first started; 1: admin created after it; 2: operator.
const users = [id(), id(), id()], created = ['2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'], csrf = 'fixture-csrf', tokens = users.map(() => randomBytes(32).toString('base64url'));
for (const [index, user] of users.entries()) {
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, `${user}@example.invalid`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', created[index], `User ${index}`, index === 2 ? 'operator' : 'admin');
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(tokens[index]), user, csrf, Date.now() + 3600000, Date.now(), Date.now(), Date.now());
}
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
test.after(() => server.close());
const request = (route, { as = 0, method = 'GET', body, headers = {} } = {}) => realFetch(`http://127.0.0.1:${server.address().port}/api/updates${route}`, { method, headers: { Cookie: 'dbm_session=' + tokens[as], Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('what\'s new shows the running version\'s shipped notes once, only to admins who predate its first start', async () => {
  const first = await (await request('/whats-new')).json();
  assert.equal(first.show, true); assert.equal(first.version, 'v' + running);
  assert.match(first.markdown, /^# DockNest/); assert.ok(!first.markdown.startsWith('---'));
  const fresh = await (await request('/whats-new', { as: 1 })).json();
  assert.equal(fresh.show, false); assert.equal(fresh.markdown, first.markdown, 'the tab can still render the notes');
  assert.equal((await request('/whats-new', { as: 2 })).status, 403);
  assert.equal((await request('/whats-new/seen', { as: 2, method: 'POST', body: { version: 'v' + running } })).status, 403);
  assert.equal((await request('/whats-new/seen', { method: 'POST', body: { version: 'v99.0.0' } })).status, 400);
  assert.equal((await request('/whats-new/seen', { method: 'POST', body: { version: 'nope' } })).status, 400);
  assert.equal((await request('/whats-new/seen', { method: 'POST', body: { version: 'v' + running }, headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await request('/whats-new/seen', { method: 'POST', body: { version: 'v' + running }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM whats_new_seen').get().n, 0);
  assert.equal((await request('/whats-new/seen', { method: 'POST', body: { version: 'v' + running } })).status, 204);
  assert.equal((await request('/whats-new/seen', { method: 'POST', body: { version: running } })).status, 204, 'idempotent, bare version accepted');
  assert.equal(db.prepare('SELECT count(*) AS n FROM whats_new_seen WHERE user_id=?').get(users[0]).n, 1);
  assert.equal((await (await request('/whats-new')).json()).show, false);
  assert.deepEqual(fetches, []);
});

test('notes are found with the release naming rule; none means no dialog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docknest-notes-')), url = pathToFileURL(dir + '/');
  await writeFile(join(dir, '2026-10-01-v7.1.md'), '---\nsecurity: true\nfeatures: 2\nimprovements: 1\nfixes: 0\n---\n# Seven one\r\nbody\x07');
  await writeFile(join(dir, '2026-10-02-v7.2.3.md'), '---\nbogus: 1\n---\nx');
  assert.equal(imageNotes('7.1.0', url), '# Seven one\nbody');
  assert.equal(imageNotes('7.2.3', url), null, 'malformed front matter shows nothing');
  assert.equal(imageNotes('7.3.0', url), null);
  assert.deepEqual(whatsNewFor(db, { version: '7.3.0' }, { id: users[0] }, url), { show: false, version: 'v7.3.0', markdown: '' });
  assert.equal(whatsNewFor(db, { version: '7.1.0' }, { id: users[0] }, url).show, false, 'no release_history row for a version that never started');
});

test('releases/:version answers only for the current offer, from the cache, with unverified notes', async () => {
  assert.equal((await request('/releases/v99.0.0')).status, 404);
  db.prepare('INSERT INTO update_preferences(id,check_enabled,decided_by,decided_at) VALUES(1,1,?,?)').run(users[0], new Date().toISOString());
  const manifest = { version: '99.0.0', tag: 'v99.0.0', schemaVersion: 99, minUpgradeFrom: '1.0.0', highlights: { security: true, features: 3, evil: 1 } };
  db.prepare("INSERT INTO update_checks(id,status,checked_at,last_success_at,next_check_at,latest_version,published_at,manifest,release_notes) VALUES(1,'ok',?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), new Date().toISOString(), Date.now() + 3_600_000, 'v99.0.0', '2026-10-22T08:00:00.000Z', JSON.stringify(manifest), '# Big release\n\n- thing');
  const ok = await request('/releases/v99.0.0'); assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.version, 'v99.0.0'); assert.equal(body.releaseUrl, 'https://github.com/DahanItamar/DockNest/releases/tag/v99.0.0');
  assert.deepEqual(body.highlights, { security: true, features: 3 }); assert.equal(body.highlightsVerified, false);
  assert.deepEqual(body.compatibility, { minimumMet: true, updatesDatabase: 'yes', fromSchema: body.compatibility.fromSchema, toSchema: 99 });
  assert.deepEqual(body.downtime, { seconds: null, basis: null });
  assert.equal(body.notesMarkdown, '# Big release\n\n- thing'); assert.equal(body.notesSource, 'github-unverified');
  assert.equal((await request('/releases/v98.0.0')).status, 404);
  assert.equal((await request('/releases/v99.0.0', { as: 2 })).status, 403);
  db.prepare('UPDATE update_checks SET release_notes=NULL WHERE id=1').run();
  const none = await (await request('/releases/99.0.0')).json();
  assert.equal(none.notesMarkdown, null); assert.equal(none.notesSource, null);
  db.prepare('UPDATE update_preferences SET check_enabled=0').run();
  assert.equal((await request('/releases/v99.0.0')).status, 404, 'checks off offers nothing');
  assert.deepEqual(fetches, []);
});
