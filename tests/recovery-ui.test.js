import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryText, recoveryValue, phaseRows, aboutTime } from '../web/recovery/model.js';
import { age } from '../web/age.js';
import { age as modelAge } from '../web/restore-tests/model.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const ago = days => new Date(NOW - days * 86_400_000).toISOString();

test('one age formatter serves "Passed X ago" and "proven X ago"', () => {
  assert.equal(modelAge, age);
  const text = recoveryText({ seconds: 720, provenAt: ago(3), stale: false, mayBeLow: false }, NOW);
  assert.equal(text.line, 'Back in about 12 min · proven 3 days ago');
  assert.equal(age(ago(3), NOW), '3 days ago');
});

test('recovery wording follows shared/recovery-time.js', () => {
  assert.equal(aboutTime(90), 'under 2 min');
  assert.equal(recoveryText({ seconds: 90, provenAt: ago(1) }, NOW).line, 'Back in under 2 min · proven yesterday');
  assert.equal(aboutTime(8400), 'about 2.3 h');
  assert.equal(recoveryValue({ seconds: 720 }), 'About 12 min');
  assert.equal(recoveryValue(null), null);
  assert.equal(recoveryText(null), null);
  assert.equal(recoveryText({ seconds: 0, provenAt: ago(1) }), null);
});

test('stale and may-be-low are carried, never invented', () => {
  const stale = recoveryText({ seconds: 1500, provenAt: ago(41), stale: true, mayBeLow: true }, NOW);
  assert.equal(stale.stale, true);
  assert.equal(stale.mayBeLow, true);
  assert.equal(recoveryText({ seconds: 600, provenAt: ago(2) }, NOW).stale, false);
});

test('phase rows: text values, shares add up, empty phases are left out', () => {
  const rows = phaseRows({ copy: 240, restore: 360, start: 120 });
  assert.deepEqual(rows.map(row => [row.label, row.text]), [['Get the backup', '4 min'], ['Restore data', '6 min'], ['Start and check', '2 min']]);
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  assert.deepEqual(phaseRows({ copy: 30, restore: 0, start: 0 }).map(row => row.text), ['under 1 min']);
  assert.deepEqual(phaseRows(null), []);
  assert.deepEqual(phaseRows({ copy: 0, restore: 0, start: 0 }), []);
});
