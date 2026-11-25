# helper/engine_base.py: what every database engine module provides, and the checks engines share.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    NOFOLLOW, diagnostic, run)
from .databases import (
    database_query)
# </build:header>
# Every field a configured data check can name. Each engine accepts exactly its own one.
CHECK_FIELDS=('table','key','collection')

def writable_mounts_covering(path,c):
    """The captured writable mounts that are a container path or hold it."""
    path=str(path)
    return [m for m in c['Mounts'] if m.get('RW') and (path==m['Destination'] or path.startswith(m['Destination'].rstrip('/')+'/'))]

def in_writable_mount(path,c):
    return bool(writable_mounts_covering(path,c))

def writable_mount_source(path,c):
    """The host path of a container path inside the deepest captured writable mount, or None outside them."""
    mounts=writable_mounts_covering(path,c)
    if not mounts:return None
    mount=max(mounts,key=lambda m:len(m['Destination']))
    return pathlib.Path(mount['Source'])/pathlib.PurePosixPath(path).relative_to(mount['Destination'])

def require_readable_logs(c,driver_none,timed_out,unreadable):
    """Refuse before any stop when the clean-stop proof in Docker logs could not be read. Messages stay literal."""
    if c.get('HostConfig',{}).get('LogConfig',{}).get('Type')=='none':raise ValueError(driver_none)
    try:
        logging=subprocess.run(['docker','logs','--tail','0',c['Id']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
    except subprocess.TimeoutExpired:raise ValueError(timed_out)
    if logging.returncode:raise ValueError(unreadable)

def stop_window_gap(cid,stopped_at,gap,timed_out,unreadable):
    """Read only this stop's Docker log window until `gap(logs)` finds nothing missing; return the last gap or None.

    Docker logging delivery can lag behind docker stop returning, so the window is re-read for a few seconds. It never
    falls back to historical successful shutdowns.
    """
    for attempt in range(6):
        # Explicit numeric tail avoids empty --since-only reads observed on
        # Docker 29.1.3 json-file logs. Keep --since so old proof cannot pass.
        try:output=subprocess.run(['docker','logs','--tail','10000','--since',str(stopped_at),cid],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
        except subprocess.TimeoutExpired:raise ValueError(timed_out)
        if output.returncode:raise ValueError(unreadable)
        missing=gap((output.stdout+output.stderr).decode(errors='replace'))
        if missing is None or attempt==5:return missing
        time.sleep(1)

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

    def detectable(self,image,declared):
        """Whether to probe this container's binary; `declared` is the service's declared engine or 'auto'."""
        return True

    def check_version(self,version):
        """Raise for a detected version this engine was not tested with."""

    def check_shape(self,check):
        return bool(check.get(self.check_field)) and not any(check.get(name) for name in CHECK_FIELDS if name!=self.check_field)

    def prepare_stop(self,service):
        """Runs after writers stop, right before the database stops."""

    def after_start(self,cid,service):
        """Runs once the restarted database answers; undoes prepare_stop."""

    # Online logical dumps (docs/online-dumps.md). An engine that can take one sets `dump_format`, `dump_config` (data
    # folder settings files a dump does not hold) and `init_marker` (the official entrypoint's log line once an empty
    # data folder is set up), and implements data_directory, dump_blocker, dump and load_dump.
    dump_format=None
    dump_config=()
    init_marker=None

def time_left(deadline):
    """Seconds left before one dump's shared deadline (time.monotonic()); every command of a dump shares it."""
    left=deadline-time.monotonic()
    if left<=0:raise subprocess.TimeoutExpired('online dump',0)
    return left

def dump_command(args,timeout,stdin=None,stdout=None):
    """Run a dump or load command with files as stdin and stdout; returns (exit code, stderr text). The text is for
    the caller's own checks only: it can hold table names or data and never reaches evidence, logs or errors."""
    started=time.monotonic();label=pathlib.Path(args[0]).name+(' '+str(args[1]) if len(args)>1 and args[0]=='docker' else '')
    diagnostic(command=label,phase='start')
    source=open(stdin,'rb') if stdin is not None else subprocess.DEVNULL
    target=os.open(stdout,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600) if stdout is not None else None
    try:
        result=subprocess.run(args,stdin=source,stdout=target if target is not None else subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=timeout)
    except subprocess.TimeoutExpired:
        diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='timeout',timeoutSeconds=timeout)
        raise
    finally:
        if stdin is not None:source.close()
        if target is not None:os.close(target)
    diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='ok' if result.returncode==0 else 'exit',exitCode=result.returncode)
    return result.returncode,result.stderr.decode(errors='replace')

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
