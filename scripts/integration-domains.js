// Domain path (docs/domains.md) on a real Linux Docker host. Called by scripts/integration-linux.js.
// Runs on the storage host (a registered server no backup uses): host nginx proxies one domain to a container's
// loopback port, and a Traefik container routes a second domain by Docker labels. Proves the check runs through the job
// queue, every hop is read from the real helper answer, a secret in the nginx file and in a Traefik label never reaches
// DockNest, and the check is read-only: the nginx files and every container's labels hash the same afterwards.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const SECRET = 'qa-domain-secret-do-not-leak', NGINX_PID = 'pid /run/nginx-qa-domains.pid;';
const NGINX_MAIN = `events {}
http {
 include /etc/nginx/conf.d/qa-domains.conf;
}
`;
const NGINX_SITE = `server {
    listen 8097;
    server_name dom.example.com;
    location / {
        proxy_set_header X-Api-Key "${SECRET}";
        proxy_pass http://127.0.0.1:18080;
    }
}
`;

export async function runDomainsScenario({ run, until, hosts, servers, db, record }) {
  const host = hosts[2], server = servers[2];
  const { claimJob, executeJob, discover } = await import('../src/engine.js');
  const { dnsResolver } = await import('../src/moves/dns.js');
  const { enqueueDomainCheck } = await import('../src/domains/jobs.js');
  const { domainsView } = await import('../src/domains/check.js');
  const docker = (...args) => run('exec', host, 'docker', ...args);
  const containers = ['qa-dom-web', 'qa-dom-forum', 'qa-dom-traefik'];
  // What a check could change: the nginx configuration tree and the labels and state of every container.
  const fingerprint = async () => [await run('exec', host, 'sh', '-c', 'find /etc/nginx -type f -exec sha256sum {} + | sort'),
    await run('exec', host, 'sh', '-c', 'for c in $(docker ps -aq); do docker inspect --format "{{.Name}} {{json .Config.Labels}} {{.State.StartedAt}}" "$c"; done | sha256sum')].join('\n');
  const original = dnsResolver.resolve;
  try {
    await docker('pull', 'nginx:1.27-alpine'); await docker('pull', 'traefik:v3.1');
    await docker('run', '-d', '--name', 'qa-dom-web', '-p', '127.0.0.1:18080:80', 'nginx:1.27-alpine');
    await docker('run', '-d', '--name', 'qa-dom-forum', '--label', 'traefik.enable=true',
      '--label', 'traefik.http.routers.forum.rule=Host(`forum.example.com`)', '--label', 'traefik.http.services.forum.loadbalancer.server.port=80',
      '--label', 'traefik.http.routers.forum-api.rule=Host(`forum.example.com`) && PathPrefix(`/api`)',
      '--label', `traefik.http.middlewares.qa.basicauth.users=qa:${SECRET}`, 'nginx:1.27-alpine');
    await docker('run', '-d', '--name', 'qa-dom-traefik', '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', 'traefik:v3.1', '--providers.docker=true', '--entrypoints.web.address=:8000');
    // A separate nginx instance with its own main file, so the host's own nginx setup is never touched.
    await run('exec', host, 'sh', '-c', `mkdir -p /etc/nginx/conf.d && printf '%s' '${NGINX_SITE}' > /etc/nginx/conf.d/qa-domains.conf && printf '%s' '${NGINX_MAIN}' > /etc/nginx/qa-domains-main.conf`);
    await run('exec', host, 'nginx', '-t', '-c', '/etc/nginx/qa-domains-main.conf');
    await run('exec', host, 'nginx', '-c', '/etc/nginx/qa-domains-main.conf', '-g', NGINX_PID);
    await until(async () => (await run('exec', host, 'curl', '-s', '-H', 'Host: dom.example.com', 'http://127.0.0.1:8097/')).includes('nginx'), 'host nginx did not proxy to the app');

    const shopId = randomUUID(), forumId = randomUUID(), now = new Date().toISOString();
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(shopId, server.id, 'Domains QA shop', JSON.stringify({ kind: 'docker', containers: ['qa-dom-web'], domains: ['dom.example.com'], stagingRoot: '/var/lib/docknest' }), now);
    db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(forumId, server.id, 'Domains QA forum', JSON.stringify({ kind: 'docker', containers: ['qa-dom-forum'], domains: ['forum.example.com'], stagingRoot: '/var/lib/docknest' }), now);
    // Public DNS is faked to answer with the server's connection address; nothing leaves the test network.
    dnsResolver.resolve = async () => [{ A: [server.host], AAAA: [] }, { A: [server.host], AAAA: [] }];
    const before = await fingerprint();

    for (const siteId of [shopId, forumId]) {
      const { jobId } = enqueueDomainCheck(siteId, null, 'qa');
      const job = claimJob();
      assert.equal(job?.id, jobId, 'the check is claimed from the job queue');
      await executeJob(job);
      const row = db.prepare('SELECT status,error FROM jobs WHERE id=?').get(jobId);
      assert.equal(row.status, 'completed', row.error ?? '');
    }
    const view = domainsView(), byName = Object.fromEntries(view.domains.map(row => [row.domain, row]));
    const states = domain => Object.fromEntries(Object.entries(byName[domain].hops).map(([name, value]) => [name, `${value.state}:${value.reason}`]));
    assert.deepEqual(states('dom.example.com'), { dns: 'ok:points-to-server', proxy: 'ok:routed', app: 'ok:running', certificate: 'fail:no-certificate' });
    assert.equal(byName['dom.example.com'].siteId, shopId);
    assert.deepEqual(byName['dom.example.com'].hops.proxy.params, { proxy: 'nginx', serverId: server.id, upstream: 'http://127.0.0.1:18080' });
    // The second Traefik router has a matcher DockNest does not read, so the list says it may be incomplete.
    assert.deepEqual(states('forum.example.com'), { dns: 'ok:points-to-server', proxy: 'warn:incomplete', app: 'ok:running', certificate: 'unknown:managed-by-proxy' });
    assert.equal(byName['forum.example.com'].siteId, forumId);

    // Routing facts also ride on an administrator's discovery scan and never come back with its answer.
    const scan = await discover(server, { record: true });
    assert.equal('routing' in scan, false);
    await until(async () => Boolean(db.prepare("SELECT 1 FROM domain_checks WHERE domain='dom.example.com' AND trigger='discover'").get()), 'the scan did not check the server domains', 30);
    const stored = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(`domain_routes:${server.id}`).value);
    assert.ok(stored.routes.some(route => route.proxy === 'traefik' && route.domains.includes('forum.example.com')));
    assert.deepEqual(stored.notUnderstood.map(item => item.router), ['forum-api']);

    const everything = JSON.stringify([db.prepare('SELECT * FROM domain_checks').all(), stored, db.prepare("SELECT * FROM jobs WHERE type='domain-check'").all(), db.prepare('SELECT * FROM audit_events').all()]);
    assert.ok(!everything.includes(SECRET), 'a secret in a proxy configuration never reaches DockNest');
    assert.equal(await fingerprint(), before, 'nginx files and container labels are unchanged by hash after the check');
    record('Domain path on real Docker: host nginx and Traefik labels route to the right apps through the job queue; configs unchanged by hash and no proxy secret stored');
  } finally {
    dnsResolver.resolve = original;
    for (const name of containers) await docker('rm', '-f', name).catch(() => {});
    await run('exec', host, 'nginx', '-c', '/etc/nginx/qa-domains-main.conf', '-g', NGINX_PID, '-s', 'stop').catch(() => {});
    await run('exec', host, 'rm', '-f', '/etc/nginx/conf.d/qa-domains.conf', '/etc/nginx/qa-domains-main.conf').catch(() => {});
  }
}
