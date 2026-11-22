import test from 'node:test';
import assert from 'node:assert/strict';
import {statusText} from '../src/runbook/guide.js';

const at = '2026-01-05T10:00:00.000Z';
test('the status line names the source the restore test read', () => {
  assert.match(statusText({backup: {verified: {at, source: 'main'}}}), /, from the main backup\.$/);
  assert.match(statusText({backup: {verified: {at, source: 'copy'}}}), /, from the off-site copy\.$/);
  assert.match(statusText({backup: {verified: {at}}}), /, from the main backup\.$/, 'older tests read the main backup');
});
