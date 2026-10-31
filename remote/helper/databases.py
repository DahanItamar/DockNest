# helper/databases.py: SQLite proofs, PostgreSQL/MySQL/Redis contracts, clean shutdown evidence, service restart, data checks.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    atomic_json, diagnostic, docker, inspect, run)
from .net import (
    health)
# </build:header>
def sqlite_file_source(filename,container):
    if not isinstance(filename,str) or not re.fullmatch(r'/[a-zA-Z0-9_./-]+',filename) or str(pathlib.PurePosixPath(filename))!=filename or '..' in pathlib.PurePosixPath(filename).parts:raise ValueError('SQLite database path must be a regular absolute file path')
    matches=[mount for mount in container['Mounts'] if filename==mount['Destination'] or filename.startswith(mount['Destination'].rstrip('/')+'/')]
    if not matches:raise ValueError('SQLite database must be inside a captured persistent mount')
    mount=max(matches,key=lambda value:len(value['Destination']));relative=os.path.relpath(filename,mount['Destination'])
    source=pathlib.Path(mount['Source']) if relative=='.' else pathlib.Path(mount['Source'])/relative
    if source.resolve()!=source or not source.is_file():raise ValueError('SQLite database path is unreadable or contains a symbolic link')
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

def database_query(container,service,query):
    """Local socket only. Credential files/variables stay inside the container."""
    if service['engine']=='postgres':
        args=['docker','exec','--user','postgres',container,'psql','-X','-w','-h','/var/run/postgresql','-U',service.get('user') or 'postgres','-d',service.get('database') or 'postgres','-At','-v','ON_ERROR_STOP=1','-c',query]
        return run(args,timeout=30).decode().strip()
    client='mariadb' if service['engine']=='mariadb' else 'mysql'
    # A [client] socket in an image's option file overrides MYSQL_UNIX_PORT.
    # Preserve an explicitly configured container-local socket as a CLI option;
    # default option-file behavior remains in effect when the variable is absent.
    script='set -eu; export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; file="${MYSQL_ROOT_PASSWORD_FILE:-${MARIADB_ROOT_PASSWORD_FILE:-}}"; if [ -n "$file" ]; then MYSQL_PWD=$(cat -- "$file"); export MYSQL_PWD; fi; set -- "$1" --protocol=socket --batch --skip-column-names --user="$2" --execute="$3"; if [ -n "${MYSQL_UNIX_PORT:-}" ]; then case "$MYSQL_UNIX_PORT" in /*) ;; *) exit 64 ;; esac; case "$MYSQL_UNIX_PORT" in *[!a-zA-Z0-9_./-]*) exit 64 ;; esac; set -- "$@" --socket="$MYSQL_UNIX_PORT"; fi; exec "$@"'
    return run(['docker','exec',container,'sh','-c',script,'docknest',client,service.get('user') or 'root',query],timeout=30).decode().strip()

def redis_query(container,service,command,raw=False):
    """Loopback only; password variables/files remain inside the container.

    An explicit --requirepass value is transported through stdin, never Docker
    command arguments or service evidence. Shell source is static and not interpolated.
    """
    database=str(service.get('database') or '0')
    if not re.fullmatch(r'\d{1,3}',database) or int(database)>15:raise ValueError('Redis checks require a supported numeric database 0..15')
    if service.get('user') not in [None,'default']:raise ValueError('Redis ACL users require a reviewed adapter')
    password='';arguments=inspect([container])[0]['Config'].get('Cmd') or []
    for index,value in enumerate(arguments):
        if value=='--requirepass':
            if index+1>=len(arguments):raise ValueError('Redis password configuration is incomplete')
            password=arguments[index+1]
    if any(character in password for character in ['\n','\r','\x00']):raise ValueError('Redis command password requires a reviewed credential adapter')
    script='set -eu; IFS= read -r supplied; export REDISCLI_AUTH="${REDISCLI_AUTH:-${REDIS_PASSWORD:-$supplied}}"; file="${REDIS_PASSWORD_FILE:-}"; if [ -n "$file" ]; then REDISCLI_AUTH=$(cat -- "$file"); export REDISCLI_AUTH; fi; if [ -z "$REDISCLI_AUTH" ]; then unset REDISCLI_AUTH; fi; database="$1"; format="$2"; shift 2; exec redis-cli -e -h 127.0.0.1 -p 6379 -n "$database" "$format" -2 "$@"'
    try:
        output=run(['docker','exec','-i',container,'sh','-c',script,'docknest',database,'--raw' if raw else '--json',*command],timeout=30,input=(password+'\n').encode())
        if raw:
            if not output.endswith(b'\n'):raise ValueError('Redis raw reply is incomplete')
            return output[:-1]
        return json.loads(output.decode())
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,UnicodeError,json.JSONDecodeError):raise ValueError('Redis local native query failed; review credentials and supported configuration')

def redis_pairs(value):
    if not isinstance(value,list) or len(value)%2:raise ValueError('Redis configuration reply is incomplete')
    return dict(zip(value[::2],value[1::2]))

def redis_info(container,service,section):
    # redis-cli renders INFO verbatim even when --json is selected.
    output=redis_query(container,service,['INFO',section],raw=True).decode()
    return dict(line.split(':',1) for line in output.splitlines() if line and not line.startswith('#') and ':' in line)

def validate_redis_contract(service,c):
    if not re.fullmatch(r'7\.4\.\d+',service['version']):raise ValueError('Redis native capture is limited to tested Redis 7.4 versions')
    cid=c['Id'];server=redis_info(cid,service,'server');replication=redis_info(cid,service,'replication');persistence=redis_info(cid,service,'persistence')
    if server.get('redis_version')!=service['version'] or server.get('redis_mode')!='standalone':raise ValueError('Redis native version/mode does not match the standalone contract')
    if replication.get('role')!='master' or replication.get('connected_slaves')!='0':raise ValueError('Redis replication requires a reviewed adapter')
    options=redis_pairs(redis_query(cid,service,['CONFIG','GET','dir','dbfilename','appendonly','appenddirname','appendfilename','save','port','tls-port','cluster-enabled','aclfile','shutdown-on-sigterm','shutdown-on-sigint','loglevel','logfile']))
    required=['dir','dbfilename','appendonly','appenddirname','appendfilename','save','port','cluster-enabled','aclfile','shutdown-on-sigterm','shutdown-on-sigint','loglevel','logfile']
    if any(name not in options for name in required):raise ValueError('Redis persistence configuration could not be fully resolved')
    # The native proof uses NOTICE persistence messages and Docker stdout logs.
    # Reject invisible evidence before interrupting any source services.
    if options['logfile'] or options['loglevel'] not in ['debug','verbose','notice']:
        raise ValueError('Redis shutdown proof requires logfile "" and loglevel notice or more verbose; update the persistent Redis configuration before retrying')
    if c.get('HostConfig',{}).get('LogConfig',{}).get('Type')=='none':raise ValueError('Redis shutdown proof requires readable Docker logs; logging driver none is unsupported')
    try:
        logging=subprocess.run(['docker','logs','--tail','0',cid],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
    except subprocess.TimeoutExpired:raise ValueError('Redis Docker logs are unavailable; fix the logging driver before retrying')
    if logging.returncode:raise ValueError('Redis Docker logs are unavailable; enable a readable logging driver before retrying')
    if options['port']!='6379' or options.get('tls-port','0')!='0' or options['cluster-enabled']!='no' or options['aclfile']:raise ValueError('Redis non-default port, TLS, cluster or ACL file requires a reviewed adapter')
    stop_signal=str(c['Config'].get('StopSignal') or 'SIGTERM').upper()
    if stop_signal not in ['SIGTERM','TERM','15','SIGINT','INT','2'] or any(options[name] not in ['default','save'] for name in ['shutdown-on-sigterm','shutdown-on-sigint']):raise ValueError('Redis requires a persistence-preserving SIGTERM/SIGINT shutdown; NOSAVE/FORCE and custom signals are blocked')
    if redis_query(cid,service,['ACL','USERS'])!=['default'] or redis_query(cid,service,['MODULE','LIST'])!=[]:raise ValueError('Redis custom ACL users or modules require a reviewed adapter')
    acl=redis_pairs(redis_query(cid,service,['ACL','GETUSER','default']))
    if 'on' not in acl.get('flags',[]) or acl.get('commands')!='+@all' or acl.get('keys') not in ['~*','%RW~*'] or acl.get('channels')!='&*' or acl.get('selectors',[]):raise ValueError('Redis restricted ACL configuration requires a reviewed adapter')
    rdb=bool(options['save'].strip());aof=options['appendonly']=='yes'
    if options['appendonly'] not in ['yes','no'] or not (rdb or aof):raise ValueError('Redis persistence must be explicitly enabled; cache-only inference is not supported')
    healthy={'loading':'0','async_loading':'0','rdb_bgsave_in_progress':'0','aof_rewrite_in_progress':'0','aof_rewrite_scheduled':'0','rdb_last_bgsave_status':'ok'}
    if aof:healthy.update({'aof_enabled':'1','aof_last_write_status':'ok','aof_last_bgrewrite_status':'ok'})
    if any(persistence.get(name)!=value for name,value in healthy.items()):raise ValueError('Redis persistence is loading, busy or unhealthy; capture blocked')
    directory=options['dir']
    if not directory.startswith('/') or '..' in pathlib.PurePosixPath(directory).parts or directory=='/' or not any(directory==m['Destination'] or directory.startswith(m['Destination'].rstrip('/')+'/') for m in c['Mounts'] if m.get('RW')):raise ValueError('Redis persistence directory must be inside a captured writable mount')
    if run(['docker','exec',cid,'readlink','-f',directory],timeout=30).decode().strip()!=directory:raise ValueError('Redis persistence directory symlinks require a reviewed adapter')
    for name in ['dbfilename','appenddirname','appendfilename']:
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',options[name]) or options[name] in ['.','..']:raise ValueError('Redis persistence filenames require a reviewed adapter')
    service.update({'dataDirectory':directory,'rdbEnabled':rdb,'aofEnabled':aof,'rdbFilename':options['dbfilename'],'aofDirectory':options['appenddirname'],'aofFilename':options['appendfilename']})

def redis_aof_inventory(directory):
    directory=pathlib.Path(directory)
    if not directory.is_dir() or directory.resolve()!=directory:raise ValueError('Redis AOF directory must be a regular captured directory')
    inventory={}
    for path in sorted(directory.iterdir()):
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            metadata=os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode):raise ValueError('Redis AOF checks reject links, directories and special files')
            digest=hashlib.sha256()
            with os.fdopen(fd,'rb',closefd=False) as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
            inventory[path.name]={'bytes':metadata.st_size,'sha256':digest.hexdigest()}
        finally:os.close(fd)
    if not inventory:raise ValueError('Redis AOF directory is empty')
    return inventory

def redis_aof_check(service,c,original,staging_root):
    # Redis 7.4 opens every AOF member with fopen("r+") even without --fix:
    # https://github.com/redis/redis/blob/7.4/src/redis-check-aof.c#L213
    # Only a disposable byte-identical copy is writable; live data is never mounted.
    if staging_root is None:raise ValueError('Redis offline AOF checks require private capture staging')
    staging_root=pathlib.Path(staging_root)
    if not staging_root.is_dir() or staging_root.resolve()!=staging_root or staging_root.stat().st_mode&0o077 or ',' in str(staging_root):raise ValueError('Redis AOF check staging must be a private regular directory without mount separators')
    directory=pathlib.PurePosixPath(service['dataDirectory'])/service['aofDirectory']
    mounts=[m for m in original['Mounts'] if m.get('RW') and (str(directory)==m['Destination'] or str(directory).startswith(m['Destination'].rstrip('/')+'/'))]
    if not mounts:raise ValueError('Redis AOF directory is outside captured writable mounts')
    mount=max(mounts,key=lambda m:len(m['Destination']))
    source=pathlib.Path(mount['Source'])/directory.relative_to(mount['Destination'])
    if os.path.commonpath([str(staging_root),str(source)]) in [str(staging_root),str(source)]:raise ValueError('Redis AOF check staging and source must not overlap')
    before=redis_aof_inventory(source)
    manifest=service['aofFilename']+'.manifest'
    if manifest not in before:raise ValueError('Redis multipart AOF manifest is missing')
    if shutil.disk_usage(staging_root).free<sum(item['bytes'] for item in before.values())+1024**3:raise ValueError('Insufficient private staging capacity for Redis AOF check')
    owner=source.stat()
    with tempfile.TemporaryDirectory(prefix='redis-aof-check-',dir=staging_root) as temporary:
        copy=pathlib.Path(temporary)
        for name in before:
            destination=copy/name
            source_fd=os.open(source/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                if not stat.S_ISREG(os.fstat(source_fd).st_mode):raise ValueError('Redis AOF validation copy requires regular source files')
                destination_fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                try:
                    with os.fdopen(source_fd,'rb',closefd=False) as reader,os.fdopen(destination_fd,'wb',closefd=False) as writer:
                        shutil.copyfileobj(reader,writer,1024*1024)
                    os.fchmod(destination_fd,0o600);os.fchown(destination_fd,owner.st_uid,owner.st_gid)
                finally:os.close(destination_fd)
            finally:os.close(source_fd)
        os.chown(copy,owner.st_uid,owner.st_gid)
        if redis_aof_inventory(source)!=before or redis_aof_inventory(copy)!=before:raise ValueError('Redis AOF validation copy does not match the stopped source')
        try:
            proof=run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--memory','1g','--memory-swap','1g','--cpus','1','--pids-limit','64','--user',str(owner.st_uid)+':'+str(owner.st_gid),'--mount','type=bind,src='+str(copy)+',dst=/check','--entrypoint','redis-check-aof',original['Image'],'/check/'+manifest],timeout=120).decode(errors='replace')
        finally:
            if redis_aof_inventory(source)!=before or redis_aof_inventory(copy)!=before:raise ValueError('Redis AOF source or disposable copy changed during validation')
        if 'All AOF files and manifest are valid' not in proof:raise ValueError('Redis offline multipart AOF check did not pass')
    return {'aofValidationCopyVerified':True,'aofSourceUnchangedVerified':True}

def redis_shutdown_evidence(service,c,original,stopped_at,staging_root=None):
    # Docker logging delivery can lag behind docker stop returning. Re-read only
    # this stop's window; never fall back to historical successful shutdowns.
    for attempt in range(6):
        # Explicit numeric tail avoids empty --since-only reads observed on
        # Docker 29.1.3 json-file logs. Keep --since so old proof cannot pass.
        try:output=subprocess.run(['docker','logs','--tail','10000','--since',str(stopped_at),c['Id']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
        except subprocess.TimeoutExpired:raise ValueError('Redis current shutdown logs timed out; review the Docker logging driver before retrying')
        if output.returncode:raise ValueError('Redis current shutdown logs could not be read; review the Docker logging driver before retrying')
        logs=(output.stdout+output.stderr).decode(errors='replace')
        if re.search(r'Fail to fsync the AOF file:|Error writing to the AOF file:|Error trying to save the DB',logs):raise ValueError('Redis current stop reported a persistence failure')
        if not re.search(r'^.*\bRedis is now ready to exit, bye bye\.\.\.\s*$',logs,re.M):failure='graceful-shutdown'
        elif service['rdbEnabled'] and not re.search(r'Saving the final RDB snapshot before exiting\.[\s\S]*DB saved on disk[\s\S]*Redis is now ready to exit, bye bye\.\.\.',logs):failure='completed final RDB save'
        elif service['aofEnabled'] and 'Calling fsync() on the AOF file.' not in logs:failure='AOF flush and fsync'
        else:break
        if attempt==5:raise ValueError('Redis current '+failure+' proof is missing after waiting for log delivery; verify Redis stdout logging and Docker log retention before retrying')
        time.sleep(1)
    flags=['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--user','redis','--volumes-from',c['Id']+':ro']
    if service['rdbEnabled']:
        proof=run([*flags,'--entrypoint','redis-check-rdb',original['Image'],service['dataDirectory']+'/'+service['rdbFilename']],timeout=120).decode(errors='replace')
        if 'RDB looks OK!' not in proof:raise ValueError('Redis offline RDB check did not pass')
    if service['aofEnabled']:
        copy_evidence=redis_aof_check(service,c,original,staging_root)
    else:copy_evidence={}
    return {'cleanShutdownLogVerified':True,'finalRdbSaveVerified':service['rdbEnabled'],'finalAofFsyncVerified':service['aofEnabled'],'rdbOfflineVerified':service['rdbEnabled'],'aofOfflineVerified':service['aofEnabled'],**copy_evidence}

def validate_database_contracts(services,containers):
    by_id={c['Id']:c for c in containers}
    for service in services:
        if service['engine']=='generic':continue
        c=by_id[service['container']]
        if service['engine']=='postgres':
            env=dict(v.split('=',1) for v in c['Config'].get('Env',[]) if '=' in v)
            service['user']=service.get('user') or env.get('POSTGRES_USER','postgres')
            service['database']=service.get('database') or env.get('POSTGRES_DB',service['user'])
            version=database_query(c['Id'],service,'SHOW server_version;').split()[0]
            if version!=service['version']:raise ValueError('Running PostgreSQL version does not match the installed server binary')
            data=database_query(c['Id'],service,'SHOW data_directory;')
            if not data.startswith('/') or '..' in pathlib.PurePosixPath(data).parts or not any(data==m['Destination'] or data.startswith(m['Destination'].rstrip('/')+'/') for m in c['Mounts'] if m.get('RW')):raise ValueError('Active PostgreSQL data directory must be included in a writable captured mount')
            if database_query(c['Id'],service,'SELECT pg_is_in_recovery();')!='f':raise ValueError('PostgreSQL standby/recovery capture requires a separate adapter')
            if database_query(c['Id'],service,"SELECT COUNT(*) FROM pg_tablespace WHERE pg_tablespace_location(oid) <> '';")!='0':raise ValueError('External PostgreSQL tablespaces require a reviewed capture adapter')
            service['dataDirectory']=data
        elif service['engine']=='redis':validate_redis_contract(service,c)
        else:
            values=database_query(c['Id'],service,'SELECT @@version, @@global.innodb_fast_shutdown, @@datadir;').split('\t')
            if len(values)!=3 or values[1] not in ['0','1','2']:raise ValueError('Cannot validate the native database shutdown setting')
            if not values[0].startswith(service['version']):raise ValueError('Running database version does not match the installed server binary')
            data=values[2].rstrip('/')
            if not any(data==m['Destination'] or data.startswith(m['Destination'].rstrip('/')+'/') for m in c['Mounts'] if m.get('RW')):raise ValueError('Database data directory must be included in a captured writable mount')
            service['originalFastShutdown']=int(values[1])
            service['slowShutdownVerified']=values[1]=='0'

def prepare_database_shutdown(service):
    # Read-only plans never change the server. Prepare only the running capture,
    # after writers stop; the recovery contract restores the original value.
    if service['engine'] not in ['mysql','mariadb']:return
    cid=service['container']
    database_query(cid,service,'SET GLOBAL innodb_fast_shutdown=0;')
    if database_query(cid,service,'SELECT @@global.innodb_fast_shutdown;')!='0':raise ValueError('Could not prepare a verified slow database shutdown; capture blocked')
    service['slowShutdownVerified']=True

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
        if service['engine']=='postgres':
            original=by_id[c['Id']]
            output=run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--user','postgres','--volumes-from',c['Id']+':ro','--env','LC_ALL=C','--entrypoint','pg_controldata',original['Image'],service['dataDirectory']],timeout=30).decode()
            if not re.search(r'^Database cluster state:\s+shut down\s*$',output,re.M):raise ValueError('PostgreSQL control file does not prove a clean primary shutdown')
            item['controlFileCleanShutdownVerified']=True
        elif service['engine'] in ['mysql','mariadb']:
            output=subprocess.run(['docker','logs','--tail','10000','--since',str(stopped_at),c['Id']],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
            if output.returncode or 'shutdown complete' not in (output.stdout+output.stderr).decode(errors='replace').lower():raise ValueError('Native database shutdown evidence missing from the current stop')
            item.update({'slowShutdownVerified':service['slowShutdownVerified'],'cleanShutdownLogVerified':True})
        elif service['engine']=='redis':item.update(redis_shutdown_evidence(service,c,by_id[c['Id']],stopped_at,staging_root))
        else:item['applicationShutdownConfirmed']=True
        evidence.append(item)
    return evidence

def restart_services(ids,services=None,started=None):
    # `started(level)` runs right after each level starts (restore tests isolate egress there); None changes nothing.
    by_id={s['container']:s for s in services or []};pending=list(ids)
    while pending:
        # Independent services start together; their health may depend on one another.
        level=[cid for cid in pending if not set(by_id.get(cid,{}).get('dependsOn',[])).intersection(pending)]
        if not level:raise ValueError('Recovery dependency cycle; operator review required')
        docker('start',*level)
        if started:started(level)
        deadline=time.time()+120
        def ready():
            if not health(level):return False
            for cid in level:
                service=by_id.get(cid)
                if service and service['engine']!='generic':
                    try:
                        if service['engine']=='redis':
                            if redis_query(cid,service,['PING'])!='PONG':return False
                        elif database_query(cid,service,'SELECT 1;')!='1':return False
                    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError):return False
            return True
        while time.time()<deadline and not ready():time.sleep(2)
        if not ready():raise ValueError('Service failed restart health; dependants remain stopped')
        for cid in level:
            service=by_id.get(cid,{})
            if service.get('engine') in ['mysql','mariadb'] and 'originalFastShutdown' in service:
                value=service['originalFastShutdown']
                if value not in [0,1,2]:raise ValueError('Invalid original database shutdown setting')
                database_query(cid,service,'SET GLOBAL innodb_fast_shutdown='+str(value)+';')
                if database_query(cid,service,'SELECT @@global.innodb_fast_shutdown;')!=str(value):raise ValueError('Original database setting did not recover; dependants remain stopped')
        pending=[cid for cid in pending if cid not in level]

def data_checks(container,service):
    result=[]
    for check in service.get('checks',[]):
        if service['engine']=='redis':
            key=check.get('key')
            if not isinstance(key,str) or not key or len(key.encode())>1024 or '\x00' in key:raise ValueError('Redis data checks require a named key up to 1024 bytes')
            kind=redis_query(container,service,['TYPE',key])
            if kind not in ['string','list','set','zset','hash','stream']:raise ValueError('Redis named check requires an existing supported key')
            command='GET' if kind=='string' else 'DUMP'
            value=redis_query(container,service,[command,key],raw=True)
            if (command=='DUMP' and not value) or redis_query(container,service,['TYPE',key])!=kind:raise ValueError('Redis named key changed during its read-only check')
            result.append({'name':check['name'],'type':kind,'sha256':hashlib.sha256(kind.encode()+b'\x00'+value).hexdigest(),'method':'read-only Redis TYPE and '+command+' digest'})
            continue
        table=check['table']
        if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]{0,62}',table):raise ValueError('Data check table must be a simple identifier')
        if service['engine']=='postgres':query='BEGIN READ ONLY; SELECT COUNT(*) FROM "'+table+'"; COMMIT;'
        elif service['engine'] in ['mysql','mariadb']:
            database=service.get('database')
            if not database or not re.fullmatch(r'[a-zA-Z0-9_]{1,63}',database):raise ValueError('Database name is required for MySQL/MariaDB data checks')
            query='START TRANSACTION READ ONLY; SELECT COUNT(*) FROM `'+database+'`.`'+table+'`; COMMIT;'
        else:raise ValueError('Generic services require a reviewed application-check adapter')
        output=database_query(container,service,query)
        values=[line.strip() for line in output.splitlines() if re.fullmatch(r'\d+',line.strip())]
        if len(values)!=1:raise ValueError('Native data check did not return one count')
        result.append({'name':check['name'],'table':table,'sha256':hashlib.sha256(values[0].encode()).hexdigest(),'method':'read-only table row count'})
    return result
