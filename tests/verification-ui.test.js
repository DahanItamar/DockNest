import test from 'node:test';
import assert from 'node:assert/strict';
import {isIntegrityChecked,integrityText,levelEvidence,verificationSummary} from '../web/verification-core.js';
import {bucketActivity} from '../web/chart-data.js';

const at='2026-10-02T10:00:00Z',none={consistency:{status:'not-tested'},isolatedRestore:{status:'not-tested'},application:{status:'not-tested'}};
const legacyApi={id:'api',verified:true,capturedAt:at,verification:{integrity:{status:'passed',source:'legacy'},...none}};
const legacyFallback={id:'fallback',verified:true,capturedAt:at,verification:{integrity:{status:'not-tested'},...none}};
const unchecked={id:'unchecked',verified:false,capturedAt:at,verification:{integrity:{status:'not-tested'},...none}};
const scrubbed={id:'scrubbed',verified:true,capturedAt:at,verification:{integrity:{status:'failed',checkedAt:at},...none}};

test('legacy verified backups read as integrity checked in labels, summaries and aggregates alike',()=>{
 for(const backup of [legacyApi,legacyFallback]){
  assert.equal(isIntegrityChecked(backup),true);assert.equal(integrityText(backup),'Integrity checked');
  assert.equal(levelEvidence(backup,'integrity').source,'legacy');assert.equal(verificationSummary(backup).tone,'ok');
 }
 assert.equal(integrityText(unchecked),'Integrity not checked');assert.equal(isIntegrityChecked(unchecked),false);
 assert.equal(integrityText(scrubbed),'Integrity failed','A recorded failure wins over the legacy flag');assert.equal(isIntegrityChecked(scrubbed),false);
 const backups=[legacyApi,legacyFallback,unchecked,scrubbed],series=bucketActivity({backups,jobs:[]},'week',new Date('2026-10-02T12:00:00Z')).series;
 const total=index=>series[index].values.reduce((a,b)=>a+b,0);
 assert.equal(total(0),backups.filter(b=>integrityText(b)==='Integrity checked').length,'Chart matches the rows labelled Integrity checked');
 assert.equal(total(1),2);
});
