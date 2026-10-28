import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {splitFieldErrors,regionFromEndpoint,retentionWindowDays,lockWarnings} from '../web/storage-form.js';

// Chrome compiles the HTML pattern attribute with the v flag; an invalid pattern silently disables validation.
const patterns=async()=>{
 const found=[];
 for(const name of (await readdir(new URL('../web/',import.meta.url))).filter(name=>name.endsWith('.jsx')))
  for(const match of (await readFile(new URL('../web/'+name,import.meta.url),'utf8')).matchAll(/pattern="([^"]*)"/g))found.push({file:name,source:match[1]});
 return found;
};
const compile=source=>new RegExp('^(?:'+source+')$','v');
test('every pattern attribute is a valid v-flag regular expression',async()=>{
 const all=await patterns();assert.ok(all.length>=6);
 for(const {file,source} of all)assert.doesNotThrow(()=>compile(source),file+': '+source);
});
test('storage form patterns accept real values and reject malformed ones (SFTP fingerprint regression included)',async()=>{
 const all=await patterns(),find=prefix=>compile(all.find(item=>item.file==='storage-targets.jsx'&&item.source.startsWith(prefix)).source);
 const region=find('[a-z0-9\\-]{1,40}'),bucket=find('[a-z0-9][a-z0-9.'),hostKey=find('(?:[a-fA-F0-9]{64}');
 for(const value of ['us-east-1','auto','us-west-004','eu-central-1'])assert.ok(region.test(value),value);
 for(const value of ['NOT VALID REGION','Us-East-1',''])assert.ok(!region.test(value),value);
 for(const value of ['docknest-backups','a.b-c','abc'])assert.ok(bucket.test(value),value);
 for(const value of ['Bad_Bucket!!','ab','-abc','abc-'])assert.ok(!bucket.test(value),value);
 for(const value of ['a'.repeat(64),'SHA256:'+'A+/b'.repeat(10)+'abc','SHA256:'+'A+/b'.repeat(10)+'abc='])assert.ok(hostKey.test(value),value);
 for(const value of ['a'.repeat(63),'SHA256:short','MD5:'+'a'.repeat(32)])assert.ok(!hostKey.test(value),value);
});
test('validation messages are split into form fields without raw paths',()=>{
 assert.deepEqual(splitFieldErrors('bucket: Enter a valid bucket name.; region: Enter the bucket region; objectLock.days: Too big'),{fields:{bucket:'Enter a valid bucket name.',region:'Enter the bucket region',lockDays:'Too big'},first:'bucket',message:'Bucket: Enter a valid bucket name. Region: Enter the bucket region Lock days: Too big'});
 assert.deepEqual(splitFieldErrors('S3 access was denied. Check the key; then retry.'),{fields:{},first:null,message:'S3 access was denied. Check the key; then retry.'});
 assert.deepEqual(splitFieldErrors('mystery.path: Something; hostKey: Use a fingerprint; with detail'),{fields:{hostKey:'Use a fingerprint; with detail'},first:'hostKey',message:'Something SSH host fingerprint: Use a fingerprint; with detail'});
 assert.equal(splitFieldErrors(': Invalid input').message,'Invalid input');
});
test('regions are derived from well-known endpoints only',()=>{
 for(const [endpoint,region] of [['https://s3.us-west-004.backblazeb2.com','us-west-004'],['https://s3.eu-central-1.amazonaws.com','eu-central-1'],['https://s3.amazonaws.com','us-east-1'],['https://s3.dualstack.eu-west-1.amazonaws.com','eu-west-1'],['https://S3.EU-CENTRAL-2.WASABISYS.COM','eu-central-2'],['https://s3.wasabisys.com','us-east-1'],['https://0123abcd.r2.cloudflarestorage.com','auto'],['https://minio.example.internal:9000',null],['not a url',null]])assert.equal(regionFromEndpoint(endpoint),region,endpoint);
});
test('retention windows and Object Lock warnings',()=>{
 assert.equal(retentionWindowDays('0 2 * * *',3),3);assert.equal(retentionWindowDays('15 * * * *',48),2);assert.equal(retentionWindowDays('0 3 * * 1',4),28);assert.equal(retentionWindowDays('*/5 1-2 * * *',7),null);
 const sites=[{id:'a',name:'Shop'},{id:'b',name:'Blog'}],daily={site_id:'a',enabled:1,schedule:'0 2 * * *',retention:3};
 assert.match(lockWarnings(30,sites,[daily])[0],/Shop keeps about 3 days/);
 assert.deepEqual(lockWarnings(2,sites,[daily]),[]);
 assert.deepEqual(lockWarnings(30,sites,[{...daily,enabled:0}]),[]);
 assert.match(lockWarnings(30,sites,[{...daily,schedule:'*/5 1-2 * * *'}])[0],/could not be read/);
 assert.equal(lockWarnings(400,sites,[daily]).length,2);
});
test('S3 is no longer labelled beta anywhere',async()=>{
 const docs=await readFile(new URL('../docs/storage-backends.md',import.meta.url),'utf8'),readme=await readFile(new URL('../README.md',import.meta.url),'utf8'),ui=await readFile(new URL('../web/storage-targets.jsx',import.meta.url),'utf8');
 assert.match(docs.split(/\r?\n/).find(line=>line.startsWith('| S3-compatible |')),/^\| S3-compatible \| Supported\./);
 assert.equal(readme.includes('S3-compatible storage is in beta'),false);
 assert.doesNotMatch(ui,/Beta|BETA|\(beta\)/);
});
