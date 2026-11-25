import assert from 'node:assert/strict';

// Stack managers (docs/site-setup.md) on a real Linux host: a Portainer-style manager keeps its stacks in its data
// volume and a Dockge-style manager in a stacks folder mounted at another path; each stack's Compose labels name the
// folder as the manager container sees it. Discovery maps both to the host, marks the manager, and browsing stays
// inside the stack folder. The managers are the fixture image under the managers' image names: discovery recognises
// them by image and mounts only, and never runs or changes them. Receives only the disposable nested hosts created by
// integration-linux; everything it creates is removed again.
export async function runStackManagersScenario({ run, hosts, servers, record }) {
  const { remote } = await import('../src/ssh.js');
  const source = hosts[0], on = (...args) => run('exec', source, ...args);
  const volume = 'qa_portainer_data', stacks = '/srv/qa-dockge-stacks';
  const write = (path, text) => on('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', 'write', path, text);
  const stack = (name, project, folder, file) => on('docker', 'run', '-d', '--name', name, '--label', 'com.docker.compose.project=' + project, '--label', 'com.docker.compose.service=web',
    '--label', 'com.docker.compose.project.working_dir=' + folder, '--label', 'com.docker.compose.project.config_files=' + folder + '/' + file, 'docknest-fixture:local');
  const names = ['qa-portainer', 'qa-dockge', 'qa-wiki-web', 'qa-notes-web'];
  try {
    await on('docker', 'tag', 'docknest-fixture:local', 'portainer/portainer-ce:qa');
    await on('docker', 'tag', 'docknest-fixture:local', 'louislam/dockge:qa');
    await on('docker', 'volume', 'create', volume);
    const data = await on('docker', 'volume', 'inspect', '--format', '{{.Mountpoint}}', volume);
    await write(data + '/compose/7/docker-compose.yml', 'services:\n  web:\n    image: docknest-fixture:local\n');
    await write(stacks + '/notes/compose.yaml', 'services:\n  web:\n    image: docknest-fixture:local\n');
    await write(stacks + '/notes/.env', 'QA_ONLY=value-stays-on-the-server\n');
    await on('docker', 'run', '-d', '--name', 'qa-portainer', '-v', volume + ':/data', 'portainer/portainer-ce:qa');
    await on('docker', 'run', '-d', '--name', 'qa-dockge', '-e', 'DOCKGE_STACKS_DIR=/opt/stacks', '-v', stacks + ':/opt/stacks', 'louislam/dockge:qa');
    await stack('qa-wiki-web', 'qa-wiki', '/data/compose/7', 'docker-compose.yml');
    await stack('qa-notes-web', 'qa-notes', '/opt/stacks/notes', 'compose.yaml');
    const discovery = await remote(servers[0], { operation: 'discover' });
    const found = name => discovery.containers.find(container => container.name === name)?.backupConfiguration;
    assert.deepEqual(found('qa-wiki-web'), { composeFiles: [data + '/compose/7/docker-compose.yml'], configFiles: [], directory: data + '/compose/7', manager: 'portainer' });
    assert.deepEqual(found('qa-notes-web'), { composeFiles: [stacks + '/notes/compose.yaml'], configFiles: [stacks + '/notes/.env'], directory: stacks + '/notes', manager: 'dockge' });
    assert.equal(found('qa-portainer').manager, undefined, 'a manager is not one of its own stacks');
    assert.ok(!JSON.stringify(discovery).includes('value-stays-on-the-server'), 'file contents never leave the server');
    const listing = await remote(servers[0], { operation: 'list-project-files', containers: ['qa-wiki-web'] });
    assert.equal(listing.directory, data + '/compose/7');
    assert.deepEqual(listing.entries.map(entry => entry.name), ['docker-compose.yml']);
    await assert.rejects(remote(servers[0], { operation: 'list-project-files', containers: ['qa-wiki-web'], directory: data }), /detected project directory/);
    assert.equal(await on('docker', 'inspect', '--format', '{{.State.Running}}', 'qa-portainer'), 'true', 'discovery never stops or changes a manager');
    record('Portainer and Dockge stacks are found through their manager: the Compose file in a data volume or a stacks folder mounted at another path maps to the host, the app is marked with its manager, and browsing stays inside the stack folder');
  } finally {
    await on('docker', 'rm', '-f', ...names).catch(() => {});
    await on('docker', 'volume', 'rm', '-f', volume).catch(() => {});
    await on('docker', 'rmi', 'portainer/portainer-ce:qa', 'louislam/dockge:qa').catch(() => {});
    await on('rm', '-rf', stacks).catch(() => {});
  }
}
