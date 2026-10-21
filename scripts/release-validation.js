// Real end-to-end release validation: a DockNest 2.0.0 installation (the repo's own compose.yaml, read-only containers,
// the real named volume) is upgraded to TARGET exactly as the release notes say, drained, downgraded and upgraded again
// with scripts/upgrade.sh, and its data and configuration are compared at every step. Linux with Docker only.
// Usage: node scripts/release-validation.js [--target vX.Y.Z] [--out DIR] [--allow-local]   (default target: newest final tag)
// Needs the release tags in the repository it runs from (fetch-depth 0). Throwaway credentials only; nothing secret is
// printed, written to the evidence directory or kept after the run (containers, volume and temp checkout are removed).
// Compose runs NODE_ENV=production, which refuses an http origin, so the instance uses APP_ORIGIN=https://test.invalid
// with SECURE_COOKIES=true and this client sends that Origin and the session cookie by hand over loopback http.
// Data seeding is by rows written through v2.0.0's own db.js, not by a real SSH capture (see docs/release-validation.md).
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FROM_TAG = 'v2.0.0', VOLUME = 'docker-backup-manager_state', TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const ORIGIN = process.env.RV_ORIGIN || 'https://test.invalid', BASE = process.env.RV_BASE_URL || 'http://127.0.0.1:3000';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), sha = data => createHash('sha256').update(data).digest('hex');

// Runs inside the api container (CommonJS, read-only): per-table row digests of /data/state.sqlite. Transient auth tables
// and settings the system rewrites on every start are left out; a spec from an earlier run fixes the compared columns.
export const DIGEST = `
const {DatabaseSync}=require('node:sqlite'),{createHash}=require('node:crypto');
const sha=t=>createHash('sha256').update(t).digest('hex');
const spec=JSON.parse(process.argv[1]||'{}'),file=process.argv[2]||'/data/state.sqlite',only=Object.keys(spec).length>0;
const skip=new Set(['sessions','rate_limits','login_challenges','challenges','enrollment_challenges']);
const volatile={users:['totp_last_counter']},keys=['worker_heartbeat','deployment_hold','artifact_reconciliation','schema_compat_floor'];
const db=new DatabaseSync(file,{readOnly:true}),out={};
for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
 if(skip.has(name)||(only&&!spec[name]))continue;
 const columns=spec[name]?.columns||db.prepare('PRAGMA table_info("'+name+'")').all().map(c=>c.name).filter(c=>!(volatile[name]||[]).includes(c));
 const filter=name==='settings';
 const rows=db.prepare('SELECT '+columns.map(c=>'"'+c+'"').join(',')+' FROM "'+name+'"'+(filter?' WHERE key NOT IN ('+keys.map(()=>'?').join(',')+')':'')).all(...(filter?keys:[]));
 const digests=rows.map(r=>sha(JSON.stringify(columns.map(c=>r[c])))).sort();
 out[name]={columns,count:digests.length,digests,hash:sha(digests.join('\\n'))};
}
db.close();console.log(JSON.stringify(out));`;

// Inspects a pre-upgrade snapshot file without opening it for writing.
export const SNAPSHOT = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/upgrade-snapshots/'+process.argv[1],{readOnly:true});
console.log(JSON.stringify({version:d.prepare('PRAGMA user_version').get().user_version,integrity:d.prepare('PRAGMA integrity_check').get().integrity_check,servers:d.prepare('SELECT COUNT(*) n FROM servers').get().n,backups:d.prepare('SELECT COUNT(*) n FROM backups').get().n}));d.close();`;

// Runs inside the v2.0.0 api container (ESM) against its own db.js: one realistic server, site, policy, finished job, a
// legacy backup (verified=1, no backup_verifications rows), a restore, audit events and a settings marker. The policy's
// next_run lies far in the future so the scheduler never rewrites it; no queue, journal or retention rows are created.
export const SEED = `const {db,audit}=await import('./src/db.js'),{seal}=await import('./src/crypto.js');
const now=new Date().toISOString(),run=(sql,...values)=>db.prepare(sql).run(...values);
run("INSERT INTO servers(id,name,host,port,username,private_key,host_key,status,created_at,note) VALUES(?,?,?,?,?,?,?,?,?,?)",'rv-server','Release validation host','host.example.invalid',22,'docknest',seal('throwaway-not-a-real-private-key'),'0'.repeat(64),'unchecked',now,'seeded by release validation');
run("INSERT INTO sites(id,server_id,name,config,created_at) VALUES(?,?,?,?,?)",'rv-site','rv-server','Release validation site',JSON.stringify({containers:['app'],domains:['site.example.invalid'],stagingRoot:'/var/lib/docknest'}),now);
run("INSERT INTO policies(site_id,enabled,schedule,timezone,retention,next_run) VALUES(?,?,?,?,?,?)",'rv-site',1,'0 3 * * *','UTC',7,'2099-01-01T00:00:00.000Z');
run("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at,details) VALUES(?,?,?,?,?,?,?,?,?)",'rv-job','rv-site','backup','completed','completed',now,now,now,'{}');
run("INSERT INTO backups(id,site_id,job_id,captured_at,path,size,checksum,manifest,pinned,verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",'rv-backup','rv-site','rv-job',now,'rv/site/backup.tar.gz.enc',1024,'a'.repeat(64),JSON.stringify({containers:['app']}),1,1,now);
run("INSERT INTO restores(id,backup_id,server_id,mode,plan,status,created_at) VALUES(?,?,?,?,?,?,?)",'rv-restore','rv-backup','rv-server','isolated',JSON.stringify({backupId:'rv-backup'}),'completed',now);
run("INSERT INTO settings(key,value) VALUES('rv_marker','kept')");
audit('release-validation','server.created','rv-server',{});audit('release-validation','backup.completed','rv-backup',{});
db.close();console.log('seeded');`;

// RFC 6238 SHA-1/6 digits, as DockNest enrols it. The secret comes from the setup response and is never printed.
const unbase32 = secret => { let bits = 0, value = 0; const bytes = []; for (const char of secret.toUpperCase().replace(/=+$/, '')) { value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(bytes); };
export function totpAt(secret, counter) { const time = Buffer.alloc(8); time.writeBigUInt64BE(BigInt(counter)); const mac = createHmac('sha1', unbase32(secret)).update(time).digest(), offset = mac[19] & 15; return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0'); }

const secrets = new Set(), secret = value => { if (typeof value === 'string' && value.length >= 6) secrets.add(value); return value; };
export const redact = text => { let result = String(text ?? ''); for (const value of secrets) result = result.split(value).join('[redacted]'); return result; };
export const leaks = text => [...secrets].filter(value => String(text).includes(value)).length;

export async function http(method, url, { body, cookie, csrf } = {}) {
  const headers = { origin: ORIGIN, accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = 'dbm_session=' + cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(BASE + url, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await response.text(); let data = null; try { data = JSON.parse(text); } catch { /* empty or non-JSON body */ }
  return { status: response.status, data, cookie: response.headers.getSetCookie().map(value => /^dbm_session=([^;]+)/.exec(value)?.[1]).find(Boolean) };
}

async function main() {
  const args = process.argv.slice(2), opt = name => { const index = args.indexOf('--' + name); return index < 0 ? undefined : args[index + 1]; };
  const root = path.resolve(import.meta.dirname, '..'), out = path.resolve(opt('out') || 'release-validation-evidence');
  const phases = [], tables = {}, evidence = { schema: 1, startedAt: new Date().toISOString(), capture: 'seeded rows written through v2.0.0 db.js (no real SSH capture)', phases, tables, versions: {} };
  const transcript = []; let baselineFiles = {}, clone = '', work = '', failed = false, current = null, lastCounter = -1;
  const admin = { email: 'admin@release-validation.invalid', password: secret(randomBytes(12).toString('base64url')), totp: '', session: null };

  const note = text => transcript.push(redact(text));
  function sh(command, argv, { cwd = clone || root, input, fail = true, quiet = false, timeout = 900_000 } = {}) {
    const result = spawnSync(command, argv, { cwd, input, encoding: 'utf8', timeout, maxBuffer: 256 << 20 });
    const output = (result.stdout || '') + (result.stderr || '') + (result.error ? String(result.error) : '');
    note(`$ ${command} ${argv.map(arg => arg.length > 120 ? arg.slice(0, 40) + '...' : arg).join(' ')}\n${quiet ? '(output omitted)' : output}\n[exit ${result.status}]`);
    if (fail && result.status !== 0) { console.error(redact(output).split('\n').slice(-40).join('\n')); throw new Error(`${command} ${argv.slice(0, 3).join(' ')} exited ${result.status}`); }
    return { status: result.status, out: result.stdout || '', all: output };
  }
  const compose = (argv, options) => sh('docker', ['compose', ...argv], options);
  const inApi = (script, ...argv) => compose(['exec', '-T', 'api', 'node', '-e', script, ...argv], { quiet: true }).out.trim();
  const gitShow = (ref, file) => sh('git', ['show', `${ref}:${file}`], { cwd: root, fail: false, quiet: true });
  const pkgVersion = ref => JSON.parse(gitShow(ref, 'package.json').out).version;
  const migrationLines = ref => [...gitShow(ref, 'src/migrations.js').out.matchAll(/^ *\{ *version: *(\d+),(.*)$/gm)];
  const schemaOf = ref => Math.max(0, ...migrationLines(ref).map(match => Number(match[1])));
  const floorOf = ref => Math.max(0, ...migrationLines(ref).filter(match => !match[2].includes('compatible: true')).map(match => Number(match[1])));
  const check = (name, ok, detail = '') => { current.checks.push({ name, ok: Boolean(ok), detail: redact(detail) }); console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : ' (' + redact(detail) + ')'}`); if (!ok) throw new Error(`Check failed: ${name}${detail ? ' (' + detail + ')' : ''}`); };
  const until = async (probe, seconds, label) => { const end = Date.now() + seconds * 1000; for (;;) { if (await probe().catch(() => false)) return; if (Date.now() > end) throw new Error('Timed out waiting for ' + label); await sleep(3000); } };

  // A code for a counter above the last one used (the server rejects replays), within its +-1 step window; waits otherwise.
  async function nextCode() { for (;;) { const now = Math.floor(Date.now() / 30000), counter = Math.max(now, lastCounter + 1); if (counter <= now + 1) { lastCounter = counter; return totpAt(admin.totp, counter); } await sleep(1000); } }
  async function login() {
    const first = await http('POST', '/api/auth/login', { body: { password: admin.password } });
    check('password login returns a second-factor challenge', first.status === 200 && first.data?.challenge, `HTTP ${first.status}`);
    const second = await http('POST', '/api/auth/verify', { body: { challenge: secret(first.data.challenge), code: await nextCode() } });
    check('authenticator code opens a session', second.status === 200 && second.cookie && second.data?.csrfToken, `HTTP ${second.status}`);
    admin.session = { cookie: secret(second.cookie), csrf: secret(second.data.csrfToken) };
  }

  const digests = (spec = {}, file) => JSON.parse(inApi(DIGEST, JSON.stringify(spec), ...(file ? [file] : [])));
  function dataIntact(label) {
    const pre = evidence.baseline, post = digests(Object.fromEntries(Object.entries(pre).map(([name, table]) => [name, { columns: table.columns }]))), report = {};
    const missing = [];
    for (const [name, table] of Object.entries(pre)) {
      const now = post[name], present = new Set(now?.digests);
      const lost = table.digests.filter(digest => !present.has(digest)).length;
      report[name] = { rows: table.count, sha256: table.hash, unchanged: !lost, exact: now?.hash === table.hash, added: Math.max(0, (now?.count ?? 0) - table.count) };
      if (lost || !now) missing.push(`${name}: ${now ? lost + ' row(s) changed or missing' : 'table missing'}`);
    }
    tables[label] = report;
    check(`${label}: every pre-existing row in ${Object.keys(pre).length} tables is unchanged`, !missing.length, missing.join('; '));
    check(`${label}: seeded rows present (servers, sites, backups)`, ['servers', 'sites', 'backups'].every(name => post[name]?.count >= 1));
  }
  const fileHashes = () => Object.fromEntries(['.env', 'data/master.key', 'data/setup.token'].map(name => [name, sha(readFileSync(path.join(clone, name)))]));
  const filesIdentical = label => { const now = fileHashes(); check(`${label}: .env, data/master.key and data/setup.token are byte-identical`, Object.keys(now).every(name => now[name] === baselineFiles[name])); };

  async function stateChecks(label, legacyApi) {
    const anonymous = await http('GET', '/api/state'); check(`${label}: /api/state refuses anonymous requests`, anonymous.status === 401, `HTTP ${anonymous.status}`);
    let state; await until(async () => { const response = await http('GET', '/api/state', { cookie: admin.session.cookie }); state = response.data; return response.status === 200 && state?.worker?.online; }, 90, `/api/state with an online worker (${label})`);
    const find = (list, id) => (state[list] || []).find(item => item.id === id);
    check(`${label}: seeded server, site, job, backup and restore are listed`, ['servers:rv-server', 'sites:rv-site', 'jobs:rv-job', 'backups:rv-backup', 'restores:rv-restore'].every(item => find(...item.split(':'))));
    check(`${label}: server credentials are not exposed`, !('private_key' in find('servers', 'rv-server')) && !JSON.stringify(state).includes('throwaway-not-a-real-private-key'));
    check(`${label}: seeded policy and audit events are listed`, state.policies?.some(policy => policy.siteId === 'rv-site' && policy.schedule === '0 3 * * *') && state.audit?.filter(event => event.actor === 'release-validation').length >= 2);
    const backup = find('backups', 'rv-backup');
    check(`${label}: the legacy backup stays verified`, backup.status === 'Verified' && backup.pinned === 1);
    if (!legacyApi) check(`${label}: the legacy backup's integrity reads as passed`, backup.verification?.integrity?.status === 'passed' && backup.verification.integrity.source === 'legacy', JSON.stringify(backup.verification?.integrity));
  }
  async function workerChecks(label, hasStatusScript) {
    check(`${label}: worker container is running`, compose(['ps', '--status', 'running', '--services']).out.split('\n').map(line => line.trim()).includes('worker'));
    if (!hasStatusScript) return note(`${label}: src/worker-status.js is not part of this release; skipped`);
    let text = ''; await until(async () => { text = compose(['exec', '-T', 'api', 'node', 'src/worker-status.js'], { fail: false }).out; return /Lease: held/.test(text) && /Heartbeat: running/.test(text); }, 90, `worker lease (${label})`);
    check(`${label}: worker-status shows a held lease and a running heartbeat`, /Lease: held/.test(text) && /Heartbeat: running/.test(text));
    check(`${label}: no job or restore needs recovery review`, /Recovery required jobs: 0/.test(text) && !/Recovery required restores/.test(text), text.split('\n').slice(0, 5).join(' | '));
  }
  const waitReady = async (tag, seconds = 300) => {
    const legacyApi = schemaOf(tag) === 0, version = pkgVersion(tag);
    await until(async () => { const response = await http('GET', legacyApi ? '/healthz' : '/api/version'); return legacyApi ? response.status === 200 : response.data?.version === version; }, seconds, `${tag} to answer`);
    if (legacyApi) { const response = await http('GET', '/api/version'); check(`${tag} has no public /api/version (answers 401)`, response.status === 401, `HTTP ${response.status}`); }
    else { const response = await http('GET', '/api/version'); check(`/api/version reports ${version} schema v${schemaOf(tag)}`, response.data?.version === version && response.data?.schemaVersion === schemaOf(tag), JSON.stringify(response.data)); }
    check(`container runs package version ${version}`, inApi('console.log(require("./package.json").version)') === version);
    check(`checkout is ${tag}`, sh('git', ['describe', '--tags', '--exact-match', 'HEAD']).out.trim() === tag);
  };
  const verifyRelease = async (label, tag) => {
    const legacyApi = schemaOf(tag) === 0;
    await waitReady(tag); filesIdentical(label); dataIntact(label); await login(); await stateChecks(label, legacyApi);
    await workerChecks(label, !legacyApi && compose(['exec', '-T', 'api', 'test', '-f', 'src/worker-status.js'], { fail: false }).status === 0);
  };
  const readStatus = (file, from, to) => {
    const raw = readFileSync(file, 'utf8'), status = JSON.parse(raw);
    check(`status file ends ok:true at phase done (${from} to ${to})`, status.ok === true && status.phase === 'done' && status.error === null && status.from === from && status.to === to, `ok=${status.ok} phase=${status.phase}`);
    check('status file contains no secrets', leaks(raw) === 0); evidence[path.basename(file)] = status; return status;
  };

  function flush(name) {
    mkdirSync(path.join(out, 'logs'), { recursive: true });
    writeFileSync(path.join(out, 'logs', `${String(phases.length).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.log`), redact(transcript.splice(0).join('\n\n')) + '\n');
  }
  async function phase(name, body) {
    const entry = { name, status: 'skipped', ms: 0, checks: [], error: null }; phases.push(entry);
    if (failed) return flush(name);
    current = entry; const started = Date.now(); console.log(`\n==> ${name}`);
    try { await body(); entry.status = 'passed'; } catch (error) { entry.status = 'failed'; entry.error = redact(error.message); failed = true; console.error(`FAILED: ${entry.error}`); }
    finally { entry.ms = Date.now() - started; if (clone && existsSync(path.join(clone, 'compose.yaml'))) { compose(['ps', '-a'], { fail: false }); compose(['logs', '--no-color', '--timestamps', '--tail', '300'], { fail: false }); } flush(name); }
  }

  mkdirSync(out, { recursive: true });
  try {
    const target = (() => { const wanted = opt('target') || process.env.RV_TARGET || ''; if (wanted) return wanted; return sh('git', ['tag', '-l', 'v*', '--sort=-v:refname'], { cwd: root }).out.split('\n').find(tag => /^v\d+\.\d+\.\d+$/.test(tag)) || ''; })();
    if (!TAG.test(target)) throw new Error(`Invalid or missing target tag "${target}". Pass --target vX.Y.Z.`);
    if (process.platform !== 'linux') throw new Error('Real Docker validation runs on Linux only.');
    if (!process.env.CI && !args.includes('--allow-local')) throw new Error('Refusing to run outside CI: this removes the docker-backup-manager_state volume and docknest containers on this machine. Use --allow-local on a disposable host.');
    evidence.versions.target = target;
    await phase('Resolve release', async () => {
      check(`tag ${FROM_TAG} exists`, sh('git', ['rev-parse', '-q', '--verify', `refs/tags/${FROM_TAG}`], { cwd: root, fail: false }).status === 0);
      check(`tag ${target} exists (fetch tags first)`, sh('git', ['rev-parse', '-q', '--verify', `refs/tags/${target}`], { cwd: root, fail: false }).status === 0);
      const from = pkgVersion(FROM_TAG), to = pkgVersion(target), minimum = JSON.parse(gitShow(target, 'package.json').out).docknest?.minUpgradeFrom;
      const newer = (a, b) => { const x = a.split('-')[0].split('.').map(Number), y = b.split('-')[0].split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
      check(`${target} (${to}) is newer than ${FROM_TAG}`, newer(to, from));
      check(`${target} supports upgrades from ${from} (minUpgradeFrom ${minimum || 'unset'})`, !minimum || !newer(minimum, from));
      check('upgrade.sh exists in the target release', gitShow(target, 'scripts/upgrade.sh').status === 0);
      Object.assign(evidence.versions, { target, targetVersion: to, targetSchema: schemaOf(target), targetCompatFloor: floorOf(target), from: FROM_TAG, fromVersion: from, targetCommit: sh('git', ['rev-parse', `${target}^{commit}`], { cwd: root }).out.trim(), validatorCommit: sh('git', ['rev-parse', 'HEAD'], { cwd: root }).out.trim() });
      Object.assign(evidence.versions, { node: process.version, docker: sh('docker', ['version', '--format', '{{.Server.Version}}'], { cwd: root }).out.trim(), compose: sh('docker', ['compose', 'version', '--short'], { cwd: root }).out.trim() });
      check('no docker-backup-manager_state volume exists yet', sh('docker', ['volume', 'inspect', VOLUME], { cwd: root, fail: false, quiet: true }).status !== 0);
      check('no docknest containers exist yet', sh('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=docknest'], { cwd: root }).out.trim() === '');
    });
    const tag = target;

    await phase(`Install ${FROM_TAG} with Compose`, async () => {
      work = mkdtempSync(path.join(tmpdir(), 'docknest-release-validation-')); clone = path.join(work, 'docknest');
      sh('git', ['clone', '--quiet', root, clone], { cwd: work }); sh('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', FROM_TAG]);
      sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);
      // The production container refuses http, so the instance claims a documentation-only https origin and the client sends it.
      writeFileSync(path.join(clone, '.env'), ['APP_DOMAIN=test.invalid', 'APP_ORIGIN=' + ORIGIN, 'SECURE_COOKIES=true', ''].join('\n'), { mode: 0o600 });
      sh('npm', ['run', '--silent', 'setup']);
      for (const name of ['data/master.key', 'data/setup.token']) chmodSync(path.join(clone, name), 0o644); // readable by the container's uid 1000; data/ stays 0700
      secret(readFileSync(path.join(clone, 'data/master.key'), 'utf8').trim()); secret(readFileSync(path.join(clone, 'data/setup.token'), 'utf8').trim());
      baselineFiles = fileHashes();
      check('master.key is a base64 32-byte key and setup.token exists', Buffer.from(readFileSync(path.join(clone, 'data/master.key'), 'utf8').trim(), 'base64').length === 32 && readFileSync(path.join(clone, 'data/setup.token'), 'utf8').trim().length > 20);
      compose(['up', '-d', '--build']);
      await until(async () => (await http('GET', '/healthz')).status === 200, 180, `${FROM_TAG} /healthz`);
      check(`${FROM_TAG} API is healthy`, true); check('api and worker containers are running', ['api', 'worker'].every(name => compose(['ps', '--status', 'running', '--services']).out.split('\n').map(line => line.trim()).includes(name)));
      check(`containers run read-only with all capabilities dropped`, compose(['ps', '-q']).out.trim().split('\n').every(id => sh('docker', ['inspect', '-f', '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}', id], { quiet: true }).out.trim() === 'true [ALL]'));
      check(`container runs package version ${pkgVersion(FROM_TAG)}`, inApi('console.log(require("./package.json").version)') === pkgVersion(FROM_TAG));
    });

    await phase(`Create state through ${FROM_TAG}`, async () => {
      const status = await http('GET', '/api/auth/status'); check('first-admin setup is required', status.data?.setupRequired === true);
      const created = await http('POST', '/api/auth/setup', { body: { email: admin.email, name: 'Release Validation', password: admin.password, setupToken: readFileSync(path.join(clone, 'data/setup.token'), 'utf8').trim() } });
      check('admin setup through the HTTP API returns an enrolment secret', created.status === 201 && created.data?.secret && created.data?.challenge, `HTTP ${created.status}`);
      admin.totp = secret(created.data.secret); (created.data.recoveryCodes || []).forEach(secret); secret(created.data.uri); secret(created.data.challenge);
      const verified = await http('POST', '/api/auth/verify', { body: { challenge: created.data.challenge, code: await nextCode() } });
      check('TOTP enrolment completes and opens a session', verified.status === 200 && verified.cookie && verified.data?.csrfToken, `HTTP ${verified.status}`);
      admin.session = { cookie: secret(verified.cookie), csrf: secret(verified.data.csrfToken) }; evidence.preUpgradeSession = admin.session.cookie;
      check('setup is closed once an administrator exists', (await http('GET', '/api/auth/status')).data?.setupRequired === false);
      check('rows seeded through the v2.0.0 container', compose(['exec', '-T', 'api', 'node', '--input-type=module', '-e', SEED], { quiet: true }).out.trim() === 'seeded');
      evidence.baseline = digests(); tables.baseline = Object.fromEntries(Object.entries(evidence.baseline).map(([name, table]) => [name, { rows: table.count, sha256: table.hash }]));
      check(`baseline hashes captured for ${Object.keys(evidence.baseline).length} tables`, evidence.baseline.users.count === 1 && evidence.baseline.backups.count === 1 && evidence.baseline.backup_verifications.count === 0);
      await stateChecks(`${FROM_TAG} seeded`, true);
    });

    await phase(`Upgrade to ${tag} as the release notes say`, async () => {
      sh('git', ['fetch', '--tags', '--quiet']); sh('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', tag]); compose(['up', '-d', '--build']);
      await waitReady(tag);
      const old = await http('GET', '/api/state', { cookie: evidence.preUpgradeSession }); check('the session opened on 2.0.0 is still valid', old.status === 200, `HTTP ${old.status}`);
      const schema = schemaOf(tag), names = compose(['exec', '-T', 'api', 'ls', '/data/upgrade-snapshots'], { fail: false }).out.split('\n').filter(name => /^state-v\d+-to-v\d+-\d{8}T\d{9}Z\.sqlite$/.test(name));
      if (schema > 0) {
        check(`a pre-upgrade snapshot state-v0-to-v${schema}-*.sqlite exists in the volume`, names.some(name => name.startsWith(`state-v0-to-v${schema}-`)), names.join(', '));
        const snapshot = JSON.parse(inApi(SNAPSHOT, names.find(name => name.startsWith(`state-v0-to-v${schema}-`))));
        check('the snapshot is a healthy v2.0.0 database with the seeded rows', snapshot.version === 0 && snapshot.integrity === 'ok' && snapshot.servers === 1 && snapshot.backups === 1, JSON.stringify(snapshot));
        evidence.snapshot = names.find(name => name.startsWith(`state-v0-to-v${schema}-`));
      }
      await verifyRelease('after upgrade', tag);
    });

    await phase('Worker drain', async () => {
      check('no drain message before the stop', !/draining/.test(compose(['logs', '--no-color', 'worker']).out));
      const id = compose(['ps', '-q', 'worker']).out.trim(), grace = Number(sh('docker', ['inspect', '-f', '{{.Config.StopTimeout}}', id]).out.trim()) || 10, started = Date.now();
      compose(['stop', 'worker'], { timeout: (grace + 60) * 1000 }); const seconds = (Date.now() - started) / 1000;
      const logs = compose(['logs', '--no-color', 'worker']).out, exit = sh('docker', ['inspect', '-f', '{{.State.ExitCode}}', id]).out.trim();
      check('worker logged that it is draining', /draining: no new jobs will be claimed/.test(logs));
      check('worker released its lease and exited 0 (not SIGKILL)', /Worker drained; lease released\./.test(logs) && exit === '0', `exit ${exit}`);
      check(`worker stopped in ${seconds.toFixed(1)}s, inside the ${grace}s grace period`, seconds < grace); evidence.drainSeconds = Number(seconds.toFixed(1)); evidence.stopGraceSeconds = grace;
      if (compose(['exec', '-T', 'api', 'test', '-f', 'src/worker-status.js'], { fail: false }).status === 0) { const text = compose(['exec', '-T', 'api', 'node', 'src/worker-status.js']).out; check('worker-status shows the lease free and the heartbeat stopped', /Lease: free/.test(text) && /Heartbeat: stopped/.test(text), text.split('\n').slice(0, 2).join(' | ')); }
      compose(['up', '-d', 'worker']); await workerChecks('after worker restart', compose(['exec', '-T', 'api', 'test', '-f', 'src/worker-status.js'], { fail: false }).status === 0);
    });

    // Compatible downgrade (only additive migrations since 2.0.0) needs no data rollback; otherwise upgrade.sh restores the
    // pre-upgrade snapshot, which holds exactly the baseline, so the same comparison applies.
    await phase(`Downgrade to ${FROM_TAG} with upgrade.sh`, async () => {
      const rollback = evidence.versions.targetCompatFloor > 1; evidence.dataRollback = rollback;
      const statusDir = path.join(work, 'status'); mkdirSync(statusDir, { mode: 0o700 });
      const result = sh('sh', ['scripts/upgrade.sh', '--version', FROM_TAG, '--non-interactive', '--wait', '120', '--timeout', '300', '--status-file', path.join(statusDir, 'downgrade.json'), ...(rollback ? ['--allow-data-rollback'] : [])], { fail: false });
      check('upgrade.sh exits 0', result.status === 0, `exit ${result.status}`);
      readStatus(path.join(statusDir, 'downgrade.json'), evidence.versions.targetVersion, evidence.versions.fromVersion);
      check(`downgrade ${rollback ? 'restored the pre-upgrade snapshot' : 'needed no data rollback (compatible schema)'}`, rollback === /Restoring metadata snapshot|Downgrade needs the metadata snapshot/.test(result.all));
      await verifyRelease('after downgrade', FROM_TAG);
    });

    await phase(`Upgrade to ${tag} again with upgrade.sh`, async () => {
      // v2.0.0 has no scripts/upgrade.sh: use the target's copy from outside the checkout, as docs/upgrading.md instructs.
      const copy = path.join(work, 'tools'); mkdirSync(copy); writeFileSync(path.join(copy, 'upgrade.sh'), gitShow(tag, 'scripts/upgrade.sh').out);
      const result = sh('sh', [path.join(copy, 'upgrade.sh'), '--version', tag, '--non-interactive', '--wait', '120', '--timeout', '300', '--status-file', path.join(work, 'status', 'upgrade.json')], { fail: false });
      check('upgrade.sh exits 0', result.status === 0, `exit ${result.status}`);
      readStatus(path.join(work, 'status', 'upgrade.json'), evidence.versions.fromVersion, evidence.versions.targetVersion);
      await verifyRelease('after second upgrade', tag);
      const hold = compose(['exec', '-T', 'api', 'node', 'scripts/deployment-preflight.js', 'check'], { fail: false }); check('deployment hold is released', /"hold":false/.test(hold.out), hold.out.trim());
    });
  } catch (error) {
    failed = true; phases.push({ name: 'Setup', status: 'failed', ms: 0, checks: [], error: redact(error.message) }); console.error('FAILED: ' + redact(error.message));
  } finally {
    // Always leave the machine clean: containers, the named volumes, the local image and the temporary checkout.
    if (clone && existsSync(path.join(clone, 'compose.yaml'))) { compose(['down', '--volumes', '--remove-orphans', '--timeout', '30'], { fail: false }); sh('docker', ['image', 'rm', '-f', 'docknest:local'], { fail: false }); }
    if (work) rmSync(work, { recursive: true, force: true });
    if (transcript.length) { mkdirSync(path.join(out, 'logs'), { recursive: true }); writeFileSync(path.join(out, 'logs', '99-cleanup.log'), redact(transcript.splice(0).join('\n\n')) + '\n'); }
    delete evidence.baseline; delete evidence.preUpgradeSession; evidence.finishedAt = new Date().toISOString(); evidence.passed = !failed && phases.length > 0 && phases.every(entry => entry.status === 'passed');
    const icon = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' }, seconds = ms => `${Math.round(ms / 1000)}s`;
    const summary = [`## Release validation: ${evidence.versions.from || FROM_TAG} to ${evidence.versions.target || '(unresolved)'} - ${evidence.passed ? 'PASS' : 'FAIL'}`, '', '| Phase | Result | Time | Checks |', '| --- | --- | --- | --- |',
      ...phases.map(entry => `| ${entry.name} | ${icon[entry.status]} | ${seconds(entry.ms)} | ${entry.checks.filter(item => item.ok).length}/${entry.checks.length}${entry.error ? ' - ' + entry.error.replace(/\|/g, '/').slice(0, 160) : ''} |`), '',
      `Data: ${evidence.capture}. Docker ${evidence.versions.docker || '?'}, Compose ${evidence.versions.compose || '?'}, Node ${process.version}.`, ''].join('\n');
    writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); writeFileSync(path.join(out, 'summary.md'), summary);
    // Last line of defence: the redacted evidence must not contain any credential generated or read by this run.
    const files = d => readdirSync(d, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(d, entry.name)) : [path.join(d, entry.name)]);
    const dirty = files(out).filter(file => leaks(readFileSync(file, 'utf8')) > 0);
    if (dirty.length) { for (const file of dirty) writeFileSync(file, 'Removed: this file contained a credential.\n'); console.error(`FAILED: credentials found in evidence files (${dirty.map(file => path.basename(file)).join(', ')}); the files were blanked.`); failed = true; }
    console.log('\n' + summary); process.exitCode = failed || !evidence.passed ? 1 : 0;
  }
}
if (import.meta.filename === path.resolve(process.argv[1] || '')) await main();
