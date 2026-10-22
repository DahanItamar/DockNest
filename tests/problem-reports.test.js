import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildIssueUrl, ISSUE_BASE, URL_LIMIT, TEMPLATES } from '../web/report/core.js';
import { buildBugReport, buildJobReport, buildStorageReport, buildServerReport, buildSelfBackupReport, buildAppErrorReport, buildUpdateReport, environmentFields, timelineLines, TEMPLATE_FIELDS, containerBucket } from '../web/report/builders.js';
import { redact, limitExcerpt, excerptFrom, EXCERPT_LINES, EXCERPT_BYTES } from '../web/report/redact.js';
import { storageErrorClass, s3ErrorClass, serverTestFailure, reportErrorFields } from '../src/storage-errors.js';

// Planted in every input of every builder: none of these may reach any URL.
const CANARIES = ['canary-host.example.com', '203.0.113.77', '2001:db8::77', '/home/canaryuser/site', '/srv/canary', 'C:\\canary\\path', 'canary.user@example.org', 'canaryuser', 'ghp_CANARYtoken0123456789abcdefABCDEF', 'AKIACANARY0123456789', 'Canary Site Name', 'canary-server', 'CANARY error text', 'Traceback canary', 'req-canary-1234', 'user-canary-5678', 'https://canary.example.net/x', 's3://canary-bucket'];
const CANARY = CANARIES.join(' ');
const env = { docker: '27.3.1', compose: '2.29.7', os: 'ubuntu', osVersion: '24.04', kernel: '6.8.0-45-generic', arch: 'x86_64', git: '2.43.0', cosign: 'v2.4.1', disk: '>50GiB' };
const hostileEnv = Object.fromEntries(Object.keys(env).map(k => [k, CANARY]));
const events = [{ phase: 'verify', at: '2026-10-01T10:00:00Z' }, { phase: 'build', at: '2026-10-01T10:00:04Z' }, { phase: 'health', at: '2026-10-01T10:02:14Z' }, { phase: 'rollback', at: '2026-10-01T10:07:14Z' }];
const status = { requestId: 'req-canary-1234', requestedBy: { id: 'user-canary-5678', name: 'canaryuser' }, from: '2.3.0', to: 'v2.4.0', state: 'rolled_back', exitCode: 4, events, acceptedAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:08:02Z', reason: 'health-timeout-api', fromSchema: 5, toSchema: 5, installMode: 'source', updaterVersion: '2.2.0', env, error: CANARY, rollbackHint: CANARY, warning: CANARY };

const all = (overrides = {}) => [
  ['bug-report.yml', buildBugReport({ version: '2.4.0', installMode: 'image', ...overrides })],
  ['job-failure.yml', buildJobReport({ version: '2.4.0', installMode: 'image', env, jobType: 'backup', phase: 'send', siteKind: 'docker', storage: 'sftp', containers: 3, helperOutcome: 'timeout', ...overrides })],
  ['job-failure.yml', buildJobReport({ version: '2.4.0', installMode: 'image', env, jobType: 'restore', outcome: 'recovery-required', ended: 'worker-interrupted', phase: 'stop', ...overrides })],
  ['storage-failure.yml', buildStorageReport({ version: '2.4.0', installMode: 'image', env, protocol: 'sftp', errorClass: 'timeout', ...overrides })],
  ['storage-failure.yml', buildStorageReport({ version: '2.4.0', installMode: 'image', env, protocol: 's3', errorClass: 'AccessDenied', ...overrides })],
  ['server-connection.yml', buildServerReport({ version: '2.4.0', installMode: 'image', env, check: 'ssh', errorClass: 'auth-failed', ...overrides })],
  ['self-backup-failure.yml', buildSelfBackupReport({ version: '2.4.0', installMode: 'image', env, destination: 's3', ended: 'failed', ...overrides })],
  ['app-error.yml', buildAppErrorReport({ version: '2.4.0', installMode: 'image', env, route: 'jobs', area: 'page', error: new TypeError(CANARY), ...overrides })],
  ['update-failure.yml', buildUpdateReport({ version: '2.3.0', installMode: 'image', env, status, ...overrides })],
];
const keys = href => [...new URL(href).searchParams.keys()];

test('core: constant base and template, typed values only, invalid dropped, 4000-character cap', () => {
  const r = buildIssueUrl('job-failure.yml', { title: 'Backup failed', version: 'v2.4.0', phase: 'send', storage: 'ftp', other: 'x', template: 'evil.yml' }, { title: /^[A-Za-z ]+$/, version: /^v\d+\.\d+\.\d+$/, phase: ['send'], storage: ['sftp'] });
  const u = new URL(r.href);
  assert.equal(u.origin + u.pathname, ISSUE_BASE);
  assert.equal(u.searchParams.get('template'), 'job-failure.yml');
  assert.deepEqual(keys(r.href), ['template', 'title', 'version', 'phase']);
  assert.deepEqual(r.dropped.sort(), ['other', 'storage', 'template']);
  assert.throws(() => buildIssueUrl('../../evil.yml', {}, {}), /Unknown report template/);
  assert.throws(() => buildIssueUrl('bug-report.yml', { a: 'x'.repeat(URL_LIMIT) }, { a: () => true }), e => e.code === 'TOO_LONG');
  assert.deepEqual(keys(buildIssueUrl('bug-report.yml', { n: 5, o: { toString: () => 'x' }, b: true }, { n: () => true, o: () => true, b: () => true }).href), ['template'], 'non-strings are dropped');
  for (const t of TEMPLATES) assert.match(t, /^[a-z-]+\.yml$/);
});

test('every builder: allow-listed fields only, valid values kept, URL within the cap', () => {
  for (const [template, r] of all()) {
    const u = new URL(r.href);
    assert.equal(u.origin + u.pathname, ISSUE_BASE);
    assert.equal(u.searchParams.get('template'), template);
    assert.ok(r.href.length <= URL_LIMIT, template);
    const allowed = new Set(['template', 'title', ...TEMPLATE_FIELDS[template]]);
    for (const key of keys(r.href)) assert.ok(allowed.has(key), template + ' sends unexpected field ' + key);
    assert.equal(u.searchParams.get('version'), template === 'update-failure.yml' ? 'v2.3.0' : 'v2.4.0');
    assert.ok(r.shared.every(([k, v]) => typeof k === 'string' && typeof v === 'string'));
  }
  const job = new URL(all()[1][1].href).searchParams;
  assert.deepEqual(Object.fromEntries([...job].filter(([k]) => !['template', 'title'].includes(k))), { version: 'v2.4.0', install_mode: 'image', job_type: 'backup', outcome: 'failed', phase: 'send', site_kind: 'docker', storage: 'sftp', containers: '2-5', helper_outcome: 'timeout', docker: '27.3', compose: '2.29', git: '2.43', cosign: 'v2.4.1', os: 'ubuntu-24', kernel: '6.8', arch: 'amd64', free_disk: '>50GiB' });
  assert.equal(job.get('title'), 'Backup failed: send step');
  const app = new URL(all()[7][1].href).searchParams;
  assert.equal(app.get('error_name'), 'TypeError'); assert.equal(app.get('route'), 'jobs'); assert.equal(app.get('title'), 'App error: TypeError on jobs');
  assert.deepEqual([1, 2, 5, 6, 10, 11, 0, -1, 2.5].map(containerBucket), ['1', '2-5', '2-5', '6-10', '6-10', '>10', null, null, null]);
});

test('update report follows section 7.1: outcome, result, stage, timeline in relative seconds, schema, reason', () => {
  const p = new URL(buildUpdateReport({ version: '2.3.0', env, status }).href).searchParams;
  assert.equal(p.get('title'), 'Update failed: v2.3.0 to v2.4.0 (rolled back)');
  assert.equal(p.get('from_version'), 'v2.3.0'); assert.equal(p.get('to_version'), 'v2.4.0');
  assert.equal(p.get('outcome'), 'rolled_back'); assert.equal(p.get('result'), 'exit-4');
  assert.equal(p.get('stage'), 'confirm'); assert.equal(p.get('phase'), 'health');
  assert.equal(p.get('timeline'), 'verify 0 4\nbuild 4 130\nhealth 134 300\nrollback 434 48');
  assert.equal(p.get('schema'), 'v5 to v5'); assert.equal(p.get('migration_ran'), 'no');
  assert.equal(p.get('reason'), 'health-timeout-api'); assert.equal(p.get('install_mode'), 'source'); assert.equal(p.get('updater_version'), 'v2.2.0');
  assert.equal(p.get('excerpt'), null, 'the excerpt is off by default');
  const odd = new URL(buildUpdateReport({ status: { ...status, reason: 'made-up', state: 'needs_action', exitCode: 6, toSchema: 6 } }).href).searchParams;
  assert.equal(odd.get('reason'), 'unknown'); assert.equal(odd.get('result'), 'exit-6'); assert.equal(odd.get('outcome'), 'needs_action'); assert.equal(odd.get('migration_ran'), 'yes');
  const refused = new URL(buildUpdateReport({ status: { ...status, state: 'refused', exitCode: null, refusal: 'low-disk' } }).href).searchParams;
  assert.equal(refused.get('outcome'), 'not_changed'); assert.equal(refused.get('result'), 'refused-low-disk');
  const stale = new URL(buildUpdateReport({ status: { ...status, state: 'running', stale: true }, view: 'stale' }).href).searchParams;
  assert.equal(stale.get('result'), 'stale'); assert.equal(stale.get('outcome'), null);
  assert.deepEqual(timelineLines([{ phase: 'verify', at: 'yesterday' }, { phase: 'evil', at: '2026-10-01T10:00:00Z' }], '2026-10-01T10:00:00Z'), [], 'unknown phases and unparsable times are dropped');
  const long = Array.from({ length: 40 }, (_, i) => ({ phase: 'build', at: new Date(Date.UTC(2026, 9, 1, 10, 0, i)).toISOString().replace('.000', '') }));
  assert.equal(timelineLines(long, '2026-10-01T10:00:00Z').length, 32, 'at most 32 lines');
});

test('environment section: coarse values only, included by default, untickable', () => {
  assert.deepEqual(environmentFields(env), { docker: '27.3', compose: '2.29', git: '2.43', cosign: 'v2.4.1', os: 'ubuntu-24', kernel: '6.8', arch: 'amd64', free_disk: '>50GiB' });
  assert.deepEqual(environmentFields({ os: 'gentoo', osVersion: '2', arch: 'riscv64' }), { os: 'other', arch: 'other' });
  assert.deepEqual(environmentFields(hostileEnv), { arch: 'other' });
  for (const [template, r] of all()) {
    if (template === 'bug-report.yml') { assert.equal(r.environment.length, 0, 'Report a bug never adds the environment'); continue; }
    assert.equal(r.environmentIncluded, true, template);
    assert.ok(keys(r.href).includes('docker'), template);
  }
  for (const [template, r] of all({ includeEnvironment: false })) for (const key of ['docker', 'compose', 'git', 'cosign', 'os', 'kernel', 'arch', 'free_disk']) assert.ok(!keys(r.href).includes(key), template + ' ' + key);
});

test('canary: planted host names, addresses, paths, emails, tokens, names, ids and error text reach no URL', () => {
  const hostile = { version: CANARY, installMode: CANARY, env: hostileEnv, jobType: CANARY, outcome: CANARY, phase: CANARY, ended: CANARY, siteKind: CANARY, storage: CANARY, containers: CANARY, helperOutcome: CANARY, protocol: CANARY, errorClass: CANARY, check: CANARY, destination: CANARY, route: CANARY, area: CANARY, error: Object.assign(new Error(CANARY), { name: CANARY, stack: CANARY }), lastPhase: CANARY, view: CANARY,
    status: { ...Object.fromEntries(Object.keys(status).map(k => [k, CANARY])), events: [{ phase: CANARY, at: CANARY }] }, host: CANARY, siteName: CANARY, serverName: CANARY, message: CANARY, stack: CANARY, email: CANARY, requestId: CANARY, userId: CANARY, path: CANARY, logs: CANARY, title: CANARY, href: CANARY };
  const builders = [buildBugReport, buildJobReport, buildStorageReport, buildServerReport, buildSelfBackupReport, buildAppErrorReport, buildUpdateReport];
  const outputs = [...builders.map(b => b(hostile)), ...all().map(([, r]) => r), ...all({ siteName: CANARY, host: CANARY, error: new RangeError(CANARY) }).map(([, r]) => r), buildUpdateReport({ ...hostile, excerpt: undefined })];
  for (const r of outputs) {
    const decoded = decodeURIComponent(r.href.replace(/\+/g, ' '));
    for (const canary of CANARIES) {
      assert.ok(!r.href.includes(canary) && !decoded.includes(canary), 'canary in URL: ' + canary + ' via ' + r.template);
      assert.ok(!JSON.stringify([r.shared, r.environment, r.timeline ?? null, r.excerpt ?? null]).includes(canary), 'canary in review dialog, environment, timeline or excerpt: ' + canary);
    }
    assert.ok(!/canary/i.test(decoded), r.template + ' leaks ' + decoded);
  }
  // The real update status carries free text in error, rollbackHint and warning: only the opt-in excerpt may use it.
  const real = buildUpdateReport({ status, version: '2.3.0' });
  assert.ok(!/canary/i.test(decodeURIComponent(real.href)));
});

test('optional excerpt: redaction of IPs, emails, URLs and host names, paths, long hex and base64; commit SHAs kept', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const text = `Health check failed on 203.0.113.77:8080 and 2001:db8::77 at 10:24:12\nmail ops@example.org, see https://status.example.net/x?a=1\nhost db.internal.example.com and canary-host.example.com\npath /home/canaryuser/site/.env and C:\\canary\\path\nkey 4f9c2a7e1b3d5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4 token ghp_CANARYtoken0123456789abcdefABCDEF\ncommit ${sha} rolled back schema v5`;
  const out = redact(text);
  for (const secret of ['203.0.113.77', '2001:db8::77', 'ops@example.org', 'status.example.net', 'db.internal.example.com', 'canary-host', '/home/canaryuser', 'C:\\canary', '4f9c2a7e1b3d', 'ghp_CANARY']) assert.ok(!out.includes(secret), secret + ' in ' + out);
  assert.ok(out.includes(sha), 'public commit SHA kept');
  assert.ok(out.includes('10:24:12') && out.includes('schema v5') && out.includes('Health check failed'), out);
  const many = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n');
  const limited = limitExcerpt(many);
  assert.equal(limited.split('\n').length, EXCERPT_LINES); assert.ok(limited.endsWith('line 99'), 'keeps the newest lines');
  assert.ok(new TextEncoder().encode(limitExcerpt('é'.repeat(5000))).length <= EXCERPT_BYTES);
  assert.ok(new TextEncoder().encode(excerptFrom({ error: 'x'.repeat(10000) })).length <= EXCERPT_BYTES);
  assert.equal(excerptFrom({ error: 'Failed at /srv/app', rollbackHint: 'run on 10.0.0.5', warning: null }), 'Failed at [redacted]\nrun on [redacted]');
});

// Security review of PR #46: each of these got past the first redaction rules. [input, secret parts that must go].
const BYPASS = [
  ['./data/alice/secret.txt', ['alice', 'secret.txt', 'data/']],
  ['../home/alice/x', ['alice', 'home/']],
  ['opt/docknest/sites/alice-blog/', ['alice-blog', 'docknest/']],
  ['~alice/.ssh/id_rsa', ['alice', 'id_rsa', '.ssh']],
  ['C:\\Users\\alice\\key.pem and \\\\fileserver\\share\\x', ['alice', 'key.pem', 'fileserver', 'share']],
  ['Could not resolve hostname nas01', ['nas01']],
  ['connect to my_host.lan failed', ['my_host']],
  ['server db-primary refused; remote: backup-box; node=worker7', ['db-primary', 'backup-box', 'worker7']],
  ['host bücher.example and xn--bcher-kva.example', ['bücher', 'xn--bcher-kva']],
  ['fullwidth intranet\uFF0Ecorp and nas\u3002local', ['intranet', 'corp', 'nas']],
  ['password=hunter2 POSTGRES_PASSWORD=S3cr3tPass! api_key: "abc def" token:xyz123', ['hunter2', 'S3cr3tPass', 'abc def', 'xyz123']],
  ['aws AKIAIOSFODNN7EXAMPLE and ASIAABCDEFGHIJKLMNOP', ['AKIAIOSFODNN7EXAMPLE', 'ASIAABCDEFGHIJKLMNOP']],
  ['Authorization: Bearer abcDEF123456789xyz and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', ['abcDEF123456789xyz', 'eyJhbGci', 'eyJzdWIi']],
  ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop and gho_abcdefghijklmnopqrstuvwx', ['github_pat_11ABCDEFG', 'gho_abcdefghijkl']],
  ['listen on 2001:db8:abcd:: now', ['2001:db8:abcd']],
  ['blob 0123456789abcdef0123456789abcdef01234567 leaked', ['0123456789abcdef0123456789abcdef01234567']],
  ['path %2Fhome%2Falice%2Fsite and http%3A%2F%2Fintranet%2Fadmin and %252Fetc%252Fshadow', ['alice', 'intranet', 'shadow', '%2F', '%3A']],
];
test('redaction closes the reviewed bypasses: relative and home paths, dotless and IDN hosts, key=value secrets, tokens, IPv6, bare SHAs, URL encoding', () => {
  for (const [input, secrets] of BYPASS) {
    const out = redact(input);
    for (const secret of secrets) assert.ok(!out.includes(secret), JSON.stringify(input) + ' -> ' + JSON.stringify(out) + ' still has ' + secret);
    assert.match(out, /\[redacted\]/);
    assert.equal(redact(out), out, 'redaction is stable when applied again before sending');
  }
  const sha = '0123456789abcdef0123456789abcdef01234567';
  for (const context of ['commit ', 'sha: ', 'HEAD is ', 'sha1=', 'HEAD ']) assert.ok(redact(context + sha).includes(sha), 'kept after ' + context);
  assert.equal(redact('Health check failed at 10:24:12, schema v5 to v6'), 'Health check failed at 10:24:12, schema v5 to v6', 'plain words, times and versions stay');
});
test('canary: hostile excerpt sources never reach the URL, the review values or the excerpt field', () => {
  const sensitive = ['canary-host.example.com', '203.0.113.77', '2001:db8::77', '/home/canaryuser', '/srv/canary', 'C:\\canary', 'canary.user@example.org', 'ghp_CANARYtoken', 'AKIACANARY0123456789', 'https://canary.example.net', 's3://canary-bucket'];
  const source = [CANARY, ...BYPASS.map(([input]) => input)].join('\n');
  const reports = [
    buildUpdateReport({ status: { ...status, error: source, rollbackHint: source, warning: source }, excerpt: excerptFrom({ error: source, rollbackHint: source, warning: source }) }),
    buildUpdateReport({ status, excerpt: source }),
  ];
  for (const r of reports) {
    const decoded = decodeURIComponent(r.href.replace(/\+/g, ' ')), shown = JSON.stringify([r.shared, r.environment, r.timeline, r.excerpt]);
    for (const secret of [...sensitive, ...BYPASS.flatMap(([, s]) => s)]) {
      assert.ok(!decoded.includes(secret), 'URL has ' + secret);
      assert.ok(!shown.includes(secret), 'dialog values or excerpt have ' + secret);
    }
  }
});
test('optional excerpt: off by default, redacted again when sent, Copy excerpt fallback past the cap', () => {
  const r = buildUpdateReport({ status, excerpt: 'Edited by the admin: host canary-host.example.com at 203.0.113.77\nhealth-timeout-api' });
  const sent = new URL(r.href).searchParams.get('excerpt');
  assert.equal(r.excerptIncluded, true);
  assert.equal(sent, 'Edited by the admin: host [redacted] at [redacted]\nhealth-timeout-api');
  const big = buildUpdateReport({ status, excerpt: Array.from({ length: 40 }, () => 'é'.repeat(25)).join('\n') });
  assert.equal(big.excerptTooLong, true); assert.equal(big.excerptIncluded, false);
  assert.equal(new URL(big.href).searchParams.get('excerpt'), null, 'the URL is sent without it');
  assert.ok(big.href.length <= URL_LIMIT); assert.ok(big.excerpt.length > 0, 'the excerpt stays available to copy');
});

test('issue templates: field ids match each builder exactly, public warning and labels present', async () => {
  for (const [template, ids] of Object.entries(TEMPLATE_FIELDS)) {
    const yml = await readFile('.github/ISSUE_TEMPLATE/' + template, 'utf8');
    const defined = [...yml.matchAll(/^\s+id: (\S+)/gm)].map(m => m[1]);
    for (const id of ids) assert.ok(defined.includes(id), template + ' is missing ' + id);
    assert.equal(new Set(defined).size, defined.length, template + ' has duplicate ids');
    assert.match(yml, /^labels: \[bug(?:, [a-z-]+)?\]$/m, template);
    assert.match(yml, /public/i, template + ' warns that issues are public');
    if (template !== 'bug-report.yml') assert.match(yml, /labels: \[bug, [a-z-]+\]/);
  }
  for (const [template, r] of all()) {
    const yml = await readFile('.github/ISSUE_TEMPLATE/' + template, 'utf8'), defined = [...yml.matchAll(/^\s+id: (\S+)/gm)].map(m => m[1]);
    for (const key of keys(r.href)) if (!['template', 'title'].includes(key)) assert.ok(defined.includes(key), template + ' has no field for ' + key);
  }
  const withExcerpt = buildUpdateReport({ status, excerpt: 'short' });
  assert.ok(keys(withExcerpt.href).includes('excerpt'));
});

test('API error classes: fixed lists only, from the error structure, never its text', () => {
  assert.equal(storageErrorClass({ level: 'client-authentication' }), 'auth-failed');
  assert.equal(storageErrorClass({}, { hostRejected: true }), 'host-key-mismatch');
  assert.equal(storageErrorClass({ code: 'ENOTFOUND' }), 'dns');
  assert.equal(storageErrorClass({ code: 'ECONNREFUSED' }), 'refused');
  assert.equal(storageErrorClass({ level: 'client-timeout' }), 'timeout');
  assert.equal(storageErrorClass({}, { phase: 'sftp' }), 'sftp-start');
  assert.equal(storageErrorClass({ message: CANARY }), 'other');
  assert.equal(s3ErrorClass('NoSuchBucket'), 'NoSuchBucket'); assert.equal(s3ErrorClass(CANARY), 'other'); assert.equal(s3ErrorClass(undefined), 'other');
  assert.deepEqual(serverTestFailure({ hostKeyRejected: true, level: 'client-socket' }), { check: 'host-key', errorClass: 'host-key-mismatch' });
  assert.deepEqual(serverTestFailure({ level: 'client-authentication', message: CANARY }), { check: 'ssh', errorClass: 'auth-failed' });
  assert.deepEqual(serverTestFailure({ code: 'ETIMEDOUT' }), { check: 'ssh', errorClass: 'timeout' });
  assert.deepEqual(serverTestFailure({ exitCode: 127 }), { check: 'python', errorClass: 'not-found' });
  assert.deepEqual(serverTestFailure({ remoteReported: true, exitCode: 1, message: CANARY }), { check: 'docker', errorClass: 'helper-error' });
  assert.deepEqual(serverTestFailure(new Error(CANARY)), { check: 'ssh', errorClass: 'other' });
  assert.deepEqual(reportErrorFields({ s3Code: 'AccessDenied', message: CANARY }), { errorClass: 'AccessDenied' });
  assert.deepEqual(reportErrorFields({ s3Status: 500, s3Code: CANARY }), { errorClass: 'other' });
  assert.deepEqual(reportErrorFields({ errorClass: 'timeout' }), { errorClass: 'timeout' });
  assert.deepEqual(reportErrorFields({ errorClass: CANARY, check: CANARY }), {});
  assert.deepEqual(reportErrorFields(new Error('plain')), {}, 'other errors get no new fields');
});

test('one builder module: no other web code builds GitHub issue URLs', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = [];
  const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const p = dir + '/' + entry.name; if (entry.isDirectory()) await walk(p); else if (/\.(jsx?|mjs)$/.test(entry.name)) files.push(p); } };
  await walk('web');
  for (const file of files) {
    if (file.startsWith('web/report/')) continue;
    const source = await readFile(file, 'utf8');
    assert.ok(!/issues\/new/.test(source), file + ' builds an issue URL outside web/report');
  }
});

test('access: admin-only except Report a bug, no default role, one facts cache per user and role', async () => {
  const { reportAllowed, createFactsLoader } = await import('../web/report/access.js');
  assert.equal(reportAllowed(undefined, 'admin'), true); assert.equal(reportAllowed(undefined, 'operator'), false);
  assert.equal(reportAllowed(undefined, 'operator', 'all'), true); assert.equal(reportAllowed(undefined, null, 'all'), false);
  assert.equal(reportAllowed(null, 'admin'), false, 'an explicit null role (lock view, not an admin) wins');
  assert.equal(reportAllowed('admin', null), true, 'the lock view passes the admin role explicitly');
  assert.equal(reportAllowed(undefined, undefined), false, 'no role, no report');
  const source = await readFile('web/report/UpdateReport.jsx', 'utf8');
  assert.doesNotMatch(source, /role\s*=\s*['"]admin['"]/, 'UpdateReportButton has no default admin role');
  assert.match(await readFile('web/updates/lock-view.jsx', 'utf8'), /UpdateReportButton[^>]*role=\{admin\?'admin':null\}/);
  const calls = [], api = async path => { calls.push(path); return { updater: { installMode: 'image', env: { docker: '27.3' } } }; };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ version: '2.4.0' }) });
  const admin = createFactsLoader({ api, role: 'admin', fetchImpl });
  assert.deepEqual(await admin(), { version: '2.4.0', installMode: 'image', env: { docker: '27.3' } });
  await admin(); assert.deepEqual(calls, ['/updates'], 'cached within one session');
  const operator = createFactsLoader({ api, role: 'operator', fetchImpl });
  assert.deepEqual(await operator(), { version: '2.4.0', installMode: null, env: null }, 'a new user or role starts with an empty cache');
  assert.deepEqual(calls, ['/updates'], 'operators never read the Update Center state');
  assert.ok((await readFile('web/report/ReportProblem.jsx', 'utf8')).includes('load:createFactsLoader({api,role})}),[api,role,userId])'),'the provider makes a new loader when the user or role changes');
});
