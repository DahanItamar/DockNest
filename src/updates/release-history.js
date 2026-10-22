// Every version this database has run, recorded by the API at startup (docs/update-center.md section 3), so versions
// installed from the command line appear in History and What's new can compare users.created_at with
// first_started_at. Idempotent: a restart, or a rollback and upgrade again, only moves last_started_at.
// Best effort: History is not worth a failed start, so any error is logged (message only) and null is returned.
export function recordRelease(db, { version, schemaVersion }, now = new Date(), log = message => console.error(message)) {
  try {
    const at = now.toISOString();
    db.prepare('INSERT INTO release_history(version,schema_version,first_started_at,last_started_at) VALUES(?,?,?,?) ON CONFLICT(version) DO UPDATE SET schema_version=excluded.schema_version,last_started_at=excluded.last_started_at').run(version, schemaVersion, at, at);
    return db.prepare('SELECT version,schema_version,first_started_at,last_started_at FROM release_history WHERE version=?').get(version);
  } catch (error) { log(`Could not record the running release: ${error.message}`); return null; }
}
