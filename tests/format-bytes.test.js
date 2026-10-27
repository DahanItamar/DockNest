// One decimal byte formatter for the whole app (shared/format-bytes.js): 1 KB = 1,000 bytes, 1 TB = 10^12.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../shared/format-bytes.js';

test('small and zero values', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(null), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes('abc'), '0 B');
});

test('decimal steps, one decimal under 100, whole units drop the decimal', () => {
  assert.equal(formatBytes(1000), '1 KB');
  assert.equal(formatBytes(1500), '1.5 KB');
  assert.equal(formatBytes(1500000), '1.5 MB');
  assert.equal(formatBytes(64e9), '64 GB');
  assert.equal(formatBytes(64.25e9), '64.3 GB');
  assert.equal(formatBytes(1.8e12), '1.8 TB');
  assert.equal(formatBytes(2e12), '2 TB', 'a configured 2 TB reads as 2 TB');
  assert.equal(formatBytes(123.4e9), '123 GB');
});

test('rounding never shows 1000 of a unit', () => {
  assert.equal(formatBytes(999950), '1 MB');
  assert.equal(formatBytes(999.6e6), '1 GB');
});

test('very large values stay in TB', () => {
  assert.equal(formatBytes(5e15), '5000 TB');
  assert.equal(formatBytes(1.2e18), '1200000 TB');
});

test('the TB capacity input round-trips: entering 2 TB stores 2e12 and reads back as 2 TB', () => {
  const stored = Number('2') * 1e12;
  assert.equal(stored, 2e12);
  assert.equal(formatBytes(stored), '2 TB');
});
