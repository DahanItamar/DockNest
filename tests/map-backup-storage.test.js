import test from 'node:test';
import assert from 'node:assert/strict';
import {backupStorageOf} from '../web/map/backup-storage.js';

const known = new Set(['main', 'other']);
test('an app with its own main destination uses it, not the default', () => {
  const out = backupStorageOf({sites: [{id: 'a', storage: {mainTargetId: 'other'}}, {id: 'b', storage: {mainTargetId: null}}], backups: [{siteId: 'a'}, {siteId: 'b'}], activeTargetId: 'main', known});
  assert.deepEqual(out, {a: 'other', b: 'main'});
});
test('a scheduled app without backups yet follows its own destination too', () => {
  const out = backupStorageOf({sites: [{id: 'a', storage: {mainTargetId: 'other'}}], policies: [{siteId: 'a', enabled: true}], activeTargetId: 'main', known});
  assert.deepEqual(out, {a: 'other'});
});
test('a removed own destination falls back to the backup destination, then the default', () => {
  const sites = [{id: 'a', storage: {mainTargetId: 'gone'}}];
  assert.deepEqual(backupStorageOf({sites, backups: [{siteId: 'a', mainTarget: {id: 'other'}}], activeTargetId: 'main', known}), {a: 'other'});
  assert.deepEqual(backupStorageOf({sites, backups: [{siteId: 'a'}], activeTargetId: 'main', known}), {a: 'main'});
});
