# helper/engine_base.py: what every database engine module provides, and the checks engines share.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    run)
from .databases import (
    database_query)
# </build:header>
# Every field a configured data check can name. Each engine accepts exactly its own one.
CHECK_FIELDS=('table','key')

def in_writable_mount(path,c):
    """True when a container path is a captured writable mount or lies inside one."""
    return any(path==m['Destination'] or path.startswith(m['Destination'].rstrip('/')+'/') for m in c['Mounts'] if m.get('RW'))

class DatabaseEngine:
    """One engine's native cold-capture contract; databases.ENGINES holds one instance per engine id.

    Writers stop, the database stops cleanly, its files are archived and native evidence proves the stop was clean.
    Subclasses set `binary` and `version_pattern` (detection) and `check_field` (data check shape), and implement
    validate(service,c), stop_evidence(service,c,original,stopped_at,staging_root), ready(cid,service) and
    data_check(cid,service,check). Steps an engine does not need are no-ops here.
    """
    check_field='table'

    def detect(self,cid):
        """The native server version from `<binary> --version` inside the running container, or None."""
        try:output=run(['docker','exec',cid,self.binary,'--version'],timeout=10).decode(errors='replace')
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired):return None
        match=re.search(self.version_pattern,output)
        return match[1] if match else None

    def check_version(self,version):
        """Raise for a detected version this engine was not tested with."""

    def check_shape(self,check):
        return bool(check.get(self.check_field)) and not any(check.get(name) for name in CHECK_FIELDS if name!=self.check_field)

    def prepare_stop(self,service):
        """Runs after writers stop, right before the database stops."""

    def after_start(self,cid,service):
        """Runs once the restarted database answers; undoes prepare_stop."""

class SqlEngine(DatabaseEngine):
    """PostgreSQL and MySQL/MariaDB: a local SQL client (`query`), `SELECT 1` readiness and read-only row counts."""

    def ready(self,cid,service):
        return database_query(cid,service,'SELECT 1;')=='1'

    def data_check(self,cid,service,check):
        table=check['table']
        if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]{0,62}',table):raise ValueError('Data check table must be a simple identifier')
        output=database_query(cid,service,self.count_query(service,table))
        values=[line.strip() for line in output.splitlines() if re.fullmatch(r'\d+',line.strip())]
        if len(values)!=1:raise ValueError('Native data check did not return one count')
        return {'name':check['name'],'table':table,'sha256':hashlib.sha256(values[0].encode()).hexdigest(),'method':'read-only table row count'}
