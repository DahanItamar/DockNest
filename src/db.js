import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { migrate } from './migrations.js';

const file = path.join(config.dataDir, 'state.sqlite');
export const db = new DatabaseSync(file);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
`);
// Versioned, serialized migration preserves existing administrators, sessions and history (src/migrations.js).
try { migrate(db, { file }); } catch (error) { db.close(); throw error; }
export const id = () => randomUUID();
export function parse(row) {
  if (!row) return row;
  const result = { ...row };
  for (const field of ['config','manifest','results','details','capabilities','plan','detail']) {
    if (typeof result[field] === 'string') { try { result[field] = JSON.parse(result[field]); } catch { /* Legacy text remains readable. */ } }
  }
  return result;
}
export function audit(actor, action, target = null, detail = {}) {
  db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?)').run(id(), actor, action, target, JSON.stringify(detail), new Date().toISOString());
}
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
