# helper/engine_postgres.py: PostgreSQL contract, control-file clean-stop proof, readiness, row-count checks and online dumps.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    run)
from .engine_base import (
    SqlEngine, dump_command, in_writable_mount)
from .databases import (
    database_query)
# </build:header>
# What PostgreSQL itself keeps at the top of its data folder (12 to 18). A dump restores into a fresh folder, so
# anything else there (a certificate, a user's own file) would be lost: such a server keeps the stopped file copy.
POSTGRES_DATA_ENTRIES=frozenset(['PG_VERSION','base','global','pg_commit_ts','pg_dynshmem','pg_logical','pg_multixact',
    'pg_notify','pg_replslot','pg_serial','pg_snapshots','pg_stat','pg_stat_tmp','pg_subtrans','pg_tblspc','pg_twophase',
    'pg_wal','pg_xact','postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf','postmaster.opts',
    'postmaster.pid','current_logfiles','log','pg_log'])
# Database names DockNest passes to pg_dump and pg_restore as --dbname values.
POSTGRES_DATABASE_NAME=re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}')
POSTGRES_ROLE_EXISTS=re.compile(r'ERROR:\s+role ".{1,63}" already exists')

class PostgresEngine(SqlEngine):
    binary='postgres'
    dump_format='pg_dump custom archive per database and pg_dumpall globals'
    dump_config=('postgresql.conf','postgresql.auto.conf','pg_hba.conf','pg_ident.conf')
    init_marker='PostgreSQL init process complete'
    version_pattern=r'PostgreSQL\)?\s+(\d+\.\d+(?:\.\d+)?)'

    def query(self,container,service,query):
        args=['docker','exec','--user','postgres',container,'psql','-X','-w','-h','/var/run/postgresql','-U',service.get('user') or 'postgres','-d',service.get('database') or 'postgres','-At','-v','ON_ERROR_STOP=1','-c',query]
        return run(args,timeout=30).decode().strip()

    def validate(self,service,c):
        env=dict(v.split('=',1) for v in c['Config'].get('Env',[]) if '=' in v)
        service['user']=service.get('user') or env.get('POSTGRES_USER','postgres')
        service['database']=service.get('database') or env.get('POSTGRES_DB',service['user'])
        version=database_query(c['Id'],service,'SHOW server_version;').split()[0]
        if version!=service['version']:raise ValueError('Running PostgreSQL version does not match the installed server binary')
        data=database_query(c['Id'],service,'SHOW data_directory;')
        if not data.startswith('/') or '..' in pathlib.PurePosixPath(data).parts or not in_writable_mount(data,c):raise ValueError('Active PostgreSQL data directory must be included in a writable captured mount')
        if database_query(c['Id'],service,'SELECT pg_is_in_recovery();')!='f':raise ValueError('PostgreSQL standby/recovery capture requires a separate adapter')
        if database_query(c['Id'],service,"SELECT COUNT(*) FROM pg_tablespace WHERE pg_tablespace_location(oid) <> '';")!='0':raise ValueError('External PostgreSQL tablespaces require a reviewed capture adapter')
        service['dataDirectory']=data

    def stop_evidence(self,service,c,original,stopped_at,staging_root):
        output=run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--user','postgres','--volumes-from',c['Id']+':ro','--env','LC_ALL=C','--entrypoint','pg_controldata',original['Image'],service['dataDirectory']],timeout=30).decode()
        if not re.search(r'^Database cluster state:\s+shut down\s*$',output,re.M):raise ValueError('PostgreSQL control file does not prove a clean primary shutdown')
        return {'controlFileCleanShutdownVerified':True}

    def count_query(self,service,table):
        return 'BEGIN READ ONLY; SELECT COUNT(*) FROM "'+table+'"; COMMIT;'

    def client(self,container,tool,service,database,interactive=False):
        """A PostgreSQL tool over the container's local socket, as the server's own user. Local socket trust: no password.
        pg_dumpall reads --dbname as a connection string, so it gets --database."""
        return ['docker','exec',*(['-i'] if interactive else []),'--user','postgres',container,tool,'-w','-h','/var/run/postgresql','-U',service.get('user') or 'postgres',('--database=' if tool=='pg_dumpall' else '--dbname=')+database]

    def data_directory(self,service,c):
        return service.get('dataDirectory')

    def dump_databases(self,cid,service):
        names=database_query(cid,service,'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname;').splitlines()
        if not names or not all(POSTGRES_DATABASE_NAME.fullmatch(name) for name in names):raise ValueError('a database name cannot be passed to pg_dump safely')
        return names

    def dump_blocker(self,service,c,host):
        for tool in ['pg_dump','pg_dumpall','pg_restore']:
            try:run(['docker','exec',c['Id'],'sh','-c','command -v "$1"','docknest',tool],timeout=10)
            except subprocess.CalledProcessError:return 'its image has no '+tool
        if database_query(c['Id'],service,'SELECT COUNT(*) FROM pg_replication_slots;')!='0':return 'it has replication slots, which a dump does not keep'
        self.dump_databases(c['Id'],service)
        others=sorted(entry.name for entry in host.iterdir() if entry.name not in POSTGRES_DATA_ENTRIES)
        if others:return 'its data folder holds files a dump does not keep ('+', '.join(others[:5])+')'
        return None

    def dump(self,cid,service,directory,timeout):
        names=self.dump_databases(cid,service)
        code,_=dump_command([*self.client(cid,'pg_dumpall',service,'postgres'),'--globals-only'],timeout,stdout=directory/'globals.sql')
        if code:raise ValueError('pg_dumpall could not save the roles')
        for index,name in enumerate(names):
            target=directory/('database-%d.pgdump'%index)
            code,_=dump_command([*self.client(cid,'pg_dump',service,name),'--format=custom'],timeout,stdout=target)
            if code:raise ValueError('pg_dump failed')
            code,_=dump_command(self.client(cid,'pg_restore',service,name,True)[:-1]+['--list'],timeout,stdin=target)
            if code:raise ValueError('pg_restore could not read the dump it made')
        return {'format':self.dump_format,'databases':names}

    def load_dump(self,cid,service,directory,listing,timeout):
        # Roles first: the superuser already exists in the fresh copy, so only "role ... already exists" may fail.
        code,errors=dump_command(self.client(cid,'psql',service,'postgres',True)+['-X','-q'],timeout,stdin=directory/'globals.sql')
        problems=[line for line in errors.splitlines() if 'ERROR:' in line and not POSTGRES_ROLE_EXISTS.search(line)]
        if code or problems:raise ValueError('The saved PostgreSQL roles could not be loaded')
        existing=set(database_query(cid,service,'SELECT datname FROM pg_database;').splitlines())
        for index,name in enumerate(listing['databases']):
            if not isinstance(name,str) or not POSTGRES_DATABASE_NAME.fullmatch(name):raise ValueError('The database dump in this backup has no valid listing')
            if name in existing:args=self.client(cid,'pg_restore',service,name,True)+['--exit-on-error','--single-transaction','--clean','--if-exists']
            else:args=self.client(cid,'pg_restore',service,'postgres',True)+['--exit-on-error','--create']
            code,_=dump_command(args,timeout,stdin=directory/('database-%d.pgdump'%index))
            if code:raise ValueError('A PostgreSQL database dump could not be loaded')
