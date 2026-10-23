import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMove, planPorts, maskValue, estimateDowntime, describeDuration, preflightHash, PORT_SEARCH_RANGE } from '../src/moves/preflight.js';

const GiB = 1024 ** 3;
// A Compose site that can move without notes. Each test changes only what it is about.
function facts(change = f => f) {
  const base = {
    site: { id: 'site', name: 'Shop', kind: 'compose', domains: ['shop.example.com'], containerCount: 2, architecture: 'x86_64', packageBytes: 2 * GiB,
      ports: [{ hostIp: '127.0.0.1', hostPort: 8082, containerPort: 80 }], bindPaths: ['/srv/shop/data'], names: { containers: ['shop-web'] },
      nginxDirectives: [], maintenanceReady: true, env: [], timings: { backupSeconds: 20, restoreSeconds: 15 } },
    source: { id: 'old', name: 'old-srv', addresses: ['203.0.113.7'] },
    target: { id: 'new', name: 'new-srv', reachable: true, hostKeyOk: true, uid: 0, architecture: 'x86_64', dockerVersion: '28.1.1', composeVersion: '2.29.1',
      freeBytes: 100 * GiB, totalBytes: 200 * GiB, usedPorts: [22, 80, 443], reservedPorts: [], existingPaths: [], conflicts: {},
      nginx: { installed: true, configOk: true, serverNames: ['other.example.com'] }, webPortOwner: 'nginx', certbot: { installed: true, account: true }, stagingWritable: true, addresses: ['198.51.100.9'] },
    state: {}, backupStorage: { freeBytes: 50 * GiB },
    dns: { mode: 'cloudflare', records: [{ type: 'A', name: 'shop.example.com', value: '203.0.113.7' }] },
  };
  const copy = structuredClone(base); change(copy); return copy;
}
const only = (result, id) => result.details.checks.filter(item => item.id === id);
const statuses = result => Object.fromEntries(result.details.checks.map(item => [item.id, item.status]));

test('a healthy site gets one plain ready sentence with the honest downtime', () => {
  const result = evaluateMove(facts());
  assert.equal(result.verdict, 'ready'); assert.equal(result.canStart, true);
  assert.equal(result.sentence, 'Shop is ready to move to new-srv. It stays online while the copy is tested; expected downtime is about 40 seconds.');
  assert.deepEqual(result.details.portMap, [{ hostIp: '127.0.0.1', protocol: 'tcp', containerPort: 80, from: 8082, to: 8082 }]);
  assert.equal(result.details.blockers, 0); assert.equal(result.details.warnings, 0);
});

test('manual DNS says the downtime lasts until the DNS change is live', () => {
  const result = evaluateMove(facts(f => { f.dns.mode = 'manual'; }));
  assert.match(result.sentence, /about 40 seconds, then until your DNS change is live\.$/);
});

test('blocked moves lead with one plain sentence naming the first reason', () => {
  const cases = [
    [f => { f.target.id = 'old'; }, 'This site is already on new-srv.'],
    [f => { f.target.reachable = false; }, 'new-srv could not be reached. Open Servers and test the connection.'],
    [f => { f.target.hostKeyOk = false; }, 'new-srv could not be reached. Open Servers and test the connection.'],
    [f => { f.state.busy = true; }, 'Finish or resolve the current work on Shop first.'],
    [f => { f.state.deploymentHold = true; }, 'Finish or resolve the current work on Shop first.'],
    [f => { f.target.uid = 1000; }, 'DockNest needs root SSH on new-srv to restore file ownership.'],
    [f => { f.target.stagingWritable = false; }, 'DockNest cannot write to /var/lib/docknest on new-srv. Check that the disk is not full or read-only.'],
    [f => { f.target.freeBytes = 5 * GiB; }, 'Needs about 7 GB. new-srv has 5 GB free.'],
    [f => { f.backupStorage.freeBytes = GiB / 2; }, 'Backup storage has less than 1 GB free. Free some space before moving.'],
    [f => { f.target.architecture = 'aarch64'; }, 'new-srv is aarch64; Shop was built for x86_64.'],
    [f => { f.target.dockerVersion = '27.5.1'; }, 'Docker 27.5.1 on new-srv is too old for this site (needs 28 or newer).'],
    [f => { f.target.dockerVersion = null; }, 'Docker is not installed on new-srv. DockNest does not install software; install it, then check again.'],
    [f => { f.target.composeVersion = null; }, 'Docker Compose 2 is not installed on new-srv.'],
    [f => { f.target.composeVersion = '1.29.2'; }, 'Docker Compose 2 is not installed on new-srv.'],
    [f => { f.target.existingPaths = [{ path: '/srv/shop/data', empty: false }]; }, '/srv/shop/data already exists on new-srv. DockNest never overwrites existing folders.'],
    [f => { f.target.conflicts = { volumes: ['shop_db'] }; }, 'A volume named shop_db already exists on new-srv. DockNest never replaces it.'],
    [f => { f.target.nginx = { installed: false }; }, 'nginx is not installed on new-srv. DockNest does not install software; install it, then check again.'],
    [f => { f.target.nginx.configOk = false; }, 'nginx on new-srv has a configuration error that DockNest did not cause. Fix it first.'],
    [f => { f.target.nginx.serverNames = ['SHOP.example.com']; }, 'shop.example.com is already served by nginx on new-srv.'],
    [f => { f.target.webPortOwner = 'other'; }, 'Another program uses port 80 on new-srv, so nginx cannot serve shop.example.com.'],
    [f => { f.target.usedPorts = Array.from({ length: PORT_SEARCH_RANGE + 1 }, (_, index) => 8082 + index); }, 'Port 8082 and the next 100 ports are all used on new-srv.'],
    [f => { f.dns.records = [{ type: 'CNAME', name: 'shop.example.com', value: 'shop.host.example.net' }]; }, 'shop.example.com is a CNAME record, so DockNest cannot switch it for you. Choose "I\'ll change DNS myself".'],
    [f => { f.dns.records.push({ type: 'A', name: 'shop.example.com', value: '203.0.113.8' }); }, 'shop.example.com has 2 A records, so DockNest cannot switch it for you. Choose "I\'ll change DNS myself".'],
    [f => { f.site.timings = { backupSeconds: 1500, restoreSeconds: 1000 }; }, 'Shop is too large to move safely: the final copy would keep it offline for about 42 minutes, longer than the 30 minute limit.'],
  ];
  for (const [change, sentence] of cases) {
    const result = evaluateMove(facts(change));
    assert.equal(result.verdict, 'blocked', sentence); assert.equal(result.canStart, false);
    assert.equal(result.sentence, sentence);
  }
});

test('an unreachable target skips host checks it could not have run', () => {
  const result = evaluateMove(facts(f => { f.target.reachable = false; f.target.uid = undefined; f.target.nginx = undefined; }));
  assert.deepEqual(result.details.checks.filter(item => item.status === 'block').map(item => item.id), ['eligibility']);
});

test('warnings proceed and stay under Advanced details', () => {
  const result = evaluateMove(facts(f => {
    f.target.usedPorts.push(8082);
    f.target.composeVersion = '2.20.0';
    f.target.freeBytes = 35 * GiB; f.target.totalBytes = 200 * GiB;
    f.target.certbot = { installed: false };
    f.site.maintenanceReady = false;
    f.site.nginxDirectives = ['client_max_body_size', 'location', 'client_max_body_size'];
    f.dns.records.push({ type: 'AAAA', name: 'shop.example.com', value: '2001:db8::7' });
  }));
  assert.equal(result.verdict, 'ready-with-notes'); assert.equal(result.canStart, true);
  assert.match(result.sentence, /^Shop is ready to move to new-srv\./);
  const text = id => only(result, id).map(item => item.text);
  assert.deepEqual(text('port'), ['Port 8082 is already used on new-srv. The site will listen on 8083 instead. Its own settings stay the same.']);
  assert.equal(only(result, 'port')[0].automatic, true);
  assert.deepEqual(result.details.portMap, [{ hostIp: '127.0.0.1', protocol: 'tcp', containerPort: 80, from: 8082, to: 8083 }]);
  assert.match(text('compose')[0], /older than 2\.24/);
  assert.deepEqual(text('disk'), ['new-srv will be more than 85% full after the move.']);
  assert.deepEqual(text('tls'), ['No certificate tool is set up on new-srv. The site will use HTTP until you issue a certificate for shop.example.com.']);
  assert.deepEqual(text('maintenance'), ['No maintenance page is set up for Shop; visitors will see an error during the final sync.']);
  assert.ok(text('nginx').includes('These nginx settings will not be copied: client_max_body_size, location.'));
  assert.ok(text('dns').some(line => /DockNest changes only the IPv4 record/.test(line)));
});

test('DNS that does not point at the source, or does not resolve, is a warning', () => {
  assert.match(only(evaluateMove(facts(f => { f.dns.records[0].value = '192.0.2.1'; })), 'dns')[0].text, /does not currently point to old-srv/);
  const none = evaluateMove(facts(f => { f.dns = { mode: 'manual', records: [] }; }));
  assert.equal(statuses(none).dns, 'warn'); assert.match(only(none, 'dns')[0].text, /does not resolve yet/);
  const proxied = evaluateMove(facts(f => { f.dns.records[0].proxied = true; f.target.certbot = { installed: false }; }));
  assert.equal(only(proxied, 'tls').length, 0, 'Cloudflare-proxied records get TLS at Cloudflare');
  assert.equal(evaluateMove(facts(f => { f.dns.mode = 'manual'; f.dns.records = [{ type: 'CNAME', name: 'shop.example.com', value: 'x.example.net' }]; })).canStart, true, 'manual DNS works with a CNAME');
});

test('env findings are warnings with masked values only, and rewrite is opt-in per key', () => {
  const env = [
    { key: 'DATABASE_URL', where: '.env', kind: 'host', masked: 'postgres://shop:hunter2@203.0.113.7:5432/shop?sslmode=require' },
    { key: 'REDIS_HOST', where: 'compose.yaml', kind: 'ip', masked: '203.0.113.7' },
  ];
  const result = evaluateMove(facts(f => { f.site.env = env; }), { envRewrite: ['REDIS_HOST'] });
  assert.equal(result.canStart, true);
  assert.deepEqual(result.details.env, [
    { key: 'DATABASE_URL', where: '.env', kind: 'host', masked: 'postgres://203.0.113.7:5432', rewrite: false },
    { key: 'REDIS_HOST', where: 'compose.yaml', kind: 'ip', masked: '203.0.113.7', rewrite: true },
  ]);
  const text = only(result, 'env').map(item => item.text);
  assert.match(text[0], /Turn on rewrite under Advanced settings/); assert.match(text[1], /on the new copy only/);
  const serialized = JSON.stringify(result);
  for (const secret of ['hunter2', 'shop:', 'sslmode']) assert.ok(!serialized.includes(secret), secret + ' must never reach preflight output');
});

test('maskValue keeps scheme, host and port only', () => {
  assert.equal(maskValue('https://user:pa@ss@api.example.com:8443/v1?token=x#frag'), 'https://api.example.com:8443');
  assert.equal(maskValue('mysql://root:secret@10.0.0.5/app'), 'mysql://10.0.0.5');
  assert.equal(maskValue('user:secret@db.internal:5432'), 'db.internal:5432');
  assert.equal(maskValue('203.0.113.7:6379'), '203.0.113.7:6379');
  assert.equal(maskValue(''), '');
  assert.equal(maskValue(undefined), '');
});

test('planPorts remaps only conflicts, keeps host IPs, honours reservations and never reuses a port', () => {
  const bindings = [{ hostIp: '127.0.0.1', hostPort: 8080, containerPort: 80 }, { hostPort: 8081, containerPort: 81 }, { hostIp: '0.0.0.0', hostPort: 9000, containerPort: 9000, protocol: 'udp' }];
  const { map, exhausted } = planPorts(bindings, [8080, 8082, 9000]);
  assert.deepEqual(exhausted, []);
  assert.deepEqual(map, [
    { hostIp: '127.0.0.1', protocol: 'tcp', containerPort: 80, from: 8080, to: 8081 },
    { hostIp: '0.0.0.0', protocol: 'tcp', containerPort: 81, from: 8081, to: 8083 },
    { hostIp: '0.0.0.0', protocol: 'udp', containerPort: 9000, from: 9000, to: 9001 },
  ]);
  assert.equal(new Set(map.map(item => item.to)).size, map.length);
  // Input order does not change the result.
  assert.deepEqual(planPorts([...bindings].reverse(), [8080, 8082, 9000]).map, map);
  assert.deepEqual(planPorts([{ hostPort: 65535, containerPort: 1 }], [65535]).exhausted.length, 1, 'never past 65535');
  assert.deepEqual(planPorts([], [1, 2]), { map: [], exhausted: [] });
});

test('static sites skip Docker and Compose checks', () => {
  const result = evaluateMove(facts(f => { f.site.kind = 'static'; f.site.ports = []; f.target.dockerVersion = null; f.target.composeVersion = null; f.target.architecture = 'aarch64'; }));
  assert.equal(result.canStart, true);
  assert.equal(only(result, 'docker').length, 0); assert.equal(only(result, 'compose').length, 0);
});

test('downtime estimate is honest and explained', () => {
  assert.equal(estimateDowntime(facts()), 35);
  assert.equal(estimateDowntime(facts(f => { f.target.transferBytesPerSecond = 100 * 1024 * 1024; })), 56);
  assert.equal(estimateDowntime(facts(f => { f.site.timings = {}; })), null);
  const unknown = evaluateMove(facts(f => { f.site.timings = undefined; }));
  assert.equal(unknown.canStart, true); assert.match(only(unknown, 'downtime')[0].text, /cannot estimate the downtime yet/);
  assert.equal(unknown.sentence, 'Shop is ready to move to new-srv. It stays online while the copy is tested.');
  assert.equal(describeDuration(12), 'about 10 seconds'); assert.equal(describeDuration(240), 'about 4 minutes'); assert.equal(describeDuration(7200), 'about 2 hours');
});

test('preflightHash binds the reviewed checks, port map and options', () => {
  const base = evaluateMove(facts()), hash = preflightHash(base, { dnsMode: 'cloudflare' });
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(preflightHash(evaluateMove(facts()), { dnsMode: 'cloudflare' }), hash, 'deterministic');
  assert.notEqual(preflightHash(base, { dnsMode: 'manual' }), hash);
  assert.notEqual(preflightHash(evaluateMove(facts(f => { f.target.usedPorts.push(8082); })), { dnsMode: 'cloudflare' }), hash);
});
