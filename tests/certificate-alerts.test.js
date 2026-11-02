// Certificate alerts (docs/alerts.md, "Certificates"): facts that ride on existing helper answers are stored per site and
// become "certificate.expiring" / "certificate.renewal_failed" events, once per certificate, stage and expiry date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'docknest-certs-'));
Object.assign(process.env, { DATA_DIR: directory, BACKUP_DIR: join(directory, 'backups'), BACKUP_STORAGE: 'local', MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), SECURE_COOKIES: 'false', NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:3000' });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
await mkdir(process.env.BACKUP_DIR, { recursive: true });
const { db } = await import('../src/db.js');
const store = await import('../src/alerts/store.js');
const events = await import('../src/alerts/events.js');
const certs = await import('../src/alerts/certificates.js');
const { migrations } = await import('../src/migrations.js');

const DAY = 86400_000, NOW = Date.UTC(2026, 10, 2, 12), at = () => new Date(NOW - DAY).toISOString();
const seconds = ms => Math.floor(ms / 1000);
const TOKEN = '123456789:' + 'AbCdEf_-12'.repeat(4).slice(0, 35);
const server = name => { const id = randomUUID(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, name, '203.0.113.7', 22, 'root', 'fixture', '0'.repeat(64), at()); return id; };
const site = (serverId, name, domains = []) => { const id = randomUUID(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(id, serverId, name, JSON.stringify({ domains }), at()); return id; };
const credential = () => store.listCredentials().find(item => item.kind === 'telegram') ?? store.createCredential({ kind: 'telegram', name: 'Bot', config: { token: TOKEN } }, 'test');
const channel = (chatId = '-1001234567890', name = 'Phone') => store.createChannel({ kind: 'telegram', name, credentialId: credential().id, config: { chatId } }, 'test');
const CERT_EVENTS = ['certificate.expiring', 'certificate.renewal_failed'];
const reset = () => { db.exec("DELETE FROM alert_outbox;DELETE FROM alert_lines;DELETE FROM alert_nodes;DELETE FROM connections;DELETE FROM site_certificates;DELETE FROM settings WHERE key='alerts_certificate_days';"); };
const outbox = () => db.prepare('SELECT event,dedupe_key,message,payload FROM alert_outbox ORDER BY created_at,rowid').all();
const row = siteId => db.prepare('SELECT * FROM site_certificates WHERE site_id=?').get(siteId);
const certbot = (name, notAfterMs, domains, extra = {}) => ({ source: 'certbot', name, notAfter: seconds(notAfterMs), domains, serial: extra.serial ?? name.replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 8) + 'AB', renews: true, ...extra });
const tls = (name, notAfterMs, domains = [name], extra = {}) => ({ source: 'tls', name, notAfter: seconds(notAfterMs), domains, ...extra });

test('migration 13 adds only the site_certificates table and is compatible', () => {
  const migration = migrations.find(item => item.name === 'site-certificates');
  assert.equal(migration.version, 13); assert.equal(migration.compatible, true);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_certificates'").get());
});

test('a certbot certificate inside the warning days alerts once, names the site and days, and never repeats', () => {
  reset(); const ch = channel(); const srv = server('Web-1'), shop = site(srv, 'Shop', ['shop.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'site', sourceId: shop, events: CERT_EVENTS }, 'test');
  assert.equal(certs.recordCertificates({ serverId: srv }, [certbot('shop.example.test', NOW + 10 * DAY + 3600_000, ['shop.example.test'])], { at: NOW }), 1);
  const [item] = outbox(); const message = JSON.parse(item.payload);
  assert.equal(item.event, 'certificate.expiring'); assert.match(item.message, /^Certificate expires soon: Shop in 10 days\./);
  assert.equal(message.title, 'Certificate expires soon'); assert.equal(message.site, 'Shop'); assert.equal(message.server, 'Web-1');
  assert.match(message.reason, /expires in 10 days/);
  assert.equal(row(shop).source, 'certbot'); assert.equal(row(shop).alerted_stage, 'expiring');
  // The same facts again (next backup, next tick, a day later): nothing new.
  assert.equal(certs.recordCertificates({ serverId: srv }, [certbot('shop.example.test', NOW + 10 * DAY + 3600_000, ['shop.example.test'])], { at: NOW + DAY }), 0);
  assert.equal(certs.detectCertificates(NOW + 2 * DAY), 0);
  assert.equal(outbox().length, 1);
});

test('a certificate outside the warning days is stored without an alert, and alerts once time brings it inside', () => {
  reset(); const ch = channel(); const srv = server('Web-2'), blog = site(srv, 'Blog', ['blog.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'server', sourceId: srv, events: CERT_EVENTS }, 'test');
  assert.equal(certs.recordCertificates({ serverId: srv }, [certbot('blog', NOW + 40 * DAY, ['blog.example.test'])], { at: NOW }), 0);
  assert.ok(row(blog)); assert.equal(row(blog).alerted_stage, null);
  // The worker's existing alert tick judges the stored facts; no server is contacted.
  assert.equal(certs.detectCertificates(NOW + 20 * DAY), 0);
  assert.equal(certs.detectCertificates(NOW + 27 * DAY), 1);
  assert.match(outbox()[0].message, /Blog in 13 days/);
});

test('a non-certbot certificate seen by the site\'s own HTTPS probe alerts the same way', () => {
  reset(); const ch = channel(); const srv = server('Web-3'), app = site(srv, 'App', ['app.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'docknest', events: CERT_EVENTS }, 'test');
  assert.equal(certs.recordCertificates({ serverId: srv, siteId: app }, [tls('app.example.test', NOW + 5 * DAY, ['app.example.test'], { serial: 'C0FFEE' })], { at: NOW }), 1);
  assert.equal(row(app).source, 'tls'); assert.equal(row(app).serial, 'C0FFEE');
  // A probe fact from another site's backup never lands on this site.
  const other = site(srv, 'Other', ['other.example.test']);
  certs.recordCertificates({ serverId: srv, siteId: other }, [tls('app.example.test', NOW + 5 * DAY)], { at: NOW });
  assert.equal(row(other).name, 'app.example.test', 'the probe ran for Other, so it is Other\'s own certificate');
  assert.equal(certs.recordCertificates({ serverId: srv }, [tls('app.example.test', NOW + 5 * DAY)], { at: NOW }), 0, 'probe facts without a site scope are ignored');
});

test('a wildcard certificate covering several sites tells each channel once, and covers one label only', () => {
  reset(); const ch = channel(); const srv = server('Web-4');
  const a = site(srv, 'Alpha', ['a.example.test']), b = site(srv, 'Beta', ['b.example.test']), apex = site(srv, 'Apex', ['example.test']), deep = site(srv, 'Deep', ['x.y.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'docknest', events: CERT_EVENTS }, 'test');
  const wildcard = certbot('example.test', NOW + 7 * DAY, ['*.example.test'], { serial: 'ABC123' });
  assert.equal(certs.recordCertificates({ serverId: srv }, [wildcard], { at: NOW }), 1, 'one message for one certificate');
  assert.ok(row(a) && row(b)); assert.equal(row(apex), undefined); assert.equal(row(deep), undefined);
  assert.equal(row(a).alerted_stage, 'expiring'); assert.equal(row(b).alerted_stage, 'expiring');
  assert.equal(certs.covers('*.example.test', 'a.example.test'), true);
  assert.equal(certs.covers('*.example.test', 'example.test'), false);
  assert.equal(certs.covers('*.example.test', 'a.b.example.test'), false);
  assert.equal(certs.covers('*.example.test', 'badexample.test'), false);
  // A second channel that only follows Beta still hears about it once.
  const second = channel('-1009876543210', 'Second');
  store.createRule({ channelId: second.id, sourceKind: 'site', sourceId: b, events: CERT_EVENTS }, 'test');
  db.prepare("UPDATE site_certificates SET alerted_stage=NULL,alerted_not_after=NULL").run();
  certs.detectCertificates(NOW);
  assert.equal(outbox().length, 2, 'the first channel is not told twice; the second channel is told once');
});

test('a site with no TLS gets no row, no alert and no error, and a site that dropped TLS loses its row', () => {
  reset(); const ch = channel(); const srv = server('Web-5'), plain = site(srv, 'Plain', ['plain.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'docknest', events: CERT_EVENTS }, 'test');
  assert.equal(certs.recordCertificates({ serverId: srv, siteId: plain }, [], { at: NOW }), 0);
  assert.equal(certs.recordCertificates({ serverId: srv, siteId: plain }, undefined, { at: NOW }), 0, 'an answer without the field changes nothing');
  assert.equal(row(plain), undefined);
  certs.recordCertificates({ serverId: srv, siteId: plain }, [tls('plain.example.test', NOW + 60 * DAY)], { at: NOW });
  assert.ok(row(plain));
  // One backup that saw no certificate (the site was down) keeps the facts; a week without any drops them.
  certs.recordCertificates({ serverId: srv, siteId: plain }, [], { at: NOW + DAY });
  assert.ok(row(plain));
  certs.recordCertificates({ serverId: srv, siteId: plain }, [], { at: NOW + 8 * DAY });
  assert.equal(row(plain), undefined);
  // Junk facts are dropped, never stored.
  assert.equal(certs.recordCertificates({ serverId: srv, siteId: plain }, [{ source: 'tls', name: '<script>', notAfter: 1 }, { source: 'ftp', name: 'x' }, null, 'text'], { at: NOW }), 0);
  assert.equal(row(plain), undefined); assert.equal(outbox().length, 0);
});

test('an expired certificate alerts as expired, and an expiring alert is followed by one expired alert', () => {
  reset(); const ch = channel(); const srv = server('Web-6'), old = site(srv, 'Old', ['old.example.test']), late = site(srv, 'Late', ['late.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'docknest', events: CERT_EVENTS }, 'test');
  // The probe could only learn that the certificate has expired (the handshake was refused).
  assert.equal(certs.recordCertificates({ serverId: srv, siteId: old }, [{ source: 'tls', name: 'old.example.test', expired: true }], { at: NOW }), 1);
  const [first] = outbox(); assert.equal(JSON.parse(first.payload).title, 'Certificate expired'); assert.match(first.message, /^Certificate expired: Old\./);
  certs.recordCertificates({ serverId: srv }, [certbot('late', NOW + 2 * DAY, ['late.example.test'])], { at: NOW });
  assert.equal(certs.detectCertificates(NOW + DAY), 0);
  assert.equal(certs.detectCertificates(NOW + 3 * DAY), 1, 'crossing into expired is a new stage');
  assert.equal(certs.detectCertificates(NOW + 4 * DAY), 0);
  assert.deepEqual(outbox().map(item => JSON.parse(item.payload).title), ['Certificate expired', 'Certificate expires soon', 'Certificate expired']);
});

test('renewal failed alerts once; a later success and a new expiry reset it, and the new certificate can alert again', () => {
  reset(); const ch = channel(); const srv = server('Web-7'), shop = site(srv, 'Shop', ['shop.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'docknest', events: CERT_EVENTS }, 'test');
  const failing = certbot('shop', NOW + 25 * DAY, ['shop.example.test'], { renewal: 'failed', serial: 'AA01' });
  assert.equal(certs.recordCertificates({ serverId: srv }, [failing], { at: NOW }), 1);
  assert.equal(outbox()[0].event, 'certificate.renewal_failed'); assert.match(outbox()[0].message, /^Certificate renewal failed: Shop on Web-7\./);
  assert.equal(certs.recordCertificates({ serverId: srv }, [failing], { at: NOW + DAY }), 0, 'the same failure is not repeated');
  // certbot renewed it: a new certificate with a later expiry.
  certs.recordCertificates({ serverId: srv }, [certbot('shop', NOW + 90 * DAY, ['shop.example.test'], { renewal: 'ok', serial: 'AA02' })], { at: NOW + 2 * DAY });
  assert.equal(row(shop).renewal, 'ok'); assert.equal(row(shop).renewal_alerted, 0);
  // The renewed certificate fails to renew later, and later still nears expiry: both alert again.
  certs.recordCertificates({ serverId: srv }, [certbot('shop', NOW + 90 * DAY, ['shop.example.test'], { renewal: 'failed', serial: 'AA02' })], { at: NOW + 70 * DAY });
  assert.equal(certs.detectCertificates(NOW + 80 * DAY), 1);
  assert.deepEqual(outbox().map(item => item.event), ['certificate.renewal_failed', 'certificate.renewal_failed', 'certificate.expiring']);
  // A later expiry with no renewal outcome in the logs also counts as renewed.
  certs.recordCertificates({ serverId: srv }, [certbot('shop', NOW + 180 * DAY, ['shop.example.test'], { serial: 'AA03' })], { at: NOW + 85 * DAY });
  assert.equal(row(shop).renewal, 'ok');
});

test('a newer certbot file replaces an older probe fact, an older one never does, and a renewal re-alerts', () => {
  reset(); const ch = channel(); const srv = server('Web-8'), shop = site(srv, 'Shop', ['shop.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'docknest', events: CERT_EVENTS }, 'test');
  certs.recordCertificates({ serverId: srv, siteId: shop }, [tls('shop.example.test', NOW + 10 * DAY, ['shop.example.test'], { serial: 'B1' })], { at: NOW });
  certs.recordCertificates({ serverId: srv }, [certbot('shop', NOW + 5 * DAY, ['shop.example.test'], { serial: 'B0' })], { at: NOW });
  assert.equal(row(shop).serial, 'B1', 'what visitors see wins over an older file');
  certs.recordCertificates({ serverId: srv }, [certbot('shop', NOW + 12 * DAY, ['shop.example.test'], { serial: 'B2' })], { at: NOW });
  assert.equal(row(shop).serial, 'B2');
  assert.equal(outbox().length, 2, 'the renewed certificate (new expiry) is a new crossing');
});

test('changing the warning days re-judges the stored facts at once: longer can alert, shorter never repeats', async () => {
  reset(); const ch = channel(); const srv = server('Web-9'), shop = site(srv, 'Shop', ['shop.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'docknest', events: CERT_EVENTS }, 'test');
  assert.equal(certs.certificateDays(), 14);
  certs.recordCertificates({ serverId: srv }, [certbot('shop', Date.now() + 20 * DAY, ['shop.example.test'])]);
  assert.equal(outbox().length, 0);
  assert.throws(() => certs.setCertificateDays(30, 'op', 'operator'), /administrator/);
  assert.throws(() => certs.setCertificateDays(0, 'admin', 'admin'), /1 to 90/);
  assert.throws(() => certs.setCertificateDays(91, 'admin', 'admin'), /1 to 90/);
  assert.deepEqual(certs.setCertificateDays(30, 'admin', 'admin'), { certificateDays: 30 });
  assert.equal(outbox().length, 1, 'now inside 30 days');
  certs.setCertificateDays(7, 'admin', 'admin'); certs.setCertificateDays(30, 'admin', 'admin');
  assert.equal(outbox().length, 1, 'back and forth does not alert twice for the same expiry');
  assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='alerts.certificate_days'").get());
  void shop;
});

test('no line wants certificate events: nothing is queued and a line added later still hears about it', () => {
  reset(); const ch = channel(); const srv = server('Web-10'), shop = site(srv, 'Shop', ['shop.example.test']);
  store.createRule({ channelId: ch.id, sourceKind: 'docknest', events: ['backup.failed'] }, 'test');
  assert.equal(certs.recordCertificates({ serverId: srv }, [certbot('shop', NOW + 3 * DAY, ['shop.example.test'])], { at: NOW }), 0);
  assert.equal(row(shop).alerted_stage, null);
  store.createRule({ channelId: ch.id, sourceKind: 'site', sourceId: shop, events: ['certificate.expiring'] }, 'test');
  assert.equal(certs.detectCertificates(NOW + 3600_000), 1);
});

test('takeCertificates records the facts and removes them from the answer', () => {
  reset(); const srv = server('Web-11'), shop = site(srv, 'Shop', ['shop.example.test']);
  const answer = certs.takeCertificates({ serverId: srv }, { helperVersion: 1, freeBytes: 5, certificates: [certbot('shop', NOW + 60 * DAY, ['shop.example.test'])] }, { at: NOW });
  assert.deepEqual(answer, { helperVersion: 1, freeBytes: 5 });
  assert.ok(row(shop));
  assert.deepEqual(certs.takeCertificates({ serverId: srv }, { helperVersion: 1 }), { helperVersion: 1 });
  const list = [{ id: 'c' }]; assert.equal(certs.takeCertificates({ serverId: srv }, list), list);
});

test('the catalogue knows both events and their messages carry no host, path or log text', () => {
  for (const type of CERT_EVENTS) assert.ok(events.EVENTS.includes(type));
  const renewal = events.templateFor({ type: 'certificate.renewal_failed', siteName: 'Shop', serverName: 'Web', at: new Date(NOW).toISOString() }, { origin: 'http://127.0.0.1:3000' });
  assert.equal(renewal.title, 'Certificate renewal failed'); assert.equal(renewal.site, 'Shop'); assert.equal(renewal.server, 'Web'); assert.equal(renewal.time, '');
  assert.match(events.messageFor({ type: 'certificate.expiring', siteName: 'Shop', daysLeft: 1 }), /in 1 day\./);
  assert.match(events.messageFor({ type: 'certificate.expiring', siteName: 'Shop', daysLeft: 0 }), /in less than a day\./);
});
