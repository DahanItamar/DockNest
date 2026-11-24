import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeHelperBundle } from '../src/helper-bundle.js';
// The Python tests import the built helper.py (build/remote), the same bytes servers receive.
writeHelperBundle();
test('remote helper rejects unsafe archives and preserves safe maintenance failure states',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_helper.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for remote helper verification; install it before running npm run check');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('Redis contracts reject unsafe persistence, authentication, shutdown and key-check states',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_redis.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for Redis contract verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('MongoDB contracts refuse unsafe topology, TLS, logging, credentials and lock states and keep credentials out of argv',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_mongo.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for MongoDB contract verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('online database dumps: opt-in, fail closed with a reason, whole checked artifacts, credentials in the container, strict loading',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_dumps.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for online dump verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('incremental backups: snapshot state, chain links verified before extraction, dumpdir path checks and ZIP refusal',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_incremental.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for incremental backup helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('move helper operations mask settings, journal before effects, never overwrite and keep isolated restore unchanged',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_moves.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for move helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('large SQLite databases are checked online, reused only when byte-identical, and streamed artifacts stay verifiable',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_sqlite_online.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for SQLite capture verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('install on server runs only fixed argv for a fixed package list and refuses everything else',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_install.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for install helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('restore test helper journals before every create, limits and isolates the copy, blocks mail and tears down only what it made',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_restore_tests.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for restore test helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('self-heal helper pins the docker events format, never matches copies, bounds the stream and restarts only a running unhealthy container',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_heal.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for self-heal helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('Safe Edit helper gates privilege, keeps env values out of argv, journals before writing and rolls back idempotently',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_edit.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for Safe Edit helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('server cleanup protects sites, backups, restore tests, moves, old copies and DockNest, and removes only previewed items by ID',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_cleanup.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for server cleanup helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('certificate facts come only from public certificate files, certbot renewal outcomes and verified probes, and never fail an operation',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_certificates.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for certificate helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('proxy routes from nginx, Nginx Proxy Manager, Caddy and Traefik carry only hosts, ports, upstreams and certificate names',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_domains.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for proxy route helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('copies keep the original read-only root, dropped capabilities and security options, or refuse with a reason',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_hardening.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for copy hardening verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('the helper source keeps shared state in common.py and builds into one helper.py that loads in a safe order',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_bundle.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for remote helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('hardening facts: privileged, socket, root, ports, limits, image pin, healthcheck, capabilities and no secrets',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_hardening_score.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for hardening helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('launch steps run git under env -i with a pinned address, keep the deploy key in a removed 0600 file, journal before every create and tear down only what they made',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_launch.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for launch helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('app keys: env, ini, php-array and file detection, the proof from packaged bytes, restored fingerprints, and no key value on stdout',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_keys.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for key helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('restore check finds host schedules, Docker objects and files outside the app folder without exposing commands',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_restore_gaps.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for restore check helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('linked apps facts: Compose project and depends_on, user-defined networks, volumes, bind sources and links, and no secrets',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_app_links.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for linked apps helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('Portainer and Dockge stacks map to their Compose folder on the host and are marked with their manager',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_stack_managers.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for stack manager helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('a plain container gets one run spec: docker create flags for Move, a Compose file and env files for its backup, a preview without env values',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_runspec.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for run spec helper verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('runtime: rootful Docker argv unchanged, rootless argv fixed, unknown ID maps and units refused',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_runtime.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for runtime verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('NAS staging base: free space comes from the persistent working folder, never from memory storage',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_nas_staging.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for NAS staging verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('engine discovery: subuid users, real storage folders, owned sockets, tagged containers, and Podman or rootless apps refused by running operations',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_engines.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for engine verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('Podman and rootless backup and restore: format 3 gate, home-only sources, ID translation, root-owned restore folder, and refusals',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_podman_backup.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for rootless backup verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('Podman and rootless restore tests: own engine, one isolated container, cgroup delegation, recorded engine for teardown and the reaper, and refusals',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_podman_restore_tests.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for restore test verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('Podman and rootless cleanup and move facts: copies kept, orphan restore folders offered, removal looks again, port floor and linger',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_podman_cleanup.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for cleanup verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
test('Podman and rootless image archives stream through descriptors: load on stdin from a root-opened file, save to a new private file, rootful Docker unchanged',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_podman_images.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT')throw new Error('Python3 is required for image archive verification');
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
