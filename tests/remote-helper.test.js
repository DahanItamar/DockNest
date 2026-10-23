import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
