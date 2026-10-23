import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compareDotted, branchOf } from '../src/radar/version.js';
import { loadBundledFeed, parseFeed, verifySignedFeed, validateFeed, MAX_FEED_BYTES } from '../src/radar/feed.js';
import { matchComponent } from '../src/radar/match.js';
import { describeFinding } from '../src/radar/describe.js';

const bundled = loadBundledFeed(fileURLToPath(new URL('../radar/advisories.json', import.meta.url)));
const today = new Date('2026-10-23T00:00:00Z');
const m = (c) => matchComponent(c, bundled, { today });

test('compareDotted', () => {
  assert.equal(compareDotted('8.3.33', '8.3.36'), -1);
  assert.equal(compareDotted('v22.23.4', '22.23.4'), 0);
  assert.equal(compareDotted('8.3.36-1~deb12u1', '8.3.36'), 1);
  assert.equal(compareDotted('8.10.0', '8.9.9'), 1);
  assert.equal(compareDotted('garbage', '1.2.3'), null);
  assert.equal(compareDotted('8.3.33; rm -rf /', '1.2.3'), null);
  assert.equal(branchOf('php', '8.3.33'), '8.3');
  assert.equal(branchOf('node', 'v24.22.0'), '24');
  assert.equal(branchOf('php', 'x'), null);
});

test('PHP matching', () => {
  const f = m({ product: 'php', version: '8.3.33', source: 'runtime' });
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].kind, f[0].severity, f[0].fixedIn], ['vulnerable', 'critical', '8.3.36']);
  assert.deepEqual(m({ product: 'php', version: '8.3.36', source: 'runtime' }), []);
  assert.deepEqual(m({ product: 'php', version: '8.3.36-1~deb12u1', source: 'runtime' }), []);
});

test('Node matching and EOL', () => {
  assert.equal(m({ product: 'node', version: '24.22.0', source: 'runtime' })[0].kind, 'vulnerable');
  assert.deepEqual(m({ product: 'node', version: '24.22.1', source: 'runtime' }), []);
  assert.ok(m({ product: 'node', version: '20.11.0', source: 'runtime' }).some((x) => x.kind === 'eol'));
  const early = matchComponent({ product: 'node', version: '20.11.0', source: 'runtime' }, bundled, { today: new Date('2026-01-01') });
  assert.ok(!early.some((x) => x.kind === 'eol'));
});

test('tag-only branch', () => {
  const base = { product: 'php', version: '8.3', source: 'image-tag' };
  assert.equal(m({ ...base, imageCreated: '2026-09-01T00:00:00Z' })[0].kind, 'likely');
  assert.equal(m({ ...base, imageCreated: '2026-10-22T00:00:00Z' })[0].kind, 'unknown');
  assert.equal(m(base)[0].kind, 'unknown');
});

test('garbage probe output', () => {
  const f = m({ product: 'php', version: 'Segmentation fault', source: 'runtime' });
  assert.deepEqual(f.map((x) => x.kind), ['unknown']);
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

test('signature, rollback, expiry', () => {
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
  const [f] = m({ product: 'php', version: '8.3.33', source: 'runtime' });
  const d = describeFinding(f, { advisory: bundled.advisories[0], siteName: 'mobix-il.com', appName: 'WordPress' });
  assert.equal(d.headline, 'mobix-il.com runs PHP 8.3.33, which has a serious flaw (PHP2Shell).');
  assert.equal(d.advice, 'Update the WordPress image to one with PHP 8.3.36 or later. DockNest will not change anything for you.');
  assert.match(d.advanced, /CVE-2026-109618/);
  const eolF = m({ product: 'node', version: '20.1.0', source: 'runtime' }).find((x) => x.kind === 'eol');
  assert.equal(describeFinding(eolF, { siteName: 'app' }).headline, 'app runs Node.js 20.1.0, which no longer receives security fixes.');
});
