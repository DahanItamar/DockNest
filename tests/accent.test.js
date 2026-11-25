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

test('the tab and touch icons follow the accent, with teal as the fallback', () => {
  // Minimal DOM: the head starts with the baked-in teal links; dnSetIcons must remove them and append fresh ones.
  const makeLink = (rel, href) => ({ rel, href, setAttribute(k, v) { if (k === 'rel') this.rel = v; }, remove() { head.children = head.children.filter(c => c !== this); } });
  const head = {
    children: [makeLink('icon', '/brand/favicon-teal.png'), makeLink('alternate icon', '/brand/favicon-teal.ico'), makeLink('apple-touch-icon', '/brand/apple-touch-teal.png')],
    querySelectorAll(sel) { return this.children.filter(c => (/apple-touch-icon/.test(sel) && c.rel === 'apple-touch-icon') || (/rel~="icon"/.test(sel) && /(^| )icon( |$)/.test(c.rel))); },
    appendChild(l) { this.children.push(l); },
  };
  const document = { head, createElement: () => makeLink('', ''), querySelector: () => null };
  const window = {};
  new Function('window', 'document', read('public/theme-init.js').split('// Apply a saved')[0])(window, document);
  const path = href => href.split('?')[0];
  const current = rel => head.children.filter(c => c.rel === rel);
  for (const id of ['teal', 'blue', 'indigo', 'orange', 'pink']) {
    window.dnSetIcons(id);
    // Exactly one icon link and one touch link remain (old ones removed, no teal leftover).
    assert.equal(current('icon').length, 1, id + ' single icon link');
    assert.equal(current('apple-touch-icon').length, 1, id + ' single touch link');
    assert.equal(head.children.filter(c => c.rel === 'alternate icon').length, 0, id + ' stale .ico removed');
    const icon = current('icon')[0].href, touch = current('apple-touch-icon')[0].href;
    assert.match(path(icon), id === 'teal' ? /favicon-[a-f0-9]+\.png$/ : new RegExp('favicon-' + id + '-32-'));
    assert.match(icon, new RegExp('\\?a=' + id + '$'), id + ' cache-busted so Chrome re-fetches');
    assert.ok(existsSync(new URL('../public' + path(icon), import.meta.url)) && existsSync(new URL('../public' + path(touch), import.meta.url)), id);
  }
  window.dnSetIcons('nope');
  assert.match(path(current('icon')[0].href), /favicon-[a-f0-9]+\.png$/);
  assert.match(read('web/brand.jsx'), /dnSetIcons\?\.\(accent\)/);
});
