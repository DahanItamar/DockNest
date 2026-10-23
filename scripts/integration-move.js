// Site move between two real Linux Docker hosts (docs/moving-sites.md). Called by scripts/integration-linux.js.
// Proves: port remap on a taken port, data and bind files arrive, nginx on the target serves the domain, the final copy
// carries changes made after the test copy, the old copy is stopped with restart=no, and Cancel removes everything
// the move created on the target while the source keeps running. DNS uses a stub resolver (no real DNS in CI).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function runMoveScenario({ run, until, hosts, servers, db, record }) {
  const { enqueueBackup, claimJob, executeJob } = await import('../src/engine.js');
  const moves = await import('../src/moves/engine.js');
  const { dnsResolver } = await import('../src/moves/dns.js');
  const [source, target] = hosts;
  const sql = "import sqlite3,sys;db=sqlite3.connect('/site/database.sqlite');db.execute('UPDATE records SET value=?',(sys.argv[1],));db.commit()";

  // Source: a container site with a volume, a bind folder, a loopback port and an nginx route for its domain.
  await run('exec', source, 'sh', '-c', "mkdir -p /move-bind && printf 'move-config' > /move-bind/runtime.txt");
  for (const name of ['move-app', 'move-cancel']) {
    const port = name === 'move-app' ? '8090' : '8095';
    await run('exec', source, 'docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped', '-p', `127.0.0.1:${port}:8080`, '-v', name + '-data:/site', ...(name === 'move-app' ? ['-v', '/move-bind:/config:ro'] : []), 'docknest-fixture:local');
    await until(async () => (await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Health.Status}}', name)) === 'healthy', 'Move fixture is not healthy');
  }
  await run('exec', source, 'sh', '-c', "mkdir -p /etc/nginx/conf.d && printf 'server { listen 8096; server_name move.example.invalid; client_max_body_size 20m; location / { proxy_pass http://127.0.0.1:8090; } }\\n' > /etc/nginx/conf.d/move.conf");
  // Target: nginx including conf.d, and port 8090 already taken so the move must remap it.
  await run('exec', target, 'sh', '-c', "mkdir -p /etc/nginx/conf.d && printf 'events {}\\nhttp {\\n include /etc/nginx/conf.d/*.conf;\\n}\\n' > /etc/nginx/nginx.conf && (pkill nginx || true) && sleep 1 && nginx");
  await run('exec', '-d', target, 'python3', '-m', 'http.server', '8090', '--bind', '127.0.0.1');
  await until(async () => (await run('exec', target, 'sh', '-c', 'cat /proc/net/tcp')).includes(':1F9A'), 'Port 8090 blocker did not start');

  const config = name => ({ containers: [name], domains: [name.replace('-', '.') + '.example.invalid'].map(domain => name === 'move-app' ? 'move.example.invalid' : domain), healthUrl: `http://127.0.0.1:${name === 'move-app' ? 8090 : 8095}/`, stagingRoot: '/var/lib/docknest', exclusiveSourcesConfirmed: true, cleanShutdownConfirmed: true, shutdownProfile: 'generic', maintenanceRequired: false });
  const sites = {};
  for (const name of ['move-app', 'move-cancel']) {
    sites[name] = randomUUID();
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(sites[name], servers[0].id, name, JSON.stringify(config(name)), new Date().toISOString());
    const queued = enqueueBackup(sites[name], 'qa'), job = claimJob(); assert.equal(job.id, queued.id); await executeJob(job);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'completed', db.prepare('SELECT error FROM jobs WHERE id=?').get(job.id).error);
  }
  await run('exec', source, 'docker', 'exec', 'move-app', 'python', '-c', sql, 'test-record');

  async function drive(moveId, until, afterStep = {}) {
    const deadline = Date.now() + 15 * 60 * 1000, seen = new Set();
    while (Date.now() < deadline) {
      moves.tickMoves();
      await new Promise(resolve => setTimeout(resolve, 200));
      for (const row of db.prepare("SELECT step FROM site_move_steps WHERE move_id=? AND state='done'").all(moveId)) {
        if (!seen.has(row.step)) { seen.add(row.step); await afterStep[row.step]?.(); }
      }
      if (until(db.prepare('SELECT state FROM site_moves WHERE id=?').get(moveId).state)) return;
      const job = claimJob();
      if (job) await executeJob(job);
    }
    throw new Error('The move did not finish in time: ' + JSON.stringify(moves.moveView(moveId).steps.map(step => [step.step, step.state, step.result.error])));
  }

  // Happy path.
  const preview = await moves.previewMove({ siteId: sites['move-app'], targetServerId: servers[1].id, options: {} }, 'qa');
  assert.equal(preview.ok, true, preview.sentence);
  assert.deepEqual(preview.advanced.ports.map(port => [port.from, port.to]), [[8090, 8091]]);
  assert.deepEqual(preview.advanced.nginx.notCopied, ['client_max_body_size']);
  dnsResolver.resolve = async () => [{ A: [preview.advanced.dns.record.value], AAAA: [] }];
  await moves.startMove(preview.id, { preflightHash: preview.preflightHash }, 'qa');
  await drive(preview.id, state => ['completed', 'rolled_back', 'failed', 'recovery_required', 'cancelled'].includes(state), {
    // Written after the test copy: only the final copy can carry it to the new server.
    test: async () => {
      assert.equal(await run('exec', target, 'curl', '-s', 'http://127.0.0.1:8091/record'), 'test-record');
      assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', 'move-app'), 'no', 'the test copy never restarts by itself');
      assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}}', 'move-app'), 'true', 'the old site stays online during the test');
      await run('exec', source, 'docker', 'exec', 'move-app', 'python', '-c', sql, 'final-record');
    },
  });
  const view = moves.moveView(preview.id);
  assert.equal(view.engineState, 'completed', view.statusLine);
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(sites['move-app']).server_id, servers[1].id);
  assert.equal(await run('exec', target, 'curl', '-s', '-H', 'Host: move.example.invalid', 'http://127.0.0.1/record'), 'final-record');
  assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{(index (index .HostConfig.PortBindings "8080/tcp") 0).HostPort}} {{.HostConfig.RestartPolicy.Name}}', 'move-app'), '8091 unless-stopped');
  assert.equal(await run('exec', target, 'cat', '/move-bind/runtime.txt'), 'move-config');
  assert.match(await run('exec', target, 'sh', '-c', 'head -1 /etc/nginx/conf.d/docknest-' + sites['move-app'] + '.conf'), /^# Managed by DockNest move /);
  assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', 'move-app'), 'false no', 'the old copy is kept, stopped, and cannot restart by itself');
  assert.equal(await run('exec', source, 'docker', 'volume', 'inspect', '--format', '{{.Name}}', 'move-app-data'), 'move-app-data', 'the old data is kept');
  record('Site move: fresh backup, loopback test copy on a remapped port, final copy behind a stopped source, nginx route on the new server, DNS wait, finalize; old copy kept stopped with restart=no');
  // The moved site is an ordinary DockNest site on its new server.
  const after = enqueueBackup(sites['move-app'], 'qa'), afterJob = claimJob(); assert.equal(afterJob.id, after.id); await executeJob(afterJob);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(afterJob.id).status, 'completed', db.prepare('SELECT error FROM jobs WHERE id=?').get(afterJob.id).error);
  assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{.State.Running}}', 'move-app'), 'true');
  record('A moved site backs up on its new server and keeps running');

  // Switch back: the new copy stops (kept), the old copy starts with its original restart policy, the record returns.
  moves.switchBack(preview.id, 'qa');
  await drive(preview.id, state => ['switched_back', 'recovery_required'].includes(state));
  assert.equal(moves.moveView(preview.id).engineState, 'switched_back', moves.moveView(preview.id).statusLine);
  assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', 'move-app'), 'true unless-stopped');
  assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', 'move-app'), 'false no', 'the new copy is stopped and kept');
  assert.equal(await run('exec', source, 'curl', '-s', 'http://127.0.0.1:8090/record'), 'final-record');
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(sites['move-app']).server_id, servers[0].id);
  record('Switch back stops and keeps the new copy, restarts the old copy with its restart policy and returns the site record');

  // A Compose site moves through a generated override; afterwards the old copy is removed with its data on request.
  await run('exec', source, 'sh', '-c', "mkdir -p /srv/move-compose && printf 'services:\\n  web:\\n    image: docknest-fixture:local\\n    restart: unless-stopped\\n    ports: [\"127.0.0.1:8097:8080\"]\\n    volumes: [\"data:/site\"]\\nvolumes:\\n  data: {}\\n' > /srv/move-compose/compose.yaml && docker compose -p movecompose -f /srv/move-compose/compose.yaml up -d");
  await until(async () => (await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Health.Status}}', 'movecompose-web-1')) === 'healthy', 'Compose fixture is not healthy');
  await run('exec', target, 'sh', '-c', 'docker compose version --short');
  sites.compose = randomUUID();
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(sites.compose, servers[0].id, 'move-compose', JSON.stringify({ ...config('move-cancel'), containers: ['movecompose-web-1'], domains: ['compose.example.invalid'], healthUrl: 'http://127.0.0.1:8097/', composeFiles: ['/srv/move-compose/compose.yaml'], externalReferencesConfirmed: true }), new Date().toISOString());
  { const queued = enqueueBackup(sites.compose, 'qa'), job = claimJob(); assert.equal(job.id, queued.id); await executeJob(job); assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'completed', db.prepare('SELECT error FROM jobs WHERE id=?').get(job.id).error); }
  const composeMove = await moves.previewMove({ siteId: sites.compose, targetServerId: servers[1].id, options: {} }, 'qa');
  assert.equal(composeMove.ok, true, composeMove.sentence);
  assert.equal(composeMove.advanced.deployMethod, 'compose-override');
  dnsResolver.resolve = async () => [{ A: [composeMove.advanced.dns.record.value], AAAA: [] }];
  await moves.startMove(composeMove.id, { preflightHash: composeMove.preflightHash }, 'qa');
  await drive(composeMove.id, state => ['completed', 'rolled_back', 'failed', 'recovery_required', 'cancelled'].includes(state));
  assert.equal(moves.moveView(composeMove.id).engineState, 'completed', moves.moveView(composeMove.id).statusLine);
  assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}} {{.HostConfig.RestartPolicy.Name}}', 'movecompose-web-1'), 'movecompose unless-stopped');
  assert.equal(await run('exec', target, 'curl', '-s', '-H', 'Host: compose.example.invalid', 'http://127.0.0.1/record'), 'snapshot-record');
  assert.equal(await run('exec', target, 'cat', '/srv/move-compose/compose.yaml').then(text => text.includes('docknest')), false, 'the Compose file is not edited');
  record('A Compose site moves with its own Compose files plus a generated override and stays part of its Compose project');
  moves.removeOldCopy(composeMove.id, { confirmation: 'move-compose', deleteData: true }, 'qa');
  await drive(composeMove.id, state => state === 'cleaned' || !!moves.moveView(composeMove.id).error);
  assert.equal(moves.moveView(composeMove.id).engineState, 'cleaned', moves.moveView(composeMove.id).error ?? '');
  assert.equal(await run('exec', source, 'sh', '-c', 'docker ps -aq --filter name=movecompose-web-1; docker volume ls -q --filter name=movecompose_data'), '');
  assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{.State.Running}}', 'movecompose-web-1'), 'true');
  record('Remove old copy (asked, with data) deletes the stopped old containers and their volume only; the moved site keeps running');

  // Cancel before the switch removes everything the move created on the target; the source never stopped.
  const cancel = await moves.previewMove({ siteId: sites['move-cancel'], targetServerId: servers[1].id, options: { askBeforeSwitch: true } }, 'qa');
  assert.equal(cancel.ok, true, cancel.sentence);
  await moves.startMove(cancel.id, { preflightHash: cancel.preflightHash }, 'qa');
  await drive(cancel.id, state => state === 'waiting');
  assert.equal(await run('exec', target, 'docker', 'inspect', '--format', '{{.State.Running}}', 'move-cancel'), 'true');
  moves.cancelMove(cancel.id, 'qa');
  await drive(cancel.id, state => ['cancelled', 'rolled_back', 'recovery_required'].includes(state));
  assert.equal(db.prepare('SELECT state FROM site_moves WHERE id=?').get(cancel.id).state, 'cancelled');
  assert.equal(await run('exec', target, 'sh', '-c', 'docker ps -aq --filter name=move-cancel; docker volume ls -q --filter name=move-cancel-data'), '');
  assert.equal(await run('exec', source, 'docker', 'inspect', '--format', '{{.State.Running}}', 'move-cancel'), 'true');
  assert.equal(db.prepare('SELECT server_id FROM sites WHERE id=?').get(sites['move-cancel']).server_id, servers[0].id);
  record('Cancelling a move before the switch removes the copy, its volume and labels on the new server; the old site never stopped');
}
