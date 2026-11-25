// The emergency kit cryptography (docs/emergency-kit.md): SLIP-0039 against its official vectors (valid and invalid), the
// RFC 7748 X25519 vectors, fixed envelope vectors (fixed ephemeral key and nonce, here only), the property that every
// K-subset rebuilds the key and no (K-1)-subset matches its digest, and the one-file offline tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, createDecipheriv, hkdfSync } from 'node:crypto';
import { WORDS } from '../src/emergency/wordlist.js';
import { combineMnemonics, generateMnemonics, decodeMnemonic, interpolate, decrypt, MnemonicError } from '../src/emergency/slip39.js';
import { seal, open, packKit, unpackKit, readEnvelopeHeader, publicKeyDigest, publicKeyOf, generateKeyPair, x25519, EnvelopeError } from '../src/emergency/envelope.js';
import { buildEmergencyTool } from '../src/emergency/bundle.js';

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const hex = value => Buffer.from(value, 'hex');
const subsets = (items, size) => size === 0 ? [[]] : items.flatMap((item, index) => subsets(items.slice(index + 1), size - 1).map(rest => [item, ...rest]));

test('SLIP-0039: every official vector combines to its master secret or is refused', async () => {
  const vectors = await fixture('slip39-vectors.json');
  assert.equal(vectors.length, 45);
  for (const [description, mnemonics, secret] of vectors) {
    if (secret) assert.equal(combineMnemonics(mnemonics, 'TREZOR').toString('hex'), secret, description);
    else assert.throws(() => combineMnemonics(mnemonics, 'TREZOR'), MnemonicError, description);
  }
});

test('SLIP-0039: the word list is the official one, and a 256-bit secret gives 33-word parts sharing their first two words', () => {
  assert.equal(createHash('sha256').update(WORDS.join('\n') + '\n').digest('hex'), 'bcc4555340332d169718aed8bf31dd9d5248cb7da6e5d355140ef4f1e601eec3');
  const { privateKey } = generateKeyPair(), { identifier, mnemonics } = generateMnemonics({ secret: privateKey, threshold: 3, count: 5 });
  assert.equal(mnemonics.length, 5);
  for (const [index, mnemonic] of mnemonics.entries()) {
    assert.equal(mnemonic.split(' ').length, 33);
    assert.deepEqual(mnemonic.split(' ').slice(0, 2), mnemonics[0].split(' ').slice(0, 2));
    assert.deepEqual({ ...decodeMnemonic(mnemonic), value: null }, { identifier, extendable: true, exponent: 1, groupIndex: 0, groupThreshold: 1, groupCount: 1, memberIndex: index, memberThreshold: 3, value: null });
  }
  for (const [threshold, count] of [[1, 3], [4, 3], [2, 17], [0, 2]]) assert.throws(() => generateMnemonics({ secret: privateKey, threshold, count }), MnemonicError);
  assert.throws(() => generateMnemonics({ secret: Buffer.alloc(15), threshold: 2, count: 3 }), MnemonicError);
});

test('property: every K-subset of N rebuilds the key, and no (K-1)-subset matches its digest', () => {
  for (const [threshold, count] of [[2, 2], [2, 3], [3, 5], [4, 6], [5, 5]]) {
    const { privateKey, publicKey } = generateKeyPair(), digest = publicKeyDigest(publicKey);
    const { mnemonics } = generateMnemonics({ secret: privateKey, threshold, count });
    for (const subset of subsets(mnemonics, threshold)) {
      const joined = combineMnemonics([...subset].reverse());
      assert.ok(joined.equals(privateKey), `${threshold}-of-${count}`); assert.equal(publicKeyDigest(publicKeyOf(joined)), digest);
    }
    for (const subset of subsets(mnemonics, threshold - 1)) {
      assert.throws(() => combineMnemonics(subset), MnemonicError, 'fewer than K parts are refused');
      // Interpolating the K-1 points at the secret index anyway gives some other key.
      const shares = subset.map(decodeMnemonic), [first] = shares;
      const guess = decrypt(interpolate(shares.map(share => ({ x: share.memberIndex, value: share.value })), 255), '', first.exponent, first.identifier, first.extendable);
      assert.notEqual(publicKeyDigest(publicKeyOf(guess)), digest);
    }
  }
});

test('SLIP-0039: a typo, swapped words, a repeated part or a part of another split is refused', () => {
  const { privateKey } = generateKeyPair(), { mnemonics } = generateMnemonics({ secret: privateKey, threshold: 2, count: 3 });
  const words = mnemonics[0].split(' ');
  const typo = [...words]; typo[10] = WORDS[(WORDS.indexOf(typo[10]) + 1) % 1024];
  const swapped = [...words]; [swapped[5], swapped[6]] = [swapped[6], swapped[5]];
  assert.throws(() => decodeMnemonic(typo.join(' ')), /checksum/);
  if (swapped[5] !== swapped[6]) assert.throws(() => decodeMnemonic(swapped.join(' ')), /checksum/);
  assert.throws(() => decodeMnemonic(words.slice(0, 32).join(' ')), MnemonicError);
  assert.throws(() => decodeMnemonic([...words.slice(0, 32), 'notaword'].join(' ')), /word list/);
  assert.throws(() => combineMnemonics([mnemonics[0], mnemonics[0]]), /twice/);
  const other = generateMnemonics({ secret: privateKey, threshold: 2, count: 3, identifier: (decodeMnemonic(mnemonics[0]).identifier + 1) % 32768 }).mnemonics;
  assert.throws(() => combineMnemonics([mnemonics[0], other[1]]), /same split/);
  assert.ok(combineMnemonics([`  ${mnemonics[1].toUpperCase()}  `, mnemonics[2]]).equals(privateKey), 'case and spacing do not matter');
});

test('X25519: the RFC 7748 function, iteration and Diffie-Hellman vectors', async () => {
  const vectors = await fixture('rfc7748-x25519.json');
  for (const vector of vectors.functionVectors) assert.equal(x25519(hex(vector.scalar), hex(vector.u)).toString('hex'), vector.output);
  let k = hex(vectors.iterated.start), u = hex(vectors.iterated.start);
  for (let round = 1; round <= 1000; round++) { [k, u] = [x25519(k, u), k]; if (round === 1) assert.equal(k.toString('hex'), vectors.iterated.after1); }
  assert.equal(k.toString('hex'), vectors.iterated.after1000);
  const dh = vectors.diffieHellman;
  assert.equal(publicKeyOf(hex(dh.alicePrivate)).toString('hex'), dh.alicePublic); assert.equal(publicKeyOf(hex(dh.bobPrivate)).toString('hex'), dh.bobPublic);
  assert.equal(x25519(hex(dh.alicePrivate), hex(dh.bobPublic)).toString('hex'), dh.shared); assert.equal(x25519(hex(dh.bobPrivate), hex(dh.alicePublic)).toString('hex'), dh.shared);
});

test('envelope: fixed vector, built from the RFC 7748 keys with a fixed nonce, and checked by an independent decryption', async () => {
  const dh = (await fixture('rfc7748-x25519.json')).diffieHellman, payload = Buffer.from('DockNest emergency kit test vector');
  const sealed = seal(payload, { publicKey: hex(dh.bobPublic), createdAt: '2026-11-19T00:00:00.000Z', release: '3.0.0', ephemeralPrivateKey: hex(dh.alicePrivate), nonce: Buffer.alloc(12, 1) });
  assert.equal(sealed.toString('hex'), '444b453100d47b22666f726d6174223a312c22646967657374223a2237366138376165616538316436353839353965376234623930323165313761653535363037633366633634646162336430383466386166623262643934653238222c22657068656d6572616c5075626c69634b6579223a226853447743596b777031523069333363744437335767325f4f67306d4f427230363653706a717162546d6f222c22637265617465644174223a22323032362d31312d31395430303a30303a30302e3030305a222c2272656c65617365223a22332e302e30227d0101010101010101010101016370ecd77aaa21a1eed48615ff3b8f2937fc4f21558aa90e707f961d4e0e5208565a344db9ee5d270a72a2b2e88ab7eace3e');
  const header = readEnvelopeHeader(sealed);
  assert.deepEqual(header, { format: 1, digest: createHash('sha256').update('docknest emergency v1').update(hex(dh.bobPublic)).digest('hex'), ephemeralPublicKey: hex(dh.alicePublic).toString('base64url'), createdAt: '2026-11-19T00:00:00.000Z', release: '3.0.0' });
  // Independently: key = HKDF-SHA256(RFC shared secret, ephemeral public || recipient public, info), AAD = everything before the ciphertext.
  const key = Buffer.from(hkdfSync('sha256', hex(dh.shared), Buffer.concat([hex(dh.alicePublic), hex(dh.bobPublic)]), 'docknest emergency kit v1', 32));
  const end = 6 + sealed.readUInt16BE(4), decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(end, end + 12));
  decipher.setAAD(sealed.subarray(0, end + 12)); decipher.setAuthTag(sealed.subarray(-16));
  assert.deepEqual(Buffer.concat([decipher.update(sealed.subarray(end + 12, -16)), decipher.final()]), payload);
  assert.deepEqual(open(sealed, hex(dh.bobPrivate)), payload);
});

test('envelope: the digest is checked before any decryption, and any change to the header or body is refused', () => {
  const recipient = generateKeyPair(), stranger = generateKeyPair(), payload = packKit({ kit: Buffer.from('DKN1 kit bytes'), passphrase: 'a recovery passphrase of 24+ chars' });
  const sealed = seal(payload, { publicKey: recipient.publicKey, release: '3.0.0' });
  assert.deepEqual(unpackKit(open(sealed, recipient.privateKey)), { passphrase: 'a recovery passphrase of 24+ chars', kit: Buffer.from('DKN1 kit bytes') });
  const damaged = Buffer.from(sealed); damaged[damaged.length - 20] ^= 1;
  assert.throws(() => open(damaged, stranger.privateKey), /do not open this emergency kit/, 'a wrong key is refused by the digest, before the damaged body is touched');
  assert.throws(() => open(damaged, recipient.privateKey), /authentication/);
  const text = sealed.toString('latin1');
  assert.throws(() => open(Buffer.from(text.replace('"release":"3.0.0"', '"release":"2.0.0"'), 'latin1'), recipient.privateKey), /authentication/, 'the header is authenticated');
  assert.throws(() => readEnvelopeHeader(Buffer.from('DKN1' + text.slice(4), 'latin1')), EnvelopeError);
  assert.throws(() => seal(payload, { publicKey: Buffer.alloc(31), release: '3.0.0' }), EnvelopeError);
  assert.throws(() => unpackKit(Buffer.from('DKP1\0\0\0\0')), EnvelopeError);
  const again = seal(payload, { publicKey: recipient.publicKey, release: '3.0.0' });
  assert.notEqual(readEnvelopeHeader(again).ephemeralPublicKey, readEnvelopeHeader(sealed).ephemeralPublicKey, 'a fresh ephemeral key per kit');
});

test('offline tool: the one-file build imports only offline built-ins and opens the newest matching kit with K parts', async () => {
  const source = buildEmergencyTool(), imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
  assert.deepEqual(imports.sort(), ['node:crypto', 'node:fs/promises', 'node:path', 'node:readline']);
  assert.doesNotMatch(source, /\bimport\(|require\(|fetch\(|node:(?:https?|net|dns|tls|child_process|worker_threads)/);
  const directory = await mkdtemp(join(tmpdir(), 'docknest-emergency-tool-'));
  try {
    const tool = join(directory, 'emergency-open.js'); await writeFile(tool, source);
    const { privateKey, publicKey } = generateKeyPair(), { mnemonics } = generateMnemonics({ secret: privateKey, threshold: 2, count: 3 });
    const passphrase = 'correct horse battery staple, offline', kits = join(directory, 'kits');
    await mkdir(kits);
    await writeFile(join(kits, 'old.dkem'), seal(packKit({ kit: Buffer.from('DKN1 older kit'), passphrase }), { publicKey, release: '2.99.0', createdAt: '2026-11-01T03:00:00.000Z' }));
    await writeFile(join(kits, 'new.dkem'), seal(packKit({ kit: Buffer.from('DKN1 newest kit'), passphrase }), { publicKey, release: '3.0.0', createdAt: '2026-11-18T03:00:00.000Z' }));
    await writeFile(join(kits, 'other.dkem'), seal(packKit({ kit: Buffer.from('DKN1 other key'), passphrase }), { publicKey: generateKeyPair().publicKey, release: '3.0.0', createdAt: '2026-11-19T03:00:00.000Z' }));
    await writeFile(join(kits, 'notes.dkem'), 'not a kit');
    const run = (args, input = '') => spawnSync(process.execPath, [tool, ...args], { cwd: directory, input, encoding: 'utf8' });
    const listed = run(['list', kits]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split('\n').slice(1).map(line => line.trim().split(/\s+/).at(-1)), ['other.dkem', 'new.dkem', 'old.dkem'], 'newest first');
    const opened = run(['open', kits, join(directory, 'out')], `${mnemonics[2]}\n\n${mnemonics[0]}\n`);
    assert.equal(opened.status, 0, opened.stderr);
    assert.deepEqual(await readFile(join(directory, 'out', 'docknest-recovery.dkit')), Buffer.from('DKN1 newest kit'));
    assert.equal(await readFile(join(directory, 'out', 'recovery-passphrase.txt'), 'utf8'), passphrase);
    assert.deepEqual((await readdir(join(directory, 'out'))).sort(), ['docknest-recovery.dkit', 'recovery-passphrase.txt']);
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'out', 'recovery-passphrase.txt'))).mode & 0o777, 0o600);
    // Single words are common English and may appear in the tool's own sentences; no run of three part words may.
    const output = (opened.stdout + opened.stderr).toLowerCase().split(/\s+/).join(' ');
    for (const words of mnemonics.map(mnemonic => mnemonic.split(' '))) for (let index = 0; index + 3 <= words.length; index++) assert.ok(!output.includes(words.slice(index, index + 3).join(' ')), 'no part words are printed');
    assert.ok(!(opened.stdout + opened.stderr).includes(privateKey.toString('hex')) && !(opened.stdout + opened.stderr).includes(privateKey.toString('base64')));
    const again = run(['open', kits, join(directory, 'out')], `${mnemonics[0]}\n${mnemonics[1]}\n`);
    assert.match(again.stderr, /already exists/);
    const short = run(['open', kits, join(directory, 'short')], `${mnemonics[0]}\n`);
    assert.equal(short.status, 1); assert.match(short.stderr, /Only 1 of the 2 parts/);
    const foreign = generateMnemonics({ secret: generateKeyPair().privateKey, threshold: 2, count: 2 }).mnemonics;
    const unmatched = run(['open', join(kits, 'new.dkem'), join(directory, 'none')], foreign.join('\n'));
    assert.equal(unmatched.status, 1); assert.match(unmatched.stderr, /none of these kits was made for them/);
    const typo = run(['open', kits, join(directory, 'typo')], mnemonics[0].replace(/^\S+/, 'zero') + '\n');
    assert.equal(typo.status, 1); assert.match(typo.stderr, /Part 1 has a typo/);
    assert.match(run([]).stderr, /Usage/);
    // The repository script behaves the same.
    const repo = spawnSync(process.execPath, [new URL('../scripts/emergency-open.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'list', kits], { encoding: 'utf8' });
    assert.equal(repo.stdout, listed.stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
