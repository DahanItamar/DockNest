import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { candidateTag } from '../scripts/release-validation.js';

const workflow = async name => (await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const sha = 'a'.repeat(40);

test('release.yml publishes final vX.Y.Z tags only, after Verify and a candidate validation of the same commit', async () => {
  const text = await workflow('release.yml');
  const steps = text.slice(text.indexOf('    steps:'));
  const refuse = steps.indexOf('Refuse anything but a final vX.Y.Z tag'), checkout = steps.indexOf('actions/checkout@');
  const verify = steps.indexOf('Require tag on main with a green Verify run'), validated = steps.indexOf('Require a successful release validation of this commit');
  const login = steps.indexOf('docker/login-action@'), build = steps.indexOf('docker/build-push-action@'), sign = steps.indexOf('cosign sign'), release = steps.indexOf('gh release create');
  assert.ok(refuse >= 0 && refuse < checkout, 'the pre-release refusal is the first step');
  assert.ok(verify > checkout && validated > verify && login > validated && build > login && sign > build && release > sign, 'both gates run before login, build, signing and the release');

  // The refusal regex, as the step runs it, accepts final tags only.
  const final = new RegExp(/grep -Eq '(\^v\[0-9\][^']+)'/.exec(steps.slice(refuse, checkout))[1]);
  for (const tag of ['v2.1.0', 'v2.2.0', 'v10.20.30']) assert.ok(final.test(tag), tag);
  for (const tag of ['v2.1.0-rc.1', 'v2.2.0-beta', 'v2.2', 'v2.2.0.1', '2.2.0', 'v2.2.0-rc.1+build']) assert.ok(!final.test(tag), tag);

  assert.doesNotMatch(text, /--prerelease|prerelease=/, 'no GitHub pre-release can be created');
  assert.match(text, /actions\/workflows\/release-validation\.yml\/runs\?branch=main&event=workflow_dispatch&status=success/);
  assert.match(text, /\.display_title == \\"Release validation candidate \$GITHUB_SHA\\"/);
  assert.match(text, /\.head_branch == \\"main\\"/);
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
  assert.match(text, /grep -Eq '\^\[0-9a-f\]\{40\}\$'/);
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
