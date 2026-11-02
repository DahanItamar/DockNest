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
