import test from 'node:test';
import assert from 'node:assert/strict';
import {betaGate} from '../src/beta-gate.js';
test('controlled beta rejects incomplete, stale, mismatched evidence and untested real boot recovery',()=>{
 const release='a'.repeat(40),evidence={formatVersion:2,status:'passed',release,at:new Date().toISOString(),nodeChecks:'passed',privacyChecks:'passed',browserChecks:'passed',engines:['postgres','mysql','mariadb'].map(engine=>({engine,version:'16.0',imageId:'sha256:'+'b'.repeat(64),digests:['fixture@sha256:'+'c'.repeat(64)],checks:['native-version','native-clean-shutdown','isolated-data-restore','live-source-preserved']})),milestones:['M1: actual Linux nested/tmpfs mounts block before stop; NFS/CIFS mount-table policy fixtures pass','M2/M3: mixed-engine capture and isolated native data checks','M2: forced native database kill rejects consistency and recovers source','M4: Linux boot journal driver recovers native source after simulated boot identity change','M4: independent Linux root archive rejects manager-uid deletion']};
 evidence.redis={status:'passed',version:'7.4.9',imageId:'sha256:'+'b'.repeat(64),digests:['redis@sha256:'+'c'.repeat(64)],checks:['native version','clean shutdown consistency','network-none named-key recovery','source live-change preserved','real SIGKILL rejection and source recovery']};
 evidence.legacyCompatibility={historicalCapture:true,originalMetadataPreserved:true,formatVersion:1,helperRevision:'e'.repeat(40),automaticApplicationStatus:'not-tested'};
 assert.equal(betaGate(evidence,{release}).allowed,true);
 for(const invalid of [{...evidence,redis:undefined},{...evidence,legacyCompatibility:undefined},{...evidence,redis:{...evidence.redis,checks:[]}}])assert.equal(betaGate(invalid,{release}).allowed,false);
 for(const invalid of [undefined,{...evidence,status:'failed'},{...evidence,release:'d'.repeat(40)},{...evidence,at:'2020-01-01'},{...evidence,engines:[]},{...evidence,privacyChecks:'failed'}])assert.equal(betaGate(invalid,{release}).allowed,false);
 assert.equal(betaGate(evidence,{release,requireHostReboot:true}).allowed,false);
});
