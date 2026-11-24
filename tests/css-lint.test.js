import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Design system v2 lint gate (docs/design-system-v2.md section 8).
const root = fileURLToPath(new URL('../web', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const files = walk(root);
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const load = (ext, clean) => files.filter((f) => f.endsWith(ext)).map((f) => {
  const raw = readFileSync(f, 'utf8');
  return { name: relative(root, f).split(sep).join('/'), text: clean ? strip(raw) : raw };
});
const css = load('.css', true);
const jsx = load('.jsx', false);

// Spinner, progress and skeleton motion only. Add here deliberately, never to silence the gate.
const ALLOWED_KEYFRAMES = new Set(['dn-spin', 'map-spin', 'dn-orbit', 'dn-skeleton', 'dn-progress', 'pw-pop', 'pw-autofill', 'otp-in', 'otp-blink']);
// Never raise this number. Lower it when you remove an !important.
const IMPORTANT_BASELINE = 41;

const hits = (re, list = css) => list.flatMap(({ name, text }) => [...text.matchAll(re)].map((m) => `${name}: ${m[0].trim().slice(0, 100)}`));

test('no transition: all', () => {
  assert.deepEqual(hits(/transition(-property)?\s*:\s*all\b[^;}]*/g), []);
});

test('focus uses :focus-visible only', () => {
  const bad = hits(/[^,{}]*:focus(?![-\w])[^,{]*/g).filter((h) => !/:not\(:focus-visible\)/.test(h));
  assert.deepEqual(bad, []);
  assert.deepEqual(hits(/:focus-within/g), []);
});

test('raw hex colours live only in tokens.css', () => {
  assert.deepEqual(hits(/#[0-9a-fA-F]{3,8}\b/g, css.filter((f) => f.name !== 'tokens.css')), []);
});

test('box-shadow uses elevation tokens, none or the focus ring', () => {
  const ok = /^box-shadow\s*:\s*(none|var\(--dn-shadow-[123]\)|var\(--dn-focus-ring\))\s*(!important)?$/;
  const bad = css.flatMap(({ name, text }) => [...text.matchAll(/box-shadow\s*:[^;}]*/g)]
    .filter((m) => !ok.test(m[0].trim())).map((m) => `${name}: ${m[0].trim().slice(0, 100)}`));
  assert.deepEqual(bad, []);
});

test('keyframes are on the allowlist', () => {
  const bad = hits(/@keyframes\s+[\w-]+/g).filter((h) => !ALLOWED_KEYFRAMES.has(h.split(/@keyframes\s+/)[1]));
  assert.deepEqual(bad, []);
});

// The one allowed Beta tag is the Synology support switch in Settings (owner decision for 3.0.0).
test('no Beta label in the UI', () => {
  assert.deepEqual(hits(/\bBeta\b/g, jsx.filter(({ name }) => !/SynologySetting[.]jsx$/.test(name))), []);
});

test('!important count never grows', () => {
  const count = css.reduce((n, f) => n + (f.text.match(/!\s*important/g) || []).length, 0);
  assert.ok(count <= IMPORTANT_BASELINE, `!important count ${count} is above the baseline ${IMPORTANT_BASELINE}`);
});

test('number inputs have no spinner arrows and nothing re-enables them', () => {
  const base = css.find((f) => f.name === 'style.css').text;
  assert.match(base, /input\[type=number\]\{[^}]*appearance:textfield/);
  assert.match(base, /input\[type=number\]::-webkit-inner-spin-button/);
  const reenabled = hits(/(spin-button|type=number\][^{]*\{[^}]*appearance:\s*(auto|textfield-reset|spinner))/g, css.filter((f) => f.name !== 'style.css'));
  assert.deepEqual(reenabled, []);
});
