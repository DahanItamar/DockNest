import test from 'node:test';
import assert from 'node:assert/strict';
import {isIntegrityChecked,integrityText,levelEvidence,levelText,recoveryStatus,restoreFact,verificationSummary} from '../web/verification-core.js';
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

const checked={status:'passed',checkedAt:at},attempt={status:'failed',method:'isolated recovery attempt did not complete',checkedAt:at};
const make=levels=>({verified:true,capturedAt:at,verification:{integrity:checked,...none,...levels}});

test('a helper-reported failure takes the badge in the error tone and moves integrity to the line',()=>{
 const backup=make({isolatedRestore:{status:'failed',method:'helper health check',checkedAt:at},application:{status:'failed',method:'row count mismatch',checkedAt:at}});
 assert.equal(levelText('application',backup.verification.application),'Application checks failed');
 const row=recoveryStatus(backup);assert.equal(row.badge,'Isolated restore failed');assert.equal(row.line,'Integrity checked');assert.equal(row.failed,true);
 assert.deepEqual(restoreFact(backup),{text:'restore test failed',tone:'warning'});
});

test('an incomplete restore attempt is not shown as a failed restore or failed application checks',()=>{
 const backup=make({isolatedRestore:attempt,application:attempt});
 assert.equal(levelText('isolatedRestore',attempt),'Restore attempt did not complete');assert.equal(levelText('application',attempt),'Application checks not run');
 const summary=verificationSummary(backup);assert.notEqual(summary.tone,'bad');assert.doesNotMatch(summary.text,/failed/);
 const row=recoveryStatus(backup);assert.equal(row.badge,'Integrity checked');assert.equal(row.line,'Restore attempt did not complete');assert.equal(row.failed,false);
 assert.deepEqual(restoreFact(backup),{text:'restore attempt did not complete',tone:'warning'});
});

test('partial and declared evidence stay visible and are never worded as passed',()=>{
 assert.equal(recoveryStatus(make({isolatedRestore:{status:'partial'}})).line,'Isolated restore partially checked');
 assert.equal(recoveryStatus(make({application:{status:'declared'}})).line,'Application checks declared by operator');
 assert.equal(recoveryStatus(make({isolatedRestore:{status:'partial'},consistency:{status:'declared'}})).line,'Isolated restore partially checked','Partial outranks declared');
 assert.equal(recoveryStatus(make({isolatedRestore:checked,application:{status:'partial'}})).line,'Isolated restore tested','Strongest passed outranks partial');
 assert.equal(recoveryStatus(make({})).line,'Restore not tested');
 assert.equal(verificationSummary({verified:false}).text,'Nothing tested yet');
 assert.deepEqual(restoreFact(make({})),{text:'restore not tested',tone:'stored'});
 assert.deepEqual(restoreFact(make({isolatedRestore:checked})),{text:'restore tested',tone:'stored'});
});
