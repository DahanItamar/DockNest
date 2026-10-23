import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temporary=await mkdtemp(join(tmpdir(),'dbm-clock-'));
process.env.DATA_DIR=join(temporary,'data');
process.env.BACKUP_DIR=temporary;
process.env.BACKUP_STORAGE='local';
process.env.NODE_ENV='test';
const {trustedCaptureTime}=await import('../src/engine.js');

test('a capture time inside the job window is kept as reported by the source server',()=>{
 const started=Date.UTC(2026,9,23,2,0,0),now=started+30*60*1000,reported=(started+5*60*1000)/1000;
 assert.deepEqual(trustedCaptureTime(reported,started,now),{ms:reported*1000,adjusted:false});
 // Small clock differences between the hosts are tolerated.
 assert.equal(trustedCaptureTime((started-2*60*1000)/1000,started,now).adjusted,false);
 assert.equal(trustedCaptureTime((now+2*60*1000)/1000,started,now).adjusted,false);
});

test('a reset or future source clock cannot reorder recovery points for retention',()=>{
 const started=Date.UTC(2026,9,23,2,0,0),now=started+30*60*1000;
 // RTC reset to 1970 would sort the newest backup as the oldest and prune it at once.
 assert.deepEqual(trustedCaptureTime(1,started,now),{ms:now,adjusted:true});
 // A clock years ahead would keep that point above every later one.
 assert.deepEqual(trustedCaptureTime(Date.UTC(2035,0,1)/1000,started,now),{ms:now,adjusted:true});
 for(const value of [undefined,null,'1761184800',Number.NaN,Number.POSITIVE_INFINITY,{}])assert.deepEqual(trustedCaptureTime(value,started,now),{ms:now,adjusted:true});
});
