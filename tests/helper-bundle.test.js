import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELPER_MODULES, buildHelper, helperSource, writeHelperBundle } from '../src/helper-bundle.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
// The exact loader src/ssh.js runs on servers: the helper arrives base64-encoded on the first stdin line.
const loader = "import base64,sys;exec(compile(base64.b64decode(sys.stdin.readline()),'<docknest-helper>','exec'))";
const operations = () => [...new Set([...helperSource().toString().matchAll(/op=='([a-z-]+)'/g)].map(match => match[1]))];

test('the helper is built from every module of remote/helper, in order, without build headers', () => {
  const present = readdirSync(new URL('../remote/helper/', import.meta.url)).filter(name => name.endsWith('.py') && name !== '__init__.py');
  assert.deepEqual(present.map(name => name.slice(0, -3)).sort(), [...HELPER_MODULES].sort());
  const source = helperSource().toString();
  assert.equal(source, buildHelper(), 'the same bytes every time');
  assert.ok(source.startsWith('#!/usr/bin/env python3\n') && !source.includes('\r'));
  assert.doesNotMatch(source, /<build:header>|from \.[a-z_]+ import/);
  assert.match(source, /^VERSION=1$/m, 'VERSION is also the backup formatVersion and must not change');
  const directory = mkdtempSync(join(tmpdir(), 'docknest-helper-bundle-'));
  try { assert.deepEqual(readFileSync(writeHelperBundle(directory)), helperSource()); } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('every operation runs through the server loader and answers only in JSON lines', () => {
  const list = operations();
  assert.ok(list.length >= 40, 'the dispatch table was found');
  const cwd = mkdtempSync(join(tmpdir(), 'docknest-helper-smoke-'));
  try {
    for (const operation of [...list, 'no-such-operation']) {
      const result = spawnSync(python, ['-c', loader], { cwd, encoding: 'utf8', timeout: 30000, input: helperSource().toString('base64') + '\n' + JSON.stringify({ operation }) + '\n' });
      if (result.error?.code === 'ENOENT') throw new Error('Python3 is required for remote helper verification');
      assert.ok([0, 1].includes(result.status), `${operation}: exit ${result.status}`);
      // capture-stream keeps stdout for the backup bytes, so its events go to stderr (EVENT_STREAM in common.py).
      const events = operation === 'capture-stream' ? result.stderr : result.stdout;
      if (operation === 'capture-stream') assert.equal(result.stdout, '', 'no event may enter the backup stream');
      const lines = events.split('\n').filter(Boolean);
      assert.ok(lines.length, `${operation}: no answer`);
      for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `${operation}: not JSON: ${line.slice(0, 80)}`);
      assert.doesNotMatch(result.stderr, /Traceback/, operation);
      if (operation === 'no-such-operation') assert.equal(JSON.parse(lines.at(-1)).error, 'Unsupported helper operation');
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('the recovery kit command keeps its usage and exit code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'docknest-helper-kit-'));
  try {
    const result = spawnSync(python, [writeHelperBundle(directory), 'restore-chain'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), 'Usage: python3 helper.py restore-chain <folder written by decrypt-backup.js --chain> <new empty folder>');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
