import test from 'node:test';
import assert from 'node:assert/strict';
import {statusState} from '../web/status-state.js';

test('account active is success while in-flight jobs stay running',()=>{
 assert.equal(statusState('active'),'success');
 for(const v of ['running','in_progress','in progress'])assert.equal(statusState(v),'running');
 assert.equal(statusState('pending'),'queued');
 assert.equal(statusState('revoked'),'failed');
 assert.equal(statusState('recovery_required'),'needs-review');
 assert.equal(statusState('completed'),'success');
});
