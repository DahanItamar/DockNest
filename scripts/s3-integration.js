// Real S3 semantics against a MinIO-compatible server (CI job s3-integration).
// Env: S3_ENDPOINT (e.g. http://127.0.0.1:9000), S3_ACCESS_KEY, S3_SECRET_KEY, optional S3_REGION.
// Provider mode (S3_BUCKET set, e.g. Cloudflare R2 or Backblaze B2): uses that existing bucket only, writes below a
// random /ci-<suffix> prefix, skips bucket creation and Object Lock, and deletes everything it wrote at the end.
// Credentials are never printed. Results: data/qa/s3-integration.json (S3_PROVIDER names the provider).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const {S3_ENDPOINT:endpoint,S3_ACCESS_KEY:accessKeyId,S3_SECRET_KEY:secretAccessKey,S3_REGION:region='us-east-1',S3_BUCKET:providerBucket}=process.env;
if(!endpoint||!accessKeyId||!secretAccessKey)throw new Error('Set S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY');
const s3=await import('../src/storage/s3.js'),{s3Request}=await import('../src/storage/s3-client.js');
const suffix=randomBytes(4).toString('hex'),lockBucket='docknest-lock-'+suffix,plainBucket=providerBucket||'docknest-plain-'+suffix;
const root=providerBucket?'/ci-'+suffix:'/ci';
const options=(bucket,extra={})=>({id:'ci',mode:'s3',name:'CI',endpoint,region,bucket,pathStyle:true,accessKeyId,secretAccessKey,root,objectLock:null,...extra});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const readAll=async stream=>{const parts=[];for await(const chunk of stream)parts.push(chunk);return Buffer.concat(parts);};
const results=[];
async function step(name,fn){const started=Date.now();try{await fn();results.push({name,status:'passed',ms:Date.now()-started});console.log('PASS',name);}catch(error){results.push({name,status:'failed',ms:Date.now()-started,error:error.message});console.log('FAIL',name,'-',error.message);}}

if(!providerBucket)await step('create buckets (one with Object Lock)',async()=>{
 await s3Request(options(lockBucket),{method:'PUT',headers:{'x-amz-bucket-object-lock-enabled':'true'}});
 await s3Request(options(plainBucket),{method:'PUT'});
});
const plain=options(plainBucket),bytes=randomBytes(40*1024*1024);
await step('multipart upload above 16 MiB streams and round-trips',async()=>{
 const chunks=Array.from({length:40},(_,index)=>bytes.subarray(index*1024*1024,(index+1)*1024*1024));
 await pipeline(Readable.from(chunks),s3.openWrite(plain,root+'/large.bin.partial'));
 assert.equal((await s3.statFile(plain,root+'/large.bin.partial')).size,bytes.length);
 assert.equal(sha(await readAll(await s3.openRead(plain,root+'/large.bin.partial'))),sha(bytes));
});
await step('ranged reads: first byte, middle, last byte, inclusive span',async()=>{
 for(const [start,end] of [[0,0],[20*1024*1024,20*1024*1024+4095],[bytes.length-1,bytes.length-1],[8*1024*1024-10,8*1024*1024+10]])
  assert.deepEqual(await readAll(await s3.openRead(plain,root+'/large.bin.partial',{start,end})),bytes.subarray(start,end+1));
 assert.deepEqual(await readAll(await s3.openRead(plain,root+'/large.bin.partial',{start:bytes.length-5})),bytes.subarray(bytes.length-5));
});
await step('conditional copy publish refuses an existing destination and a replaced source',async()=>{
 await s3.renameFile(plain,root+'/large.bin.partial',root+'/large.bin');
 assert.equal(sha(await readAll(await s3.openRead(plain,root+'/large.bin'))),sha(bytes));
 await assert.rejects(s3.statFile(plain,root+'/large.bin.partial'),error=>error.code==='ENOENT');
 await pipeline(Readable.from([Buffer.from('second')]),s3.openWrite(plain,root+'/second.partial'));
 await assert.rejects(s3.renameFile(plain,root+'/second.partial',root+'/large.bin'),/already exists/);
 // The adapter pins copies with x-amz-copy-source-if-match; a stale ETag must be refused by the server.
 await assert.rejects(s3Request(plain,{method:'PUT',key:root.slice(1)+'/third',headers:{'x-amz-copy-source':'/'+plainBucket+root+'/second.partial','x-amz-copy-source-if-match':'"00000000000000000000000000000000"'}}),error=>error.s3Status===412||error.s3Code==='PreconditionFailed');
});
await step('readiness probe: write, multipart, copy, read, range and delete',async()=>{
 const probe=await s3.test(plain);
 for(const name of ['writeVerified','multipartVerified','copyVerified','readVerified','rangeVerified','deleteVerified'])assert.equal(probe[name],true,name);
});
const locked=options(lockBucket,{objectLock:{mode:'GOVERNANCE',days:1}});
if(providerBucket){
 await step('clean up: every object this run wrote is removed',async()=>{
  for(const file of await s3.list(plain,root))await s3.removeFile(plain,file.value);
  assert.deepEqual(await s3.list(plain,root),[]);
 });
}else{
await step('readiness probe passes with Object Lock and explains a bucket without it',async()=>{
 assert.equal((await s3.test(locked)).objectLock,'enabled');
 await assert.rejects(s3.test(options(plainBucket,{objectLock:{mode:'GOVERNANCE',days:1}})),/Object Lock is not enabled/);
});
await step('publish applies retention; delete is refused before it ends',async()=>{
 await pipeline(Readable.from([randomBytes(1024)]),s3.openWrite(locked,root+'/locked.partial'));
 await s3.renameFile(locked,root+'/locked.partial',root+'/locked');
 const attrs=await s3.statFile(locked,root+'/locked');
 assert.equal(attrs.lockMode,'GOVERNANCE');assert.ok(Date.parse(attrs.retainUntil)>Date.now()+86400000-120000);
 await assert.rejects(s3.removeFile(locked,root+'/locked'),error=>error.code==='EOBJECTLOCKED');
 await assert.rejects(s3Request(locked,{method:'DELETE',key:'ci/locked',query:{versionId:attrs.versionId}}),error=>[400,403].includes(error.s3Status));
});
await step('a short lock expires and removal then succeeds',async()=>{
 const until=new Date(Date.now()+3000).toISOString().replace(/\.\d{3}Z$/,'Z');
 await s3Request(locked,{method:'PUT',key:'ci/short',headers:{'x-amz-object-lock-mode':'GOVERNANCE','x-amz-object-lock-retain-until-date':until,'content-md5':createHash('md5').update('short').digest('base64')},body:Buffer.from('short')});
 await assert.rejects(s3.removeFile(locked,root+'/short'),error=>error.code==='EOBJECTLOCKED');
 await new Promise(resolve=>setTimeout(resolve,5000));
 await s3.removeFile(locked,root+'/short');
 await assert.rejects(s3.statFile(locked,root+'/short'),error=>error.code==='ENOENT');
});
}
await mkdir('data/qa',{recursive:true});
await writeFile('data/qa/s3-integration.json',JSON.stringify({kind:'s3-integration',server:process.env.S3_PROVIDER||process.env.S3_SERVER_IMAGE||'unknown',finishedAt:new Date().toISOString(),results},null,2)+'\n');
const failed=results.filter(result=>result.status==='failed').length;
console.log(failed?failed+' S3 integration step(s) failed.':'S3 integration passed against '+(process.env.S3_PROVIDER||'a MinIO-compatible server')+'. Linux backup/restore over S3 is not covered here.');
process.exitCode=failed?1:0;
