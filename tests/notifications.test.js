// Notification centre (docs/notifications.md): migration 28 on an existing database, feeding from the alert events for every
// administrator, dedupe, per-user isolation, the API (auth, CSRF, roles, filters, paging), redaction, retention and the
// extra events (restores, recovery time). All data is fake (example.com, documentation addresses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = await mkdtemp(join(tmpdir(), 'docknest-notifications-'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const { migrations, migrate, schemaVersion, compatFloor } = await import('../src/migrations.js');
const store = await import('../src/notifications/store.js');
const { emit } = await import('../src/alerts/delivery.js');
const detect = await import('../src/alerts/detect.js');
const { EVENTS } = await import('../src/alerts/events.js');
const { profileOf, NOTIFY_ONLY, validLink } = await import('../src/notifications/catalog.js');

const now = () => new Date().toISOString();
const csrf = 'fixture-csrf';
const people = [['a', 'admin'], ['b', 'admin'], ['v', 'viewer']].map(([name, role], index) => ({ name, role, id: id(), token: randomBytes(32).toString('base64url'), index }));
const [A, B, V] = people;
for (const person of people) {
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(person.id, `${person.name}@example.com`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', now(), person.name, person.role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(person.token), person.id, csrf, Date.now() + 3600_000, Date.now(), Date.now(), Date.now());
}
const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
test.after(() => listener.close());
const call = (method, route, { who = A, body, token = true, header = true } = {}) => fetch(`http://127.0.0.1:${listener.address().port}/api${route}`, { method, headers: { ...(token ? { Cookie: 'dbm_session=' + who.token } : {}), Origin: process.env.APP_ORIGIN, ...(header ? { 'x-csrf-token': csrf } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const rows = who => db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id').all(who.id);
const clear = () => db.exec('DELETE FROM notifications');
const failed = (extra = {}) => ({ type: 'backup.failed', key: 'site:one', siteName: 'Shop', serverName: 'Main', jobId: 'job-0001-aaaa', ...extra });

test('migration 28 is additive and compatible: a v27 database upgrades in place and keeps its rows', () => {
  assert.equal(schemaVersion, 28);
  assert.deepEqual(migrations.at(-1), { version: 28, name: 'notifications', compatible: true, up: migrations.at(-1).up });
  assert.equal(compatFloor(migrations), compatFloor(migrations, 27), 'compat floor is unchanged, so 2.16 code keeps running on a v28 database');
  const old = new DatabaseSync(':memory:');
  old.exec('PRAGMA foreign_keys=ON');
  migrate(old, { file: join(root, 'old.sqlite'), list: migrations.filter(item => item.version <= 27), now: () => new Date('2026-11-01T00:00:00Z'), log: () => {} });
  old.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,role) VALUES('u','x@example.com','h','s','[]',1,'2026-01-01','admin')").run();
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='notifications'").get().n, 0);
  migrate(old, { file: join(root, 'old.sqlite'), now: () => new Date('2026-11-02T00:00:00Z'), log: () => {} });
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 28);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'existing rows are kept');
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='notifications'").get().n, 1);
  old.prepare("INSERT INTO notifications(user_id,event_key,dedupe_key,severity,category,title,body,first_at,last_at) VALUES('u','e','d','error','backups','t','b','x','x')").run();
  assert.throws(() => old.prepare("INSERT INTO notifications(user_id,event_key,dedupe_key,severity,category,title,body,first_at,last_at) VALUES('u','e','d','loud','backups','t','b','x','x')").run(), /CHECK/);
  old.prepare("DELETE FROM users WHERE id='u'").run();
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0, 'a deleted user takes their notifications with them');
  migrate(old, { file: join(root, 'old.sqlite'), now: () => new Date('2026-11-03T00:00:00Z'), log: () => {} });
});

test('every alert event has a severity and a category; the in-app additions are covered too', () => {
  for (const type of [...EVENTS, ...Object.keys(NOTIFY_ONLY)]) { const profile = profileOf({ type }); assert.ok(profile, type); assert.ok(['error', 'warning', 'info', 'success'].includes(profile.severity), type); }
  const pick = (type, extra = {}) => profileOf({ type, ...extra }).severity;
  assert.equal(pick('backup.succeeded'), 'success'); assert.equal(pick('backup.failed'), 'error'); assert.equal(pick('restore.succeeded'), 'success'); assert.equal(pick('restore.failed'), 'error');
  assert.equal(pick('restore_test.recovered'), 'success'); assert.equal(pick('restore_test.failed'), 'error'); assert.equal(pick('restore_test.couldnt_run'), 'warning'); assert.equal(pick('recovery_time.stale'), 'warning');
  assert.equal(pick('server.unreachable'), 'error'); assert.equal(pick('server.disk_low'), 'warning'); assert.equal(pick('certificate.expiring'), 'warning'); assert.equal(pick('certificate.expiring', { code: 'expired' }), 'error'); assert.equal(pick('update.available'), 'info');
  assert.equal(profileOf({ type: 'nope' }), null);
});

test('emit feeds every administrator, and only administrators; a repeat folds into count and is unread again', () => {
  clear();
  emit(failed(), { at: Date.parse('2026-11-20T10:00:00Z') });
  assert.equal(rows(A).length, 1); assert.equal(rows(B).length, 1); assert.equal(rows(V).length, 0, 'a viewer gets none');
  const first = rows(A)[0];
  assert.deepEqual([first.severity, first.category, first.count, first.link, first.read_at], ['error', 'backups', 1, 'job:job-0001-aaaa', null]);
  assert.equal(first.body, 'Shop on Main.'); assert.doesNotMatch(first.body, /Open DockNest| at dd:dd/);
  store.markRead(A.id, [first.id]); store.archive(A.id, [first.id]);
  emit(failed(), { at: Date.parse('2026-11-20T11:00:00Z') });
  const folded = rows(A);
  assert.equal(folded.length, 1, 'one row, not two'); assert.equal(folded[0].count, 2); assert.equal(folded[0].read_at, null, 'unread again'); assert.equal(folded[0].archived_at, null, 'back in the inbox');
  assert.equal(folded[0].first_at, '2026-11-20T10:00:00.000Z'); assert.equal(folded[0].last_at, '2026-11-20T11:00:00.000Z');
  assert.equal(rows(B)[0].count, 2);
  emit(failed({ key: 'site:two', siteName: 'Blog' }), { at: Date.parse('2026-11-20T11:05:00Z') });
  assert.equal(rows(A).length, 2, 'another source is another row');
  emit({ type: 'backup.succeeded', key: 'site:one', siteName: 'Shop', serverName: 'Main' }, { at: Date.parse('2026-11-20T11:06:00Z') });
  assert.equal(rows(A).length, 3, 'a different event for the same source is its own row');
  emit(failed(), { at: Date.parse('2026-11-23T11:00:00Z') });
  assert.equal(rows(A).filter(row => row.dedupe_key === 'backup.failed:site:one').length, 2, 'a state-like repeat after the 24 hour window starts a new row');
});

test('an occurrence key folds a replay of the same thing, however late', () => {
  clear();
  emit({ type: 'update.available', key: 'occ:update:9.9.9', version: '9.9.9' }, { at: Date.parse('2026-11-01T00:00:00Z') });
  emit({ type: 'update.available', key: 'occ:update:9.9.9', version: '9.9.9' }, { at: Date.parse('2026-11-20T00:00:00Z') });
  assert.equal(rows(A).length, 1); assert.equal(rows(A)[0].count, 2); assert.equal(rows(A)[0].severity, 'info'); assert.equal(rows(A)[0].link, 'route:Update Center');
});

test('titles and bodies never hold secrets, addresses, paths or URLs, whatever a builder was given', () => {
  clear();
  emit({ type: 'backup.failed', key: 'site:leak', siteName: 'Shop 203.0.113.9 /srv/data/shop https://x.example.com/?token=abc ' + 'A'.repeat(40), serverName: 'Main' });
  const row = rows(A)[0], text = `${row.title} ${row.body}`;
  for (const pattern of [/203\.0\.113/, /\/srv\//, /https?:/, /A{32}/, /token=/]) assert.doesNotMatch(text, pattern);
  assert.equal(store.scrub('mail ops@example.com or <a.b+c@mail.example.org> now', 100), 'mail [email] or [email] now');
  assert.match(store.scrub('see C:\\Users\\me\\key.pem and /etc/ssh/id_rsa now', 100), /^see \[path\] and \[path\] now$/);
  assert.equal(store.scrub('word '.repeat(200), 400).length, 400);
  assert.ok(validLink('job:job-0001-aaaa') && validLink('route:Jobs') && validLink(null)); assert.ok(!validLink('route:Evil') && !validLink('https://example.com') && !validLink('javascript:alert(1)'));
});

test('API: sign-in, CSRF and the administrator role are required', async () => {
  clear(); emit(failed());
  assert.equal((await call('GET', '/notifications', { token: false })).status, 401);
  assert.equal((await call('POST', '/notifications/read-all', { header: false })).status, 403, 'no CSRF header');
  assert.equal((await call('GET', '/notifications', { who: V })).status, 403, 'a viewer');
  assert.equal((await call('POST', '/notifications/read-all', { who: V })).status, 403);
  assert.equal((await call('GET', '/notifications')).status, 200);
  assert.equal((await call('GET', '/notifications?tab=elsewhere')).status, 400);
  assert.equal((await call('GET', '/notifications?limit=1000')).status, 400);
  assert.equal((await call('POST', '/notifications/read', { body: { ids: [] } })).status, 400);
  assert.equal((await call('POST', '/notifications/read', { body: { ids: ['x'] } })).status, 400);
});

test('API: a user sees and changes only their own rows', async () => {
  clear(); emit(failed());
  const [mine] = rows(A), [theirs] = rows(B);
  assert.equal((await (await call('GET', '/notifications', { who: A })).json()).items[0].id, mine.id);
  assert.equal((await (await call('POST', '/notifications/read', { who: A, body: { ids: [theirs.id] } })).json()).changed, 0, 'cannot read-mark another user\'s row');
  assert.equal((await (await call('POST', '/notifications/archive', { who: A, body: { ids: [theirs.id] } })).json()).changed, 0);
  assert.equal(rows(B)[0].read_at, null); assert.equal(rows(B)[0].archived_at, null);
  assert.equal((await (await call('POST', '/notifications/read', { who: A, body: { ids: [mine.id] } })).json()).changed, 1);
  assert.equal((await (await call('GET', '/notifications/unread-count', { who: A })).json()).unread, 0);
  assert.equal((await (await call('GET', '/notifications/unread-count', { who: B })).json()).unread, 1);
  emit(failed({ key: 'site:iso2' }));
  assert.equal((await (await call('POST', '/notifications/read-all', { who: A })).json()).changed, 1);
  assert.equal(rows(B).every(row => row.read_at === null), true, 'read-all is per user');
});

test('API: tabs, filters, counts, paging, archive and unarchive', async () => {
  clear();
  const at = Date.parse('2026-11-20T10:00:00Z'), event = (type, key, extra = {}) => ({ type, key, siteName: 'Shop', serverName: 'Main', ...extra });
  emit(event('backup.failed', 'site:1'), { at }); emit(event('backup.succeeded', 'site:2'), { at: at + 1000 }); emit(event('server.disk_low', 'server:1', { freeBytes: 1 << 30, usedPercent: 95 }), { at: at + 2000 });
  emit(event('update.available', 'occ:u', { version: '9.0.0' }), { at: at + 3000 }); emit(event('restore_test.failed', 'occ:rt', {}), { at: at + 4000 });
  const get = async query => (await call('GET', '/notifications' + query)).json();
  const all = await get('');
  assert.equal(all.total, 5); assert.equal(all.items[0].event, 'restore_test.failed', 'newest first');
  assert.deepEqual((await get('?tab=needs_action')).items.map(item => item.severity).sort(), ['error', 'error', 'warning']);
  assert.equal((await get('?tab=backups')).total, 3, 'backups and restore tests'); assert.equal((await get('?tab=storage')).total, 1); assert.equal((await get('?tab=system')).total, 1);
  assert.equal((await get('?severity=success')).total, 1); assert.equal(all.counts.unread.all, 5); assert.equal(all.counts.unread.needs_action, 3);
  const page = await get('?limit=2&offset=2'); assert.equal(page.items.length, 2); assert.equal(page.total, 5);
  const one = all.items.find(item => item.event === 'backup.succeeded');
  await call('POST', '/notifications/read', { body: { ids: [one.id] } });
  assert.equal((await get('?unread=1')).total, 4); assert.equal((await get('?unread=true&severity=success')).total, 0);
  await call('POST', '/notifications/archive', { body: { ids: [one.id] } });
  assert.equal((await get('')).total, 4); const archived = await get('?tab=archived'); assert.equal(archived.total, 1); assert.equal(archived.items[0].archived, true);
  await call('POST', '/notifications/unarchive', { body: { ids: [one.id] } });
  assert.equal((await get('?tab=archived')).total, 0); assert.equal((await get('')).total, 5);
});

test('the state summary carries the unread count, newest id and the newest four, for administrators only', async () => {
  clear();
  for (let i = 0; i < 6; i++) emit(failed({ key: 'site:s' + i, siteName: 'App' + i }), { at: Date.parse('2026-11-20T10:00:00Z') + i * 1000 });
  const state = await (await call('GET', '/state')).json();
  assert.equal(state.notifications.unread, 6); assert.equal(state.notifications.recent.length, 4); assert.equal(state.notifications.recent[0].title, 'Backup failed');
  assert.equal(state.notifications.newestId, Math.max(...rows(A).map(row => row.id)));
  assert.equal(JSON.stringify(state.notifications).includes('user_id'), false);
  assert.equal((await (await call('GET', '/state', { who: V })).json()).notifications, undefined);
});

test('retention: rows 90 days past their last occurrence are deleted, newer rows and folded repeats stay', () => {
  clear();
  const at = Date.parse('2026-11-20T00:00:00Z');
  emit(failed({ key: 'site:old' }), { at: at - 91 * 86400_000 }); emit(failed({ key: 'site:edge' }), { at: at - 89 * 86400_000 }); emit(failed({ key: 'site:fold' }), { at: at - 120 * 86400_000 }); emit(failed({ key: 'site:fold' }), { at: at - 10 * 86400_000 });
  assert.equal(store.purge(at), 4, 'the 91 and 120 day rows, one per administrator');
  assert.deepEqual(rows(A).map(row => row.dedupe_key).sort(), ['backup.failed:site:edge', 'backup.failed:site:fold']);
});

test('restores, restore tests that passed and stale recovery times are noticed from existing records, once', () => {
  clear(); detect.resetStaleCheck();
  const server = id(), site = id(), t0 = '2026-11-20T09:00:00.000Z';
  db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,'Main','host.example.invalid',22,'root','sealed','SHA256:x',?)").run(server, t0);
  db.prepare("INSERT INTO sites VALUES(?,?,'Shop','{}',?)").run(site, server, t0);
  detect.detectJobsAndMoves(t0); // first run only sets the cursors
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,finished_at) VALUES('job-restore-ok1',?,'restore','completed','done',?,?)").run(site, t0, '2026-11-20T09:30:00.000Z');
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,finished_at,error) VALUES('job-restore-bad1',?,'restore','failed','done',?,?,'/srv/secret/path failed')").run(site, t0, '2026-11-20T09:31:00.000Z');
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,finished_at) VALUES('job-testrun-0001',?,'restore-test','completed','done',?,?)").run(site, t0, '2026-11-20T09:32:00.000Z');
  detect.detectJobsAndMoves('2026-11-20T10:00:00.000Z'); detect.detectJobsAndMoves('2026-11-20T10:00:05.000Z');
  const list = rows(A).sort((a, b) => a.id - b.id);
  assert.deepEqual(list.map(row => [row.event_key, row.severity, row.link]), [['restore.succeeded', 'success', 'job:job-restore-ok1'], ['restore.failed', 'error', 'job:job-restore-bad1']]);
  assert.equal(list.some(row => /secret|\/srv/.test(row.body)), false, 'the job error text is never copied');
  const before = rows(A).length; detect.detectJobsAndMoves('2026-11-20T10:10:00.000Z'); assert.equal(rows(A).length, before, 'a second pass adds nothing');
  assert.equal(store.notify({ type: 'recovery_time.stale', key: 'occ:rto:x:1', siteName: 'Shop' }), 2);
  assert.equal(store.notify({ type: 'restore_test.passed', key: 'occ:restore-test:q:passed', siteName: 'Shop', serverName: 'Test box' }), 2);
  assert.equal(rows(A).at(-1).body, 'Shop on Test box');
});
