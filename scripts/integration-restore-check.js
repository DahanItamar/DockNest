import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

// The restore check (docs/restore-check.md) on a real Linux host: a cron.d file and a systemd timer that touch the app
// are found through Check readiness, a user network the app does not create is listed, a stored answer is joined on,
// and a token on the cron line never reaches the result, the audit trail or the logs. Receives only the disposable
// nested hosts created by integration-linux; everything it creates is removed again.
export async function runRestoreCheckScenario({ run, hosts, servers, db, record }) {
  const { checkReadiness } = await import('../src/engine.js');
  const source = hosts[0], name = 'qa-restore-app', network = 'qa-restore-net', folder = '/srv/qa-restore/data';
  const token = 'qa-' + randomBytes(12).toString('hex'), siteId = randomUUID();
  const cron = '/etc/cron.d/qa-restore', timer = '/etc/systemd/system/qa-restore.timer', service = '/etc/systemd/system/qa-restore.service';
  const write = (path, text) => run('exec', source, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', 'write', path, text);
  try {
    await run('exec', source, 'mkdir', '-p', folder);
    await run('exec', source, 'docker', 'network', 'create', network);
    await run('exec', source, 'docker', 'run', '-d', '--name', name, '--network', network, '-v', folder + ':/data', 'docknest-fixture:local');
    await write(cron, `SHELL=/bin/sh\n*/5 * * * * root QA_TOKEN=${token} ${folder}/sync.sh --token=${token}\n`);
    await write(timer, '[Timer]\nOnCalendar=*-*-* 03:00:00\n[Install]\nWantedBy=timers.target\n');
    await write(service, `[Service]\nType=oneshot\nEnvironment=QA_TOKEN=${token}\nExecStart=/usr/local/bin/docker exec ${name} true\n`);
    const config = { containers: [name], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false, maintenance: { required: false } };
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, 'Restore check fixture', JSON.stringify(config), new Date().toISOString());
    const logged = [], original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(original)) console[level] = (...args) => { logged.push(args.map(String).join(' ')); original[level](...args); };
    let result;
    try { result = await checkReadiness(siteId); } finally { Object.assign(console, original); }
    const gaps = result.restoreGaps, find = (kind, path) => gaps.findings.find(item => item.kind === kind && item.path === path);
    assert.ok(Array.isArray(gaps?.findings), 'readiness returns restoreGaps findings');
    const scheduled = find('host-schedule', cron), timed = find('host-schedule', service), networked = find('external-network', network);
    assert.deepEqual([scheduled?.line, scheduled?.schedule, scheduled?.matched], [2, '*/5 * * * *', folder]);
    assert.equal(scheduled.includable, true); assert.deepEqual(scheduled.includePaths, [cron]);
    assert.deepEqual([timed?.line, timed?.schedule, timed?.matched], [4, '*-*-* 03:00:00', name]);
    assert.deepEqual(timed.includePaths, [timer, service]);
    assert.equal(networked?.matched, name);
    for (const text of [JSON.stringify(result), JSON.stringify(db.prepare('SELECT * FROM audit_events').all()), logged.join('\n')]) assert.ok(!text.includes(token), 'the cron token never leaves the server');
    db.prepare('INSERT INTO site_restore_decisions VALUES(?,?,?,?,?,?)').run(siteId, networked.key, 'note', 'Created by the provisioning script', 'qa', new Date().toISOString());
    const again = await checkReadiness(siteId);
    assert.equal(again.restoreGaps.findings.find(item => item.key === networked.key).decision, 'note');
    assert.equal(again.ready, result.ready, 'answers never change readiness');
    record('Restore check finds a cron.d job and a systemd timer that touch the app and an external network, joins stored answers, and keeps the cron line token out of the result, audit trail and logs');
  } finally {
    await run('exec', source, 'docker', 'rm', '-f', name).catch(() => {});
    await run('exec', source, 'docker', 'network', 'rm', network).catch(() => {});
    await run('exec', source, 'rm', '-rf', cron, timer, service, '/srv/qa-restore').catch(() => {});
  }
}
