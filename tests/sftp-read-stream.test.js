import test from 'node:test';
import assert from 'node:assert/strict';
import {sftpReadStream} from '../src/sftp-read-stream.js';

function fixture(content,{failAt,partial=7000}={}){
 let active=0,maximum=0,closed=0;
 const sftp={
  open(_file,flags,cb){assert.equal(flags,'r');setImmediate(()=>cb(null,Buffer.from('fixture')));},
  fstat(_handle,cb){setImmediate(()=>cb(null,{size:content.length}));},
  read(_handle,buffer,offset,length,position,cb){
   active++;maximum=Math.max(maximum,active);
   setTimeout(()=>{active--;if(failAt!==undefined&&position>=failAt)return cb(new Error('Read failed'));const bytes=Math.min(partial,length,content.length-position);content.copy(buffer,offset,position,position+bytes);cb(null,bytes);},position<65536?3:0);
  },
  close(_handle,cb){closed++;setImmediate(()=>cb());}
 };
 return {sftp,stats:()=>({maximum,closed})};
}
test('parallel SFTP reads preserve order, inclusive ranges and partial server responses',async()=>{
 const content=Buffer.alloc(2*1024*1024);for(let i=0;i<content.length;i++)content[i]=i%251;
 const f=fixture(content),chunks=[];
 for await(const chunk of sftpReadStream(f.sftp,'/fixture',{start:19,end:1300123}))chunks.push(chunk);
 assert.deepEqual(Buffer.concat(chunks),content.subarray(19,1300124));
 assert.ok(f.stats().maximum>1);assert.ok(f.stats().maximum<=16);assert.equal(f.stats().closed,1);
});
test('SFTP failure and consumer cancellation close the owned handle once',async()=>{
 const content=Buffer.alloc(2*1024*1024),broken=fixture(content,{failAt:65536});
 await assert.rejects(async()=>{for await(const _ of sftpReadStream(broken.sftp,'/fixture')){};},/Read failed/);
 assert.equal(broken.stats().closed,1);
 const cancelled=fixture(content),stream=sftpReadStream(cancelled.sftp,'/fixture');
 for await(const _ of stream)break;
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(cancelled.stats().closed,1);assert.ok(cancelled.stats().maximum<=16);
});
test('empty files, EOF beyond a range and premature truncation are handled safely',async()=>{
 const empty=fixture(Buffer.alloc(0));for await(const _ of sftpReadStream(empty.sftp,'/fixture'))assert.fail('Empty file returned data');assert.equal(empty.stats().closed,1);
 const f=fixture(Buffer.from('small')),chunks=[];for await(const chunk of sftpReadStream(f.sftp,'/fixture',{start:3,end:99}))chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'ll');
 const truncated=fixture(Buffer.from('small'));truncated.sftp.fstat=(_handle,cb)=>setImmediate(()=>cb(null,{size:100}));
 await assert.rejects(async()=>{for await(const _ of sftpReadStream(truncated.sftp,'/fixture')){};},/ended before/);assert.equal(truncated.stats().closed,1);
 assert.throws(()=>sftpReadStream(f.sftp,'/fixture',{start:-1}),/Invalid/);
});
