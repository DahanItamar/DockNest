import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const script=resolve('scripts/audit-repository.js');
const audit=async text=>{
 const directory=await mkdtemp(join(tmpdir(),'docknest-audit-'));
 try{
  execFileSync('git',['init','-q'],{cwd:directory});await writeFile(join(directory,'notes.md'),text);execFileSync('git',['add','notes.md'],{cwd:directory});
  return spawnSync(process.execPath,[script],{cwd:directory,encoding:'utf8'});
 }finally{await rm(directory,{recursive:true,force:true});}
};
test('privacy audit allows protocol-defined special-purpose ranges but still reports public addresses',async()=>{
 const reserved=['169.254.169.254','100.100.100.200','100.64.0.1','192.0.0.192','198.18.0.1','224.0.0.1','240.0.0.1'].join(' ');
 assert.equal((await audit(reserved)).status,0);
 // Built at runtime so this file does not itself contain a public address.
 const result=await audit('server '+[93,184,216,34].join('.'));assert.equal(result.status,1);assert.match(result.stderr,/non-example IP address/);
 assert.equal((await audit('edge '+[100,128,0,1].join('.'))).status,1,'Only 100.64.0.0/10 is allowed');
});
