# helper/databases.py: SQLite proofs, the database ENGINES registry, contracts, clean shutdown evidence, service restart, data checks.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    atomic_json, diagnostic, docker, inspect)
from .net import (
    health)
from .engine_postgres import (
    PostgresEngine)
from .engine_mysql import (
    MysqlEngine)
from .engine_redis import (
    RedisEngine)
# </build:header>
def sqlite_file_source(filename,container):
    if not isinstance(filename,str) or not re.fullmatch(r'/[a-zA-Z0-9_./-]+',filename) or str(pathlib.PurePosixPath(filename))!=filename or '..' in pathlib.PurePosixPath(filename).parts:raise ValueError('SQLite database path must be a regular absolute file path')
    matches=[mount for mount in container['Mounts'] if filename==mount['Destination'] or filename.startswith(mount['Destination'].rstrip('/')+'/')]
    if not matches:raise ValueError('SQLite database must be inside a captured persistent mount')
    mount=max(matches,key=lambda value:len(value['Destination']));relative=os.path.relpath(filename,mount['Destination'])
    source=pathlib.Path(mount['Source']) if relative=='.' else pathlib.Path(mount['Source'])/relative
    if source.is_symlink() or source.resolve()!=source:raise ValueError('SQLite database path contains a symbolic link: '+filename)
    if not source.is_file():raise ValueError('SQLite database file is missing or not a regular file: '+filename)
    with source.open('rb') as file:
        if file.read(16)!=b'SQLite format 3\x00':raise ValueError('Declared file is not a SQLite format-3 database')
    return source,mount

SQLITE_OFFLINE_CHECK_MAX_BYTES=1024**3
def sqlite_checked_online(source):
    """WAL databases above the offline limit are checked from a live read snapshot."""
    if source.stat().st_size<=SQLITE_OFFLINE_CHECK_MAX_BYTES:return False
    with source.open('rb') as file:header=file.read(20)
    return header[18:20]==b'\x02\x02'

def sqlite_check_mode(cfg):
    mode=cfg.get('sqliteIntegrityCheck','full')
    if mode not in ['full','off']:raise ValueError('sqliteIntegrityCheck must be full or off')
    return mode

def online_sqlite_checks(services,containers,cfg):
    """Run before maintenance or stop: a WAL read snapshot does not block writers."""
    if sqlite_check_mode(cfg)=='off':return
    limit=int(cfg.get('sqliteOnlineCheckTimeout',7200))
    if limit<60 or limit>21600:raise ValueError('Online SQLite check timeout must be 60..21600 seconds')
    if not any(service.get('sqliteFiles') for service in services):return
    by_id={c['Id']:c for c in containers};results={}
    for service in services:
        if not service.get('sqliteFiles') or service['container'] not in by_id:continue
        for filename in service['sqliteFiles']:
            source,_=sqlite_file_source(filename,by_id[service['container']])
            if str(source) in results or not sqlite_checked_online(source):continue
            started=time.monotonic();diagnostic(command='sqlite integrity_check',phase='start')
            connection=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=30)
            try:
                connection.execute('PRAGMA query_only=ON');connection.execute('BEGIN')
                deadline=started+limit;connection.set_progress_handler(lambda:1 if time.monotonic()>deadline else 0,10000)
                try:status=connection.execute('PRAGMA integrity_check').fetchall()
                except sqlite3.OperationalError:
                    if time.monotonic()>deadline:
                        diagnostic(command='sqlite integrity_check',phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='timeout',timeoutSeconds=limit)
                        raise ValueError('Online SQLite integrity check exceeded %d seconds; raise sqliteOnlineCheckTimeout'%limit)
                    raise
                if status!=[('ok',)]:raise ValueError('Online SQLite integrity check failed')
            finally:connection.close()
            elapsed=time.monotonic()-started
            diagnostic(command='sqlite integrity_check',phase='finish',elapsedMs=round(elapsed*1000),outcome='ok')
            results[str(source)]={'path':filename,'integrity':'ok','elapsedSeconds':round(elapsed,1),'method':'online SQLite integrity_check on a WAL read snapshot'}
    for service in services:
        if service.get('sqliteFiles') and service['container'] in by_id:
            service['onlineSqliteChecks']=[results[str(sqlite_file_source(f,by_id[service['container']])[0])] for f in service['sqliteFiles'] if str(sqlite_file_source(f,by_id[service['container']])[0]) in results]

SQLITE_PROOF_CACHE=pathlib.Path('/var/lib/docknest/sqlite-proof-cache.json')
def file_identity(source):
    info=os.stat(source)
    return {'device':info.st_dev,'inode':info.st_ino,'bytes':info.st_size,'mtimeNs':info.st_mtime_ns,'ctimeNs':info.st_ctime_ns}

def file_sha256(source):
    digest=hashlib.sha256()
    with open(source,'rb') as file:
        while chunk:=file.read(8*1024*1024):digest.update(chunk)
    return digest.hexdigest()

def load_sqlite_proof_cache():
    try:
        value=json.loads(SQLITE_PROOF_CACHE.read_text())
        return value if isinstance(value,dict) and value.get('version')==1 and isinstance(value.get('files'),dict) else {'version':1,'files':{}}
    except (OSError,ValueError):return {'version':1,'files':{}}

def reusable_sqlite_proof(source,filename):
    """Reuse a passed offline check only for a byte-identical, unchanged database file."""
    entry=load_sqlite_proof_cache()['files'].get(str(source))
    if not isinstance(entry,dict) or entry.get('sqliteVersion')!=sqlite3.sqlite_version:return None
    identity=file_identity(source)
    if entry.get('identity')!=identity:return None
    started=time.monotonic();diagnostic(command='sqlite unchanged-file check',phase='start')
    matched=file_sha256(source)==entry.get('sha256') and file_identity(source)==identity
    diagnostic(command='sqlite unchanged-file check',phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='ok' if matched else 'exit',exitCode=0 if matched else 1)
    return {**entry['evidence'],'path':filename} if matched else None

def remember_sqlite_proof(source,identity,item):
    # Called only after a passed offline check; the file must not change during it.
    if file_identity(source)!=identity:return
    cache=load_sqlite_proof_cache()
    cache['files'][str(source)]={'identity':identity,'sha256':file_sha256(source),'sqliteVersion':sqlite3.sqlite_version,'evidence':item,'checkedAt':time.time()}
    if file_identity(source)!=identity:return
    SQLITE_PROOF_CACHE.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    atomic_json(SQLITE_PROOF_CACHE,cache)

def sqlite_file_proof(service,container,reuse=False):
    evidence=[]
    for filename in service['sqliteFiles']:
        source,_=sqlite_file_source(filename,container)
        journal=pathlib.Path(str(source)+'-journal')
        if journal.exists() and journal.stat().st_size:raise ValueError('SQLite rollback journal needs recovery before offline capture')
        for suffix in ['-wal','-shm','-journal']:
            sidecar=pathlib.Path(str(source)+suffix)
            if sidecar.exists() and (sidecar.resolve()!=sidecar or not sidecar.is_file()):raise ValueError('SQLite sidecar must be a captured regular file')
        if service.get('sqliteCheckMode')=='off' and source.stat().st_size>SQLITE_OFFLINE_CHECK_MAX_BYTES:
            # Site opted out of long integrity checks; consistency still rests on the
            # verified clean shutdown, and restore verification repeats this digest.
            identity=file_identity(source)
            evidence.append({'path':filename,'bytes':identity['bytes'],'sha256':file_sha256(source),'method':'offline file SHA-256 after clean shutdown; integrity check disabled for this site'})
            continue
        if sqlite_checked_online(source):
            # Large WAL databases are integrity-checked online before shutdown; offline
            # evidence is a deterministic file digest that restore verification repeats.
            digest=hashlib.sha256();size=0
            with source.open('rb') as file:
                while chunk:=file.read(8*1024*1024):digest.update(chunk);size+=len(chunk)
            evidence.append({'path':filename,'bytes':size,'sha256':digest.hexdigest(),'method':'online SQLite integrity_check before shutdown and offline file SHA-256'})
            continue
        large=reuse and source.stat().st_size>SQLITE_OFFLINE_CHECK_MAX_BYTES
        if large:
            reused=reusable_sqlite_proof(source,filename)
            if reused is not None:evidence.append(reused);continue
            identity=file_identity(source)
        connection=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=5)
        try:
            connection.execute('PRAGMA query_only=ON');connection.execute('BEGIN')
            deadline=time.monotonic()+600;connection.set_progress_handler(lambda:1 if time.monotonic()>deadline else 0,10000)
            if connection.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:raise ValueError('Offline SQLite integrity check failed')
            tables=[row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            counts={name:connection.execute('SELECT count(*) FROM "'+name.replace('"','""')+'"').fetchone()[0] for name in tables}
            evidence.append({'path':filename,'integrity':'ok','tableCount':len(tables),'tableDigest':hashlib.sha256(json.dumps(counts,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'method':'offline SQLite integrity_check and table counts'})
        finally:connection.close()
        if large:remember_sqlite_proof(source,identity,evidence[-1])
    return evidence

def cached_sqlite_file_proof(cache,service,container,reuse=False):
    # Only used while every selected writer is stopped, before restore startup.
    key=tuple((filename,str(sqlite_file_source(filename,container)[0])) for filename in service['sqliteFiles'])
    if key not in cache:cache[key]=sqlite_file_proof(service,container,reuse)
    return cache[key]

# Native engines in detection order: the first whose server binary answers `--version` wins (MariaDB images can
# also ship mysqld). The engine modules (engine_*.py) hold every engine-specific step; nothing else branches on one.
ENGINES={'postgres':PostgresEngine(),'mariadb':MysqlEngine('mariadbd','mariadb'),'mysql':MysqlEngine('mysqld','mysql'),'redis':RedisEngine()}

def database_query(container,service,query):
    """Local socket only. Credential files/variables stay inside the container."""
    return ENGINES[service['engine']].query(container,service,query)

def validate_database_contracts(services,containers):
    by_id={c['Id']:c for c in containers}
    for service in services:
        if service['engine']!='generic':ENGINES[service['engine']].validate(service,by_id[service['container']])

def prepare_database_shutdown(service):
    engine=ENGINES.get(service['engine'])
    if engine:engine.prepare_stop(service)

def shutdown_evidence(services,containers,stopped_at,staging_root=None):
    evidence=[];by_id={c['Id']:c for c in containers}
    sqlite_cache={}
    for service in services:
        c=inspect([service['container']])[0];state=c['State']
        sqlite_term=service['engine']=='generic' and service.get('sqliteFiles') and service.get('sqliteSigtermConfirmed') and state['ExitCode']==143 and c['Config'].get('StopSignal','SIGTERM') in ['SIGTERM','TERM','15']
        if state['Running'] or (state['ExitCode']!=0 and not sqlite_term) or state.get('OOMKilled'):raise ValueError('Clean shutdown failed: running, nonzero exit or OOM')
        item={'container':c['Id'],'engine':service['engine'],'version':service['version'],'zeroExitCodeVerified':state['ExitCode']==0}
        if service.get('sqliteFiles'):
            # Capture may reuse a passed check for byte-identical files; restore always rechecks.
            proof=cached_sqlite_file_proof(sqlite_cache,service,c,reuse=True)
            service['expectedSqliteChecks']=proof
            item.update(sqliteOfflineIntegrityVerified=all('integrity' in check for check in proof),sqliteOnlineChecks=service.get('onlineSqliteChecks',[]),sqliteChecks=proof,sigtermExit143Verified=bool(sqlite_term),validatorVersion=sqlite3.sqlite_version)
        engine=ENGINES.get(service['engine'])
        if engine:item.update(engine.stop_evidence(service,c,by_id.get(c['Id']),stopped_at,staging_root))
        else:item['applicationShutdownConfirmed']=True
        evidence.append(item)
    return evidence

def restart_services(ids,services=None,started=None):
    # `started(level)` runs right after each level starts (restore tests isolate egress there); None changes nothing.
    by_id={s['container']:s for s in services or []};pending=list(ids)
    def engine_of(cid):return ENGINES.get(by_id.get(cid,{}).get('engine'))
    while pending:
        # Independent services start together; their health may depend on one another.
        level=[cid for cid in pending if not set(by_id.get(cid,{}).get('dependsOn',[])).intersection(pending)]
        if not level:raise ValueError('Recovery dependency cycle; operator review required')
        docker('start',*level)
        if started:started(level)
        deadline=time.time()+120
        def ready():
            if not health(level):return False
            try:return all(engine_of(cid).ready(cid,by_id[cid]) for cid in level if engine_of(cid))
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError):return False
        while time.time()<deadline and not ready():time.sleep(2)
        if not ready():raise ValueError('Service failed restart health; dependants remain stopped')
        for cid in level:
            if engine_of(cid):engine_of(cid).after_start(cid,by_id[cid])
        pending=[cid for cid in pending if cid not in level]

def data_checks(container,service):
    engine=ENGINES.get(service['engine'])
    if service.get('checks') and not engine:raise ValueError('Generic services require a reviewed application-check adapter')
    return [engine.data_check(container,service,check) for check in service.get('checks',[])]
