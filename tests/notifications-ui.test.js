// Notification centre, UI logic (web/notifications/model.js, toast-store.js) and the design rules for its sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pushToast, dismissToast, visibleToasts, ttlFor, freshSince, toastOf, linkTarget, badgeText, signature, TABS, tabCount, MAX_VISIBLE } from '../web/notifications/model.js';
import { toasts } from '../web/notifications/toast-store.js';

const t = (key, severity = 'success', extra = {}) => ({ key, severity, title: 'Title ' + key, ...extra });

test('toast stack: newest at the bottom, at most three shown, the rest counted', () => {
  let list = [];
  for (const key of ['a', 'b', 'c', 'd', 'e']) list = pushToast(list, t(key));
  const { shown, hidden } = visibleToasts(list);
  assert.equal(MAX_VISIBLE, 3); assert.deepEqual(shown.map(item => item.key), ['c', 'd', 'e'], 'the last three, oldest of them first'); assert.equal(hidden, 2);
  assert.deepEqual(visibleToasts(list.slice(0, 2)), { shown: list.slice(0, 2), hidden: 0 });
  assert.deepEqual(visibleToasts([]), { shown: [], hidden: 0 });
});

test('toast stack: the same key replaces the toast and moves it to the bottom; bad toasts are ignored', () => {
  let list = pushToast(pushToast([], t('a')), t('b'));
  list = pushToast(list, t('a', 'error', { body: 'again' }));
  assert.deepEqual(list.map(item => item.key), ['b', 'a']); assert.equal(list[1].severity, 'error');
  assert.equal(pushToast(list, { key: '', title: 'x' }), list); assert.equal(pushToast(list, { key: 'z' }), list);
  assert.equal(pushToast([], { key: 'q', title: 'x', severity: 'loud' })[0].severity, 'info', 'an unknown severity becomes info');
  assert.deepEqual(dismissToast(list, 'b').map(item => item.key), ['a']); assert.equal(dismissToast(list, 'nope'), list);
  let many = []; for (let i = 0; i < 80; i++) many = pushToast(many, t('k' + i)); assert.equal(many.length, 50, 'the list is bounded');
});

test('toast time: errors stay until dismissed, success clears in 5 s', () => {
  assert.equal(ttlFor('error'), null); assert.equal(ttlFor('success'), 5000); assert.equal(ttlFor('warning'), 8000); assert.equal(ttlFor('info'), 8000);
});

test('the store raises, replaces, dismisses and tells listeners', () => {
  toasts.clear(); let calls = 0; const off = toasts.subscribe(() => calls++);
  toasts.push(t('x')); toasts.push(t('x')); toasts.dismiss('x'); toasts.dismiss('x'); off(); toasts.push(t('y'));
  assert.equal(calls, 3, 'push, push (a replace), dismiss; the second dismiss changes nothing'); assert.equal(toasts.get().length, 1); toasts.clear(); assert.equal(toasts.get().length, 0);
});

test('poll: the first load announces nothing; later new or repeated unread items are announced oldest first, once', () => {
  const item = (id, count = 1, extra = {}) => ({ id, count, read: false, archived: false, severity: 'error', title: 'T' + id, body: 'B', link: null, ...extra });
  const first = freshSince(null, [item(3), item(2)]);
  assert.deepEqual(first.fresh, [], 'seeded only'); assert.deepEqual(first.seen, { 2: 1, 3: 1 });
  const same = freshSince(first.seen, [item(3), item(2)]); assert.deepEqual(same.fresh, []);
  const next = freshSince(first.seen, [item(5), item(4), item(3)]);
  assert.deepEqual(next.fresh.map(x => x.id), [4, 5], 'oldest first, so the newest lands at the bottom');
  const repeat = freshSince(next.seen, [item(5, 2), item(4), item(3)]); assert.deepEqual(repeat.fresh.map(x => x.id), [5], 'a repeat (count up) is announced again');
  assert.deepEqual(freshSince(next.seen, [item(6, 1, { read: true })]).fresh, [], 'read items stay quiet');
  assert.deepEqual(freshSince(next.seen, [item(7, 1, { archived: true })]).fresh, [], 'archived items stay quiet');
  assert.equal(toastOf(item(5, 3)).key, 'n:5'); assert.match(toastOf(item(5, 3)).body, /3 times/); assert.equal(toastOf(item(5)).body, 'B');
});

test('links: only a job id or a known page shape is followed', () => {
  assert.deepEqual(linkTarget('job:job-0001-aaaa'), { type: 'job', id: 'job-0001-aaaa', label: 'View job' });
  assert.deepEqual(linkTarget('route:Storage'), { type: 'route', name: 'Storage', label: 'Open Storage' });
  assert.equal(linkTarget('route:Update Center').label, 'Open Update Center');
  for (const bad of [null, undefined, '', 'https://example.com', 'javascript:alert(1)', 'job:../x', 'route:<b>', 7]) assert.equal(linkTarget(bad), null, String(bad));
});

test('tabs, badge and the page reload signature', () => {
  assert.deepEqual(TABS.map(tab => tab[1]), ['All', 'Needs action', 'Backups & restores', 'Storage', 'System', 'Archived']);
  assert.equal(tabCount({ unread: { all: 4 } }, 'all'), 4); assert.equal(tabCount(undefined, 'all'), 0);
  assert.equal(badgeText(0), '0'); assert.equal(badgeText(7), '7'); assert.equal(badgeText(120), '99+');
  assert.notEqual(signature({ unread: 1, newestId: 2, recent: [{ lastAt: 'a', count: 1 }] }), signature({ unread: 1, newestId: 2, recent: [{ lastAt: 'b', count: 2 }] }));
  assert.equal(signature(undefined), '');
});

test('design rules: no emoji, no raw colours, no bordered icon buttons or pill badges in the new sources', () => {
  const dir = new URL('../web/notifications/', import.meta.url), files = readdirSync(dir).map(name => [name, readFileSync(new URL(name, dir), 'utf8')]);
  for (const [name, text] of files) {
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, name + ': no emoji');
    if (name.endsWith('.css')) {
      assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/, name + ': semantic tokens only, no raw hex');
      assert.doesNotMatch(text, /rgb\(|hsl\(/, name + ': no raw colour functions');
      for (const rule of text.split('}')) { const [selector, body = ''] = rule.split('{'); if (/^\s*button\.nc-/.test(selector) && !selector.includes(':') && body.includes('background:')) assert.match(body, /border:0/, 'unboxed: ' + selector.trim()); }
      assert.doesNotMatch(text, /nc-[a-z-]*\{[^}]*border-radius:var\(--dn-radius-full\)[^}]*border:1px/, name + ': no bordered pill');
    }
  }
});
