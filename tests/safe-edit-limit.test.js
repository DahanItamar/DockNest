// The apply time limit rules the Review step uses (web/site-edit/safe-edit-client.js): the range the server also enforces,
// the wording, and when a limit earns a warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMIT, validLimit, limitText, limitWarnings, historyChanges } from '../web/site-edit/safe-edit-client.js';
import { LIMITS } from '../src/site-edits/state.js';

test('the client range is the server range', () => {
  assert.deepEqual(LIMIT, LIMITS.timeLimit);
});

test('a limit is a whole number of seconds from 60 to 600', () => {
  for (const good of ['60', '120', ' 300 ', '600', 90]) assert.equal(validLimit(good), true, String(good));
  for (const bad of ['59', '601', '', '12.5', '1e2', '-60', 'abc', '0600x', '6000']) assert.equal(validLimit(bad), false, bad);
});

test('limits read as minutes when whole, else as seconds', () => {
  assert.equal(limitText(60), '1 minute'); assert.equal(limitText(120), '2 minutes'); assert.equal(limitText(600), '10 minutes'); assert.equal(limitText(90), '90 seconds');
});

test('only a long limit and a limit shorter than the data copy warn', () => {
  assert.deepEqual(limitWarnings('120', null), []);
  assert.deepEqual(limitWarnings('300', null), [], '5 minutes is not a long wait');
  assert.deepEqual(limitWarnings('600', null).map(item => [item.title, item.text]), [['Longer wait', 'The site can stay offline for up to 10 minutes before it rolls back.']]);
  assert.deepEqual(limitWarnings('360', 0).map(item => item.text), ['The site can stay offline for up to 6 minutes before it rolls back.']);
  const short = limitWarnings('60', 4.2 * 1024 ** 3);
  assert.deepEqual(short.map(item => item.title), ['Short time limit']);
  assert.equal(short[0].text, 'Copying 4.2 GB of data may need more than 60 seconds. If it does not finish, the change rolls back.');
  assert.deepEqual(limitWarnings('600', 4.2 * 1024 ** 3).map(item => item.title), ['Longer wait'], 'a long limit covers a copy of this size');
  assert.deepEqual(limitWarnings('120', 100 * 1024 ** 2), [], 'a small copy fits');
  assert.deepEqual(limitWarnings('30', 4.2 * 1024 ** 3), [], 'an invalid limit has its own message');
});

test('history names an undo', () => {
  assert.equal(historyChanges({ undoOf: 'x', changed: [], env: {} }), 'Undid a change');
  assert.equal(historyChanges({ changed: ['services.web.image'], env: {} }), 'web.image');
});
