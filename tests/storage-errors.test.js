import test from 'node:test';
import assert from 'node:assert/strict';
import { storageConnectionError } from '../src/storage-errors.js';
test('storage diagnostics distinguish connection stages without exposing remote error text',()=>{
 const secret='private fixture password';
 const cases=[ [{level:'client-authentication'}, {}, /authentication failed/], [{}, {hostRejected:true}, /fingerprint does not match/], [{code:'ENOTFOUND'}, {}, /hostname/], [{code:'ECONNREFUSED'}, {}, /refused/], [{level:'client-timeout'}, {}, /timed out/], [{}, {phase:'sftp'}, /authentication succeeded/], [{}, {}, /SSH connection failed/] ];
 for(const [error,context,pattern] of cases){const message=storageConnectionError({...error,message:secret},context);assert.match(message,pattern);assert.ok(!message.includes(secret));}
});
