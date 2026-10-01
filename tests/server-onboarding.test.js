import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
const { utils } = ssh2;
import { prepareServerKey,serverReportCommand } from '../src/server-onboarding.js';

test('dedicated SSH key installation contains only its matching public key and a read-only server report',async()=>{
 const result=await prepareServerKey();
 const parsed=utils.parseKey(result.privateKey);
 assert.ok(!(parsed instanceof Error));
 assert.equal(result.publicKey.split(' ')[1],parsed.getPublicSSH().toString('base64'));
 assert.ok(result.installCommand.includes(result.publicKey));
 assert.ok(!result.installCommand.includes(result.privateKey));
 assert.ok(result.installCommand.includes("printf '%s\\n'"));
 assert.ok(result.installCommand.includes('grep -qxF'));
 assert.ok(result.installCommand.endsWith(serverReportCommand));
 assert.ok(!result.installCommand.includes('sshd_config'));
 assert.ok(!result.installCommand.includes('apt install'));
});
