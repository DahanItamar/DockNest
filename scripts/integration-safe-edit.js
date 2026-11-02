// Safe Edit on a real Linux Docker host (docs/safe-edit.md, "Test plan"). Called by scripts/integration-linux.js.
// Drives the real engine, the real helper (remote/helper/edit.py) and real backups and restores; only the review token's
// user/session binding is supplied directly instead of through HTTP. Covers test plan 1-9, security review item 16 and:
// health-check failure with an image change and the data restore, gate refusals, a hand edit between load and apply,
// a multi-file project with an override, env_file, an image from .env and a service without a health check.
// Each scenario names what it proves in its record() line. Not runnable on Windows (needs the Docker-in-Docker hosts).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function runSafeEditScenario({ run, until, hosts, servers, db, record }) {
  const { claimJob, executeJob, siteInfo } = await import('../src/engine.js');
  const se = await import('../src/site-edits/engine.js');
  const { remote } = await import('../src/ssh.js');
  const host = hosts[0], server = servers[0];
  const sh = script => run('exec', host, 'sh', '-c', script);
  const write = async (path, text) => { await sh(`mkdir -p "$(dirname '${path}')" && cat > '${path}' <<'DOCKNEST_EOF'\n${text}DOCKNEST_EOF`); };
  const cat = path => sh(`cat '${path}'`);
  const fileSha = async path => (await sh(`sha256sum '${path}' | cut -c1-64`)).trim();
  const inspect = (container, format) => run('exec', host, 'docker', 'inspect', '--format', format, container);
  const userId = randomUUID(), sessionHash = 'f'.repeat(64), who = { userId, sessionHash };
  db.prepare("INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,'admin')").run(userId, 'safe-edit@example.invalid', 'x', 'x', '[]', new Date().toISOString(), 'Safe Edit QA');

  // Images: 1.0 and 1.1 are healthy, broken never becomes healthy, migrate writes to its data then fails its health check.
  await sh("mkdir -p /edit-images && cd /edit-images && printf 'FROM docknest-fixture:local\\nENV EDIT_VERSION=1.1\\n' > Dockerfile.ok && printf 'FROM docknest-fixture:local\\nHEALTHCHECK --interval=2s --timeout=2s --retries=2 CMD exit 1\\n' > Dockerfile.broken && printf 'FROM docknest-fixture:local\\nHEALTHCHECK --interval=2s --timeout=2s --retries=2 CMD exit 1\\nCMD [\"sh\",\"-c\",\"python -c \\\\\"import sqlite3;d=sqlite3.connect(\\x27/site/database.sqlite\\x27);d.execute(\\x27CREATE TABLE IF NOT EXISTS records(value TEXT)\\x27);d.execute(\\x27UPDATE records SET value=\\x22migrated\\x22\\x27);d.commit()\\\\\" && exec python /app/app.py\"]\\n' > Dockerfile.migrate");
  await run('exec', host, 'docker', 'tag', 'docknest-fixture:local', 'edit-app:1.0');
  for (const [tag, file] of [['1.1', 'ok'], ['broken', 'broken'], ['migrate', 'migrate']]) await run('exec', host, 'docker', 'build', '-q', '-t', `edit-app:${tag}`, '-f', `/edit-images/Dockerfile.${file}`, '/edit-images');

  // ---------- helpers ----------
  async function composeSite(name, files, { up = true, health = true } = {}) {
    for (const [path, text] of Object.entries(files)) await write(path, text);
    const composeFiles = Object.keys(files).filter(path => /compose[^/]*\.ya?ml$/.test(path));
    if (up) {
      await sh(`cd /srv/${name} && docker compose -p ${name} ${composeFiles.map(file => `-f ${file}`).join(' ')} --project-directory /srv/${name} up -d`);
      await until(async () => (await inspect(`${name}-web-1`, '{{.State.Running}}')) === 'true', `${name} did not start`);
      if (health) await until(async () => (await inspect(`${name}-web-1`, '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')).match(/healthy|none/), `${name} is not healthy`);
    }
    const containers = (await sh(`docker ps -a --filter label=com.docker.compose.project=${name} --format '{{.Names}}'`)).split('\n').filter(Boolean).sort();
    const siteId = randomUUID(), port = 8200 + Math.floor(Math.random() * 600);
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, server.id, name, JSON.stringify({ containers, composeFiles, stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', externalReferencesConfirmed: true, maintenanceRequired: true, healthUrl: '', domains: [], port }), new Date().toISOString());
    return siteId;
  }
  // The worker: ticks, claims and runs every job (real backups, restores and edit steps) until the edit settles.
  async function drive(editId, settled = row => row.result !== null || row.state === 'needs_attention', { minutes = 12, during = null } = {}) {
    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() < deadline) {
      se.tickSiteEdits();
      const row = se.loadEdit(editId);
      if (settled(row)) return row;
      await during?.(row);
      const job = claimJob();
      if (job) await executeJob(job); else await sleep(1000);
    }
    throw new Error('The Safe Edit did not settle in time: ' + JSON.stringify(se.loadSteps(editId).map(step => [step.step, step.state, step.detail])));
  }
  const view = siteId => se.editView(siteId);
  const fileFrom = (loaded, suffix) => loaded.files.find(file => file.path.endsWith(suffix));
  async function reviewed(siteId, change) { return se.reviewSiteEdit(siteId, change, who); }
  async function refusedReview(siteId, change, code) {
    await assert.rejects(reviewed(siteId, change), error => { assert.equal(error.code, code, `${error.code} ${error.message}`); assert.doesNotMatch(error.message, /root:|\/etc\/shadow|\$6\$/); return true; });
  }
  async function applyChange(siteId, change, extra = {}) {
    const review = await reviewed(siteId, change);
    return { review, editId: se.applySiteEdit(siteId, { token: review.token, ...extra }, who).edit.id };
  }
  const editCompose = async (siteId, suffix, edit) => { const loaded = await view(siteId), file = fileFrom(loaded, suffix); return { files: [{ path: file.path, sha256: file.sha256, text: edit(file.text) }] }; };
  const imageId = container => inspect(container, '{{.Image}}');
  const protectiveTags = editId => sh(`docker images --format '{{.Repository}}:{{.Tag}}' | grep -c 'docknest-edit/${editId}' || true`);

  // ---------- 1. image tag upgrade that passes; the old image stays on disk ----------
  const webCompose = (image, extra = '') => `services:\n  web:\n    image: ${image}\n    restart: unless-stopped\n    ports:\n      - "127.0.0.1:8301:8080"\n    volumes:\n      - data:/site\n${extra}volumes:\n  data: {}\n`;
  const shop = await composeSite('editshop', { '/srv/editshop/compose.yaml': webCompose('edit-app:1.0') });
  const oldImage = await imageId('editshop-web-1');
  let loaded = await view(shop);
  assert.equal(loaded.kind, 'compose'); assert.deepEqual(loaded.services.map(service => service.name), ['web']);
  let change = await editCompose(shop, 'compose.yaml', text => text.replace('edit-app:1.0', 'edit-app:1.1'));
  let { review, editId } = await applyChange(shop, change, { timeLimitSeconds: 120 });
  assert.equal(review.summary.imageChanged, true); assert.equal(review.summary.dataRollback, true);
  let row = await drive(editId);
  assert.equal(row.result, 'applied', row.reason ?? '');
  assert.equal(await inspect('editshop-web-1', '{{.Config.Image}}'), 'edit-app:1.1');
  assert.ok(await run('exec', host, 'docker', 'image', 'inspect', '--format', '{{.Id}}', oldImage), 'the old image ID stays until the next prune');
  assert.equal((await protectiveTags(editId)).trim(), '0', 'finish removes the protective tags');
  assert.doesNotMatch(await sh('ls /var/lib/docknest/edits 2>/dev/null || true'), new RegExp(editId), 'finish removes the journal');
  record('Safe Edit 1: an image tag upgrade takes a backup, pulls before the maintenance page, comes up healthy and keeps the old image ID until a prune');

  // ---------- 2 + 9. image change with a database migration on start, then failing health: data rolled back in place ----------
  const beforeText = await cat('/srv/editshop/compose.yaml'), beforeSha = await fileSha('/srv/editshop/compose.yaml'), beforeImage = await imageId('editshop-web-1');
  await run('exec', host, 'docker', 'exec', 'editshop-web-1', 'python', '-c', "import sqlite3;d=sqlite3.connect('/site/database.sqlite');d.execute('UPDATE records SET value=?',('before-edit',));d.commit()");
  change = await editCompose(shop, 'compose.yaml', text => text.replace('edit-app:1.1', 'edit-app:migrate'));
  ({ editId } = await applyChange(shop, change, { timeLimitSeconds: 60 }));
  row = await drive(editId, undefined, { minutes: 15 });
  assert.equal(row.result, 'rolled_back', row.reason ?? ''); assert.equal(row.failed_step, 'check_health'); assert.equal(row.data_rollback, true);
  assert.equal(await fileSha('/srv/editshop/compose.yaml'), beforeSha, 'the Compose file is byte-identical');
  assert.equal(await cat('/srv/editshop/compose.yaml'), beforeText);
  assert.equal(await imageId('editshop-web-1'), beforeImage, 'the previous image ID runs again');
  assert.equal(await inspect('editshop-web-1', '{{.State.Running}}'), 'true');
  // The data came back in place from the safety copy: the value the failed version migrated is gone.
  assert.equal(await run('exec', host, 'docker', 'exec', 'editshop-web-1', 'python', '-c', "import sqlite3;print(sqlite3.connect('/site/database.sqlite').execute('SELECT value FROM records').fetchone()[0])"), 'before-edit');
  assert.ok(!db.prepare("SELECT 1 FROM jobs WHERE type='restore' AND site_id=?").get(shop), 'no isolated restore is used for the data rollback');
  assert.doesNotMatch(await sh('ls /var/lib/docknest/edits 2>/dev/null || true'), new RegExp(editId), 'finish removed the journal and the safety copy');
  record('Safe Edit 2/9: an image change that migrated its data on start and then failed its health check is rolled back in place: files byte-identical, old image ID running, data back from the safety copy, copy removed');

  // ---------- 3. an environment value that makes the app exit after 20 s: fails at stability ----------
  const crashCompose = 'services:\n  web:\n    image: edit-app:1.0\n    env_file: [app.env]\n    command: ["sh","-c","python /app/app.py & if [ \\"$$CRASH\\" = yes ]; then sleep 20; exit 1; fi; wait"]\n    ports:\n      - "127.0.0.1:8302:8080"\n';
  const crash = await composeSite('editcrash', { '/srv/editcrash/compose.yaml': crashCompose, '/srv/editcrash/app.env': '# app settings\nCRASH=no\nexport GREETING="hello # not a comment"\n' });
  loaded = await view(crash);
  const appEnv = loaded.env.find(item => item.file.endsWith('app.env'));
  assert.ok(appEnv?.keys.some(key => key.key === 'CRASH'));
  assert.doesNotMatch(JSON.stringify(loaded), /CRASH=no|hello # not/, 'values never leave the server');
  const envBefore = await cat('/srv/editcrash/app.env');
  ({ editId } = await applyChange(crash, { env: [{ file: appEnv.file, key: 'CRASH', value: 'yes' }] }, { timeLimitSeconds: 120 }));
  row = await drive(editId, undefined, { minutes: 15 });
  assert.equal(row.result, 'rolled_back', row.reason ?? ''); assert.equal(row.data_rollback, false);
  assert.equal(await cat('/srv/editcrash/app.env'), envBefore, 'comments, export lines and quoting come back byte for byte');
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM site_edits WHERE id=?').get(editId)) + JSON.stringify(db.prepare('SELECT * FROM site_edit_steps WHERE edit_id=?').all(editId)), /CRASH=yes|"yes"/);
  record('Safe Edit 3: an environment change that makes the app exit after 20 s fails the stability check and is rolled back without a data restore');

  // ---------- 4. a port already in use: refused at review, nothing written ----------
  await run('exec', '-d', host, 'python3', '-m', 'http.server', '8399', '--bind', '127.0.0.1');
  await until(async () => (await sh('cat /proc/net/tcp')).includes(':20CF'), 'port blocker did not start');
  const shopSha = await fileSha('/srv/editshop/compose.yaml');
  await refusedReview(shop, await editCompose(shop, 'compose.yaml', text => text.replace('127.0.0.1:8301:8080', '127.0.0.1:8399:8080')), 'PORT_IN_USE');
  assert.equal(await fileSha('/srv/editshop/compose.yaml'), shopSha);
  record('Safe Edit 4: a port already in use on the server is refused at review and nothing is written');

  // ---------- 5 + 16. the gate: privilege, host access and Compose steering ----------
  const add = extra => text => text.replace('    restart: unless-stopped\n', `    restart: unless-stopped\n${extra}`);
  for (const [extra, code] of [['    privileged: true\n', 'PRIVILEGE_ADDED'], ['    network_mode: host\n', 'PRIVILEGE_ADDED'], ['    use_api_socket: true\n', 'PRIVILEGE_ADDED'], ['    cap_add: [SYS_ADMIN]\n', 'PRIVILEGE_ADDED'], ['    labels:\n      docknest.move: spoofed\n', 'PRIVILEGE_ADDED'], ['    labels:\n      com.docker.compose.project: other\n', 'PRIVILEGE_ADDED']]) {
    await refusedReview(shop, await editCompose(shop, 'compose.yaml', add(extra)), code);
  }
  for (const mount of ['/var/run/docker.sock:/var/run/docker.sock', '/etc:/host-etc:ro']) {
    await refusedReview(shop, await editCompose(shop, 'compose.yaml', text => text.replace('      - data:/site\n', `      - data:/site\n      - ${mount}\n`)), 'PATH_REFUSED');
  }
  await refusedReview(shop, await editCompose(shop, 'compose.yaml', add('    env_file: [/etc/shadow]\n')), 'PATH_REFUSED');
  // A symlinked bind source is refused even when it points inside the site's folder.
  await sh('mkdir -p /srv/editshop/real && ln -sfn /srv/editshop/real /srv/editshop/link');
  await refusedReview(shop, await editCompose(shop, 'compose.yaml', text => text.replace('      - data:/site\n', '      - data:/site\n      - /srv/editshop/link:/linked\n')), 'PATH_REFUSED');
  // Environment cannot steer Compose (refused by DockNest before the server is asked).
  loaded = await view(crash);
  for (const entry of [{ key: 'COMPOSE_FILE', value: '/etc/x.yaml' }, { key: 'GOOD', value: 'a\nCOMPOSE_FILE=/etc/x.yaml' }, { key: 'DOCKER_HOST', value: 'tcp://192.0.2.1:2375' }]) {
    await refusedReview(crash, { env: [{ file: appEnv.file, ...entry }] }, 'ENV_REFUSED');
  }
  assert.equal(await fileSha('/srv/editshop/compose.yaml'), shopSha, 'no refused candidate ever reached the real files');
  // A service that already has host access is frozen: no new image through Safe Edit.
  const socketSite = await composeSite('editsock', { '/srv/editsock/compose.yaml': 'services:\n  web:\n    image: edit-app:1.0\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n' });
  await refusedReview(socketSite, await editCompose(socketSite, 'compose.yaml', text => text.replace('edit-app:1.0', 'edit-app:1.1')), 'SERVICE_FROZEN');
  record('Safe Edit 5/16: privileged, host network, use_api_socket, added capabilities, docknest.* and Compose labels, docker.sock and /etc binds, env_file /etc/shadow, symlinked binds and COMPOSE_/DOCKER_/newline environment values are refused with fixed reasons; a docker.sock service cannot get a new image');

  // ---------- conflict detection: a hand edit between load and review, and during the backup ----------
  change = await editCompose(shop, 'compose.yaml', text => text.replace('edit-app:1.1', 'edit-app:1.0'));
  await sh("printf '# edited by hand\\n' >> /srv/editshop/compose.yaml");
  await refusedReview(shop, change, 'FILE_CHANGED');
  change = await editCompose(shop, 'compose.yaml', text => text.replace('edit-app:1.1', 'edit-app:1.0'));
  ({ editId } = await applyChange(shop, change));
  let handEdited = false;
  row = await drive(editId, undefined, { during: async current => { if (!handEdited && current.progress.backupJobId) { handEdited = true; await sh("printf '# second hand edit\\n' >> /srv/editshop/compose.yaml"); } } });
  assert.equal(row.result, 'failed'); assert.equal(row.reason, 'The files changed during the backup.');
  assert.match(await cat('/srv/editshop/compose.yaml'), /# second hand edit\n$/, 'the hand edit is kept, never rolled over');
  record('Safe Edit conflicts: a hand edit between load and review is refused (reload), and one made during the backup step stops the edit before anything is written');

  // ---------- 6. the worker is killed during apply: the next worker rolls back ----------
  change = await editCompose(shop, 'compose.yaml', text => text.replace('edit-app:1.1', 'edit-app:broken'));
  ({ editId } = await applyChange(shop, change));
  // Run up to the apply job, then do what that job does (edit-apply takes the candidate from the journal) and stop as a killed worker would (job left edit_running).
  for (;;) {
    se.tickSiteEdits();
    const job = claimJob();
    if (!job) { await sleep(1000); continue; }
    const details = JSON.parse(job.details);
    if (job.type !== 'site-edit' || details.step !== 'apply') { await executeJob(job); continue; }
    const current = se.loadEdit(editId);
    db.prepare('UPDATE site_edits SET progress=? WHERE id=?').run(JSON.stringify({ ...current.progress, applyStarted: true }), editId);
    await remote(server, { operation: 'edit-apply', editId, siteId: shop, invocation: details.invocation, allowedRoots: details.allowedRoots, config: siteInfo(shop).site.config, sshPort: server.port, reviewedModelSha256: current.progress.reviewedModelSha256 }).catch(() => {});
    break;
  }
  se.recoverInterruptedSiteEdits();
  row = await drive(editId, undefined, { minutes: 15 });
  assert.equal(row.result, 'rolled_back', row.reason ?? ''); assert.equal(row.reason, 'DockNest restarted during the change, so it was undone.');
  assert.equal(await inspect('editshop-web-1', '{{.State.Running}}'), 'true');
  record('Safe Edit 6: a worker killed during apply leaves the candidate on disk; the next worker reads edit-status and rolls back');

  // ---------- 16. rollback without re-pull: pull_policy always, a prune between prepare and rollback, orphan removal ----------
  await write('/srv/editshop/compose.yaml', webCompose('edit-app:1.1', '    pull_policy: always\n'));
  await sh('cd /srv/editshop && docker compose -p editshop -f /srv/editshop/compose.yaml --project-directory /srv/editshop up -d --pull never');
  db.prepare('DELETE FROM site_compose_invocations WHERE site_id=?').run(shop);
  change = await editCompose(shop, 'compose.yaml', text => text.replace('edit-app:1.1', 'edit-app:broken'));
  change.files[0].text = change.files[0].text.replace('volumes:\n  data: {}\n', '  cache:\n    image: edit-app:1.0\nvolumes:\n  data: {}\n');
  ({ editId } = await applyChange(shop, change, { timeLimitSeconds: 60 }));
  let pruned = false;
  row = await drive(editId, undefined, { minutes: 15, during: async current => { if (!pruned && current.progress.applyStarted) { pruned = true; await sh('docker image prune -af >/dev/null 2>&1 || true'); } } });
  assert.equal(row.result, 'rolled_back', row.reason ?? '');
  assert.equal(await inspect('editshop-web-1', '{{.Config.Image}}'), 'edit-app:1.1', 'rolled back without pulling (the tag exists only locally)');
  assert.equal((await sh("docker ps -a --filter label=com.docker.compose.project=editshop --filter label=com.docker.compose.service=cache -q")).trim(), '', 'the service the candidate added is removed');
  record('Safe Edit 16: rollback never pulls (pull_policy: always, local-only tag), survives docker image prune -a between prepare and rollback, and removes the service the candidate added');

  // ---------- 7. the rollback itself fails: needs attention, the maintenance page stays ----------
  change = await editCompose(shop, 'compose.yaml', text => text.replace('edit-app:1.1', 'edit-app:broken'));
  ({ editId } = await applyChange(shop, change, { timeLimitSeconds: 60 }));
  let corrupted = false;
  row = await drive(editId, undefined, { minutes: 15, during: async current => { if (!corrupted && current.progress.phase === 'check_health') { corrupted = true; await sh(`for f in $(find /var/lib/docknest/edits/${editId} -type f); do printf 'corrupted' > "$f"; done`); } } });
  assert.equal(row.state, 'needs_attention', JSON.stringify(row));
  assert.equal(row.reason, 'The previous version could not be put back. The site stays behind the maintenance page.');
  const maintenanceDirectory = siteInfo(shop).site.config.maintenance.directory;
  assert.equal(await sh(`test -e '${maintenanceDirectory}/enabled' && echo on || echo off`), 'on', 'the maintenance page stays on');
  assert.equal(await sh(`test -d /var/lib/docknest/edits/${editId}/data && echo kept || echo gone`), 'kept', 'a failed rollback keeps the data safety copy');
  const { detailOf } = await import('../src/site-edits/views.js');
  assert.equal(detailOf(editId).dataCopyNote, 'A safety copy of the data is kept on the server.');
  record('Safe Edit 7: a rollback that fails (journal corrupted) leaves the site behind the maintenance page and the edit needs attention; the data safety copy is kept and the edit says so');
  // Restore backup from needs-attention ends the edit; then put the site back for the next checks.
  await se.restoreSiteEditBackup(editId, userId);
  row = await drive(editId, current => current.result !== null, { minutes: 15 });
  assert.equal(row.result, 'failed'); assert.match(row.reason, /backup from before the change was restored/);
  await write('/srv/editshop/compose.yaml', webCompose('edit-app:1.1'));
  await sh('cd /srv/editshop && docker compose -p editshop -f /srv/editshop/compose.yaml --project-directory /srv/editshop up -d --pull never --remove-orphans');

  // ---------- 8. a single-container site: environment and port change by recreate ----------
  await run('exec', host, 'docker', 'run', '-d', '--name', 'editsolo', '-e', 'MODE=one', '-p', '127.0.0.1:8303:8080', 'edit-app:1.0');
  await until(async () => (await inspect('editsolo', '{{.State.Health.Status}}')) === 'healthy', 'single container is not healthy');
  const solo = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(solo, server.id, 'editsolo', JSON.stringify({ containers: ['editsolo'], stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: true, healthUrl: '', domains: [] }), new Date().toISOString());
  loaded = await view(solo);
  assert.equal(loaded.kind, 'container'); assert.equal(loaded.usable.compose, false);
  const soloEnv = loaded.env[0];
  ({ editId } = await applyChange(solo, { env: [{ file: soloEnv.file, key: 'MODE', value: 'two-secret-value' }] }));
  row = await drive(editId);
  assert.equal(row.result, 'applied', row.reason ?? '');
  assert.match(await inspect('editsolo', '{{json .Config.Env}}'), /MODE=two-secret-value/);
  assert.doesNotMatch(await sh('ps -eo args'), /two-secret-value/, 'no value in any process argument');
  assert.equal(await sh(`ls /var/lib/docknest/edits 2>/dev/null | grep -c ${editId} || true`), '0', 'the 0600 env file was removed with the journal');
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM jobs').all()) + JSON.stringify(db.prepare('SELECT * FROM audit_events').all()), /two-secret-value/);
  record('Safe Edit 8: a single-container site gets an environment change by recreate from inspect, through a 0600 env file that is removed afterwards; the value is in no argv, job or audit row');

  // ---------- multi-file project with an override, env_file, the image from .env, no health check ----------
  const multi = await composeSite('editmulti', {
    '/srv/editmulti/compose.yaml': 'services:\n  web:\n    image: ${IMG}\n    env_file: [web.env]\n    healthcheck:\n      disable: true\n',
    '/srv/editmulti/compose.override.yaml': 'services:\n  web:\n    ports:\n      - "127.0.0.1:8304:8080"\n',
    '/srv/editmulti/.env': 'IMG=edit-app:1.0\n',
    '/srv/editmulti/web.env': 'MODE=multi\n',
  }, { health: false });
  loaded = await view(multi);
  assert.equal(loaded.files.length, 2, 'both Compose files are editable');
  assert.equal(loaded.usable.image, false, 'the image comes from .env: the Image tab points to Environment');
  const dotEnv = loaded.env.find(item => item.file.endsWith('/.env'));
  ({ review, editId } = await applyChange(multi, { env: [{ file: dotEnv.file, key: 'IMG', value: 'edit-app:1.1' }], ...(await editCompose(multi, 'compose.override.yaml', text => text.replace('8304', '8305'))) }, { timeLimitSeconds: 90 }));
  assert.equal(review.summary.imageChanged, true, 'changing IMG in .env changes the resolved image');
  assert.ok(review.warnings.some(item => item.code === 'NO_HEALTH_CHECK'));
  row = await drive(editId);
  assert.equal(row.result, 'applied', row.reason ?? '');
  assert.equal(await inspect('editmulti-web-1', '{{.Config.Image}}'), 'edit-app:1.1');
  assert.equal(await inspect('editmulti-web-1', '{{(index (index .HostConfig.PortBindings "8080/tcp") 0).HostPort}}'), '8305');
  record('Safe Edit: a two-file project (port in the override), env_file, the image from .env and no health check: changed together, "running and stable" counted');
}
