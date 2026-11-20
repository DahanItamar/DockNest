# helper/engine_postgres.py: PostgreSQL contract, control-file clean-stop proof, readiness and row-count checks.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    run)
from .engine_base import (
    SqlEngine, in_writable_mount)
from .databases import (
    database_query)
# </build:header>
class PostgresEngine(SqlEngine):
    binary='postgres'
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
