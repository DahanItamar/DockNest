import test from 'node:test';
import assert from 'node:assert/strict';
import { kitDateOf } from '../web/keys/kit-date.js';

const date = '2026-11-18T03:10:00.000Z';
test('the kit date shows only when a kit was found', () => {
  assert.equal(kitDateOf({ result: 'passed', reason: null, kitDate: date }), date);
  assert.equal(kitDateOf({ result: 'failed', reason: 'hashes', kitDate: date }), date, 'a kit that was found but did not open keeps its date');
  assert.equal(kitDateOf({ result: 'failed', reason: 'hashes', kitDate: null }), null, 'no date on record, none shown');
  for (const reason of ['no_kit', 'unreadable', 'no_passphrase', 'error', null]) assert.equal(kitDateOf({ result: 'failed', reason, kitDate: date }), null, `never reached a kit (${reason})`);
  assert.equal(kitDateOf(null), null); assert.equal(kitDateOf({ result: 'passed', kitDate: null }), null);
});
