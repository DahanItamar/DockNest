// Recovery Guide API and generator (docs/recovery-guide.md) against the loopback SFTP fixture: administrators only, the
// page data, the PDF download (attachment, no-store, never stored), server-enforced re-verification for login details,
// the audit entry (who, when, app ids and flags only), redaction of addresses and logins, honest "Verified" wording,
// the restore order from linked apps, the emergency kit as it really is, out of date with categories and the
// runbook.outdated alert once per digest, and the redacted copy written next to the kit after each Self Backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startSftpFixture } from './sftp-fixture.js';
import { readText as pdfText, readLines } from './pdf-text.js';
// A long quoted word is folded into pieces joined by "\" at the end of a line; joined back, nothing can hide in a fold.
const readText = pdf => pdfText(pdf).replace(/'\\\n'/g, '').replace(/ \\\n {2}/g, ' ');
const root = await mkdtemp(join(tmpdir(), 'docknest-runbook-'));
Object.assign(process.env, { DATA_DIR: root, MASTER_KEY_FILE: join(root, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const printed = [];
for (const method of ['log', 'error', 'warn', 'info']) { const original = console[method]; console[method] = (...args) => { printed.push(args.map(String).join(' ')); original.apply(console, args); }; }
const { app } = await import('../src/server.js');
const { db, id } = await import('../src/db.js');
const { digest, seal } = await import('../src/crypto.js');
const { recordVerification, recordTestVerification } = await import('../src/recovery-evidence.js');
const { saveSelfBackupSettings, enqueueSelfBackup, claimSelfBackup, executeSelfBackup } = await import('../src/self-backup.js');
const { splitEmergencyKit } = await import('../src/emergency/keys.js');
const { noteInventoryChange } = await import('../src/runbook/state.js');
const { loadInventory } = await import('../src/runbook/inventory.js');
const { buildGuide, restoreOrder } = await import('../src/runbook/guide.js');
const { guideCopies, COPY_OPTIONS } = await import('../src/runbook/copy.js');

const fixture = await startSftpFixture(), target = id(), now = () => new Date().toISOString();
const LOGIN_NOTE = 'Sign in as dana with Shop-Pass-0042.', SECRET = fixture.options.password, SERVER_ADDRESS = '203.0.113.7', STORAGE_ADDRESS = fixture.options.host;
db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(target, 'Home storage', fixture.options.host, fixture.options.port, fixture.options.username, fixture.options.hostKey, 'password', seal(SECRET), '/backups', 1e12, 'connected', now(), now());
db.prepare("INSERT INTO settings VALUES('backup_storage_target',?)").run(target);
const [administrator, operator, stale] = [id(), id(), id()], csrf = 'fixture-csrf', tokens = [0, 1, 2].map(() => randomBytes(32).toString('base64url'));
for (const [index, user] of [administrator, operator, stale].entries()) {
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, `user${index}@example.com`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', now(), `Owner ${index}`, index === 1 ? 'operator' : 'admin');
  const verified = index === 2 ? Date.now() - 3600_000 : Date.now();
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(tokens[index]), user, csrf, Date.now() + 3600_000, Date.now(), verified, verified);
}
const server = id();
db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at,note) VALUES(?,?,?,22,'root',?,?,'connected',?,?)").run(server, 'web-1', SERVER_ADDRESS, seal('fixture-private-key'), 'ab'.repeat(32), now(), 'The rented server');
const site = (name, config) => { const siteId = id(); db.prepare('INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)').run(siteId, server, name, JSON.stringify(config), now()); return siteId; };
const shop = site('Shop', { kind: 'docker', containers: ['shop-web', 'shop-db'], composeFiles: ['/srv/shop/compose.yaml'], domains: ['shop.example.com'], services: [{ container: 'shop-db', engine: 'postgres' }] });
const blog = site('בלוג', { kind: 'docker', containers: ['blog'], domains: ['blog.example.net'], services: [{ container: 'blog', engine: 'generic', sqliteFiles: ['/data/blog.sqlite'] }] });
const docs = site('Docs', { kind: 'static', containers: [], documentRoot: '/var/www/docs', configFiles: ['/etc/nginx/sites-enabled/docs'], domains: ['docs.example.com'] });
db.prepare("INSERT INTO policies VALUES(?,1,'0 3 * * *','UTC',7,NULL)").run(shop);
const backup = (siteId, containers, at) => {
  const jobId = id(), backupId = id();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at) VALUES(?,?,'backup','completed','completed',?)").run(jobId, siteId, at);
  db.prepare('INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,1,?,?,0,1,?)').run(backupId, siteId, jobId, at, `sftp:${target}:/backups/BACKUP/web-1--${server}/${siteId}/backup_2026-11-19_03-00-00Z--${backupId}.tar.gz.enc`, 'c'.repeat(64), JSON.stringify({ formatVersion: 1, containers }), at);
  return { backupId, jobId };
};
const shopBackup = backup(shop, [{ name: '/shop-web', image: 'nginx:1.27', mounts: [{ type: 'bind', destination: '/usr/share/nginx/html' }] }, { name: '/shop-db', image: 'postgres:16', mounts: [{ type: 'volume', destination: '/var/lib/postgresql/data' }] }], '2026-11-19T03:00:00.000Z');
backup(blog, [{ name: '/blog', image: 'ghost:5', mounts: [{ type: 'bind', destination: '/data' }] }], '2026-11-18T03:00:00.000Z');
// Shop passed an automatic restore test; Blog has only manual evidence, which never reads as "Verified".
recordTestVerification(shopBackup.backupId, 'isolatedRestore', { status: 'passed' }, shopBackup.jobId);
recordVerification(db.prepare('SELECT id FROM backups WHERE site_id=?').get(blog).id, 'isolatedRestore', { status: 'passed', method: 'manual restore' });

const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
const request = (route, { index = 0, body } = {}) => fetch(`http://127.0.0.1:${listener.address().port}/api${route}`, { method: body ? 'POST' : 'GET', headers: { Cookie: 'dbm_session=' + tokens[index], Origin: process.env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const pdf = async (body, index = 0) => { const response = await request('/runbook/pdf', { index, body }); return { response, bytes: Buffer.from(await response.arrayBuffer()) }; };
const allApps = [shop, blog, docs];
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test('the page data is for administrators only, starts as never made and holds no address or login', async () => {
  assert.equal((await request('/runbook', { index: 1 })).status, 403);
  const response = await request('/runbook'), page = await response.json(), text = JSON.stringify(page);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual([page.made, page.outdated, page.changes], [false, false, []]);
  for (const secret of [SECRET, SERVER_ADDRESS, `${STORAGE_ADDRESS}:${fixture.options.port}`, fixture.options.username, 'fixture-private-key']) assert.ok(!text.includes(secret), 'no address or login in the page data');
  assert.deepEqual(page.guide.apps.map(item => [item.name, item.statusText]), [
    ['Shop', `Verified: a restore test passed on ${new Date().getUTCDate()} ${new Date().toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${new Date().getUTCFullYear()}, from the main backup.`],
    ['בלוג', 'Backed up, not tested yet.'],
    ['Docs', 'Not backed up yet.'],
  ]);
  assert.equal(page.guide.fleet.kit.summary, 'One kit, opened with your recovery passphrase.');
  assert.equal(page.guide.fleet.kit.holders, undefined, 'no parts or labels without the split');
  assert.ok(page.guide.startHere.install.some(item => item.command?.includes('git clone --branch v')));
  const restore = page.guide.apps[0].restore.independent.map(item => item.command).join('\n');
  assert.match(restore, /'<storage-user>:<storage-password>'/);
  assert.match(restore, /'sftp:\/\/<storage-address>\/backups\/BACKUP\/web-1--/);
  assert.match(page.guide.apps[0].works.command, /docker exec shop-db pg_isready/);
});

test('the PDF is an attachment that is never cached, audited with ids and flags only, and holds no secret by default', async () => {
  const { response, bytes } = await pdf({ apps: allApps });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="recovery-guide\.pdf"$/);
  assert.ok(bytes.subarray(0, 8).toString('latin1').startsWith('%PDF-1.7'));
  const text = readText(bytes);
  for (const expected of ['Start here', 'Restore everything in this order', 'Fleet overview', 'Shop', 'בלוג', 'Docs', 'Backed up, not tested yet.', 'One kit, opened with your recovery passphrase.', '<storage-password>']) assert.ok(text.includes(expected), expected);
  for (const secret of [SECRET, SERVER_ADDRESS, 'fixture-private-key', 'Contains secrets']) assert.ok(!text.includes(secret), `no ${secret === 'Contains secrets' ? 'secrets mark' : 'secret'} by default`);
  const entry = db.prepare("SELECT actor,target,detail FROM audit_events WHERE action='runbook.pdf' ORDER BY created_at DESC,rowid DESC LIMIT 1").get();
  assert.equal(entry.actor, administrator);
  assert.deepEqual(JSON.parse(entry.detail), { apps: [...allApps].sort(), include: { addresses: false, logins: false, commands: true, tests: true, schedules: true, notes: true } });
  const page = await (await request('/runbook')).json();
  assert.deepEqual([page.made, page.outdated, page.madeBy], [true, false, 'Owner 0']);
  for (const table of ['settings', 'audit_events', 'runbook_state', 'jobs']) assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes('%PDF'), `no PDF kept in ${table}`);
});

test('login details need an administrator who re-verified, checked on the server, and mark every page', async () => {
  assert.equal((await pdf({ apps: [shop], include: { logins: true } }, 1)).response.status, 403, 'operators cannot');
  const refused = await pdf({ apps: [shop], include: { logins: true } }, 2);
  assert.equal(refused.response.status, 403);
  assert.equal(JSON.parse(refused.bytes.toString()).code, 'REAUTH_REQUIRED');
  const { response, bytes } = await pdf({ apps: [shop], include: { logins: true, addresses: true } });
  assert.equal(response.status, 200);
  const text = readText(bytes), lines = readLines(bytes), pages = Math.max(...lines.map(line => line.page));
  assert.ok(text.includes(SECRET) && text.includes(SERVER_ADDRESS), 'the login and the addresses are in it when asked for');
  for (let page = 1; page <= pages; page++) assert.ok(lines.some(line => line.page === page && line.text.startsWith('Contains secrets')), `page ${page} is marked`);
  assert.ok(!text.includes('fixture-private-key'), 'never the SSH private keys of servers');
  const entry = JSON.parse(db.prepare("SELECT detail FROM audit_events WHERE action='runbook.pdf' ORDER BY created_at DESC,rowid DESC LIMIT 1").get().detail);
  assert.deepEqual(entry, { apps: [shop], include: { addresses: true, logins: true, commands: true, tests: true, schedules: true, notes: true } });
  const addressOnly = readText((await pdf({ apps: [shop], include: { addresses: true } })).bytes);
  assert.ok(addressOnly.includes(SERVER_ADDRESS) && !addressOnly.includes(SECRET) && addressOnly.includes('<storage-password>'));
  const withoutCommands = readText((await pdf({ apps: [shop], include: { commands: false } })).bytes);
  assert.ok(!withoutCommands.includes('git clone') && !withoutCommands.includes('curl'), 'commands can be left out');
});

test('bad requests are refused: no apps, over 200 apps, unknown apps or options', async () => {
  assert.equal((await pdf({ apps: [] })).response.status, 400);
  assert.equal((await pdf({ apps: Array.from({ length: 201 }, () => id()) })).response.status, 400);
  assert.equal((await pdf({ apps: [id()] })).response.status, 400);
  assert.equal((await pdf({ apps: [shop], include: { masterKey: true } })).response.status, 400);
  assert.equal((await request('/runbook/notes', { body: { notes: 'x'.repeat(4001) } })).status, 400);
});

test('login notes per app: re-verified administrators write them, sealed, never read back, only in a PDF with logins', async () => {
  const note = (body, index = 0, app = shop) => request(`/runbook/apps/${app}/login-note`, { index, body });
  assert.equal((await note({ note: LOGIN_NOTE }, 1)).status, 403, 'operators cannot');
  const stale = await note({ note: LOGIN_NOTE }, 2);
  assert.equal(stale.status, 403); assert.equal((await stale.json()).code, 'REAUTH_REQUIRED');
  assert.equal((await note({ note: LOGIN_NOTE }, 0, id())).status, 404);
  assert.equal((await note({ note: 'x'.repeat(4001) })).status, 400);
  const saved = await note({ note: LOGIN_NOTE });
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { saved: true, hasLoginNote: true });
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM app_login_notes').all()).includes('Dana'), 'sealed in the database');
  assert.deepEqual(JSON.parse(db.prepare("SELECT detail FROM audit_events WHERE action='runbook.login_note'").get().detail), { cleared: false });
  const page = await (await request('/runbook')).json();
  assert.equal(page.guide.apps.find(item => item.id === shop).hasLoginNote, true);
  assert.ok(!JSON.stringify(page).includes(LOGIN_NOTE), 'never sent back');
  assert.ok(!readText((await pdf({ apps: allApps })).bytes).includes(LOGIN_NOTE), 'not in a PDF without login details');
  const lines = readLines((await pdf({ apps: [shop], include: { logins: true } })).bytes), at = lines.find(line => line.text === LOGIN_NOTE || line.actual === LOGIN_NOTE);
  assert.ok(at, 'in the PDF with login details');
  assert.ok(lines.some(line => line.page === at.page && line.text.startsWith('Contains secrets')), 'inside the secrets marking');
});

test('out of date: categories of what changed, the Overview line, and runbook.outdated once per digest', async () => {
  db.prepare("INSERT INTO connections(id,provider,name,secret,settings,created_at,updated_at) VALUES('phone','telegram','phone','sealed','{}',?,?)").run(now(), now());
  db.prepare("INSERT INTO alert_nodes(id,provider,name,connection_id,created_at,updated_at) VALUES('node-phone','telegram','phone','phone',?,?)").run(now(), now());
  db.prepare("INSERT INTO alert_lines(id,node_id,source_kind,source_id,events,enabled,created_at,updated_at) VALUES('line','node-phone','docknest',NULL,?,1,?,?)").run(JSON.stringify(['runbook.outdated']), now(), now());
  await pdf({ apps: allApps });
  assert.equal((await (await request('/state')).json()).runbook.outdated, false);
  assert.equal((await request('/runbook/notes', { body: { notes: 'Ask Dana at dana@example.com.' } })).status, 200);
  await settle();
  db.prepare('UPDATE servers SET host=? WHERE id=?').run('198.51.100.9', server);
  site('Wiki', { kind: 'docker', containers: ['wiki'], domains: ['wiki.example.com'] });
  await noteInventoryChange();
  const page = await (await request('/runbook')).json();
  assert.equal(page.outdated, true);
  assert.deepEqual(page.changes.map(change => change.code), ['app_added', 'server_address_changed', 'notes_changed']);
  assert.ok(page.changes.every(change => change.label.endsWith('.')));
  assert.equal((await (await request('/state')).json()).runbook.outdated, true);
  assert.equal((await (await request('/state', { index: 1 })).json()).runbook, undefined, 'operators do not get the line');
  const alerts = () => db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE event='runbook.outdated'").get().n, sent = alerts();
  assert.equal(sent, 2, 'the note (through the API) and then the other changes each made a new digest');
  await noteInventoryChange();
  assert.equal(alerts(), sent, 'one alert per digest');
  db.prepare('UPDATE servers SET name=? WHERE id=?').run('web-one', server);
  await noteInventoryChange();
  assert.equal(alerts(), sent + 1, 'a new digest alerts again');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM runbook_state').all()).includes('198.51.100.9'), 'only hashes of the inventory are kept');
});

test('keys safe: how many app keys the newest backup holds, and each missing key as a known gap, never a fingerprint', async () => {
  const fingerprint = 'a1b2c3d4'.repeat(4);
  db.prepare("INSERT INTO app_keys(site_id,rule_id,location,fingerprint,in_backup,first_seen_at) VALUES(?,'laravel-app-key','env:shop-web',?,?,'2026-01-01T00:00:00.000Z')").run(shop, fingerprint, shopBackup.backupId);
  db.prepare("INSERT INTO app_keys(site_id,rule_id,location,fingerprint,in_backup,first_seen_at) VALUES(?,'n8n-encryption-key','env:blog',?,NULL,'2026-01-01T00:00:00.000Z')").run(blog, fingerprint);
  const guide = buildGuide(await loadInventory(), { version: '3.0.0' }), page = name => guide.apps.find(item => item.name === name);
  assert.equal(page('Shop').keys, 'App keys: 1 of 1 in the newest backup.');
  assert.deepEqual(page('Shop').keyGaps, []);
  assert.equal(page('בלוג').keys, 'App keys: 0 of 1 in the newest backup.');
  assert.match(page('בלוג').keyGaps[0], /^the key .+ is not in the newest backup\. /);
  const text = readText((await pdf({ apps: allApps })).bytes);
  assert.ok(text.includes('App keys: 1 of 1 in the newest backup.') && text.includes('Known gap: the key'));
  assert.ok(!text.includes(fingerprint.slice(0, 8)) && !JSON.stringify(guide).includes(fingerprint.slice(0, 8)), 'never a fingerprint');
  db.prepare('DELETE FROM app_keys').run();
});

test('an incremental backup: its whole chain is downloaded; a missing parent or a package not on storage leaves it to DockNest', async () => {
  const chained = site('Chained', { kind: 'docker', containers: ['chained'], domains: [] });
  const container = [{ name: '/chained', image: 'app:1', mounts: [] }];
  const full = backup(chained, container, '2026-11-17T03:00:00.000Z'), increment = backup(chained, container, '2026-11-18T03:00:00.000Z');
  db.prepare("INSERT INTO backup_chain_links VALUES(?,'full','chain-1',NULL,0)").run(full.backupId);
  db.prepare("INSERT INTO backup_chain_links VALUES(?,'incremental','chain-1',?,1)").run(increment.backupId, full.backupId);
  const restore = async () => buildGuide(await loadInventory(), { version: '3.0.0', appIds: [chained] }).apps[0].restore;
  const whole = (await restore()).independent.map(item => item.command).join('\n');
  assert.equal(whole.match(/^curl /gm).length, 2, 'the full backup and the increment');
  assert.match(whole, /decrypt-backup\.js --chain/);
  db.prepare('UPDATE backups SET path=? WHERE id=?').run('/var/lib/docknest/backups/full.tar.gz.enc', full.backupId);
  let page = await restore();
  assert.equal(page.independent, undefined, 'no commands when a package of the chain is not on SFTP or S3 storage');
  assert.match(page.note, /only DockNest can restore it/);
  db.prepare('UPDATE backup_chain_links SET parent_id=? WHERE backup_id=?').run(id(), increment.backupId);
  page = await restore();
  assert.equal(page.independent, undefined, 'no commands when the parent backup is missing');
  assert.match(page.note, /needs earlier backups of its chain/);
  db.prepare('INSERT INTO site_archives VALUES(?,?)').run(chained, now());
});

test('the restore order puts the app that owns a shared database first', () => {
  const apps = [{ id: 'a', name: 'Shop', containers: ['shop-web'] }, { id: 'b', name: 'Database', containers: ['main-db'] }, { id: 'c', name: 'Docs', containers: [] }];
  assert.deepEqual(restoreOrder(apps, [{ appIds: ['a', 'b'], kind: 'database', via: 'main-db' }]).map(item => [item.name, item.reason]), [
    ['Database', 'Restore it first: Shop uses its database.'],
    ['Shop', 'Restore it after Database: it uses that database.'],
    ['Docs', 'It does not depend on another app.'],
  ]);
  assert.deepEqual(restoreOrder(apps, [{ appIds: ['a', 'b'], kind: 'network', via: 'proxy' }]).map(item => item.name), ['Shop', 'Database', 'Docs'], 'a network-only link does not order');
});

test('the emergency kit section says K of N and the labels only when the split is on', async () => {
  const split = splitEmergencyKit({ k: 2, n: 3, labels: ['Sister', 'Brother', 'Lawyer'] }, administrator);
  const guide = buildGuide(await loadInventory(), { version: '3.0.0' });
  assert.equal(guide.fleet.kit.summary, 'Split between trusted people: any 2 of these 3 people together can open it.');
  assert.deepEqual(guide.fleet.kit.holders, ['Sister', 'Brother', 'Lawyer']);
  assert.ok(guide.fleet.kit.details[0].includes(split.digest.slice(0, 4)));
  const text = readText((await pdf({ apps: [shop] })).bytes);
  assert.ok(text.includes('any 2 of these 3 people') && text.includes('Lawyer'));
  for (const part of split.parts) assert.ok(!text.includes(part.words.split(' ').slice(0, 3).join(' ')), 'never a part');
  db.prepare('UPDATE emergency_keys SET retired_at=? WHERE retired_at IS NULL').run(now());
  assert.equal(buildGuide(await loadInventory(), { version: '3.0.0' }).fleet.kit.summary, 'One kit, opened with your recovery passphrase.');
});

test('after each Self Backup a redacted copy is written next to the kit and replaces the older one', async () => {
  assert.deepEqual(COPY_OPTIONS, { addresses: false, logins: false, commands: true, tests: true, schedules: true, notes: true });
  saveSelfBackupSettings({ enabled: false, schedule: '0 3 * * *', timezone: 'UTC', passphrase: randomBytes(32).toString('base64url'), recoverySecretSaved: true }, administrator);
  const copies = () => [...fixture.files.keys()].filter(name => /^\/backups\/BACKUP\/docknest-recovery\/recovery-guide_[0-9TZ_-]+--[0-9a-f-]{36}\.pdf$/.test(name));
  // The last download had login details; the copy never does.
  await pdf({ apps: [shop], include: { logins: true, addresses: true } });
  enqueueSelfBackup(administrator); assert.equal(await executeSelfBackup(claimSelfBackup()), true);
  assert.equal(copies().length, 1);
  const first = copies()[0], text = readText(fixture.files.get(first));
  for (const secret of [SECRET, LOGIN_NOTE, '198.51.100.9', `${STORAGE_ADDRESS}:${fixture.options.port}`, fixture.options.username, 'Contains secrets']) assert.ok(!text.includes(secret), 'the copy has no address or login');
  for (const expected of ['Shop', 'בלוג', 'Docs', 'Wiki', '<storage-password>']) assert.ok(text.includes(expected), expected);
  assert.deepEqual(guideCopies().map(item => item.path), [`sftp:${target}:${first}`]);
  await new Promise(resolve => setTimeout(resolve, 1100));
  enqueueSelfBackup(administrator); assert.equal(await executeSelfBackup(claimSelfBackup()), true);
  assert.equal(copies().length, 1, 'the newer copy replaced the older one');
  assert.notEqual(copies()[0], first);
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='runbook.copy_written'").get());
});

test('no secret reaches the logs, the audit trail, job details or settings', async () => {
  await settle();
  const stored = JSON.stringify([db.prepare('SELECT * FROM audit_events').all(), db.prepare('SELECT * FROM jobs').all(), db.prepare('SELECT * FROM settings').all(), db.prepare('SELECT * FROM runbook_state').all()]);
  for (const secret of [SECRET, LOGIN_NOTE, 'fixture-private-key']) {
    assert.ok(!stored.includes(secret), 'not in the database');
    assert.ok(!printed.some(line => line.includes(secret)), 'not printed');
  }
  listener.close(); await fixture.close();
});
