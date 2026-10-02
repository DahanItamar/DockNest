import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {sftpWriteStream} from '../src/sftp-streams.js';

test('batched SFTP failure settles the Writable callback once and preserves exclusive protected creation',async()=>{
 let errors=[];
 const raw=new Writable({write(_chunk,_encoding,cb){cb();},writev(_chunks,cb){setImmediate(()=>{cb(new Error('fixture disconnected'));cb(new Error('fixture disconnected again'));});}});
 const sftp={createWriteStream(file,options){assert.equal(file,'/fixture');assert.equal(options.flags,'wx');assert.equal(options.mode,0o600);assert.equal(options.highWaterMark,1024*1024);return raw;}};
 const stream=sftpWriteStream(sftp,'/fixture');stream.on('error',error=>errors.push(error.message));
 const closed=new Promise(resolve=>stream.once('close',resolve));
 stream.cork();stream.write('first');stream.write('second');stream.uncork();
 await closed;await new Promise(resolve=>setTimeout(resolve,10));
 assert.deepEqual(errors,['fixture disconnected']);
});
