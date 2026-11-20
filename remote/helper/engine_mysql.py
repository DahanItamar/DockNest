# helper/engine_mysql.py: MySQL and MariaDB contract, verified slow shutdown, clean-stop log proof and row-count checks.
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
# A [client] socket in an image's option file overrides MYSQL_UNIX_PORT.
# Preserve an explicitly configured container-local socket as a CLI option;
# default option-file behavior remains in effect when the variable is absent.
MYSQL_QUERY_SCRIPT='set -eu; export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; file="${MYSQL_ROOT_PASSWORD_FILE:-${MARIADB_ROOT_PASSWORD_FILE:-}}"; if [ -n "$file" ]; then MYSQL_PWD=$(cat -- "$file"); export MYSQL_PWD; fi; set -- "$1" --protocol=socket --batch --skip-column-names --user="$2" --execute="$3"; if [ -n "${MYSQL_UNIX_PORT:-}" ]; then case "$MYSQL_UNIX_PORT" in /*) ;; *) exit 64 ;; esac; case "$MYSQL_UNIX_PORT" in *[!a-zA-Z0-9_./-]*) exit 64 ;; esac; set -- "$@" --socket="$MYSQL_UNIX_PORT"; fi; exec "$@"'

class MysqlEngine(SqlEngine):
    """MySQL and MariaDB share one contract; they differ in the server binary and the client name."""
    version_pattern=r'Ver\s+(\d+\.\d+(?:\.\d+)?)'

    def __init__(self,binary,client):
        self.binary=binary;self.client=client

    def query(self,container,service,query):
        return run(['docker','exec',container,'sh','-c',MYSQL_QUERY_SCRIPT,'docknest',self.client,service.get('user') or 'root',query],timeout=30).decode().strip()

    def validate(self,service,c):
        values=database_query(c['Id'],service,'SELECT @@version, @@global.innodb_fast_shutdown, @@datadir;').split('\t')
        if len(values)!=3 or values[1] not in ['0','1','2']:raise ValueError('Cannot validate the native database shutdown setting')
        if not values[0].startswith(service['version']):raise ValueError('Running database version does not match the installed server binary')
        if not in_writable_mount(values[2].rstrip('/'),c):raise ValueError('Database data directory must be included in a captured writable mount')
        service['originalFastShutdown']=int(values[1])
        service['slowShutdownVerified']=values[1]=='0'

    def prepare_stop(self,service):
        # Read-only plans never change the server. Prepare only the running capture,
        # after writers stop; the recovery contract restores the original value.
        cid=service['container']
        database_query(cid,service,'SET GLOBAL innodb_fast_shutdown=0;')
        if database_query(cid,service,'SELECT @@global.innodb_fast_shutdown;')!='0':raise ValueError('Could not prepare a verified slow database shutdown; capture blocked')
        service['slowShutdownVerified']=True

    def stop_evidence(self,service,c,original,stopped_at,staging_root):
        output=subprocess.run(['docker','logs','--tail','10000','--since',str(stopped_at),c['Id']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
        if output.returncode or 'shutdown complete' not in (output.stdout+output.stderr).decode(errors='replace').lower():raise ValueError('Native database shutdown evidence missing from the current stop')
        return {'slowShutdownVerified':service['slowShutdownVerified'],'cleanShutdownLogVerified':True}

    def after_start(self,cid,service):
        if 'originalFastShutdown' not in service:return
        value=service['originalFastShutdown']
        if value not in [0,1,2]:raise ValueError('Invalid original database shutdown setting')
        database_query(cid,service,'SET GLOBAL innodb_fast_shutdown='+str(value)+';')
        if database_query(cid,service,'SELECT @@global.innodb_fast_shutdown;')!=str(value):raise ValueError('Original database setting did not recover; dependants remain stopped')

    def count_query(self,service,table):
        database=service.get('database')
        if not database or not re.fullmatch(r'[a-zA-Z0-9_]{1,63}',database):raise ValueError('Database name is required for MySQL/MariaDB data checks')
        return 'START TRANSACTION READ ONLY; SELECT COUNT(*) FROM `'+database+'`.`'+table+'`; COMMIT;'
