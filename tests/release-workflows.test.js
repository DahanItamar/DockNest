import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { candidateTag } from '../scripts/release-validation.js';

const workflow = async name => (await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const sha = 'a'.repeat(40);

test('release.yml publishes final vX.Y.Z tags only, after Verify and a candidate validation of the same commit', async () => {
  const text = await workflow('release.yml');
  const jobs = text.slice(text.indexOf('\njobs:\n')), gateAt = jobs.indexOf('\n  gate:\n'), publishAt = jobs.indexOf('\n  publish:\n');
  assert.ok(gateAt >= 0 && publishAt > gateAt, 'a gate job comes before the publish job');
  assert.equal([...jobs.matchAll(/^ {2}[\w-]+:$/gm)].length, 2, 'exactly two jobs');
  const gate = jobs.slice(gateAt, publishAt), publish = jobs.slice(publishAt);

  // The gate is read-only; only the publish job can write, and it runs only after the gate succeeded.
  assert.match(gate, /\n {4}permissions:\n {6}contents: read[^\n]*\n {6}actions: read[^\n]*\n {4}steps:/);
  assert.doesNotMatch(gate, /: write/);
  assert.match(publish, /\n {4}needs: gate\n/);
  assert.match(publish, /\n {4}permissions:\n {6}contents: write[^\n]*\n {6}packages: write[^\n]*\n {6}id-token: write[^\n]*\n {4}steps:/);
  for (const job of [gate, publish]) {
    const checkouts = job.split('uses: actions/checkout@').slice(1);
    assert.equal(checkouts.length, 1);
    assert.match(checkouts[0].split('\n      - ')[0], /persist-credentials: false/, 'checkouts keep no git credentials');
  }

  const refuse = gate.indexOf('Refuse anything but a final vX.Y.Z tag'), checkout = gate.indexOf('actions/checkout@');
  const verify = gate.indexOf('Require tag on main with a green Verify run'), validated = gate.indexOf('Require a successful release validation of this commit');
  assert.ok(refuse >= 0 && refuse < checkout, 'the pre-release refusal is the first gate step');
  assert.ok(verify > checkout && validated > verify, 'the Verify and candidate gates run in the gate job');
  const login = publish.indexOf('docker/login-action@'), build = publish.indexOf('docker/build-push-action@'), sign = publish.indexOf('cosign sign'), release = publish.indexOf('gh release create');
  assert.ok(login > 0 && build > login && sign > build && release > sign, 'login, build, signing and the release happen in the publish job');

  // The refusal regex, as the step runs it (a whole-string bash match), accepts final tags only.
  assert.match(gate.slice(refuse, checkout), /shell: bash/);
  const final = new RegExp(/\[\[ \$REF_NAME =~ (\^v\[0-9\]\S+) \]\]/.exec(gate.slice(refuse, checkout))[1]);
  for (const tag of ['v2.1.0', 'v2.2.0', 'v10.20.30']) assert.ok(final.test(tag), tag);
  for (const tag of ['v2.1.0-rc.1', 'v2.2.0-beta', 'v2.2', 'v2.2.0.1', '2.2.0', 'v2.2.0-rc.1+build']) assert.ok(!final.test(tag), tag);

  assert.doesNotMatch(text, /--prerelease|prerelease=/, 'no GitHub pre-release can be created');
  assert.match(text, /actions\/workflows\/release-validation\.yml\/runs\?branch=main&event=workflow_dispatch&status=success/);
  assert.match(text, /\.display_title == \\"Release validation candidate \$GITHUB_SHA\\"/);
  assert.match(text, /\.event == \\"workflow_dispatch\\" and \.head_branch == \\"main\\"/);
  assert.match(text, /for run in \$runs; do git merge-base --is-ancestor "\$run" origin\/main/, 'the validating run itself ran from a main commit');
  assert.match(text, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$GITHUB_SHA/);
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
});

test('release-validation.yml validates a main commit privately and names the run after it', async () => {
  const text = await workflow('release-validation.yml');
  const on = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));
  assert.doesNotMatch(on, /\n {2}push:/, 'runs by hand only, never for a pushed tag');
  assert.match(on, /\n {6}candidate:/); assert.match(on, /\n {6}target:/);
  assert.match(text, /run-name: .*format\('Release validation candidate \{0\}', inputs\.candidate\)/);
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(text, /packages: write|contents: write|docker\/login-action|docker push|git push|git tag (?!-l )/,'nothing is pushed or tagged');
  assert.match(text, /\[ "\$DISPATCH_REF" = refs\/heads\/main \]/);
  assert.match(text, /git merge-base --is-ancestor "\$CANDIDATE" origin\/main/);
  // Inputs are validated by whole-string bash matches, never line-wise grep, so a multi-line value cannot pass.
  assert.doesNotMatch(text, /\| grep -Eq/);
  const resolve = text.slice(text.indexOf('name: Resolve what to validate'), text.indexOf('name: Validate v2.0.0'));
  assert.match(resolve, /shell: bash/);
  const pattern = name => new RegExp(new RegExp(`\\[\\[ \\$${name} =~ (\\S+) \\]\\]`).exec(resolve)[1]);
  assert.ok(pattern('CANDIDATE').test(sha));
  for (const value of ['a'.repeat(39), 'A'.repeat(40), `${sha}\n${sha}`, `${sha}\nmode=target`]) assert.ok(!pattern('CANDIDATE').test(value), JSON.stringify(value));
  assert.ok(pattern('version').test('2.2.0')); assert.ok(!pattern('version').test('2.2.0-rc.1')); assert.ok(!pattern('version').test('2.2.0\n2.2.0'));
  assert.ok(pattern('target').test('v2.1.0')); assert.ok(!pattern('target').test('v2.1.0\nmode=candidate'));
});

test('every action in the release workflows is pinned to a full commit SHA', async () => {
  for (const name of ['release.yml', 'release-validation.yml']) {
    const uses = [...(await workflow(name)).matchAll(/uses: (\S+)/g)].map(match => match[1]);
    assert.ok(uses.length > 0, name);
    for (const action of uses) assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${action}`);
  }
});

test('a candidate is released as v + its final package version', () => {
  assert.equal(candidateTag(sha, JSON.stringify({ version: '2.2.0' })), 'v2.2.0');
  assert.throws(() => candidateTag(sha, JSON.stringify({ version: '2.2.0-rc.1' })), /final X\.Y\.Z/);
  assert.throws(() => candidateTag(sha, ''), /Cannot read package\.json/);
  assert.throws(() => candidateTag('abc1234', JSON.stringify({ version: '2.2.0' })), /full 40-character/);
  assert.throws(() => candidateTag('A'.repeat(40), JSON.stringify({ version: '2.2.0' })), /full 40-character/);
});
