// Recovery Guide (docs/recovery-guide.md) on the real Linux hosts and SFTP storage. Called by scripts/integration-linux.js.
// Proves: a Recovery Guide PDF passes `qpdf --check`, and `pdftotext` reads its text (Hebrew included) with no login
// value when login details are off; a Self Backup writes the redacted copy next to the kit; and the guide's own
// independent restore commands, run as printed on a clean Linux Docker host that never ran the app, bring a Compose
// demo app back with its data. The commands are generated with login details on and without addresses, so the only
// change made to them is the storage address placeholder, which becomes the storage host's address on the test network.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const exec = promisify(execFile);
// Runs a repository script; never prints its arguments or output, which hold the recovery passphrase file.
const script = args => exec(process.execPath, ['--no-addons', ...args], { maxBuffer: 1024 * 1024 });

export async function runRunbookScenario({ run, until, hosts, servers, db, record, directory, storagePassword }) {
  const { enqueueBackup, claimJob, executeJob } = await import('../src/engine.js');
  const { saveSelfBackupSettings, enqueueSelfBackup, claimSelfBackup, executeSelfBackup, readLatestSelfBackup } = await import('../src/self-backup.js');
  const { loadInventory } = await import('../src/runbook/inventory.js');
  const { buildGuide } = await import('../src/runbook/guide.js');
  const { guidePdf, VERSION } = await import('../src/runbook/render.js');
  const { guideCopies } = await import('../src/runbook/copy.js');
  const { openRead } = await import('../src/storage.js');
  const { PLACEHOLDERS } = await import('../src/runbook/commands.js');
  const work = join(directory, 'runbook'), source = hosts[0], clean = hosts[0].replace('-source-', '-clean-');
  const sh = (host, text) => run('exec', host, 'sh', '-c', text);
  await mkdir(work, { recursive: true, mode: 0o700 });

  // A Compose demo app with a bind-mounted data folder, its record changed after the image was made.
  const name = 'recoverydemo', folder = `/srv/${name}`;
  await sh(source, `mkdir -p ${folder} && printf 'services:\\n  web:\\n    image: docknest-fixture:local\\n    restart: unless-stopped\\n    ports:\\n      - "127.0.0.1:8311:8080"\\n    volumes:\\n      - ./site:/site\\n' > ${folder}/compose.yaml && cd ${folder} && docker compose -f ${folder}/compose.yaml up -d`);
  await until(async () => (await sh(source, `docker exec ${name}-web-1 python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/record').read().decode())"`)) === 'snapshot-record', 'The demo app did not start');
  await sh(source, `docker exec ${name}-web-1 python -c "import sqlite3;d=sqlite3.connect('/site/database.sqlite');d.execute(\\"UPDATE records SET value='runbook-record'\\");d.commit()"`);
  const siteId = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, servers[0].id, 'הדגמה Demo', JSON.stringify({ containers: [`${name}-web-1`], composeFiles: [`${folder}/compose.yaml`], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', externalReferencesConfirmed: true, maintenanceRequired: false, healthUrl: '', domains: [] }), new Date().toISOString());
  enqueueBackup(siteId, 'qa'); const job = claimJob(); await executeJob(job);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'completed', 'the demo app is backed up');

  // The PDF, as downloaded without login details: qpdf accepts it and pdftotext reads its text, Hebrew included.
  const inventory = await loadInventory(), file = join(work, 'recovery-guide.pdf');
  await writeFile(file, guidePdf(inventory, { appIds: inventory.apps.map(app => app.id), include: {}, madeAt: new Date().toISOString() }));
  await exec('qpdf', ['--check', file]);
  const text = (await exec('pdftotext', ['-enc', 'UTF-8', file, '-'], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  for (const expected of ['Recovery Guide', 'Start here', 'Restore everything in this order', 'Fleet overview', 'Demo', PLACEHOLDERS.storagePassword]) assert.ok(text.includes(expected), `pdftotext finds "${expected}"`);
  assert.ok(text.includes('הדגמה') || text.includes('המגדה'), 'pdftotext reads the Hebrew app name');
  assert.ok(!text.includes(storagePassword), 'no storage password without login details');
  record('A Recovery Guide PDF passes qpdf --check; pdftotext reads its sections, a Hebrew app name and the placeholders, and no storage password');

  // Self Backup writes the redacted copy next to the kit; it too passes qpdf and holds no login.
  const passphrase = randomBytes(32).toString('base64url'), passphraseFile = join(work, 'recovery.passphrase');
  saveSelfBackupSettings({ enabled: false, schedule: '0 3 * * *', timezone: 'UTC', passphrase, recoverySecretSaved: true }, 'qa-admin');
  enqueueSelfBackup('qa-admin'); assert.equal(await executeSelfBackup(claimSelfBackup()), true);
  const [copy] = guideCopies();
  assert.match(copy.path, /\/BACKUP\/docknest-recovery\/recovery-guide_[0-9_-]+Z--[0-9a-f-]{36}\.pdf$/);
  const chunks = []; for await (const chunk of await openRead(copy.path)) chunks.push(chunk);
  const copyFile = join(work, 'copy.pdf'); await writeFile(copyFile, Buffer.concat(chunks));
  await exec('qpdf', ['--check', copyFile]);
  const copyText = (await exec('pdftotext', ['-enc', 'UTF-8', copyFile, '-'], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  assert.ok(copyText.includes('Demo') && !copyText.includes(storagePassword) && !copyText.includes('Contains secrets'));
  record('A Self Backup writes the Recovery Guide copy next to the kit on SFTP storage; it passes qpdf and holds no login');

  // The independent restore, on a clean host: the kit opened as Start here says, then the app's commands as printed.
  const kit = join(work, 'kit.dkit'), opened = join(work, 'docknest-kit');
  await writeFile(kit, (await readLatestSelfBackup()).bytes); await writeFile(passphraseFile, passphrase, { mode: 0o600 });
  await script(['scripts/recovery-kit.js', 'restore', kit, opened, passphraseFile]);
  try {
    await run('run', '-d', '--privileged', '--name', clean, '-e', 'DOCKER_TLS_CERTDIR=', 'docknest-qa-host:local');
    await until(async () => (await run('exec', clean, 'docker', 'info', '--format', '{{.OSType}}')) === 'linux', 'The clean host Docker engine failed to start');
    await run('exec', clean, 'apk', 'add', '--no-cache', 'nodejs');
    await run('cp', opened, `${clean}:/root/docknest-kit`);
    const storageAddress = `${await run('inspect', '--format', '{{.NetworkSettings.IPAddress}}', hosts[2])}:22`;
    const guide = buildGuide(await loadInventory({ logins: true }), { appIds: [siteId], include: { logins: true }, version: VERSION });
    const steps = guide.apps[0].restore.independent;
    assert.deepEqual(steps.map(item => item.text.split('.')[0]), ['Make a private folder for this app and download its backup into it', 'Decrypt the backup with the recovery kit and unpack it', 'Load the saved container images', 'Put each data folder back where it was', 'Put the Compose files back', 'Start the app with its Compose file']);
    const commands = steps.map(item => item.command).join('\n').replaceAll(PLACEHOLDERS.storageAddress, storageAddress);
    assert.ok(!commands.includes('<'), 'no placeholder is left');
    await run('exec', clean, 'sh', '-ec', commands);
    await until(async () => (await sh(clean, `wget -qO- http://127.0.0.1:8311/record || true`)) === 'runbook-record', 'The restored demo app did not answer with its data');
    assert.match(await sh(clean, guide.apps[0].works.command), /recoverydemo-web-1.*Up/s, 'the guide\'s own check shows the container up');
    record('On a clean Linux Docker host, the Recovery Guide\'s printed restore commands (download over SFTP with the pinned key, decrypt with the kit, images, data folder, Compose file, start) bring the demo app back with its data');
  } finally {
    await run('rm', '-f', '-v', clean).catch(() => {});
    await sh(source, `cd ${folder} && docker compose -f ${folder}/compose.yaml down`).catch(() => {});
    db.prepare('INSERT OR IGNORE INTO site_archives VALUES(?,?)').run(siteId, new Date().toISOString());
  }
}
