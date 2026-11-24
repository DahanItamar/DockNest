import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// WCAG 2.x contrast gate for the DockNest v2 tokens in web/tokens.css. Parses only the token section
// (before the "@aliases" marker): plain :root{} rules are light, :root[data-theme=dark]{} rules override
// them for dark. Rules inside @media are ignored. Text pairs need 4.5:1; UI, border and focus pairs 3:1.
const file = readFileSync(new URL('../web/tokens.css', import.meta.url), 'utf8');
const css = file.split('@aliases')[0].replace(/\/\*[\s\S]*?\*\//g, '');

function topLevelRules(text) {
  const rules = []; let depth = 0, start = 0, sel = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') { if (depth === 0) { sel = text.slice(start, i).trim(); start = i + 1; } depth++; }
    else if (c === '}') { depth--; if (depth === 0) { rules.push([sel, text.slice(start, i)]); start = i + 1; } }
  }
  return rules;
}
const decls = body => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map(m => [m[1], m[2].trim()]));
// Accents: Teal is the default (plain :root); Blue, Indigo and Orange override through :root[data-accent=NAME] (light) and
// :root[data-accent=NAME][data-theme=dark]. Every accent is gated in both themes.
const ACCENTS = ['teal', 'blue', 'indigo', 'orange'];
const light = {}, darkOnly = {}, accentLight = {}, accentDark = {};
for (const [sel, body] of topLevelRules(css)) {
  if (sel.startsWith('@')) continue;
  const flat = sel.replace(/\s/g, '');
  let m;
  if (flat === ':root') Object.assign(light, decls(body));
  else if (flat === ':root[data-theme=dark]') Object.assign(darkOnly, decls(body));
  else if ((m = /^:root\[data-accent=(\w+)\]$/.exec(flat))) accentLight[m[1]] = { ...accentLight[m[1]], ...decls(body) };
  else if ((m = /^:root\[data-accent=(\w+)\]\[data-theme=dark\]$/.exec(flat))) accentDark[m[1]] = { ...accentDark[m[1]], ...decls(body) };
}
const themes = {};
for (const accent of ACCENTS) {
  const lightVars = { ...light, ...(accentLight[accent] ?? {}) };
  themes[accent + ' light'] = lightVars;
  themes[accent + ' dark'] = { ...lightVars, ...darkOnly, ...(accentDark[accent] ?? {}) };
}

function resolve(vars, name, seen = new Set()) {
  if (seen.has(name)) throw new Error('cycle ' + name); seen.add(name);
  const v = vars[name]; if (v == null) throw new Error('missing ' + name);
  return v.replace(/var\((--[\w-]+)\)/g, (_, n) => resolve(vars, n, seen));
}
function parseColor(s) {
  s = s.trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) { let h = m[1]; if (h.length <= 4) h = [...h].map(x => x + x).join('');
    const n = h.match(/../g).map(x => parseInt(x, 16)); return [n[0], n[1], n[2], n.length > 3 ? n[3] / 255 : 1]; }
  m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[\/,]\s*([\d.]+)(%?))?\s*\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : (m[5] ? +m[4] / 100 : +m[4])];
  throw new Error('unparsed colour ' + s);
}
const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };

// [foreground, background, minimum, category]. Alpha colours are composited over the
// background, and an alpha background over --dn-bg-surface.
const T = 4.5, L = 3, U = 3;
const pairs = [];
const add = (fgs, bgs, min, cat) => { for (const f of fgs) for (const b of bgs) pairs.push([f, b, min, cat]); };
const neutralBgs = ['--dn-bg-app', '--dn-bg-surface', '--dn-bg-subtle', '--dn-bg-hover'];
add(['--dn-text-primary', '--dn-text-secondary', '--dn-text-tertiary', '--dn-text-link', '--dn-text-link-hover', '--dn-brand-text'], neutralBgs, T, 'text');
add(['--dn-text-primary', '--dn-brand-text', '--dn-text-secondary'], ['--dn-bg-selected', '--dn-brand-surface'], T, 'text');
add(['--dn-text-primary', '--dn-text-secondary'], ['--dn-bg-raised'], T, 'text');
add(['--dn-text-on-solid'], ['--dn-brand-solid', '--dn-brand-solid-hover', '--dn-danger-solid', '--dn-danger-solid-hover', '--dn-success-solid', '--dn-info-solid'], T, 'text-on-solid');
add(['--dn-warning-on-solid'], ['--dn-warning-solid', '--dn-warning-solid-hover'], T, 'text-on-solid');
add(['--dn-text-on-solid-muted'], ['--dn-brand-solid', '--dn-chrome-solid'], T, 'text-on-solid');
add(['--dn-text-on-solid'], ['--dn-chrome-solid', '--dn-chrome-solid-hover'], T, 'text-on-solid');
// Chrome (blue) roles: nav current item, header accents, icon chips
add(['--dn-chrome-text'], [...neutralBgs, '--dn-chrome-surface', '--dn-chrome-chip'], T, 'chrome-text');
add(['--dn-brand-text'], ['--dn-brand-chip'], T, 'chrome-text');
add(['--dn-brand-text-soft'], ['--dn-bg-selected', '--dn-brand-surface'], T, 'text');
add(['--dn-text-primary'], ['--dn-chrome-surface'], T, 'chrome-text');
add(['--dn-chrome-indicator'], ['--dn-bg-surface', '--dn-chrome-surface'], U, 'ui-state');
for (const s of ['success', 'warning', 'danger', 'info'])
  add([`--dn-${s}-text`], [`--dn-${s}-surface`, '--dn-bg-surface', '--dn-bg-app', '--dn-bg-subtle'], T, 'semantic-text');
add(['--dn-badge-immutable-text'], ['--dn-badge-immutable-surface'], T, 'feature-text');
add(['--dn-safe-locked-text'], ['--dn-safe-locked-surface'], T, 'feature-text');
add(['--dn-safe-unlocked-text'], ['--dn-safe-unlocked-surface'], T, 'feature-text');
add(['--dn-share-pending-text'], ['--dn-share-pending-surface'], T, 'feature-text');
add(['--dn-share-issued-text'], ['--dn-share-issued-surface'], T, 'feature-text');
add(['--dn-share-confirmed-text'], ['--dn-share-confirmed-surface'], T, 'feature-text');
add(['--dn-text-primary'], ['--dn-map-canvas'], T, 'feature-text');
add(['--dn-text-tertiary'], ['--dn-map-canvas'], T, 'feature-text');
// Large text (>=24px or >=18.66px bold): page titles may use secondary on app bg.
add(['--dn-text-tertiary'], ['--dn-bg-app', '--dn-bg-surface'], L, 'large-text');
// UI component boundaries and state indicators (WCAG 1.4.11).
add(['--dn-border-strong'], neutralBgs, U, 'ui-border');
add(['--dn-focus-color'], [...neutralBgs, '--dn-brand-surface', '--dn-bg-selected'], U, 'focus-ring');
add(['--dn-brand-solid'], ['--dn-bg-surface', '--dn-bg-app', '--dn-bg-subtle'], U, 'ui-solid-vs-surface');
add(['--dn-danger-solid'], ['--dn-bg-surface', '--dn-bg-app'], U, 'ui-solid-vs-surface');
add(['--dn-selected-indicator'], neutralBgs, U, 'ui-state');
add(['--dn-switch-track-off'], ['--dn-bg-surface', '--dn-bg-app', '--dn-bg-subtle'], U, 'ui-state');
add(['--dn-switch-thumb'], ['--dn-switch-track-off', '--dn-brand-solid'], U, 'ui-state');
add(['--dn-map-domain-ring', '--dn-map-path', '--dn-map-node-selected'], ['--dn-map-canvas', '--dn-bg-surface'], U, 'feature-graphic');
add(['--dn-share-pending-border'], ['--dn-bg-surface', '--dn-share-pending-surface'], U, 'feature-graphic');
add(['--dn-safe-locked-icon'], ['--dn-safe-locked-surface', '--dn-bg-surface'], U, 'feature-graphic');
add(['--dn-safe-unlocked-icon'], ['--dn-safe-unlocked-surface', '--dn-bg-surface'], U, 'feature-graphic');
add(['--dn-viz-1', '--dn-viz-2', '--dn-viz-3', '--dn-viz-4'], ['--dn-bg-surface'], U, 'data-viz');
// Decorative (reported, not gated): dividers and card edges are not required to identify a control.
add(['--dn-border-subtle', '--dn-border'], ['--dn-bg-surface', '--dn-bg-app'], 0, 'decorative');
for (const s of ['success', 'warning', 'danger', 'info']) add([`--dn-${s}-border`], [`--dn-${s}-surface`], 0, 'decorative');

test('every v2 token pair meets its WCAG threshold in light and dark, for every accent', () => {
  const failures = [];
  for (const [theme, vars] of Object.entries(themes)) {
    const surface = parseColor(resolve(vars, '--dn-bg-surface'));
    for (const [f, b, min, cat] of pairs) {
      let bg = parseColor(resolve(vars, b)); if (bg[3] < 1) bg = over(bg, surface);
      const fg = over(parseColor(resolve(vars, f)), bg);
      const r = Math.round(ratio(fg, bg) * 100) / 100;
      if (r < min) failures.push(`${theme} ${cat} ${f} on ${b} = ${r} (< ${min})`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(pairs.length > 100);
});

test('the accent sets are complete: every accent defines the same tokens in light and dark', () => {
  const names = vars => Object.keys(vars).filter(k => /^--dn-(brand|chrome)-\d+$|-step$|-ui$|text-soft$|^--dn-brand-logo$|^--dn-viz-[1-4]$|^--dn-viz-area$|^--dn-map-domain-fill$/.test(k)).sort();
  const base = names({ ...light });
  assert.ok(base.length >= 24 + 6, 'teal defaults');
  for (const accent of ACCENTS.filter(x => x !== 'teal')) {
    assert.deepEqual(names(accentLight[accent]), base, accent + ' light');
    assert.deepEqual(names(accentDark[accent]), names(darkOnly), accent + ' dark');
  }
});

test('legacy names alias v2 tokens, the dark theme hook is intact and type scaling is gone', () => {
  assert.match(file, /:root\[data-theme=dark\]\{/);
  const aliases = file.split('@aliases')[1];
  for (const name of ['--accent', '--surface', '--text-primary', '--primary-main', '--chart-backup', '--error', '--border-control'])
    assert.ok(aliases.includes(name + ':var(--dn-'), name);
  assert.doesNotMatch(file, /min-width:(1920|2560)px\)\{:root\{--fs/);
});
