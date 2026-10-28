import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compareDotted, branchOf } from '../src/radar/version.js';
import { loadBundledFeed, parseFeed, verifySignedFeed, validateFeed, MAX_FEED_BYTES } from '../src/radar/feed.js';
import { matchComponent } from '../src/radar/match.js';
import { describeFinding } from '../src/radar/describe.js';

const bundled = loadBundledFeed(fileURLToPath(new URL('../src/radar/advisories.json', import.meta.url)));
const today = new Date('2026-10-28T00:00:00Z');
const m = (c) => matchComponent(c, bundled, { today });
const byId = (id) => bundled.advisories.find((a) => a.id === id);

test('compareDotted', () => {
  assert.equal(compareDotted('8.3.11', '8.3.12'), -1);
  assert.equal(compareDotted('v20.12.1', '20.12.1'), 0);
  assert.equal(compareDotted('8.3.12-1~deb12u1', '8.3.12'), 1);
  assert.equal(compareDotted('8.10.0', '8.9.9'), 1);
  assert.equal(compareDotted('garbage', '1.2.3'), null);
  assert.equal(compareDotted('8.3.33; rm -rf /', '1.2.3'), null);
  assert.equal(branchOf('php', '8.3.33'), '8.3');
  assert.equal(branchOf('node', 'v24.11.0'), '24');
  assert.equal(branchOf('php', 'x'), null);
});

test('bundled feed: only sourced advisories with real dates and references', () => {
  assert.equal(bundled.serial, 1);
  for (const advisory of bundled.advisories) {
    assert.ok(advisory.cve.length >= 1, advisory.id);
    assert.ok(advisory.refs.length >= 1 && advisory.refs.every((ref) => ref.startsWith('https://nvd.nist.gov/vuln/detail/CVE-')), advisory.id);
    assert.ok(Date.parse(advisory.publishedAt) < Date.parse('2026-10-28'), 'published before this release');
  }
  assert.deepEqual(bundled.eol.filter((e) => e.product === 'php' && e.cycle === '8.1'), [{ product: 'php', cycle: '8.1', eol: '2025-12-31' }]);
  assert.deepEqual(bundled.eol.filter((e) => e.product === 'node' && e.cycle === '20'), [{ product: 'node', cycle: '20', eol: '2026-04-30' }]);
});

test('PHP matching: runtime versions on supported branches', () => {
  const f = m({ product: 'php', version: '8.3.11', source: 'runtime' });
  assert.deepEqual(f.map((x) => [x.advisoryId, x.kind, x.severity, x.fixedIn]), [['DN-2024-0002', 'vulnerable', 'medium', '8.3.12'], ['DN-2025-0001', 'vulnerable', 'medium', '8.3.23']]);
  assert.deepEqual(m({ product: 'php', version: '8.3.23', source: 'runtime' }), []);
  assert.deepEqual(m({ product: 'php', version: '8.3.23-1~deb12u1', source: 'runtime' }), []);
  assert.deepEqual(m({ product: 'php', version: '8.4.1', source: 'runtime' }).map((x) => x.advisoryId), ['DN-2025-0001'], '8.4 was never affected by DN-2024-0002');
  assert.deepEqual(m({ product: 'php', version: '8.5.0', source: 'runtime' }), []);
});

test('Node matching and end of life', () => {
  const f = m({ product: 'node', version: '20.11.0', source: 'runtime' });
  assert.deepEqual(f.map((x) => [x.kind, x.severity]), [['vulnerable', 'high'], ['eol', 'medium']]);
  assert.deepEqual(m({ product: 'node', version: '22.11.0', source: 'runtime' }), [], '22 is newer than every fixed branch');
  const early = matchComponent({ product: 'node', version: '20.12.1', source: 'runtime' }, bundled, { today: new Date('2026-01-01') });
  assert.deepEqual(early, [], 'patched and not yet end of life');
  assert.ok(m({ product: 'php', version: '8.1.34', source: 'runtime' }).some((x) => x.kind === 'eol'));
  assert.ok(!m({ product: 'php', version: '8.2.30', source: 'runtime' }).some((x) => x.kind === 'eol'), '8.2 ends on 2026-12-31');
});

test('floating tag without a probe is never vulnerable: likely, severity capped, newer builds skipped', () => {
  const base = { product: 'node', version: '20', source: 'image-tag' };
  const old = m({ ...base, imageCreated: '2024-01-01T00:00:00Z' }).find((x) => x.advisoryId === 'DN-2024-0001');
  assert.deepEqual([old.kind, old.severity], ['likely', 'medium'], 'high is capped at medium');
  const undated = m(base).find((x) => x.advisoryId === 'DN-2024-0001');
  assert.equal(undated.kind, 'likely');
  assert.equal(m({ ...base, imageCreated: '2026-09-01T00:00:00Z' }).find((x) => x.advisoryId === 'DN-2024-0001'), undefined, 'built after the advisory');
  for (const f of [...m(base), ...m({ product: 'php', version: '8.3', source: 'image-tag' })]) assert.notEqual(f.kind, 'vulnerable');
  // A pinned full tag (php:8.3.11-apache) shows the patch level, so it can be vulnerable.
  assert.equal(m({ product: 'php', version: '8.3.11', source: 'image-tag' })[0].kind, 'vulnerable');
});

test('garbage probe output and unknown products', () => {
  const f = m({ product: 'php', version: 'Segmentation fault', source: 'runtime' });
  assert.ok(f.length && f.every((x) => x.kind === 'unknown' && x.severity !== 'critical' && x.severity !== 'high'));
  assert.deepEqual(m({ product: 'ruby', version: '3.2.0', source: 'runtime' }), []);
});

test('sanitising', () => {
  const raw = JSON.parse(JSON.stringify(bundled));
  raw.advisories[0].title = 'Evil\u0000\u001b[31m title\n' + 'x'.repeat(500);
  raw.advisories[0].refs = ['http://nvd.nist.gov/a', 'https://evil.example/a', 'https://github.com/x/y', 'javascript:alert(1)', 'https://nvd.nist.gov.evil.com/'];
  const v = validateFeed(raw);
  assert.ok(v.advisories[0].title.length <= 160);
  assert.doesNotMatch(v.advisories[0].title, /[\u0000-\u001f]/);
  assert.deepEqual(v.advisories[0].refs, ['https://github.com/x/y']);
  assert.throws(() => validateFeed({ ...raw, format: 2 }));
  assert.throws(() => parseFeed(Buffer.alloc(MAX_FEED_BYTES + 1)), { code: 'feed_too_large' });
});

test('signature, rollback, expiry (kept for the later signed refresh; unused by 2.12.0)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const bytes = Buffer.from(JSON.stringify(bundled));
  const sig = crypto.sign(null, bytes, privateKey).toString('base64');
  const opts = { bytes, signature: sig, publicKeys: [pub], now: today };
  assert.equal(verifySignedFeed(opts).serial, 1);
  assert.throws(() => verifySignedFeed({ ...opts, bytes: Buffer.concat([bytes, Buffer.from(' ')]) }), { code: 'bad_signature' });
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => verifySignedFeed({ ...opts, publicKeys: [other] }), { code: 'bad_signature' });
  assert.throws(() => verifySignedFeed({ ...opts, lastSerial: 1 }), { code: 'rollback' });
  assert.throws(() => verifySignedFeed({ ...opts, now: new Date('2028-01-01') }), { code: 'expired' });
  assert.throws(() => verifySignedFeed({ bytes, signature: sig, now: today }), { code: 'no_pinned_key' });
});

test('describe', () => {
  const [f] = m({ product: 'node', version: '20.11.0', source: 'runtime' });
  const d = describeFinding(f, { advisory: byId('DN-2024-0001'), siteName: 'shop.example', appName: 'api' });
  assert.equal(d.headline, 'shop.example runs Node.js 20.11.0, which has a significant flaw (Node.js HTTP/2 server crash).');
  assert.equal(d.advice, 'Update the api image to one with Node.js 20.12.1 or later. DockNest will not change anything for you.');
  assert.match(d.advanced, /CVE-2024-27983/);
  const eolF = m({ product: 'node', version: '20.1.0', source: 'runtime' }).find((x) => x.kind === 'eol');
  assert.equal(describeFinding(eolF, { siteName: 'app' }).headline, 'app runs Node.js 20.1.0, which no longer receives security fixes.');
  const likely = m({ product: 'node', version: '20', source: 'image-tag' }).find((x) => x.kind === 'likely');
  const l = describeFinding(likely, { advisory: byId('DN-2024-0001'), siteName: 'blog' });
  assert.match(l.headline, /^Possibly affected: blog may run a Node.js version/);
  assert.equal(l.advice, 'What to do: rebuild or pull the latest image to be sure. DockNest will not change anything for you.');
});
