import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { candidateTag } from '../scripts/release-validation.js';
import { UPDATER_LIST } from '../scripts/release-manifest.js';

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

test('release.yml signs the manifest with a pinned cosign and verifies it before the release is published', async () => {
  const text = await workflow('release.yml'), publish = text.slice(text.indexOf('\n  publish:\n'));
  // One cosign-installer, with cosign-release pinned explicitly to an exact version (F6): signing and both
  // verifications run with that one binary.
  const installers = [...text.matchAll(/uses: sigstore\/cosign-installer@\S+[^\n]*\n {8}with:\n {10}cosign-release: '([^']+)'\n/g)];
  assert.equal(installers.length, 1); assert.equal(text.split('sigstore/cosign-installer@').length, 2);
  const pinned = installers[0][1];
  assert.match(pinned, /^v\d+\.\d+\.\d+$/);
  // When the updater's file list names a cosign pin for hosts, it is the same version (I4).
  const list = await readFile(new URL(`../${UPDATER_LIST}`, import.meta.url), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (list && JSON.parse(list).cosign) assert.equal(JSON.parse(list).cosign.version, pinned);

  const at = needle => { const index = publish.indexOf(needle); assert.ok(index >= 0, needle); return index; };
  const install = at('sigstore/cosign-installer@'), signImage = at('cosign sign --yes "$IMAGE"');
  const write = at('node scripts/release-manifest.js --version "$VERSION" --tag "$GITHUB_REF_NAME" --commit "$GITHUB_SHA" --repository "$GITHUB_REPOSITORY"');
  const signBlob = at('cosign sign-blob --yes --bundle docknest-release.json.sigstore.json docknest-release.json');
  const verifyLocal = at('bash "$RUNNER_TEMP/verify.sh" .'), create = at('gh release create "$@"'), download = at('gh release download "$GITHUB_REF_NAME"');
  const verifyPublished = at('bash "$RUNNER_TEMP/verify.sh" "$RUNNER_TEMP/published"'), release = at('gh release edit "$GITHUB_REF_NAME" --draft=false --latest');
  assert.ok(install < signImage && signImage < write && write < signBlob && signBlob < verifyLocal, 'install, sign the image, write and sign the manifest, verify');
  assert.ok(verifyLocal < create && create < download && download < verifyPublished && verifyPublished < release, 'verify, draft, verify the uploaded copy, then publish');
  assert.equal(publish.split('cosign sign-blob').length, 2); assert.equal(publish.split('gh release edit').length, 2);

  // Verification pins the identity a host verifier pins: this workflow at this tag, pushed, at this commit.
  const verify = publish.slice(publish.indexOf("cat > \"$RUNNER_TEMP/verify.sh\" <<'EOF'"), publish.indexOf('\n          EOF\n'));
  for (const flag of ['--certificate-identity "https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@$GITHUB_REF"', '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
    '--certificate-github-workflow-repository "$GITHUB_REPOSITORY"', '--certificate-github-workflow-trigger push', '--certificate-github-workflow-ref "$GITHUB_REF"', '--certificate-github-workflow-sha "$GITHUB_SHA"']) assert.ok(verify.includes(flag), flag);
  assert.match(verify, /set -euo pipefail/);
  assert.match(verify, /cosign verify "\$\{identity\[@\]\}" "\$IMAGE"/);
  assert.match(verify, /cosign verify-blob "\$\{identity\[@\]\}" --bundle "\$1\/docknest-release\.json\.sigstore\.json" "\$1\/docknest-release\.json"/);
  assert.match(verify, /release-manifest\.js --check "\$1\/docknest-release\.json" --version "\$VERSION" --commit "\$GITHUB_SHA" --repository "\$GITHUB_REPOSITORY" --digest "\$DIGEST"/);

  // The release is only ever created as a draft with both signed files; a published release is never rewritten.
  const step = publish.slice(publish.indexOf('Create the GitHub Release as a draft'));
  assert.match(step, /assets=\(docknest-release\.json docknest-release\.json\.sigstore\.json\)/);
  assert.match(step, /set -- "\$GITHUB_REF_NAME" "\$\{assets\[@\]\}" --draft --title/);
  assert.match(step, /\n {12}false\) echo "::error::[^"]*"; exit 1 ;;\n/);
  assert.match(step, /--pattern docknest-release\.json --pattern docknest-release\.json\.sigstore\.json/);
  assert.match(step, /release-manifest\.js --notes-body "\$notes"/, 'front matter never reaches the release page');
  assert.doesNotMatch(step, /--notes-file "\$notes"/);
  assert.equal(text.split('gh release create').length, 2);
});

test('release.yml pushes only a commit tag and moves the version tags by digest after the draft verifies', async () => {
  const text = await workflow('release.yml'), publish = text.slice(text.indexOf('\n  publish:\n'));
  const at = needle => { const index = publish.indexOf(needle); assert.ok(index >= 0, needle); return index; };
  // The build pushes one non-version tag; the metadata tags reach only the retag step.
  const build = publish.slice(at('docker/build-push-action@'), at('sigstore/cosign-installer@'));
  assert.match(build, /\n {10}tags: \$\{\{ steps\.release\.outputs\.image \}\}:sha-\$\{\{ github\.sha \}\}\n/);
  assert.equal(publish.split('steps.meta.outputs.tags').length, 2, 'the version tags are used once, by the retag step');
  const verifyPublished = at('bash "$RUNNER_TEMP/verify.sh" "$RUNNER_TEMP/published"'), retag = at('docker buildx imagetools create "$@" "$SOURCE"');
  const tags = at('TAGS: ${{ steps.meta.outputs.tags }}'), readBack = at('docker buildx imagetools inspect "$tag"'), release = at('gh release edit "$GITHUB_REF_NAME" --draft=false --latest');
  assert.ok(verifyPublished < tags && tags < retag && retag < readBack && readBack < release, 'verify the draft, retag by digest, read the tags back, then publish');
  assert.match(publish, /SOURCE: \$\{\{ steps\.release\.outputs\.image \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(publish, /\[ "\$\{#tags\[@\]\}" -eq 4 \]/, 'exactly X.Y.Z, X.Y, X and latest');
  assert.match(publish, /\[ "\$got" = "\$DIGEST" \] \|\| \{ echo "::error::/);
  assert.equal(publish.split('cosign sign --yes').length, 2); assert.match(publish, /cosign sign --yes "\$IMAGE"/);

  // The release lookup fails on any unexpected error instead of treating it as "no release".
  assert.doesNotMatch(text, /\|\| echo none|gh release view "\$GITHUB_REF_NAME" --json isDraft/);
  assert.match(publish, /draft=\$\(gh release list --limit 1000 --json tagName,isDraft --jq '[^']*select\(\.tagName == \$ENV\.GITHUB_REF_NAME\)[^']*error\("more than one release for the tag"\)[^']*'\)/);
  assert.match(publish, /\*\) echo "::error::unexpected release state \$draft"; exit 1 ;;/);
  for (const step of publish.split('\n      - ').filter(step => /gh release (list|view)|imagetools inspect/.test(step))) assert.match(step, /set -o pipefail|set -euo pipefail/);

  // A reused draft keeps only the two signed files, and the draft is checked to carry exactly those.
  assert.match(publish, /case "\$name" in docknest-release\.json\|docknest-release\.json\.sigstore\.json\) ;; \*\) gh release delete-asset "\$GITHUB_REF_NAME" "\$name" --yes ;; esac/);
  assert.match(publish, /\[ "\$names" = "docknest-release\.json docknest-release\.json\.sigstore\.json" \]/);
  // After publishing, the public assets are compared byte for byte (SHA-256) with the signed local files.
  const final = publish.slice(release);
  assert.match(final, /gh release download "\$GITHUB_REF_NAME" --dir "\$RUNNER_TEMP\/final"/);
  assert.match(final, /\[ "\$\(sha256sum < "\$asset"\)" = "\$\(sha256sum < "\$RUNNER_TEMP\/final\/\$asset"\)" \] \|\| \{ echo "::error::/);
});

test('the image build pins its base by digest and sends only an allow-listed context', async () => {
  const dockerfile = (await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map(match => match[1]);
  assert.equal(froms.length, 2);
  for (const from of froms) assert.match(from, /^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/);
  const ignore = (await readFile(new URL('../.dockerignore', import.meta.url), 'utf8')).replace(/\r\n/g, '\n').split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(ignore[0], '*', 'everything is excluded first');
  const allowed = ignore.filter(line => line.startsWith('!')).map(line => line.slice(1).replace(/\/$/, ''));
  // Every path the Dockerfile copies from the build stage, and the integration host's start script, is allowed.
  const copied = [...dockerfile.matchAll(/^COPY --from=build \S+ \/app\/(\S+)/gm)].map(match => match[1].replace(/\*.*$/, '').replace(/\/$/, ''));
  for (const need of [...copied.filter(name => !['package', 'node_modules', 'dist'].includes(name)), 'package.json', 'package-lock.json', 'index.html', 'vite.config.js', 'web', 'public', 'tests/integration/start.sh'])
    assert.ok(allowed.includes(need), need);
  for (const secret of ['.env', '.git', '.ssh', 'data', 'backups', 'node_modules', 'dist', 'tests', 'docs']) assert.ok(!allowed.includes(secret), secret);
  for (const rule of ['**/node_modules', '**/.env', '**/.env.*']) assert.ok(ignore.indexOf(rule) > ignore.findLastIndex(line => line.startsWith('!')), rule);
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
