# helper/engine_redis.py: Redis 7 and Valkey 8 standalone contract, final-save log proof, offline RDB/AOF checks, key digests
# and online RDB snapshots.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    inspect, run)
from .engine_base import (
    DatabaseEngine, dump_command, in_writable_mount, require_readable_logs, stop_window_gap, time_left, writable_mount_source)
# </build:header>
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
    script='set -eu; IFS= read -r supplied; export REDISCLI_AUTH="${REDISCLI_AUTH:-${REDIS_PASSWORD:-$supplied}}"; file="${REDIS_PASSWORD_FILE:-}"; if [ -n "$file" ]; then REDISCLI_AUTH=$(cat -- "$file"); export REDISCLI_AUTH; fi; if [ -z "$REDISCLI_AUTH" ]; then unset REDISCLI_AUTH; fi; database="$1"; format="$2"; shift 2; cli=redis-cli; command -v redis-cli >/dev/null 2>&1 || cli=valkey-cli; exec "$cli" -e -h 127.0.0.1 -p 6379 -n "$database" "$format" -2 "$@"'
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
    source=writable_mount_source(directory,original)
    if source is None:raise ValueError('Redis AOF directory is outside captured writable mounts')
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

# Valkey is a Redis fork with the same protocol, files and CLI (valkey-cli, valkey-server, valkey-check-rdb); official
# images ship redis-* names too, but detection never relies on them. Supported: Redis 7.x and Valkey 7.2 / 8.x.
REDIS_BINARIES=('redis-server','valkey-server')
REDIS_SUPPORTED={'redis':r'7\.\d+\.\d+','valkey':r'(?:7\.2|8\.\d+)\.\d+'}
# The RDB checker is redis-check-rdb or valkey-check-rdb; a static script picks whichever the image has.
REDIS_CHECK_RDB='for tool in redis-check-rdb valkey-check-rdb; do if command -v "$tool" >/dev/null 2>&1; then exec "$tool" "$1"; fi; done; exit 127'
REDIS_FILE_NAME=re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}')

class RedisEngine(DatabaseEngine):
    binary='redis-server'
    version_pattern=r'\bv=(\d+\.\d+\.\d+)\b'
    check_field='key'
    # Online dump (docs/online-dumps.md): a BGSAVE snapshot, loaded by placing the RDB in a fresh data folder.
    dump_format='Redis RDB snapshot (BGSAVE)'
    init_marker='Ready to accept connections'

    def detect(self,cid):
        for binary in REDIS_BINARIES:
            try:output=run(['docker','exec',cid,binary,'--version'],timeout=10).decode(errors='replace')
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired):continue
            match=re.search(self.version_pattern,output)
            if match:return match[1]
        return None

    def check_version(self,version):
        if not re.fullmatch(r'[78]\.\d+\.\d+',version):raise ValueError('Redis native capture is limited to tested Redis 7 and Valkey 8 versions; reviewed adapter required')

    def validate(self,service,c):
        cid=c['Id'];server=redis_info(cid,service,'server');replication=redis_info(cid,service,'replication');persistence=redis_info(cid,service,'persistence')
        # Valkey keeps redis_version at its compatibility level and reports its own number as valkey_version.
        flavor='valkey' if 'valkey_version' in server or server.get('server_name')=='valkey' or service['version'].startswith('8.') else 'redis'
        # The binary may report either number (Valkey answers to both names), so either one identifies the same server.
        reported=[server.get('valkey_version'),server.get('redis_version')] if flavor=='valkey' else [server.get('redis_version')]
        native=service['version'] if service['version'] in reported or (flavor=='valkey' and 'valkey_version' not in server) else None
        if not re.fullmatch(REDIS_SUPPORTED[flavor],service['version']):raise ValueError('Redis native capture is limited to tested Redis 7 and Valkey 8 versions')
        if native!=service['version']:raise ValueError('Redis native version does not match the version of the installed server binary')
        # Valkey 8.1 and later name the mode server_mode (redis_mode is kept only for Redis clients that ask).
        if (server.get('redis_mode') or server.get('server_mode'))!='standalone':raise ValueError('Redis native version/mode does not match the standalone contract')
        if replication.get('role')!='master' or replication.get('connected_slaves')!='0':raise ValueError('Redis replication requires a reviewed adapter')
        options=redis_pairs(redis_query(cid,service,['CONFIG','GET','dir','dbfilename','appendonly','appenddirname','appendfilename','save','port','tls-port','cluster-enabled','aclfile','shutdown-on-sigterm','shutdown-on-sigint','loglevel','logfile']))
        required=['dir','dbfilename','appendonly','appenddirname','appendfilename','save','port','cluster-enabled','aclfile','shutdown-on-sigterm','shutdown-on-sigint','loglevel','logfile']
        if any(name not in options for name in required):raise ValueError('Redis persistence configuration could not be fully resolved')
        rdb=bool(options['save'].strip());aof=options['appendonly']=='yes'
        if options['appendonly'] not in ['yes','no']:raise ValueError('Redis persistence configuration could not be fully resolved')
        if options['port']!='6379' or options.get('tls-port','0')!='0' or options['cluster-enabled']!='no' or options['aclfile']:raise ValueError('Redis non-default port, TLS, cluster or ACL file requires a reviewed adapter')
        stop_signal=str(c['Config'].get('StopSignal') or 'SIGTERM').upper()
        if stop_signal not in ['SIGTERM','TERM','15','SIGINT','INT','2'] or any(options[name] not in ['default','save'] for name in ['shutdown-on-sigterm','shutdown-on-sigint']):raise ValueError('Redis requires a persistence-preserving SIGTERM/SIGINT shutdown; NOSAVE/FORCE and custom signals are blocked')
        if redis_query(cid,service,['ACL','USERS'])!=['default'] or redis_query(cid,service,['MODULE','LIST'])!=[]:raise ValueError('Redis custom ACL users or modules require a reviewed adapter')
        acl=redis_pairs(redis_query(cid,service,['ACL','GETUSER','default']))
        if 'on' not in acl.get('flags',[]) or acl.get('commands')!='+@all' or acl.get('keys') not in ['~*','%RW~*'] or acl.get('channels')!='&*' or acl.get('selectors',[]):raise ValueError('Redis restricted ACL configuration requires a reviewed adapter')
        if not (rdb or aof):
            # Cache only: no RDB schedule and no append-only file, so nothing on disk to prove or back up. The stopped
            # copy still includes the app's folders; the clean exit code is the shutdown evidence.
            service.update({'flavor':flavor,'persistence':'cache','rdbEnabled':False,'aofEnabled':False})
            return
        # The native proof uses NOTICE persistence messages and Docker stdout logs.
        # Reject invisible evidence before interrupting any source services.
        if options['logfile'] or options['loglevel'] not in ['debug','verbose','notice']:
            raise ValueError('Redis shutdown proof requires logfile "" and loglevel notice or more verbose; update the persistent Redis configuration before retrying')
        require_readable_logs(c,'Redis shutdown proof requires readable Docker logs; logging driver none is unsupported','Redis Docker logs are unavailable; fix the logging driver before retrying','Redis Docker logs are unavailable; enable a readable logging driver before retrying')
        healthy={'loading':'0','async_loading':'0','rdb_bgsave_in_progress':'0','aof_rewrite_in_progress':'0','aof_rewrite_scheduled':'0','rdb_last_bgsave_status':'ok'}
        if aof:healthy.update({'aof_enabled':'1','aof_last_write_status':'ok','aof_last_bgrewrite_status':'ok'})
        if any(persistence.get(name)!=value for name,value in healthy.items()):raise ValueError('Redis persistence is loading, busy or unhealthy; capture blocked')
        directory=options['dir']
        if not directory.startswith('/') or '..' in pathlib.PurePosixPath(directory).parts or directory=='/' or not in_writable_mount(directory,c):raise ValueError('Redis persistence directory must be inside a captured writable mount')
        if run(['docker','exec',cid,'readlink','-f',directory],timeout=30).decode().strip()!=directory:raise ValueError('Redis persistence directory symlinks require a reviewed adapter')
        for name in ['dbfilename','appenddirname','appendfilename']:
            if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',options[name]) or options[name] in ['.','..']:raise ValueError('Redis persistence filenames require a reviewed adapter')
        service.update({'flavor':flavor,'persistence':'disk','dataDirectory':directory,'rdbEnabled':rdb,'aofEnabled':aof,'rdbFilename':options['dbfilename'],'aofDirectory':options['appenddirname'],'aofFilename':options['appendfilename']})

    def stop_evidence(self,service,c,original,stopped_at,staging_root):
        if not service.get('rdbEnabled') and not service.get('aofEnabled'):return {'cacheOnly':True,'cleanShutdownLogVerified':False,'finalRdbSaveVerified':False,'finalAofFsyncVerified':False,'rdbOfflineVerified':False,'aofOfflineVerified':False}
        def gap(logs):
            if re.search(r'Fail to fsync the AOF file:|Error writing to the AOF file:|Error trying to save the DB',logs):raise ValueError('Redis current stop reported a persistence failure')
            if not re.search(r'^.*\b(?:Redis|Valkey) is now ready to exit, bye bye\.\.\.\s*$',logs,re.M):return 'graceful-shutdown'
            if service['rdbEnabled'] and not re.search(r'Saving the final RDB snapshot before exiting\.[\s\S]*DB saved on disk[\s\S]*(?:Redis|Valkey) is now ready to exit, bye bye\.\.\.',logs):return 'completed final RDB save'
            if service['aofEnabled'] and 'Calling fsync() on the AOF file.' not in logs:return 'AOF flush and fsync'
            return None
        failure=stop_window_gap(c['Id'],stopped_at,gap,'Redis current shutdown logs timed out; review the Docker logging driver before retrying','Redis current shutdown logs could not be read; review the Docker logging driver before retrying')
        if failure:raise ValueError('Redis current '+failure+' proof is missing after waiting for log delivery; verify Redis stdout logging and Docker log retention before retrying')
        flags=['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--user',service.get('flavor') or 'redis','--volumes-from',c['Id']+':ro']
        if service['rdbEnabled']:
            proof=run([*flags,'--entrypoint','sh',original['Image'],'-c',REDIS_CHECK_RDB,'docknest',service['dataDirectory']+'/'+service['rdbFilename']],timeout=120).decode(errors='replace')
            if 'RDB looks OK!' not in proof:raise ValueError('Redis offline RDB check did not pass')
        if service['aofEnabled']:
            copy_evidence=redis_aof_check(service,c,original,staging_root)
        else:copy_evidence={}
        return {'cleanShutdownLogVerified':True,'finalRdbSaveVerified':service['rdbEnabled'],'finalAofFsyncVerified':service['aofEnabled'],'rdbOfflineVerified':service['rdbEnabled'],'aofOfflineVerified':service['aofEnabled'],**copy_evidence}

    def ready(self,cid,service):
        return redis_query(cid,service,['PING'])=='PONG'

    def data_check(self,cid,service,check):
        key=check.get('key')
        if not isinstance(key,str) or not key or len(key.encode())>1024 or '\x00' in key:raise ValueError('Redis data checks require a named key up to 1024 bytes')
        kind=redis_query(cid,service,['TYPE',key])
        if kind not in ['string','list','set','zset','hash','stream']:raise ValueError('Redis named check requires an existing supported key')
        command='GET' if kind=='string' else 'DUMP'
        value=redis_query(cid,service,[command,key],raw=True)
        if (command=='DUMP' and not value) or redis_query(cid,service,['TYPE',key])!=kind:raise ValueError('Redis named key changed during its read-only check')
        return {'name':check['name'],'type':kind,'sha256':hashlib.sha256(kind.encode()+b'\x00'+value).hexdigest(),'method':'read-only Redis TYPE and '+command+' digest'}

    # Online snapshot (docs/online-dumps.md). Only an RDB-only server takes one: with an append-only file on, a server
    # starts from that file and ignores the RDB, so a restored snapshot would silently come back empty. Such servers
    # (and cache-only ones, which keep nothing on disk) keep the stopped file copy.
    def data_directory(self,service,c):
        return service.get('dataDirectory')

    def dump_blocker(self,service,c,host):
        if service.get('persistence')=='cache' or not service.get('rdbEnabled'):return 'it keeps nothing on disk'
        if service.get('aofEnabled'):return 'it also keeps an append-only file, which a snapshot does not replace'
        name=service.get('rdbFilename')
        if not isinstance(name,str) or not REDIS_FILE_NAME.fullmatch(name):return 'its snapshot file name cannot be used safely'
        if redis_info(c['Id'],service,'persistence').get('rdb_bgsave_in_progress')!='0':return 'it is saving to disk right now'
        others=sorted(entry.name for entry in host.iterdir() if entry.name!=name and not re.fullmatch(r'temp-\d+\.rdb',entry.name))
        if others:return 'its data folder holds files a snapshot does not keep ('+', '.join(others[:5])+')'
        return None

    def key_count(self,cid,service):
        total=0
        for value in redis_info(cid,service,'keyspace').values():
            match=re.match(r'keys=(\d+)',value)
            if match:total+=int(match[1])
        return total

    def dump(self,cid,service,directory,deadline):
        info=lambda:redis_info(cid,service,'persistence')
        before=info()
        if before.get('rdb_bgsave_in_progress')!='0':raise ValueError('the server was already saving to disk')
        options=redis_pairs(redis_query(cid,service,['CONFIG','GET','dir','dbfilename','appendonly']))
        name=service['rdbFilename']
        if options.get('dir')!=service['dataDirectory'] or options.get('dbfilename')!=name or options.get('appendonly')!='no':raise ValueError('its settings changed since the backup was planned')
        saves=int(before.get('rdb_saves','-1'));last=int(redis_query(cid,service,['LASTSAVE']))
        keys=self.key_count(cid,service)
        reply=redis_query(cid,service,['BGSAVE'])
        if not isinstance(reply,str) or 'Background saving started' not in reply:raise ValueError('the server did not start a snapshot')
        # Done when no save runs, it ended well and a save was counted: rdb_saves, or LASTSAVE (whole seconds) moving on.
        while True:
            time_left(deadline);after=info()
            if after.get('rdb_bgsave_in_progress')=='0':
                if after.get('rdb_last_bgsave_status')!='ok':raise ValueError('the server could not write its snapshot')
                if int(after.get('rdb_saves','-1'))>saves or int(redis_query(cid,service,['LASTSAVE']))>last:break
            time.sleep(0.5)
        # The file is read through the container (never a link on the host) into a new private file.
        code,_=dump_command(['docker','exec',cid,'cat','--',service['dataDirectory']+'/'+name],time_left(deadline),stdout=directory/'dump.rdb')
        if code:raise ValueError('the snapshot file could not be read')
        image=inspect([cid])[0]['Image']
        proof=run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','-v',str(directory)+':/docknest-dump:ro','--entrypoint','sh',image,'-c',REDIS_CHECK_RDB,'docknest','/docknest-dump/dump.rdb'],timeout=time_left(deadline)).decode(errors='replace')
        if 'RDB looks OK!' not in proof:raise ValueError('the snapshot did not pass the Redis file check')
        return {'format':self.dump_format,'databases':[name],'listing':{'keys':keys}}

    def load_dump(self,cid,service,directory,listing,timeout):
        names=listing['databases']
        if len(names)!=1 or not isinstance(names[0],str) or not REDIS_FILE_NAME.fullmatch(names[0]) or not isinstance(listing.get('keys'),int):raise ValueError('The database dump in this backup has no valid listing')
        data=listing['dataDirectory'];deadline=time.monotonic()+timeout
        # The fresh copy ran once on an empty folder; stop it, put the snapshot in place (owned like the folder), start it.
        run(['docker','stop','--time','60',cid],timeout=90)
        image=inspect([cid])[0]['Image']
        place='set -eu; d="$1"; f="$2"; cp /docknest-load/dump.rdb "$d/.docknest-load.tmp"; chown "$(stat -c %u:%g "$d")" "$d/.docknest-load.tmp"; chmod 600 "$d/.docknest-load.tmp"; mv -f "$d/.docknest-load.tmp" "$d/$f"'
        run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--volumes-from',cid,'-v',str(directory)+':/docknest-load:ro','--entrypoint','sh',image,'-c',place,'docknest',data,names[0]],timeout=time_left(deadline))
        run(['docker','start',cid],timeout=60)
        while True:
            try:
                if redis_query(cid,service,['PING'])=='PONG':break
            except ValueError:pass
            time_left(deadline);time.sleep(1)
        # Loaded means keys came back: any key when the source had some (a TTL may have expired a few meanwhile).
        if listing['keys']>0 and self.key_count(cid,service)==0:raise ValueError('The restored database has no keys after loading its snapshot')
