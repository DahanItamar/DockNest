import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DATABASE_ENGINES, ENGINE_IDS, SQL_ENGINE_IDS, engineCheckField, engineLabel } from '../shared/database-engines.js';
import { databasesOf } from '../web/map/layout.js';

test('one engine list: unique ids, labels and data check fields', () => {
  assert.deepEqual(ENGINE_IDS, ['postgres', 'mysql', 'mariadb', 'redis', 'mongo']);
  assert.equal(new Set(DATABASE_ENGINES.map(engine => engine.label)).size, DATABASE_ENGINES.length);
  assert.deepEqual(ENGINE_IDS.map(engineCheckField), ['table', 'table', 'table', 'key', 'collection']);
  assert.equal(engineLabel('mongo'), 'MongoDB');
  for (const unknown of ['generic', 'auto', 'sqlite', undefined]) assert.equal(engineLabel(unknown), undefined);
  assert.throws(() => { DATABASE_ENGINES[0].id = 'changed'; }, TypeError);
});

test('the release gate keeps requiring evidence for exactly the SQL engines', () => {
  assert.deepEqual(SQL_ENGINE_IDS, ['postgres', 'mysql', 'mariadb']);
});

test('the map lists MongoDB like the other detected databases', () => {
  const site = { id: 's1', config: { services: [{ container: 'demo-shop-mongo', engine: 'mongo', version: '7.0.14', database: 'shop' }, { container: 'web', engine: 'generic' }] } };
  assert.deepEqual(databasesOf(site).map(item => item.label), ['MongoDB 7.0.14 · shop']);
});

test('every JS engine has a helper engine module and a registry entry', () => {
  const registry = readFileSync(new URL('../remote/helper/databases.py', import.meta.url), 'utf8').match(/^ENGINES=\{(.*)\}$/m)[1];
  assert.deepEqual([...registry.matchAll(/'([a-z]+)':/g)].map(match => match[1]).sort(), [...ENGINE_IDS].sort());
});
