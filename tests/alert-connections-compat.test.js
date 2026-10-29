// Upgrade and rollback with the real 2.9.0 code (docs/alert-channels.md, "Rollback" and "Test plan", previous version).
// The released src/ of v2.9.0 runs unmodified in a scratch folder under node_modules (so it finds the same packages) on
// one DATA_DIR, alternating with this checkout: 2.9.0 sets up alerts, this version upgrades and adds a Connection, 2.9.0
// starts again and still sends its alerts, this version upgrades again, and a replaced secret stops 2.9.0 from using
// the old one. Fake tokens only; Telegram is a mocked fetch in each process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)), tag = 'v2.9.0';
const available = (() => { try { execFileSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], { cwd: root, stdio: 'ignore' }); return true; } catch { if (process.env.CI) throw new Error(`${tag} is not available; fetch the release tags`); return false; } })();
const TOKEN = '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35), NEW_TOKEN = '987654321:' + 'ZyXwVu_-98'.repeat(4).slice(0, 35);
// Runs a module snippet in `cwd` with a mocked Telegram and prints the snippet's result as JSON.
const prelude = `globalThis.sent = []; const mock = delivery => { delivery.alertHttp.fetch = async (url, init) => { sent.push({ url, chat: JSON.parse(init.body ?? '{}').chat_id }); return new Response('{"ok":true,"result":{}}', { status: 200 }); }; };`;
const run = (cwd, env, code) => JSON.parse(execFileSync(process.execPath, ['--no-addons', '--input-type=module', '-e', `${prelude}\n${code}`], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').at(-1));

test('2.9.0 -> this version -> 2.9.0 -> this version: alerts keep working and a replaced secret is not reused by 2.9.0', { skip: !available && `${tag} tag not fetched`, timeout: 180_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'docknest-alert-compat-')), data = join(work, 'data');
  const old = join(root, 'node_modules', '.cache', `docknest-alert-compat-${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(data, { recursive: true }); await mkdir(old, { recursive: true });
    execFileSync('tar', ['-x'], { cwd: old, input: execFileSync('git', ['archive', '--format=tar', tag, 'src', 'shared', 'scripts', 'remote', 'package.json'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }) });
    const env = { ...process.env, DATA_DIR: data, BACKUP_DIR: join(data, 'backups'), BACKUP_STORAGE: 'local', NODE_ENV: 'test', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000', MASTER_KEY_FILE: join(data, 'master.key'), SETUP_TOKEN_FILE: join(data, 'setup.token') };
    await mkdir(env.BACKUP_DIR, { recursive: true });
    await writeFile(env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
    await writeFile(env.SETUP_TOKEN_FILE, randomBytes(32).toString('base64url'));

    // 1. 2.9.0: one bot for two chats, one mail account, lines, and one alert still waiting in its queue.
    const ids = run(old, env, `const store = await import('./src/alerts/store.js'), delivery = await import('./src/alerts/delivery.js'), { db } = await import('./src/db.js');
      const bot = store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: '${TOKEN}' } }, 't');
      const family = store.createChannel({ kind: 'telegram', name: 'Family', credentialId: bot.id, config: { chatId: '-1001' } }, 't');
      const workChat = store.createChannel({ kind: 'telegram', name: 'Work', credentialId: bot.id, config: { chatId: '-1002' } }, 't');
      const mail = store.createCredential({ kind: 'smtp', name: 'Mail', config: { host: 'smtp.example.com', port: 587, security: 'starttls', username: '', password: '', from: 'a@example.com' } }, 't');
      store.createChannel({ kind: 'email', name: 'Inbox', credentialId: mail.id, config: { to: ['me@example.com'] } }, 't');
      for (const node of [family, workChat]) store.createRule({ channelId: node.id, sourceKind: 'docknest', events: ['backup.failed'] }, 't');
      delivery.emit({ type: 'backup.failed', key: 'site:before', siteName: 'shop', serverName: 'srv' });
      console.log(JSON.stringify({ bot: bot.id, family: family.id, work: workChat.id, version: db.prepare('PRAGMA user_version').get().user_version }));`);
    assert.equal(ids.version, 9);

    // 2. This version upgrades without any action, shows the same alerts, delivers the waiting one and adds a Connection.
    const upgraded = run(root, env, `const store = await import('./src/alerts/store.js'), delivery = await import('./src/alerts/delivery.js'), { db } = await import('./src/db.js'); mock(delivery);
      const before = { credentials: store.listCredentials().map(item => [item.id, item.name, item.usedBy.map(node => node.name)]), channels: store.listChannels().map(item => [item.id, item.config, item.needsCredential]) };
      await delivery.deliverDue();
      const fresh = store.createCredential({ kind: 'telegram', name: 'New bot', config: { token: '${NEW_TOKEN}' } }, 't');
      store.createChannel({ kind: 'telegram', name: 'New chat', credentialId: fresh.id, config: { chatId: '-1009' } }, 't');
      store.createChannel({ kind: 'telegram', name: 'Ops', credentialId: '${ids.bot}', config: { chatId: '-1003' } }, 't');
      console.log(JSON.stringify({ ...before, sent, version: db.prepare('PRAGMA user_version').get().user_version, connections: db.prepare('SELECT COUNT(*) AS n FROM connections').get().n }));`);
    assert.equal(upgraded.version, (await import('../src/migrations.js')).schemaVersion);
    assert.deepEqual(upgraded.credentials.find(item => item[0] === ids.bot), [ids.bot, 'Bot', ['Family', 'Work']]);
    assert.deepEqual(upgraded.channels.find(item => item[0] === ids.family), [ids.family, { chatId: '-1001' }, false]);
    assert.deepEqual(upgraded.sent.map(item => item.chat).sort(), ['-1001', '-1002'], 'the alert waiting at upgrade time is sent once per chat');
    assert.ok(upgraded.sent.every(item => item.url === `https://api.telegram.org/bot${TOKEN}/sendMessage`));
    assert.equal(upgraded.connections, 5);

    // 3. Roll back to 2.9.0: it starts, sees its alerts as they were at upgrade time and still sends them.
    const rolledBack = run(old, env, `await import('./src/server.js'); const store = await import('./src/alerts/store.js'), delivery = await import('./src/alerts/delivery.js'), detect = await import('./src/alerts/detect.js'); mock(delivery);
      detect.detectJobsAndMoves();
      const view = { credentials: store.listCredentials().map(item => item.name).sort(), channels: store.listChannels().map(item => [item.name, item.needsCredential]).sort() };
      delivery.emit({ type: 'backup.failed', key: 'site:after', siteName: 'shop', serverName: 'srv' });
      await delivery.deliverDue();
      store.updateChannel('${ids.family}', { name: 'Family renamed in 2.9' }, 't');
      console.log(JSON.stringify({ ...view, sent }));`);
    assert.deepEqual(rolledBack.credentials, ['Bot', 'Mail'], 'changes made after the upgrade are not visible to 2.9.0');
    assert.deepEqual(rolledBack.channels, [['Family', false], ['Inbox', false], ['Work', false]]);
    const after = rolledBack.sent.filter(item => item.url.includes(TOKEN));
    assert.ok(after.length >= 2 && ['-1001', '-1002'].every(chat => after.some(item => item.chat === chat)), '2.9.0 still delivers to both chats');

    // 4. Upgrade again: nothing is copied twice, the 2.9 change is flagged, and replacing the bot token removes the old row.
    const again = run(root, env, `const store = await import('./src/alerts/store.js'), connections = await import('./src/alerts/connections.js'), { db } = await import('./src/db.js');
      const warned = connections.legacyChangedSinceImport(), names = store.listChannels().map(item => item.name).sort();
      store.updateCredential('${ids.bot}', { config: { token: '${NEW_TOKEN}' } }, 't');
      console.log(JSON.stringify({ warned, names, connections: db.prepare('SELECT COUNT(*) AS n FROM connections').get().n, legacy: db.prepare('SELECT COUNT(*) AS n FROM alert_credentials WHERE id=?').get('${ids.bot}').n }));`);
    assert.equal(again.warned, true, 'the Connections page can warn about changes made in 2.9.0');
    assert.deepEqual(again.names, ['Family', 'Inbox', 'New chat', 'Ops', 'Work'], 'the 2.9 rename is not copied again');
    assert.equal(again.connections, 5); assert.equal(again.legacy, 0);

    // 5. 2.9.0 again: the nodes of the replaced credential need a credential and nothing goes out with the old token.
    const final = run(old, env, `const store = await import('./src/alerts/store.js'), delivery = await import('./src/alerts/delivery.js'); mock(delivery);
      delivery.emit({ type: 'backup.failed', key: 'site:final', siteName: 'shop', serverName: 'srv' }); await delivery.deliverDue();
      console.log(JSON.stringify({ channels: store.listChannels().map(item => [item.name, item.needsCredential]).sort(), sent }));`);
    assert.deepEqual(final.channels, [['Family renamed in 2.9', true], ['Inbox', false], ['Work', true]]);
    assert.equal(final.sent.length, 0);
  } finally { await rm(old, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); }
});

// A full 2.9.0 alert setup at its limits (20 credentials, 40 nodes, 200 lines, a busy queue), made by the released code
// with every case the 2.8 routes allow: shared chats, one bot for many chats, unused credentials, email only, unicode and
// 80-character names, disabled lines and lines to servers and sites deleted later. The 2.8 views must read the same after.
test('a 2.9.0 alert setup at its limits reads the same through the 2.8 routes after the upgrade', { skip: !available && `${tag} tag not fetched`, timeout: 180_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'docknest-alert-compat-')), data = join(work, 'data');
  const old = join(root, 'node_modules', '.cache', `docknest-alert-compat-${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(join(data, 'backups'), { recursive: true }); await mkdir(old, { recursive: true });
    execFileSync('tar', ['-x'], { cwd: old, input: execFileSync('git', ['archive', '--format=tar', tag, 'src', 'shared', 'scripts', 'remote', 'package.json'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }) });
    const env = { ...process.env, DATA_DIR: data, BACKUP_DIR: join(data, 'backups'), BACKUP_STORAGE: 'local', NODE_ENV: 'test', SECURE_COOKIES: 'false', APP_ORIGIN: 'http://127.0.0.1:3000', MASTER_KEY_FILE: join(data, 'master.key'), SETUP_TOKEN_FILE: join(data, 'setup.token') };
    await writeFile(env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
    await writeFile(env.SETUP_TOKEN_FILE, randomBytes(32).toString('base64url'));
    // The view fields the Map reads, without the timestamps and results that a later send changes.
    const views = `const views = () => ({
        credentials: store.listCredentials().map(({ id, kind, name, config, configReadable, usedBy }) => ({ id, kind, name, config, configReadable, usedBy })),
        channels: store.listChannels().map(({ id, kind, name, credentialId, credentialName, needsCredential, config }) => ({ id, kind, name, credentialId, credentialName, needsCredential, config })),
        rules: store.listRules().map(({ id, channelId, sourceKind, sourceId, events, enabled }) => ({ id, channelId, sourceKind, sourceId, events, enabled })) });`;
    const before = run(old, env, `const store = await import('./src/alerts/store.js'), delivery = await import('./src/alerts/delivery.js'), { db } = await import('./src/db.js'); ${views}
      const at = new Date().toISOString(), servers = [], sites = [];
      for (let index = 0; index < 5; index++) { const server = crypto.randomUUID(), site = crypto.randomUUID(); db.prepare("INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,'h',22,'root','k','f',?)").run(server, 'srv ' + index, at); db.prepare("INSERT INTO sites VALUES(?,?,?,'{}',?)").run(site, server, 'site ' + index, at); servers.push(server); sites.push(site); }
      const credentials = [];
      for (let index = 0; index < 20; index++) {
        const mail = index % 4 === 3, name = index === 0 ? 'Ünïcödé 🚀 '.repeat(8).slice(0, 80) : 'Login ' + index;
        credentials.push(store.createCredential(mail ? { kind: 'smtp', name, config: { host: 'smtp' + index + '.example.com', port: 587, security: 'starttls', username: 'u', password: 'fixture-pass-' + index, from: 'a@example.com' } } : { kind: 'telegram', name, config: { token: '${TOKEN}' } }, 't'));
      }
      const nodes = [];
      for (let index = 0; index < 40; index++) {
        const credential = credentials[index % 12], mail = credential.kind === 'smtp', name = index === 1 ? 'x'.repeat(80) : 'Node ' + index + ' ✉';
        nodes.push(store.createChannel(mail ? { kind: 'email', name, credentialId: credential.id, config: { to: ['n' + (index % 3) + '@example.com'], subjectPrefix: index % 2 ? '[P]' : '' } } : { kind: 'telegram', name, credentialId: credential.id, config: { chatId: String(-1000 - (index % 7)) } }, 't'));
      }
      let lines = 0;
      for (const node of nodes) for (const [kind, id] of [['docknest', null], ...servers.slice(0, 2).map(id => ['server', id]), ...sites.slice(0, 2).map(id => ['site', id])]) { if (lines >= 200) break; store.createRule({ channelId: node.id, sourceKind: kind, sourceId: id, events: ['backup.failed', 'server.unreachable'], enabled: lines % 5 !== 0 }, 't'); lines++; }
      for (const site of sites.slice(0, 2)) db.prepare('DELETE FROM sites WHERE id=?').run(site); db.prepare('DELETE FROM servers WHERE id=?').run(servers[1]);
      for (let index = 0; index < 30; index++) delivery.emit({ type: 'backup.failed', key: 'site:' + index, siteName: 's', serverName: 'v' });
      console.log(JSON.stringify({ ...views(), queue: db.prepare('SELECT COUNT(*) AS n FROM alert_queue').get().n }));`);
    assert.equal(before.credentials.length, 20); assert.equal(before.channels.length, 40); assert.equal(before.rules.length, 200);
    const after = run(root, env, `const store = await import('./src/alerts/store.js'), { db } = await import('./src/db.js'); ${views}
      console.log(JSON.stringify({ ...views(), outbox: db.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get().n, pending: db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE status='pending'").get().n, connections: db.prepare('SELECT COUNT(*) AS n FROM connections').get().n }));`);
    for (const key of ['credentials', 'channels', 'rules']) assert.deepEqual(after[key], before[key], `${key} read the same`);
    assert.equal(after.outbox, before.queue, 'every queued message was copied');
    assert.ok(after.connections > 20 && after.connections <= 60, 'one Connection per credential and destination, within the limit');
  } finally { await rm(old, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); }
});
