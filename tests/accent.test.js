import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ACCENTS, DEFAULT_ACCENT, validAccent, accentKeyFor, ACCENT_KEY } from '../web/accent.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('the accent choice is Teal by default and only the four known accents are accepted', () => {
  assert.equal(DEFAULT_ACCENT, 'teal');
  assert.deepEqual(ACCENTS.map(accent => accent.id), ['teal', 'blue', 'indigo', 'orange', 'pink']);
  for (const id of ['teal', 'blue', 'indigo', 'orange', 'pink']) assert.equal(validAccent(id), id);
  for (const bad of ['classic', 'green', 'crimson', 'purple', '', null, undefined, '__proto__', 'TEAL', '"><script>']) assert.equal(validAccent(bad), 'teal', String(bad));
});

test('the accent is saved like the theme: per account in this browser, with a device-wide fallback', () => {
  assert.equal(ACCENT_KEY, 'docknest-accent');
  assert.equal(accentKeyFor(null), 'docknest-accent');
  assert.equal(accentKeyFor('admin'), 'docknest-accent:user:admin');
});

test('the early theme script, the tokens and the logo set cover exactly the same accents', () => {
  const init = read('public/theme-init.js');
  const listed = /\['teal','blue','indigo','orange','pink'\]/.test(init);
  assert.ok(listed, 'theme-init.js allows the same four accents');
  const tokens = read('web/tokens.css');
  for (const { id } of ACCENTS) {
    assert.match(tokens, new RegExp('--dn-accent-' + id + ':#[0-9A-F]{6}'), id + ' swatch token');
    if (id !== 'teal') for (const selector of [`:root[data-accent=${id}]{`, `:root[data-accent=${id}][data-theme=dark]{`]) assert.ok(tokens.includes(selector), selector);
  }
  const assets = JSON.parse(read('web/brand-assets.json'));
  assert.deepEqual(Object.keys(assets.accents), ACCENTS.map(accent => accent.id));
  for (const { id } of ACCENTS) for (const mode of ['light', 'dark']) {
    const { src, srcSet } = assets.accents[id][mode];
    assert.match(src, new RegExp('^/brand/logo-' + id + '-' + mode + '-600-[a-f0-9]{10}\.webp$'));
    assert.ok(existsSync(new URL('../public' + src, import.meta.url)), src + ' exists');
    for (const part of srcSet.split(',')) assert.ok(existsSync(new URL('../public' + part.trim().split(' ')[0], import.meta.url)), part);
  }
});

test('no hardcoded purple or blue literals are left outside the token file', () => {
  const css = ['web/dashboard.css', 'web/shell.css', 'web/style.css', 'web/frame.css', 'web/rebrand.css'].map(read).join('\n');
  for (const old of ['#5E35B1', '#4527A0', '#673AB7', '#1268D3', '#1577E3', '#7E57D6', '#9E7EB5', '#4E7FC4']) assert.ok(!css.toUpperCase().includes(old), old);
  assert.doesNotMatch(read('web/chart-data.js'), /#[0-9A-Fa-f]{6}/, 'chart series use token names');
  assert.doesNotMatch(read('web/dashboard.jsx'), /color="#/, 'sparklines take a token name');
  assert.match(read('web/charts.jsx'), /color='--dn-viz-2'/);
});
