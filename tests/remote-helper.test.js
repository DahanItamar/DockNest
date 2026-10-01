import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('remote restore archive validation rejects escape paths and links',t=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['remote/test_helper.py'],{encoding:'utf8'});
 if(result.error?.code==='ENOENT'){t.skip('Python3 is required for remote helper tests');return;}
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
