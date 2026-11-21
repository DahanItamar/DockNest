import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DATABASE_ENGINES, ENGINE_IDS, SQL_ENGINE_IDS, engineCheckField, engineLabel, engineTestedVersions, releaseEvidenceIds } from '../shared/database-engines.js';
import { databasesOf } from '../web/map/layout.js';

test('one engine list: unique ids, labels and data check fields', () => {
  assert.deepEqual(ENGINE_IDS, ['postgres', 'mysql', 'mariadb', 'redis', 'mongo']);
  assert.equal(new Set(DATABASE_ENGINES.map(engine => engine.label)).size, DATABASE_ENGINES.length);
  assert.deepEqual(ENGINE_IDS.map(engineCheckField), ['table', 'table', 'table', 'key', 'collection']);
  assert.equal(engineLabel('mongo'), 'MongoDB');
  for (const unknown of ['generic', 'auto', 'sqlite', undefined]) assert.equal(engineLabel(unknown), undefined);
  assert.throws(() => { DATABASE_ENGINES[0].id = 'changed'; }, TypeError);
});

test('every engine names its release evidence; the shared native records stay the SQL engines', () => {
  assert.deepEqual(SQL_ENGINE_IDS, ['postgres', 'mysql', 'mariadb']);
  assert.deepEqual(releaseEvidenceIds('engines'), ['postgres', 'mysql', 'mariadb']);
  assert.deepEqual(releaseEvidenceIds('redis'), ['redis']);
  assert.deepEqual(releaseEvidenceIds('mongo'), ['mongo']);
  assert.ok(DATABASE_ENGINES.every(engine => ['engines', 'redis', 'mongo'].includes(engine.releaseEvidence)));
  assert.deepEqual(engineTestedVersions('mongo'), ['6.0', '7.0', '8.0']);
  assert.deepEqual(engineTestedVersions('postgres'), []);
});

test('the map lists MongoDB like the other detected databases', () => {
  const site = { id: 's1', config: { services: [{ container: 'demo-shop-mongo', engine: 'mongo', version: '7.0.14', database: 'shop' }, { container: 'web', engine: 'generic' }] } };
  assert.deepEqual(databasesOf(site).map(item => item.label), ['MongoDB 7.0.14 · shop']);
});

test('every JS engine has a helper engine module and a registry entry', () => {
  const registry = readFileSync(new URL('../remote/helper/databases.py', import.meta.url), 'utf8').match(/^ENGINES=\{(.*)\}$/m)[1];
  assert.deepEqual([...registry.matchAll(/'([a-z]+)':/g)].map(match => match[1]).sort(), [...ENGINE_IDS].sort());
});

test('the map lists Redis and Valkey with what they keep', () => {
  const site = { id: 's1', config: { services: [
    { container: 'cache', engine: 'redis', version: '7.4.1', persistence: 'cache' },
    { container: 'queue', engine: 'redis', flavor: 'valkey', version: '8.0.1', persistence: 'disk' },
    { container: 'plain', engine: 'redis', version: '7.2.5' }] } };
  assert.deepEqual(databasesOf(site).map(item => item.label), ['Redis 7.4.1 · cache only', 'Valkey 8.0.1 · saved to disk', 'Redis 7.2.5']);
});
