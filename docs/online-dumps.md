# Online database dumps

Since 3.0.0. Opt-in per app: `config.onlineDumps: true` (through the app API; there is no switch in the app settings
yet). Without it, and for every app saved before 3.0.0, each database stops cleanly and its files are copied, exactly as
before ([database contracts](database-contracts.md)).

## What it does

With the option on, each running PostgreSQL, MySQL, MariaDB, Redis or Valkey database of the app takes a consistent logical dump with
its own tools, inside its own container, and keeps running. Writers of the app still stop first (they hold files a
dump cannot cover), so the dump sees a quiet database and matches the writers' files. An app made only of databases
has no downtime and no maintenance page at all.

| Engine | Dump | Consistency |
|---|---|---|
| PostgreSQL | `pg_dumpall --globals-only` (roles) and one `pg_dump --format=custom` per database that accepts connections | each database is one snapshot transaction |
| MySQL | `mysqldump --single-transaction --all-databases --routines --events --triggers --flush-privileges --set-gtid-purged=OFF` | one InnoDB transaction for every database |
| MariaDB | `mariadb-dump` with the same options (no GTID option) | the same |
| Redis, Valkey | `BGSAVE` snapshot: DockNest waits for the save to finish and be counted (`rdb_saves` or `LASTSAVE` moves on, no save in progress, last save ok), copies the RDB file and checks it with the image's own `redis-check-rdb` or `valkey-check-rdb` | a point-in-time snapshot of the whole dataset |
| MongoDB | not yet: it keeps the stopped copy, with a warning | |

The tools connect over the container's local socket. PostgreSQL uses local trust as the `postgres` user, as DockNest's
checks already do. MySQL and MariaDB read the root password from the container's own `MYSQL_ROOT_PASSWORD` or
`MARIADB_ROOT_PASSWORD` (or the `_FILE` variant) inside a fixed shell script, so no password is ever in Docker
arguments, evidence, logs, job text or the manifest. Tool output (which can name tables or hold data) is checked inside
the helper and never leaves it; reasons are fixed sentences.

## When the stopped copy is kept instead

DockNest decides before anything stops, read-only, and fails closed. A database keeps the stopped file copy, and the
backup carries a warning "Online dumps: NAME stopped for a file copy because REASON", when:

- the engine has no dump (MongoDB);
- Redis or Valkey: it keeps nothing on disk (a cache; the stopped copy still includes the app's folders), or it also keeps an
  append-only file (a server with one starts from that file and ignores a snapshot, so only RDB-only servers take a
  snapshot), a save is already running, its data folder holds files other than the snapshot, or a setting changed since
  planning;
- the image does not use the official `docker-entrypoint.sh`, which sets up an empty data folder on restore;
- the data folder is not a plain folder in a captured writable mount, or another container of the app mounts it;
- PostgreSQL: `pg_dump`, `pg_dumpall` or `pg_restore` is missing, the server has replication slots, a database name
  cannot be passed safely, it has tablespaces of its own, a database refuses connections or is a template (other than
  template0 and an unchanged template1), template1 holds objects or extensions of its own, or its data folder holds
  files PostgreSQL does not keep there itself (a certificate, for example): a dump would lose any of these;
- MySQL or MariaDB: the dump tool is missing, or a table outside the system schemas is not InnoDB (MyISAM, Aria, CSV
  and others cannot be read in one transaction); this is checked when planning and again right before the dump;
- the dump fails or times out (`config.dumpTimeout`, 60 to 21600 seconds, default 3600, one deadline for every
  command of that database's dump). Nothing of a failed dump is
  kept; the database then stops and is copied as usual.

A move always stops every database (its final copy must be a stopped one), and incremental backups keep the stopped
copy too, with a warning, because a chain stores files. **Check readiness** lists, for an app with the option, which
databases will take a dump and why any other will not.

## The package

The dump of container I is `database-I.tar`, listed in `manifest.artifacts` and named in the service's `dump` entry of
`manifest.backupPlan.services`. It holds the dump files, `listing.json` (engine, format, databases, data directory and
carried files) and `config/`: the settings files a dump does not hold, copied from the data folder without following
links (PostgreSQL `postgresql.conf`, `postgresql.auto.conf`, `pg_hba.conf`, `pg_ident.conf`; MySQL `mysqld-auto.cnf`;
MariaDB `.my-healthcheck.cnf`). The mount archive of that data folder holds only the empty folder (owner, mode, ACLs).
The consistency evidence of the service says `online logical dump` with the dump's size and SHA-256. A helper older
than 3.0.0 does not know `database-*.tar` and refuses the package instead of restoring an empty database.

## Restore

A restore (isolated restore and automatic restore test) loads every dump before the app's containers exist: a
throwaway copy of the database container, on network `none` and the restored data folders, starts; the official
entrypoint sets up an empty database; the carried settings files go back into the data folder and the copy restarts;
the dump loads (PostgreSQL: roles, where only "role ... already exists" is accepted, then `pg_restore --exit-on-error`,
`--single-transaction --clean --if-exists` into an existing database or `--create` otherwise; MySQL and MariaDB: the
client reads the SQL file); then the copy stops cleanly and is removed. Any error fails the restore. The app then starts
on the loaded data folder and the configured data checks compare it with the values recorded at backup, as for any
backup. Data checks are counted right before the dump; if other apps write to the same database, check tables only this
app writes. A move refuses a package with a dump. The package's `restore-guide.md` ("Database dumps") and the Recovery
Guide give the steps by hand.

## Limits

- PostgreSQL databases are each consistent, not with each other; the app's writers are stopped, so they are quiet.
- PostgreSQL databases the fresh copy already has (`postgres` and the image's `POSTGRES_DB`) are loaded with
  `--clean`, which keeps the copy's database-level owner, privileges and `ALTER DATABASE ... SET` settings: those come
  from the image's own setup, not from the dump. Objects inside the database keep their saved owners and privileges.
  A database the copy does not have is created from the dump with all of them.
- MySQL system tables in MyISAM or Aria (accounts) are not covered by the transaction; an account change during the
  dump is not.
- `ALTER`, `DROP`, `RENAME` or `TRUNCATE` from another app during a MySQL dump can break it; a failure falls back.

## Tests

Python: `remote/test_dumps.py`. Linux Docker integration (`scripts/integration-online-dumps.js`, in the full suite and
`INTEGRATION_ONLY=dumps`): PostgreSQL 16 (staged), MySQL 8.4 (staged) and MariaDB 11.4 (direct) keep running through
the backup, the isolated restore loads roles, a second database or accounts and the data checks pass; a MyISAM table
falls back with its warning; an app with a writer next to PostgreSQL stops only the writer and restores both; an
automatic restore test of a dumped backup passes.

## Redis and Valkey

Valkey is a Redis fork with the same protocol and files, so both are one engine. Supported: Redis 7.x and Valkey 7.2 or
8.x (standalone, default user). The Databases list shows each one with what it keeps, for example "Redis 7.4 - saved to
disk" or "Valkey 8.0 - cache only". Check readiness says the same in plain words.

- **Cache only** (no `save` rule and no append-only file): nothing is on disk, so there is nothing to back up. This is not
  an error. The normal stopped copy still includes the app's folders.
- **Passwords**: a password set with `requirepass`, `REDIS_PASSWORD` or a password file is read inside the container and
  given to the CLI through `REDISCLI_AUTH`. It never appears in a command line, evidence, a log or the manifest.
- **Restore**: the snapshot is placed in the data folder of a throwaway copy that has no network, the copy starts, and
  DockNest checks that the keys came back. The usual data checks (`checks` with a key) then compare values.
- **Fail closed**: a save that errors, does not finish before the deadline or does not pass the file check never leaves a
  file; the server then stops and is copied as before, with the reason in the warning.
- **For the interface**: the plan's `services[]` entries carry `onlineCopy` (true when the engine can take an online copy: PostgreSQL, MySQL, MariaDB, Redis, Valkey) and, for Redis and Valkey, `flavor` (`redis` or `valkey`) and `persistence` (`disk` or `cache`).
