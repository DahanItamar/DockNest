// Keys safe on real Linux Docker (docs/keys-safe.md). Called by scripts/integration-linux.js with the source host
// (hosts[0]) and the restore test server (hosts[1]). A Laravel-style Compose app keeps APP_KEY in .env (a configuration
// file, so in the backup) and SECRET_KEY_BASE in extra.env, an env_file the app does not back up (missing). The real
// engine and helper run over SSH: readiness takes the silent baseline, a backup proves the keys from the packaged
// bytes, a restore test finds the same fingerprints in its restored copy, and a hand edit of the Compose file raises
// config.changed exactly once. No key value, its SHA-256 or its base64 reaches helper stdout, the database or logs.
// Not "validated" until this passes in CI on Linux.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

export async function runKeysSafeScenario({ run, until, hosts, servers, db, record }) {
  const { checkReadiness, enqueueBackup, claimJob, executeJob, discover } = await import('../src/engine.js');
  const { remote } = await import('../src/ssh.js');
  const { keysView } = await import('../src/keys-safe/padlock.js');
  const { keysRequest } = await import('../src/keys-safe/fingerprint.js');
  const rt = await import('../src/restore-tests/engine.js');
  const [host] = hosts, [server, testServer] = servers;
  rt.testTiming.scale = 0.25; rt.testTiming.cancelPollMs = 200;
  const sh = script => run('exec', host, 'sh', '-c', script);
  const write = async (path, text) => { await sh(`mkdir -p "$(dirname '${path}')" && cat > '${path}' <<'DOCKNEST_EOF'\n${text}DOCKNEST_EOF`); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Made-up key values; neither may appear in anything DockNest stores, returns or prints.
  const appKey = 'base64:' + randomBytes(32).toString('base64'), keyBase = randomBytes(48).toString('hex');
  const forms = [appKey, appKey.slice(7), keyBase].flatMap(value => [value, createHash('sha256').update(value).digest('hex'), Buffer.from(value).toString('base64')]);
  const assertNoValue = (text, where) => { for (const form of forms) assert.ok(!String(text).includes(form), `${where} holds a key value or a plain hash of it`); };
  const changedEvents = siteId => db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='config.changed' AND target=?").get(siteId).n;

  await run('exec', host, 'docker', 'build', '-q', '-t', 'docknest-keys:local', '/fixture-site');
  await write('/srv/keysapp/compose.yaml', 'services:\n  web:\n    image: docknest-keys:local\n    env_file: [.env, extra.env]\n    volumes: [keysapp-data:/site]\nvolumes:\n  keysapp-data: {}\n');
  await write('/srv/keysapp/.env', `APP_NAME=Keys\nAPP_KEY=${appKey}\n`);
  await write('/srv/keysapp/extra.env', `SECRET_KEY_BASE=${keyBase}\n`);
  await sh('cd /srv/keysapp && docker compose -p keysapp -f compose.yaml --project-directory /srv/keysapp up -d');
  await until(async () => (await run('exec', host, 'docker', 'inspect', '--format', '{{.State.Health.Status}}', 'keysapp-web-1')) === 'healthy', 'keysapp is not healthy');
  const config = { containers: ['keysapp-web-1'], composeFiles: ['/srv/keysapp/compose.yaml'], configFiles: ['/srv/keysapp/.env'], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, externalReferencesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false, maintenance: { required: false } };
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, server.id, 'Keys app', JSON.stringify(config), new Date().toISOString());

  // 1. Readiness: the first observation is a silent baseline.
  const ready = await checkReadiness(siteId);
  assert.ok(!('keyScan' in ready));
  const baseline = db.prepare('SELECT item,known_good_source,first_seen_changed_at FROM config_fingerprints WHERE site_id=? ORDER BY item').all(siteId).map(row => ({ ...row }));
  assert.deepEqual(baseline.map(row => row.item), ['/srv/keysapp/.env', '/srv/keysapp/compose.yaml', '/srv/keysapp/extra.env', 'laravel-app-key@env:keysapp-web-1', 'laravel-app-key@file:/srv/keysapp/.env', 'rails-secret-key-base@env:keysapp-web-1', 'rails-secret-key-base@file:/srv/keysapp/extra.env']);
  assert.ok(baseline.every(row => row.known_good_source === 'baseline' && row.first_seen_changed_at === null));
  assert.equal(changedEvents(siteId), 0);
  assert.equal(keysView(siteId).state, 'red', 'no backup yet');
  // Raw helper answers carry rule ids, locations and fingerprints only.
  const scan = await remote(server, { operation: 'key-scan', config, keys: keysRequest() });
  assertNoValue(JSON.stringify(scan), 'key-scan stdout');
  assertNoValue(JSON.stringify(await remote(server, { operation: 'readiness', config, keys: keysRequest() })), 'readiness stdout');
  record('Keys safe: readiness finds APP_KEY in the container env and .env and SECRET_KEY_BASE in an env_file, takes a silent baseline, and helper stdout holds fingerprints only');

  // 2. A backup proves each key from the bytes it packaged; the key in the file outside the backup is missing.
  const queued = enqueueBackup(siteId, 'qa'), job = claimJob();
  assert.equal(job.id, queued.id); await executeJob(job);
  const done = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(job.id);
  assert.equal(done.status, 'completed', done.error);
  const backup = db.prepare('SELECT * FROM backups WHERE job_id=?').get(job.id);
  let view = keysView(siteId);
  const status = () => Object.fromEntries(keysView(siteId).keys.map(key => [`${key.ruleId}@${key.location}`, key.status]));
  assert.deepEqual(status(), { 'laravel-app-key@env:keysapp-web-1': 'in-backup', 'laravel-app-key@file:/srv/keysapp/.env': 'in-backup', 'rails-secret-key-base@env:keysapp-web-1': 'in-backup', 'rails-secret-key-base@file:/srv/keysapp/extra.env': 'missing' });
  assert.equal(view.state, 'red');
  assert.equal(view.keys.find(key => key.location === 'file:/srv/keysapp/extra.env').reason, 'The file is not one of the files this app backs up.');
  assert.ok(view.keys.every(key => /^[0-9a-f]{8}$/.test(key.fingerprint)));
  assert.equal(JSON.parse(backup.manifest).keys.filter(key => key.inBackup).length, 3);
  record('Keys safe: a real backup proves APP_KEY (container env and .env) from the manifest and config-N.tar bytes; SECRET_KEY_BASE in an un-included env_file is missing with its path');

  // 3. A restore test finds the same fingerprints in the restored copy: only then "Verified in a restore test".
  const testId = rt.createRestoreTest({ siteId, serverId: testServer.id, backupId: backup.id, actor: 'qa' }).id;
  const deadline = Date.now() + 20 * 60_000;
  let test = rt.loadTest(testId);
  while (Date.now() < deadline && !(test.result !== null && ['done', 'failed', 'acknowledged'].includes(test.cleanup))) {
    rt.tickRestoreTests();
    const next = claimJob();
    if (next) await executeJob(next); else await wait(500);
    test = rt.loadTest(testId);
  }
  assert.equal(test.result, 'passed', test.reason ?? 'the restore test did not finish');
  assert.deepEqual(test.checks.find(check => check.kind === 'keys'), { name: 'App keys', kind: 'keys', target: null, status: 'passed', detail: '3 keys match the backup' });
  view = keysView(siteId);
  assert.deepEqual(view.keys.filter(key => key.status === 'verified').map(key => key.verifiedTestId), [testId, testId, testId]);
  record('Keys safe: a restore test on a second host restores the app, finds the same key fingerprints in its env and restored .env, and only then marks the keys verified');

  // 4. A hand edit of the Compose file raises config.changed once, whatever the number of later checks.
  await sh("printf '# changed by hand\\n' >> /srv/keysapp/compose.yaml");
  await checkReadiness(siteId);
  assert.equal(changedEvents(siteId), 1);
  await checkReadiness(siteId); await discover(server, { scanKeys: true });
  assert.equal(changedEvents(siteId), 1, 'once per new fingerprint set');
  view = keysView(siteId);
  assert.deepEqual(view.changed.map(item => item.item), ['/srv/keysapp/compose.yaml']); assert.ok(view.changed[0].firstSeenAt);
  record('Keys safe: a hand edit of the Compose file raises config.changed exactly once across readiness and discovery, naming the file only');

  for (const [where, rows] of [['audit_events', db.prepare('SELECT * FROM audit_events').all()], ['jobs', db.prepare('SELECT * FROM jobs WHERE site_id=?').all(siteId)], ['backups', db.prepare('SELECT * FROM backups WHERE site_id=?').all(siteId)], ['restore_tests', db.prepare('SELECT * FROM restore_tests WHERE site_id=?').all(siteId)], ['app_keys', db.prepare('SELECT * FROM app_keys').all()], ['config_fingerprints', db.prepare('SELECT * FROM config_fingerprints').all()], ['alert_outbox', db.prepare('SELECT * FROM alert_outbox').all()]]) assertNoValue(JSON.stringify(rows), where);
  await sh('cd /srv/keysapp && docker compose -p keysapp -f compose.yaml --project-directory /srv/keysapp down -v');
  record('Keys safe: no key value, its SHA-256 or its base64 is in the audit trail, jobs, backups, restore tests, key tables or alerts');
}
