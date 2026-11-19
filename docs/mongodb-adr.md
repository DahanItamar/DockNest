# ADR: MongoDB support and one module per database engine

Status: proposed for 2.16.5. Related: [database-contracts.md](database-contracts.md), [support-matrix.md](support-matrix.md).

## Audit of the engines today

DockNest does not take logical dumps for any engine. Every database is captured cold: writers stop, the database
stops cleanly, its data folders are archived, and native evidence proves the stop was clean.

| Step | Where | PostgreSQL | MySQL / MariaDB | Redis 7.4 | SQLite |
|---|---|---|---|---|---|
| Detection | `backup.service_contracts` | `postgres --version` in the container | `mariadbd` / `mysqld --version` | `redis-server --version` | declared per file by the operator (`sqliteFiles`) |
| Contract | `databases.validate_database_contracts` | data directory in a writable captured mount, primary, no tablespaces | data directory in a mount, reads `innodb_fast_shutdown` | standalone primary, default ACL, persistence on, readable logs | header and path checks |
| Before stop | `prepare_database_shutdown` | none | sets and verifies slow shutdown | none | none |
| Clean-stop proof | `shutdown_evidence` | `pg_controldata` says "shut down" | "shutdown complete" in this stop's logs | final RDB save / AOF fsync in logs, `redis-check-rdb`, `redis-check-aof` on a private copy | offline `integrity_check` and table counts |
| Ready after start | `restart_services` | `SELECT 1` | `SELECT 1`, restores the shutdown setting | `PING` | none |
| Data checks | `data_checks` | read-only row count per table | read-only row count per table | `TYPE` + value digest per key | table counts |
| Restore / restore test | `restore.py`, `restore_test.py` | same `data_checks` compared with the values recorded at backup | same | same | same |

Engine knowledge is spread over six functions as `if engine == ...` branches, plus four copies of the engine list
(`src/server.js` schema, `src/beta-gate.js`, `web/map/layout.js`, the check-shape rule in `service_contracts`).

## Decisions

1. **One module per engine.** `remote/helper/engine_postgres.py`, `engine_mysql.py`, `engine_redis.py` and
   `engine_mongo.py` each define one engine class with the same methods: `detect`, `validate`, `prepare_stop`,
   `stop_evidence`, `ready`, `data_check` and `check_shape`. `databases.py` keeps the shared pieces and an `ENGINES`
   registry; callers ask the registry instead of branching. The helper is still built into one file, so names inside
   each module carry the engine prefix. The JavaScript side reads its engine list from one module,
   `shared/database-engines.js`. The refactor ships first with no behaviour change, proven by the existing tests.
2. **MongoDB follows the same cold contract** as the other engines, so restore, Move and restore tests keep one data
   path and the backup format does not change:
   - Detection: `mongod --version` in the container. Tested majors only (6.0, 7.0, 8.0); others are refused.
   - Contract: `dbPath` (from `getCmdLineOpts`) inside a writable captured mount, WiredTiger engine, no TLS-only mode.
     A standalone server or a single-member replica set passes. A multi-member set, a secondary or an arbiter is
     refused: one member's files are not a whole copy of the set.
   - Credentials: the shell inside the container reads `MONGO_INITDB_ROOT_USERNAME` and
     `MONGO_INITDB_ROOT_PASSWORD` (or `_FILE`) and passes them to `mongosh` through a static script and environment
     variables. They never appear in Docker arguments, evidence, logs or job text. Auth on with no readable credentials
     fails closed.
   - Tools: `mongosh` must exist in the container. Without it the backup is refused with a plain reason. No image is
     pulled on the server for this.
   - Clean-stop proof: exit code 0, this stop's logs contain `WiredTiger closed` and the shutdown exit code 0, and
     `mongod.lock` in `dbPath` is empty.
   - Ready after start: `db.runCommand({ping:1})`. Data checks: `{name, collection}` with an optional `database`,
     read-only `countDocuments`, kept as a hash like the other engines.
3. **Logical dumps** (`mongodump --archive --gzip` / `mongorestore`) are an open question for the owner, see below. They
   are not needed for consistency, because writers are already stopped, and they would add a second restore path.
4. **Second engine**: not in 2.16.5. Follow-up candidates, in order: Elasticsearch/OpenSearch single node,
   CouchDB. Each is one new `engine_*.py` module plus its integration scenario.

## Upgrade safety

No migration and no change to stored configuration. Existing apps keep their detected engines; a MongoDB container
that was refused before ("Stateful service requires a supported per-service database contract") is now detected and
checked. Old backups restore exactly as before.
