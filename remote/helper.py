#!/usr/bin/env python3
"""Versioned Linux helper. No request values are interpolated into shell commands."""
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress
VERSION=1

RESTORE_GUIDE="""# Independent restore guide — format v1
Keep the DBM1 encrypted file, its SHA256 checksum, and the separate 32-byte master key.
Use scripts/decrypt-backup.js from this project's repository on Node.js 24. Verify the whole GCM tag and checksum before extraction. Never extract plaintext streamed before authentication.
After successful authenticated decryption, unpack payload.tar.gz into a new root-owned directory with mode 0700. Reject absolute paths, traversal, device nodes, escaping links and writes through symlinks before extraction. Safe relative symlinks and hard links to archived regular files are preserved.
Contents: manifest.json (contains secret Docker environment and settings), images.tar (exact original images and committed writable layers), mount-I-J.tar for each container/mount, config-I.tar for explicit compose/env/config files, and this guide.
Run docker load -i images.tar. Match manifest.containers[I] with manifest.snapshotImages[I]; do not use latest from a registry.
Extract each mount-I-J.tar into a different empty directory, keeping numeric UID/GID, modes, ACLs and xattrs. Recreate mounts at manifest.containers[I].Mounts[J].Destination; use read-only when RW is false. Never overwrite live bind paths or existing volume data.
For the basic isolated one-container restore, use docker create --name NEW_UNIQUE_NAME --network none --restart no --mount type=bind,src=NEW_SOURCE,dst=ORIGINAL_DEST SNAPSHOT_IMAGE_ID for every mount; append readonly when required. Committed image configuration preserves original command, entrypoint, environment and health check. Then docker start NEW_UNIQUE_NAME.
Run docker inspect and docker exec checks to verify database records, uploaded files, login and important workflows. No inbound or outbound networking is available in this mode. Network isolation prevents production emails, payments and integrations. Do not enable networking until secrets, scheduled jobs and external side effects have been reviewed.
The automatic grouped restore creates fresh internal bridge networks with isolated gateway mode (Docker 28+), preserves original network membership and DNS aliases, publishes no ports, disables external DNS forwarding and keeps originally stopped containers stopped. Static IP assignments, shared container network namespaces and overlapping mount paths require a reviewed offline adapter. Saved Compose files require path/port/project-name updates and secret review; do not run them unchanged.
Copy config archives into separate review directories. Configure TLS, reverse proxy, domains and DNS separately. Plan cutover only after application validation succeeds.
Replacement requires a verified backup of the current target before stopping it, explicit confirmation, a rollback plan and separate health verification. Never infer application recoverability from transport checksum alone.
Delete plaintext staging securely according to your storage policy; filesystem deletion alone does not guarantee erasure on every disk.
"""

EVENT_STREAM=sys.stdout
CAPTURE_DIAGNOSTICS=False
def emit(**kw): print(json.dumps(kw),file=EVENT_STREAM,flush=True)
def diagnostic(**kw):
    if CAPTURE_DIAGNOSTICS:emit(diagnostic={'at':time.time(),**kw})
def sync_directory(path):
    directory=os.open(path,os.O_RDONLY)
    try:os.fsync(directory)
    finally:os.close(directory)

def create_staging_root(root):
    root=pathlib.Path(root);root.mkdir(parents=True,mode=0o700)
    # Each new ancestor entry must survive before a journal can authorize stop.
    for directory in [root,*root.parents]:sync_directory(directory)

def sync_maintenance_flag(directory):
    flag=directory/'enabled'
    if flag.exists():
        with flag.open('rb') as source:os.fsync(source.fileno())
    sync_directory(directory)

def atomic_json(path,value):
    path=pathlib.Path(path);temporary=path.with_name(path.name+'.tmp-'+str(uuid.uuid4()))
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'w') as output:json.dump(value,output);output.flush();os.fsync(output.fileno())
        os.replace(temporary,path)
        directory=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:temporary.unlink(missing_ok=True)
def complete_recovery(root,boot_id=None):
    """One durable marker both records completion and disarms all recovery drivers."""
    root=pathlib.Path(root);marker=root/'disarmed'
    record={'version':1,'completed':True,'at':time.time()}
    if boot_id is not None:record['bootId']=boot_id
    try:atomic_json(marker,record)
    except Exception:
        # atomic_json may have renamed before directory fsync failed. Keep this
        # job armed on failure and let the caller persist operator-review evidence.
        try:
            marker.unlink(missing_ok=True)
            directory=os.open(root,os.O_RDONLY)
            try:os.fsync(directory)
            finally:os.close(directory)
        except OSError:pass
        raise
def run(args,timeout=3600,input=None):
    started=time.monotonic();label=pathlib.Path(args[0]).name+(' '+str(args[1]) if len(args)>1 and args[0]=='docker' else '')
    diagnostic(command=label,phase='start')
    try:
        result=subprocess.check_output(args,stderr=subprocess.DEVNULL,timeout=timeout,input=input)
        diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='ok')
        return result
    except subprocess.TimeoutExpired:
        diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='timeout',timeoutSeconds=timeout)
        raise
    except subprocess.CalledProcessError as error:
        diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='exit',exitCode=error.returncode)
        raise
def docker(*args): return run(['docker',*args])
def inspect(ids): return json.loads(docker('inspect',*ids))

# A Docker bind path can conceal a remote filesystem. Unknown filesystems fail closed.
LOCAL_FILESYSTEMS={'ext2','ext3','ext4','xfs','btrfs','zfs','overlay'}
def mount_table(text=None):
    if text is None:
        try:text=pathlib.Path('/proc/self/mountinfo').read_text()
        except OSError:raise ValueError('Cannot inspect Linux mount tables; capture is blocked')
    def unescape(value):return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),value)
    result=[]
    for line in text.splitlines():
        fields=line.split();
        try:
            divider=fields.index('-')
            if divider<6 or len(fields)<divider+4:raise ValueError()
            result.append({'id':fields[0],'device':fields[2],'root':unescape(fields[3]),'path':unescape(fields[4]),'filesystem':fields[divider+1],'readOnly':'ro' in fields[5].split(',')})
        except (ValueError,IndexError):raise ValueError('Malformed Linux mount table; capture is blocked')
    if not result:raise ValueError('Empty Linux mount table; capture is blocked')
    return result

def classify_source(source,table=None,excluded=()):
    table=mount_table() if table is None else table
    value=os.path.abspath(source)
    if os.path.realpath(value)!=value:raise ValueError('Source path contains a symbolic link; reviewed mapping required')
    covering=[m for m in table if value==m['path'] or value.startswith(m['path'].rstrip('/')+'/')]
    if not covering:raise ValueError('Source filesystem could not be classified')
    mount=max(covering,key=lambda m:len(m['path']))
    if mount['filesystem'] not in LOCAL_FILESYSTEMS:raise ValueError('Unsupported source filesystem: '+mount['filesystem']+'. NFS/CIFS/FUSE and unknown filesystems require an adapter.')
    if any(m['path']!=value and m['path'].startswith(value.rstrip('/')+'/') and not excluded_path(m['path'],excluded) for m in table):raise ValueError('Source contains a nested mount; reviewed capture adapter required')
    metadata=os.stat(value,follow_symlinks=False)
    result={'filesystem':mount['filesystem'],'mountId':mount['id'],'device':metadata.st_dev,'inode':metadata.st_ino,'path':value}
    if excluded:result['excludedPaths']=sorted(excluded)
    return result

def excluded_path(path,excluded):
    return any(path==entry or path.startswith(entry+'/') for entry in excluded)

def mount_exclusions(cfg,containers):
    declarations=cfg.get('mountExclusions',[])
    if declarations and not cfg.get('mountExclusionsConfirmed'):raise ValueError('Confirm excluded data is outside this backup and must be recovered separately')
    sources={m['Source'] for c in containers for m in c['Mounts']};result={}
    for item in declarations:
        source=item.get('source','');path=item.get('path','')
        if source not in sources or not re.fullmatch(r'/[a-zA-Z0-9_./-]+',path) or '..' in pathlib.PurePosixPath(path).parts or str(pathlib.PurePosixPath(path))!=path or not path.startswith(source.rstrip('/')+'/'):
            raise ValueError('Mount exclusions require a current selected source and an exact child path')
        if not isinstance(item.get('reason'),str) or not item['reason'].strip():raise ValueError('Every mount exclusion needs a recovery reason')
        if 'requiredForRestore' in item and not isinstance(item['requiredForRestore'],bool):raise ValueError('External restore requirement must be a boolean')
        if os.path.realpath(path)!=path:raise ValueError('Excluded paths cannot contain symbolic links')
        if path in result.get(source,[]):raise ValueError('Duplicate mount exclusion')
        result.setdefault(source,[]).append(path)
    for filename in cfg.get('composeFiles',[])+cfg.get('configFiles',[]):
        if any(excluded_path(filename,paths) for paths in result.values()):raise ValueError('Required configuration cannot be excluded')
    return {source:sorted(paths) for source,paths in result.items()}

def scoped_classify(source,table,exclusions):
    paths=exclusions.get(source,[])
    return classify_source(source,table,paths) if paths else classify_source(source,table)

def source_archive(source,target,excluded=()):
    source=pathlib.Path(source)
    options=['--no-wildcards','--anchored',*('--exclude='+source.name+'/'+os.path.relpath(path,source) for path in excluded)] if excluded else []
    run(['tar','--xattrs','--acls','--numeric-owner',*options,'-cpf',str(target),'-C',str(source.parent),'--',source.name])

def source_archive_command(source,excluded=()):
    source=pathlib.Path(source)
    options=['--no-wildcards','--anchored',*('--exclude='+source.name+'/'+os.path.relpath(path,source) for path in excluded)] if excluded else []
    # atime changes when the first pass reads data; ctime is not restored.
    return ['tar','--format=posix','--pax-option=delete=atime,delete=ctime,exthdr.name=%d/PaxHeaders/%f','--xattrs','--acls','--numeric-owner',*options,'-cpf','-','-C',str(source.parent),'--',source.name]

TRANSFER=None
def transfer_progress(count,final=False):
    # Uncompressed bytes added to the outgoing archive; total comes from the inventory pass.
    if TRANSFER is None:return
    TRANSFER['done']+=count;now=time.monotonic()
    if final or now-TRANSFER['emitted']>=2:
        TRANSFER['emitted']=now;emit(progress={'done':TRANSFER['done'],'total':TRANSFER['total']})

def command_artifact(command,archive=None,name=None,expected=None,spool=None):
    started=time.monotonic();label=pathlib.Path(command[0]).name+(' '+str(command[1]) if len(command)>1 and command[0]=='docker' else '')
    diagnostic(command=label,phase='artifact-start')
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    class Reader:
        def __init__(self):self.bytes=0;self.digest=hashlib.sha256()
        def read(self,size=-1):
            data=process.stdout.read(size);self.bytes+=len(data);self.digest.update(data)
            if archive is not None:transfer_progress(len(data))
            return data
    reader=Reader()
    try:
        if archive is None and spool is not None:
            # Spooled once: some outputs (docker save of fresh commits) are not byte-stable.
            fd=os.open(spool,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as output:
                while data:=reader.read(1024*1024):output.write(data)
                output.flush();os.fsync(output.fileno())
        elif archive is None:
            while reader.read(1024*1024):pass
        else:
            info=tarfile.TarInfo(name);info.size=expected['bytes'];info.mode=0o600
            archive.addfile(info,reader)
            if reader.read(1):raise ValueError('Streamed artifact grew during capture')
        code=process.wait()
        diagnostic(command=label,phase='artifact-finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='ok' if code==0 else 'exit',exitCode=code)
        if code!=0:raise ValueError('Artifact command failed during direct capture')
        evidence={'bytes':reader.bytes,'sha256':reader.digest.hexdigest()}
        if expected is not None and evidence!=expected:raise ValueError('Streamed artifact changed during capture')
        return evidence
    finally:
        process.stdout.close()
        if process.poll() is None:process.kill()
        process.wait()

def open_stream_archive(output,level):
    # Stream-mode compresslevel exists from Python 3.12. Choose before opening: a
    # failed open has already written a gzip header to the output.
    if sys.version_info>=(3,12):return tarfile.open(fileobj=output,mode='w|gz',compresslevel=level,bufsize=1024*1024)
    return tarfile.open(fileobj=output,mode='w|gz',bufsize=1024*1024)

def stream_artifacts(archive,specs,spool_root=None,spooled=()):
    inventory={};files={}
    try:
        for name,command,link in specs:
            if link:inventory[name]=inventory[link]
            elif spool_root is not None and name in spooled:
                files[name]=pathlib.Path(spool_root)/('spool-'+name)
                inventory[name]=command_artifact(command,spool=files[name])
            else:inventory[name]=command_artifact(command)
        emit(stage='transferring')
        global TRANSFER
        TRANSFER={'done':0,'total':sum(inventory[name]['bytes'] for name,_,link in specs if not link),'emitted':0}
        transfer_progress(0,True)
        for name,command,link in specs:
            if link:
                info=tarfile.TarInfo(name);info.type=tarfile.LNKTYPE;info.linkname=link;info.mode=0o600;archive.addfile(info)
            elif name in files:command_artifact(['cat','--',str(files[name])],archive,name,inventory[name])
            else:command_artifact(command,archive,name,inventory[name])
        transfer_progress(0,True)
    finally:
        TRANSFER=None
        for path in files.values():path.unlink(missing_ok=True)
    return inventory

def stream_document(archive,name,value):
    data=value.encode();info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o600
    archive.addfile(info,io.BytesIO(data))

def capture_size(containers,configuration,exclusions,images):
    sources={m['Source'] for c in containers for m in c['Mounts']}
    sources.update(configuration)
    size=0
    for source in sources:
        options=['--exclude='+path for path in exclusions.get(source,[])]
        size+=int(run(['du','-sb',*options,'--',source]).split()[0])
    return size+sum(c.get('SizeRw',0) or 0 for c in containers)+sum(image['Size'] for image in images)

def backup_plan(cfg,containers=None):
    containers=preflight(cfg) if containers is None else containers
    services=service_contracts(cfg,containers)
    if any(s['engine']=='generic' for s in services) and not cfg.get('cleanShutdownConfirmed'):
        raise ValueError('Application writers require explicit clean-shutdown confirmation regardless of the legacy shutdown profile')
    validate_database_contracts(services,containers)
    table=mount_table();sources=[];seen=set();exclusions=mount_exclusions(cfg,containers)
    if exclusions and any(s['engine']!='generic' for s in services):raise ValueError('Mount exclusions require reviewed generic application services; native database adapters retain full capture')
    for c in containers:
        for m in c['Mounts']:
            if m['Source'] not in seen:sources.append(scoped_classify(m['Source'],table,exclusions));seen.add(m['Source'])
    for source in ([cfg['documentRoot']] if cfg.get('kind')=='static' else [])+cfg.get('composeFiles',[])+cfg.get('configFiles',[]):
        if source not in seen:sources.append(classify_source(source,table));seen.add(source)
    # Docker inspect may enumerate MountPoints in a different order on each
    # read. Compare the same source/mount records in a stable order, retaining
    # every identity and mount option; keep raw inspect order for capture.
    sources.sort(key=lambda source:source['path'])
    topology=[{'id':c['Id'],'image':c['Image'],'config':c['Config'],'host':c['HostConfig'],'mounts':sorted(c['Mounts'],key=lambda mount:mount['Destination']),'networks':c.get('NetworkSettings',{}).get('Networks',{})} for c in containers]
    fingerprint=hashlib.sha256(json.dumps({'sources':sources,'topology':topology,'services':services,'configuration':{k:v for k,v in cfg.items() if not k.startswith('_')}},sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'version':1,'kind':cfg.get('kind','docker'),'fingerprint':fingerprint,'sources':sources,'containerIds':[c['Id'] for c in containers],'services':services,'restartOrder':service_order(services),'coverage':{'status':'scoped' if exclusions else 'declared','externalWritersConfirmed':bool(cfg.get('exclusiveSourcesConfirmed')),'excludedPaths':cfg.get('mountExclusions',[]),'externalDataIncluded':not bool(exclusions)},'unresolvedDependencies':[]}

def public_plan(plan):
    return {**{k:v for k,v in plan.items() if k not in ['sources','services']},'sources':[{'filesystem':s['filesystem'],'classification':'local'} for s in plan['sources']],'services':[{k:v for k,v in s.items() if k in ['container','engine','version','role','dependsOn']} for s in plan['services']]}

def revalidate_sources(plan):
    table=mount_table()
    for source in plan['sources']:
        if scoped_classify(source['path'],table,{source['path']:source.get('excludedPaths',[])})!=source:raise ValueError('Source identity or mount changed; capture is blocked')

def service_contracts(cfg,containers):
    """Resolve exact service identities and probe native binaries, never infer version from tags."""
    references={value:c['Id'] for c in containers for value in [c['Id'],c['Name'].lstrip('/')]}
    declarations={};result=[]
    for item in cfg.get('services',[]):
        cid=references.get(item['container'])
        if not cid or cid in declarations:raise ValueError('Service contracts must refer to unique selected containers')
        declarations[cid]=item
    for c in containers:
        declaration=declarations.get(c['Id'],{})
        engine=declaration.get('engine','auto');detected=None;version=None
        if c['State']['Running']:
            for name,binary in [('postgres','postgres'),('mariadb','mariadbd'),('mysql','mysqld'),('redis','redis-server')]:
                try:
                    output=run(['docker','exec',c['Id'],binary,'--version'],timeout=10).decode(errors='replace')
                    match=re.search(r'\bv=(\d+\.\d+\.\d+)\b' if name=='redis' else r'(?:PostgreSQL\)?\s+|Ver\s+)(\d+\.\d+(?:\.\d+)?)',output)
                    if match:detected=name;version=match[1];break
                except (subprocess.CalledProcessError,subprocess.TimeoutExpired):pass
        hint=c['Config'].get('Image','').lower()
        if detected and engine not in ['auto',detected]:raise ValueError('Declared database engine does not match the installed binary')
        engine=detected or ('generic' if engine=='auto' else engine)
        if engine=='generic' and any(word in hint for word in ['postgres','mysql','mariadb','mongo','redis','cockroach','cassandra','elasticsearch']):raise ValueError('Stateful service requires a supported per-service database contract')
        if engine!='generic' and (not detected or not version):raise ValueError('Database must be running for native version and consistency preflight; stopped database requires an offline adapter')
        if engine=='redis' and not re.fullmatch(r'7\.4\.\d+',version):raise ValueError('Redis native capture is limited to tested Redis 7.4 versions; reviewed adapter required')
        expected=declaration.get('version')
        if expected and version!=expected:raise ValueError('Installed database version differs from the service contract')
        for check in declaration.get('checks',[]):
            if engine=='generic' or (engine=='redis' and (not check.get('key') or check.get('table'))) or (engine in ['postgres','mysql','mariadb'] and (not check.get('table') or check.get('key'))):
                raise ValueError('Configured data checks do not match the detected native engine')
        dependencies=[]
        for value in declaration.get('dependsOn',[]):
            if value not in references:raise ValueError('Service dependency is outside the selected site')
            dependencies.append(references[value])
        result.append({'container':c['Id'],'engine':engine,'version':version,'role':'database' if engine!='generic' else 'writer','dependsOn':dependencies,'database':declaration.get('database'),'user':declaration.get('user'),'checks':declaration.get('checks',[])})
        if declaration.get('sqliteFiles'):
            if engine!='generic':raise ValueError('SQLite file proof is limited to declared generic applications')
            installed=run(['docker','exec',c['Id'],'python3','-c','import sqlite3;print(sqlite3.sqlite_version)'],timeout=10).decode().strip()
            if not re.fullmatch(r'3\.\d+\.\d+',installed) or installed!=declaration.get('sqliteVersion'):raise ValueError('Installed SQLite version differs from the explicit file contract')
            item=result[-1];item.update(sqliteFiles=sorted(declaration['sqliteFiles']),sqliteVersion=installed,sqliteSigtermConfirmed=bool(declaration.get('sqliteSigtermConfirmed')))
            exclusions=mount_exclusions(cfg,containers)
            for filename in item['sqliteFiles']:
                source,mount=sqlite_file_source(filename,c)
                if excluded_path(str(source),exclusions.get(mount['Source'],[])):raise ValueError('Required SQLite database is excluded from capture')
        elif declaration.get('sqliteSigtermConfirmed'):raise ValueError('SIGTERM acceptance requires explicit SQLite file checks')
    databases=[s['container'] for s in result if s['role']=='database']
    for s in result:
        if s['role']=='writer':s['dependsOn']=list(dict.fromkeys(s['dependsOn']+databases))
    service_order(result) # Reject cycles before maintenance or stop.
    return result

def service_order(services):
    by_id={s['container']:s for s in services};order=[];visiting=set()
    def visit(cid):
        if cid in visiting:raise ValueError('Service dependencies contain a cycle')
        if cid in order:return
        if cid not in by_id:raise ValueError('Unknown service dependency')
        visiting.add(cid)
        for dependency in by_id[cid].get('dependsOn',[]):visit(dependency)
        visiting.remove(cid);order.append(cid)
    for cid in by_id:visit(cid)
    return order

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

def restart_services(ids,services=None):
    by_id={s['container']:s for s in services or []};pending=list(ids)
    while pending:
        # Independent services start together; their health may depend on one another.
        level=[cid for cid in pending if not set(by_id.get(cid,{}).get('dependsOn',[])).intersection(pending)]
        if not level:raise ValueError('Recovery dependency cycle; operator review required')
        docker('start',*level);deadline=time.time()+120
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

def artifact_inventory(root):
    result={}
    for p in sorted(root.iterdir()):
        if p.name=='images.tar' or re.fullmatch(r'(?:mount-\d+-\d+|config-\d+|static-files)\.tar',p.name):
            digest=hashlib.sha256()
            with open(p,'rb') as f:
                for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
            result[p.name]={'bytes':p.stat().st_size,'sha256':digest.hexdigest()}
    return result

def verify_artifacts(root,manifest):
    expected=manifest.get('artifacts')
    if expected is None:return False # Legacy package: no invented artifact evidence.
    actual=artifact_inventory(root)
    if actual!=expected:raise ValueError('Backup artifacts are missing, changed or unexpected')
    names={'static-files.tar'} if manifest.get('kind')=='static' else {'images.tar',*('mount-%d-%d.tar'%(i,j) for i,c in enumerate(manifest['containers']) for j,_ in enumerate(c['Mounts']))}
    names.update('config-%d.tar'%i for i,_ in enumerate(manifest.get('configurationFiles',[])))
    if set(actual)!=names:raise ValueError('Artifact inventory does not cover all manifest dependencies')
    return True
def pinned_socket(addresses,port,timeout):
    """Connects only to addresses validated earlier, so a second DNS answer cannot redirect the probe."""
    error=OSError('No validated probe address')
    for address in addresses:
        try:return socket.create_connection((address,port),timeout)
        except OSError as failure:error=failure
    raise error
class PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self,host,port,addresses,**kw):super().__init__(host,port,**kw);self.addresses=addresses
    def connect(self):self.sock=pinned_socket(self.addresses,self.port,self.timeout)
class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self,host,port,addresses,**kw):super().__init__(host,port,**kw);self.addresses=addresses
    def connect(self):
        sock=pinned_socket(self.addresses,self.port,self.timeout)
        try:self.sock=self._context.wrap_socket(sock,server_hostname=self.host)
        except Exception:sock.close();raise
class OriginHTTPSConnection(PinnedHTTPSConnection):
    def __init__(self,host,port,**kw):super().__init__(host,port,['127.0.0.1'],**kw)

PROBE_LIMIT=256*1024
METADATA_ADDRESSES={ipaddress.ip_address(a) for a in ['169.254.169.254','169.254.170.2','fd00:ec2::254','100.100.100.200']}
THIS_NETWORK=ipaddress.ip_network('0.0.0.0/8')
class ProbePolicyError(ValueError):
    """A probe target the address policy refuses. Unlike a network failure, retrying cannot fix it."""
PROBE_POLICY_FALLBACKS=[]
def local_address(address):
    """True when the source host owns this address (bind succeeds only for local interfaces)."""
    try:
        with socket.socket(socket.AF_INET6 if address.version==6 else socket.AF_INET,socket.SOCK_STREAM) as probe:probe.bind((str(address),0))
        return True
    except OSError:return False
def probe_addresses(hostname,port,domains=()):
    """Resolve on the source host and return the addresses to pin, refusing internal targets.
    Loopback and public addresses are allowed. Private, CGNAT and ULA addresses are allowed only
    for a configured site domain name that resolves to an address of this host. Link-local, cloud
    metadata, multicast, unspecified and reserved addresses are always refused. Every answer must pass."""
    host=hostname.lower().rstrip('.')
    try:literal=ipaddress.ip_address(host)
    except ValueError:literal=None
    try:answers=[literal] if literal else [ipaddress.ip_address(info[4][0].split('%')[0]) for info in socket.getaddrinfo(host,port,type=socket.SOCK_STREAM)]
    except (OSError,UnicodeError):raise ValueError('Probe host could not be resolved from the source server')
    configured=not literal and host in {str(d).lower().rstrip('.') for d in domains or ()}
    chosen=[]
    for address in answers:
        address=getattr(address,'ipv4_mapped',None) or address
        if not address.is_loopback: # ::1 sits inside the reserved ::/8 block.
            if address in METADATA_ADDRESSES or address.is_link_local or address.is_multicast or address.is_unspecified or address.is_reserved or getattr(address,'is_site_local',False) or (address.version==4 and address in THIS_NETWORK):raise ProbePolicyError('the URL resolves to a link-local, cloud metadata or reserved address')
            if not address.is_global and not (configured and local_address(address)):raise ProbePolicyError('the URL resolves to a private address that does not belong to this server; use the site domain, a loopback port or a public address')
        if str(address) not in chosen:chosen.append(str(address))
    if not chosen:raise ValueError('Probe host could not be resolved from the source server')
    return chosen
def fetch(url,timeout,domains=(),redirects=5):
    """GET with every hop resolved, validated and pinned. Redirects are followed only to the same
    host or to another configured site domain; otherwise the redirect response itself is returned.
    timeout is a total budget for the whole probe: every connect attempt, redirect and body read."""
    allowed={str(d).lower().rstrip('.') for d in domains or ()};origin=None;deadline=time.monotonic()+timeout
    for _ in range(redirects+1):
        parsed=urllib.parse.urlsplit(url)
        if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password:raise ProbePolicyError('use an HTTP(S) URL without login details')
        host=parsed.hostname.lower().rstrip('.');origin=origin or host
        if host!=origin and host not in allowed:return status,body
        port=parsed.port or (443 if parsed.scheme=='https' else 80);addresses=probe_addresses(host,port,domains)
        remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('Probe exceeded its total time limit')
        if parsed.scheme=='https':connection=PinnedHTTPSConnection(parsed.hostname,port,addresses,timeout=remaining,context=ssl.create_default_context())
        else:connection=PinnedHTTPConnection(parsed.hostname,port,addresses,timeout=remaining)
        try:status,body,location=exchange(connection,urllib.parse.urlunsplit(('','',parsed.path or '/',parsed.query,'')),{'Cache-Control':'no-cache','User-Agent':'DockNest-helper/%d'%VERSION,'Accept':'*/*'},deadline)
        finally:connection.close()
        if status not in (301,302,303,307,308) or not location:return status,body
        url=urllib.parse.urljoin(url,location)
    return status,body

def exchange(connection,path,headers,deadline):
    """One request/response under an absolute deadline. Socket timeouts only bound each read, so a server
    dripping one byte per second would otherwise hold a probe (and the restart or recovery loop) for hours.
    On expiry the socket is shut down to unblock the worker and the probe counts as failed, not refused."""
    result={}
    def work():
        try:
            connection.request('GET',path,headers=headers)
            response=connection.getresponse();result['value']=(response.status,response.read(PROBE_LIMIT),response.getheader('Location'))
        except BaseException as error:result['error']=error
    worker=threading.Thread(target=work,daemon=True);worker.start();worker.join(max(0,deadline-time.monotonic()))
    if worker.is_alive():
        try:
            if connection.sock:connection.sock.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        connection.close();raise TimeoutError('Probe exceeded its total time limit')
    if 'error' in result:raise result['error']
    return result['value']

PROBE_LABELS={'health':'maintenance health URL','public':'public maintenance URL'}
def probe_policy_preflight(cfg):
    """Returns {probe: reason} for stored probe URLs the policy refuses, before anything on the host
    changes. Only DNS is queried; no HTTP request is sent. A name that does not resolve is not a policy
    decision and is left to the probe itself, as before the policy existed."""
    m=cfg.get('maintenance') or {};refused={}
    targets=[('health',m.get('healthUrl'))]
    if m.get('required') and not m.get('probeOrigin'):targets.append(('public',m.get('publicUrl')))
    for probe,url in targets:
        if not url:continue
        parsed=urllib.parse.urlsplit(url)
        try:
            if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password:raise ProbePolicyError('use an HTTP(S) URL without login details')
            probe_addresses(parsed.hostname,parsed.port or (443 if parsed.scheme=='https' else 80),cfg.get('domains',()))
        except ProbePolicyError as error:refused[probe]=str(error)
        except ValueError:pass
    return refused
def skip_refused_probes(cfg):
    """Upgrade safety: a site saved before the policy keeps getting backups. Refused probes are disabled
    for every phase (capture, watchdog, boot recovery via the journaled cfg) and never contacted; health
    then relies on container state and Docker health checks, as for sites without a health URL.
    The underscore key stays out of the plan fingerprint."""
    refused=probe_policy_preflight(cfg)
    cfg['_skippedProbes']=sorted(set(cfg.get('_skippedProbes',[]))|set(refused))
    for probe in refused:policy_fallback(probe)
    return refused
def probe_url(cfg,probe):
    if probe in cfg.get('_skippedProbes',()):return None
    return (cfg.get('maintenance') or {}).get('healthUrl' if probe=='health' else 'publicUrl')
def policy_fallback(probe):
    # Recorded so the job result can say the probe was skipped rather than passed.
    PROBE_POLICY_FALLBACKS.append(probe);diagnostic(phase='probe-policy-fallback',probe=probe)

def public_probe(m,domains=()):
    url=m.get('publicUrl','')
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password:raise ProbePolicyError('use an HTTP(S) URL without login details')
    if not m.get('probeOrigin'):return fetch(url,10,domains)
    # Same hostname and verified TLS identity; only the connection address changes to loopback.
    if parsed.scheme=='https':connection=OriginHTTPSConnection(parsed.hostname,parsed.port or 443,timeout=10,context=ssl.create_default_context())
    else:connection=http.client.HTTPConnection('127.0.0.1',parsed.port or 80,timeout=10)
    try:
        path=urllib.parse.urlunsplit(('','',parsed.path or '/',parsed.query,''))
        return exchange(connection,path,{'Host':parsed.netloc,'Cache-Control':'no-cache'},time.monotonic()+10)[:2]
    finally:connection.close()

def health(containers,url=None,domains=(),fallback=False):
    """A policy-refused URL raises unless fallback is set; recovery paths then rely on container
    health only (the same check used when no health URL is configured) instead of waiting forever."""
    for c in inspect(containers) if containers else []:
        if not c['State']['Running']: return False
        if c['State'].get('Health',{}).get('Status','healthy')!='healthy': return False
    if url:
        try:
            status,body=fetch(url,5,domains)
            if status!=200 or b'dbm-maintenance-v1' in body:return False
        except ProbePolicyError:
            if not fallback:raise
            policy_fallback('health')
        except Exception:return False
    return True
def maintenance(cfg,enabled):
    m=cfg.get('maintenance',{})
    if not m.get('required'):return
    directory=pathlib.Path(m['directory'])
    if not directory.is_absolute() or '..' in directory.parts:raise ValueError('Invalid maintenance directory')
    if not (directory/'ready').is_file():raise ValueError('Maintenance proxy integration is not ready')
    def enable_flag():
        flag=directory/'enabled';flag.touch(mode=0o600)
        if m.get('readableFlag'):flag.chmod(0o644)
    if enabled:
        was_enabled=(directory/'enabled').exists()
        enable_flag()
        try:
            if 'public' not in cfg.get('_skippedProbes',()):
                if not m.get('publicUrl'):raise ValueError('Public maintenance probe URL required')
                status,body=public_probe(m,cfg.get('domains',()))
                if status!=503 or b'dbm-maintenance-v1' not in body:raise ValueError('Maintenance probe is not the deployed HTTP 503 page')
            sync_maintenance_flag(directory)
        except Exception:
            if not was_enabled:
                (directory/'enabled').unlink(missing_ok=True)
                sync_maintenance_flag(directory)
            raise
    else:
        if not health(cfg.get('_runningContainers',cfg['containers']),probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):raise ValueError('Health probe failed; maintenance retained')
        (directory/'enabled').unlink(missing_ok=True)
        if probe_url(cfg,'public'):
            try:
                try:status,body=public_probe(m,cfg.get('domains',()))
                except ProbePolicyError:policy_fallback('public');status,body=200,b''
                if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('Public access did not recover')
                sync_maintenance_flag(directory)
            except Exception:
                enable_flag()
                sync_maintenance_flag(directory)
                raise ValueError('Public probe failed; maintenance retained')
        else:sync_maintenance_flag(directory)
def recover(root,ids,cfg,deadline,parent):
    while not (root/'disarmed').exists() and time.time()<deadline:
        if cfg.get('_directDelivery'):
            try:os.kill(parent,0)
            except ProcessLookupError:break
        time.sleep(2)
    if (root/'disarmed').exists():
        (root/'watchdog.done').touch(mode=0o600)
        return
    try:
        if os.getpgid(parent)==parent:os.killpg(parent,signal.SIGTERM)
    except ProcessLookupError:pass
    try:
        restart_services(ids,cfg.get('_serviceContracts'))
        until=time.time()+120
        while time.time()<until and not health(ids,probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):time.sleep(2)
        if ids and not health(ids,probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):raise ValueError('Recovery health failed')
        maintenance(cfg,False)
        atomic_json(root/'recovery.json',{'recovered':True,'at':time.time(),**({'probePolicyFallback':sorted(set(PROBE_POLICY_FALLBACKS))} if PROBE_POLICY_FALLBACKS else {})})
        complete_recovery(root)
    except Exception:
        atomic_json(root/'recovery.json',{'recovered':False,'at':time.time()})
def project_roots(container):
    labels=container.get('Config',{}).get('Labels',{}) or {}
    if not labels.get('com.docker.compose.project'):return []
    paths=[labels.get('com.docker.compose.project.working_dir','')]
    paths.extend(str(pathlib.Path(value.strip()).parent) for value in labels.get('com.docker.compose.project.config_files','').split(',') if value.strip())
    roots=[]
    for value in paths:
        p=pathlib.Path(value)
        if not value or not p.is_absolute() or '..' in p.parts:continue
        if str(p) in ['/', '/etc','/home','/root','/var','/srv','/opt','/tmp']:continue
        if str(p).startswith(('/proc','/sys','/dev','/run')):continue
        if p.is_dir() and os.path.realpath(p)==os.path.abspath(p) and str(p) not in roots:roots.append(str(p))
    return roots

def nginx_sites(folders=None):
    """Return routing metadata only, never nginx configuration contents or TLS keys."""
    sites=[]
    def parse(tokens):
        nodes=[];words=[]
        for token in tokens:
            if token==';':
                if words:nodes.append((words[0],words[1:],[]))
                words=[]
            elif token=='{':
                nested=parse(tokens)
                if words:nodes.append((words[0],words[1:],nested))
                words=[]
            elif token=='}':break
            else:words.append(token)
        return nodes
    def walk(nodes):
        for name,args,children in nodes:
            yield name,args,children
            yield from walk(children)
    for folder in folders or ['/etc/nginx/sites-enabled','/etc/nginx/conf.d']:
        directory=pathlib.Path(folder)
        if not directory.is_dir():continue
        for file in sorted(directory.iterdir()):
            if not file.is_file() or file.stat().st_size>1024*1024:continue
            try:
                lexer=shlex.shlex(file.read_text(),posix=True,punctuation_chars='{};');lexer.whitespace_split=True
                nodes=parse(iter(lexer))
            except (ValueError,OSError):continue
            for name,args,children in walk(nodes):
                if name!='server':continue
                domains=[v for key,values,_ in children if key=='server_name' for v in values if re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]+',v) and '.' in v]
                if not domains:continue
                flattened=list(walk(children))
                proxies=[values[0] for key,values,_ in flattened if key=='proxy_pass' and values]
                dynamic=any(key in ['proxy_pass','fastcgi_pass','uwsgi_pass','scgi_pass'] for key,_,_ in flattened)
                roots=[values[0] for key,values,_ in children if key=='root' and values]
                if not roots:
                    roots=[v[0] for key,values,nested in children if key=='location' and values==['/'] for k,v,_ in nested if k=='root' and v]
                for root in roots[:1] if not dynamic else []:
                    p=pathlib.Path(root)
                    if p.is_absolute() and '..' not in p.parts and str(p) not in ['/','/etc','/root','/home','/var','/var/www','/srv','/opt','/tmp'] and p.is_dir() and p.resolve()==p and (p/'index.html').is_file():
                        sites.append({'kind':'static','name':domains[0],'domains':domains,'documentRoot':str(p),'configFiles':[str(file.resolve())],'healthUrl':'https://'+domains[0]})
                if proxies:sites.append({'kind':'proxy','domains':domains,'upstreams':proxies})
    unique={}
    for site in sites:unique[(site['kind'],tuple(site['domains']),site.get('documentRoot',''))]=site
    return list(unique.values())

def web_hints(container,routes):
    ports=container.get('NetworkSettings',{}).get('Ports',{}) or {}
    candidates=[];domains=[]
    for internal,bindings in ports.items():
        if not internal.endswith('/tcp'):continue
        for binding in bindings or []:
            port=binding.get('HostPort','');host=binding.get('HostIp','')
            if not port.isdigit() or host not in ['127.0.0.1','0.0.0.0','::','::1']:continue
            if internal.split('/')[0] not in ['80','8080','3000','5173','8000','5000','5678']:continue
            candidates.append('http://127.0.0.1:'+port+'/')
            for route in routes:
                if any(re.fullmatch(r'http://(?:127\.0\.0\.1|localhost):'+port+r'(?:/.*)?',value) for value in route.get('upstreams',[])):domains.extend(route['domains'])
    return {'healthUrls':list(dict.fromkeys(candidates)),'domains':list(dict.fromkeys(domains))}

def configuration_paths(container):
    labels=container.get('Config',{}).get('Labels',{}) or {}
    roots=project_roots(container)
    def valid_file(value):
        p=pathlib.Path(value)
        return p.is_absolute() and '..' not in p.parts and any(p.is_relative_to(root) for root in roots) and p.is_file() and os.path.realpath(p)==os.path.abspath(p) and os.access(p,os.R_OK)
    compose=[value.strip() for value in labels.get('com.docker.compose.project.config_files','').split(',') if value.strip()]
    configs=[]
    for root in roots:
        candidate=str((pathlib.Path(root)/'.env').resolve())
        if valid_file(candidate) and candidate not in configs:configs.append(candidate)
    for filename in compose:
        if not valid_file(filename):continue
        text=pathlib.Path(filename).read_text(errors='replace')
        # Support inline, list and path-object env_file syntax without exposing values.
        values=[];indent=None
        for line in text.splitlines():
            match=re.match(r'^(\s*)env_file:\s*(.*?)\s*(?:#.*)?$',line)
            if match:
                indent=len(match[1]);value=match[2].strip()
                if value:values.extend(part.strip().strip('\"\'') for part in value.strip('[]').split(','))
                continue
            if indent is not None:
                if line.strip() and len(line)-len(line.lstrip())<=indent:indent=None;continue
                match=re.match(r'\s*(?:-\s*)?(?:path:\s*)?([./][^\s#]+)\s*(?:#.*)?$',line)
                if match:values.append(match[1].strip('\"\''))
        for value in values:
            if '$' in value:continue
            candidate=str((pathlib.Path(filename).parent/value).resolve())
            if valid_file(candidate) and candidate not in configs:configs.append(candidate)
    return {'composeFiles':[value for value in compose if valid_file(value)],'configFiles':configs,'directory':roots[0] if roots else ''}

def list_project_files(ids,directory=None):
    if not ids or len(ids)>30 or not all(isinstance(value,str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',value) for value in ids):raise ValueError('Choose valid site containers')
    roots=list(dict.fromkeys(root for container in inspect(ids) for root in project_roots(container)))
    if not roots:raise ValueError('No project configuration folder was detected. Enter the file paths manually.')
    p=pathlib.Path(directory or roots[0])
    if not p.is_absolute() or '..' in p.parts or not any(p.is_relative_to(root) for root in roots):raise ValueError('Choose a folder inside this site\'s detected project directory')
    if os.path.realpath(p)!=os.path.abspath(p) or not p.is_dir():raise ValueError('Choose a regular project folder, not a symbolic link')
    entries=[]
    with os.scandir(p) as items:
        for item in items:
            kind='link' if item.is_symlink() else 'directory' if item.is_dir(follow_symlinks=False) else 'file' if item.is_file(follow_symlinks=False) else 'other'
            entry_path=str(p/item.name)
            entries.append({'name':item.name,'path':entry_path,'kind':kind,'selectable':kind=='file' and bool(re.fullmatch(r'/[a-zA-Z0-9_./-]+',entry_path))})
    entries.sort(key=lambda item:(item['kind']!='directory',item['name'].lower()))
    parent=str(p.parent) if any(p.parent.is_relative_to(root) for root in roots) else None
    return {'directory':str(p),'parent':parent,'entries':entries[:500],'limited':len(entries)>500}

TEMPORARY_FOLDERS={'/tmp','/run/mysqld','/var/run/mysqld','/var/cache/nginx','/app/.next/cache'}
def temporary_mounts(c,declared):
    result=[]
    names={c.get('Id'),c.get('Name','').lstrip('/')}
    for destination,options in c.get('HostConfig',{}).get('Tmpfs',{}).items():
        if destination not in TEMPORARY_FOLDERS:raise ValueError('RAM folder '+destination+' needs a reviewed capture adapter; it may contain persistent data.')
        if not any(item.get('container') in names and item.get('destination')==destination for item in declared):raise ValueError('Review temporary RAM folders in Edit configuration. '+destination+' must be recreated empty on restore; its contents disappear when the container stops.')
        if not isinstance(options,str) or not re.fullmatch(r'(?:(?:size=\d+[kKmMgG]?|mode=0?[0-7]{3,4}|uid=\d+|gid=\d+|nr_inodes=\d+|ro|rw|nosuid|suid|nodev|dev|noexec|exec)(?:,|$))+',options):raise ValueError('Temporary RAM folder options require a reviewed adapter')
        result.append((destination,options))
    return result

def static_preflight(cfg):
    if cfg.get('unresolvedDependencies'):raise ValueError('Resolve required external dependencies before capture')
    root=pathlib.Path(cfg.get('documentRoot',''))
    if not root.is_absolute() or '..' in root.parts or not root.is_dir() or root.resolve()!=root:raise ValueError('Choose a regular static website directory from discovery')
    if not any(site.get('documentRoot')==str(root) for site in nginx_sites() if site['kind']=='static'):raise ValueError('The directory must belong to a discovered static nginx website')
    if cfg.get('containers') or cfg.get('composeFiles'):raise ValueError('Static sites cannot contain Docker services or Compose files')
    if not cfg.get('exclusiveSourcesConfirmed') or not cfg.get('externalReferencesConfirmed'):raise ValueError('Review the static website files and confirm that no deployment will change them during capture')
    if os.geteuid()!=0:raise ValueError('Root SSH required to preserve ownership')
    for filename in cfg.get('configFiles',[]):
        p=pathlib.Path(filename)
        if not p.is_absolute() or '..' in p.parts or not p.is_file() or p.is_symlink():raise ValueError('Static configuration file is unreadable or invalid')
    classify_source(str(root))
    for source in cfg.get('configFiles',[]):classify_source(source)
    tree_digest(root)
    return root

def tree_digest(root):
    digest=hashlib.sha256();count=0;size=0
    for current,dirs,files in os.walk(root,followlinks=False):
        dirs.sort();files.sort()
        for name in dirs+files:
            p=pathlib.Path(current)/name;s=p.lstat();relative=str(p.relative_to(root))
            if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)):raise ValueError('Static website contains a link or special file requiring an offline capture adapter')
            record=[relative,stat.S_IMODE(s.st_mode),s.st_uid,s.st_gid,'directory' if p.is_dir() else 'file']
            if p.is_file():
                file_hash=hashlib.sha256()
                with p.open('rb') as source:
                    for chunk in iter(lambda:source.read(1024*1024),b''):file_hash.update(chunk)
                record.extend([s.st_size,file_hash.hexdigest()]);count+=1;size+=s.st_size
            digest.update(json.dumps(record,separators=(',',':')).encode()+b'\n')
    return {'sha256':digest.hexdigest(),'files':count,'bytes':size}

def capture_static(req):
    cfg=req['config'];source=static_preflight(cfg);uuid.UUID(req['job'])
    plan=backup_plan(cfg,[])
    if req.get('planFingerprint') and req['planFingerprint']!=plan['fingerprint']:raise ValueError('Backup plan changed; review configuration before capture')
    base=pathlib.Path(cfg.get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts or base.resolve()!=base:raise ValueError('Use a regular absolute staging directory')
    if os.path.commonpath([str(base),str(source)]) in [str(base),str(source)]:raise ValueError('Staging and static website paths cannot overlap')
    root=base/req['job']
    if root.exists():raise ValueError('Staging already exists; inspect retained job before retry')
    create_staging_root(root)
    emit(stage='source_ready') # No daemon is stopped and no maintenance flag is touched.
    before=tree_digest(source)
    if shutil.disk_usage(root).free<before['bytes']*3+1024**3:raise ValueError('Insufficient staging capacity')
    run(['tar','--xattrs','--acls','--numeric-owner','-cpf',str(root/'static-files.tar'),'-C',str(source.parent),'--',source.name])
    if tree_digest(source)!=before:raise ValueError('Website changed during capture. Retry when its deployment has finished.')
    verification=root/'verification';safe_extract(root/'static-files.tar',verification)
    if tree_digest(verification/source.name)!=before:raise ValueError('Captured static files do not match the website. Retry after its deployment has finished.')
    shutil.rmtree(verification)
    for i,filename in enumerate(cfg.get('configFiles',[])):
        p=pathlib.Path(filename);run(['tar','--xattrs','--acls','--numeric-owner','-cpf',str(root/('config-%d.tar'%i)),'-C',str(p.parent),'--',p.name])
    manifest={'formatVersion':1,'kind':'static','complete':True,'capturedAt':time.time(),'architecture':'portable-static','containers':[],'originalImages':[],'snapshotImages':[],'documentRoot':str(source),'staticFiles':before,'configurationFiles':cfg.get('configFiles',[]),'downtimeSeconds':0,'containerDowntimeSeconds':0,'visitorDowntimeSeconds':0,'restoreTested':False}
    revalidate_sources(plan);manifest['backupPlan']=plan;manifest['artifacts']=artifact_inventory(root)
    manifest['consistency']={'status':'passed','method':'stable source tree and extracted-file digest','scope':'static files'}
    (root/'manifest.json').write_text(json.dumps(manifest));os.chmod(root/'manifest.json',0o600)
    (root/'restore-guide.md').write_text('Static website backup. static-files.tar preserves numeric owners, permissions, ACLs and xattrs. Restore into a new private directory and verify staticFiles.sha256 before an explicit nginx cutover. Original website and nginx/TLS configuration must never be overwritten automatically. Configuration archives are for review; TLS keys and external services are not included.\n')
    (root/'disarmed').touch(mode=0o600);(root/'watchdog.done').touch(mode=0o600)
    emit(stage='packing')
    run(['tar','-czf',str(root/'payload.tar.gz'),'-C',str(root),'static-files.tar','manifest.json','restore-guide.md',*[p.name for p in root.glob('config-*.tar')]])
    emit(result={'remotePath':str(root/'payload.tar.gz'),'root':str(root),'manifest':manifest})

def capture_static_stream(req,output):
    cfg=req['config'];source=static_preflight(cfg);uuid.UUID(req['job']);plan=backup_plan(cfg,[])
    if req.get('planFingerprint') and req['planFingerprint']!=plan['fingerprint']:raise ValueError('Backup plan changed; review configuration before capture')
    base=pathlib.Path(cfg.get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts or base.resolve()!=base:raise ValueError('Use a regular absolute staging directory')
    if os.path.commonpath([str(base),str(source)]) in [str(base),str(source)]:raise ValueError('Staging and static website paths cannot overlap')
    root=base/req['job']
    if root.exists():raise ValueError('Staging already exists; inspect retained job before retry')
    create_staging_root(root);emit(stage='source_ready');before=tree_digest(source)
    specs=[('static-files.tar',source_archive_command(source),None),*[(f'config-{i}.tar',source_archive_command(path),None) for i,path in enumerate(cfg.get('configFiles',[]))]]
    with tarfile.open(fileobj=output,mode='w|gz',compresslevel=6,bufsize=1024*1024) as archive:
        inventory=stream_artifacts(archive,specs)
        if tree_digest(source)!=before:raise ValueError('Website changed during direct capture')
        revalidate_sources(plan)
        manifest={'formatVersion':1,'kind':'static','complete':True,'deliveryMode':'direct','capturedAt':time.time(),'architecture':'portable-static','containers':[],'originalImages':[],'snapshotImages':[],'documentRoot':str(source),'staticFiles':before,'configurationFiles':cfg.get('configFiles',[]),'downtimeSeconds':0,'containerDowntimeSeconds':0,'visitorDowntimeSeconds':0,'restoreTested':False,'backupPlan':plan,'artifacts':inventory,'consistency':{'status':'passed','method':'stable source tree and streamed artifact digests','scope':'static files'}}
        stream_document(archive,'manifest.json',json.dumps(manifest))
        stream_document(archive,'restore-guide.md','Static website backup. Restore static-files.tar into a new private directory and verify staticFiles.sha256. Never overwrite the live website automatically.\n')
    (root/'disarmed').touch(mode=0o600);(root/'watchdog.done').touch(mode=0o600);output.flush()
    emit(result={'streamed':True,'root':str(root),'manifest':manifest})

def preflight(cfg):
    if cfg.get('deliveryMode','staged') not in ['staged','direct']:raise ValueError('Unsupported backup delivery mode')
    if cfg.get('unresolvedDependencies'):raise ValueError('Resolve required external dependencies before capture')
    if cfg.get('kind')=='static':static_preflight(cfg);return []
    ids=cfg.get('containers',[])
    if not ids or not all(isinstance(x,str) and x and not x.startswith('-') for x in ids):raise ValueError('Select valid containers')
    if not cfg.get('exclusiveSourcesConfirmed'):raise ValueError('Confirm no external processes write the selected data')
    profile=cfg.get('shutdownProfile','generic')
    if profile not in ['generic','postgres','mysql']:raise ValueError('Unsupported shutdown profile')
    if profile=='generic' and not cfg.get('cleanShutdownConfirmed'):raise ValueError('Generic shutdown requires explicit application clean-shutdown confirmation')
    cs=inspect(ids); selected={c['Id'] for c in cs};exclusions=mount_exclusions(cfg,cs)
    others=docker('ps','-q').decode().split()
    mounts=[]
    for c in cs:
        temporary_mounts(c,cfg.get('temporaryMemoryFolders',[]))
        if c.get('HostConfig',{}).get('Privileged') or c.get('HostConfig',{}).get('Devices'):raise ValueError('Privileged/device-backed containers require a capture adapter')
        if c.get('Config',{}).get('Labels',{}).get('com.docker.compose.project'):
            if not cfg.get('composeFiles'):raise ValueError('Select this site\'s Compose project files in Edit configuration before backing up. No files have been selected for this backup.')
            if not cfg.get('externalReferencesConfirmed'):raise ValueError('Review the Compose and environment files in Edit configuration and confirm the dependencies before backing up.')
        for m in c['Mounts']:
            if m['Type'] not in ['bind','volume']:raise ValueError('Unsupported mount: '+m['Type'])
            if m['Type']=='volume':
                volume=json.loads(docker('volume','inspect',m['Name']))[0]
                if volume.get('Driver')!='local' or volume.get('Options'):raise ValueError('Non-local or driver-configured volumes require a capture adapter')
            src=m['Source']
            if src.startswith(('/proc','/sys','/dev','/run')) or src.endswith('docker.sock'):raise ValueError('System mount is not portable')
            if not os.path.exists(src) or not os.access(src,os.R_OK):raise ValueError('Unreadable mount source')
            scoped_classify(src,mount_table(),exclusions)
            if os.path.islink(src):raise ValueError('Mount source symlink requires a capture adapter')
            if os.path.isdir(src):
                for current,dirs,files in os.walk(src,followlinks=False):
                    dirs[:]=[name for name in dirs if not excluded_path(os.path.join(current,name),exclusions.get(src,[]))]
                    for filename in dirs+files:
                        p=os.path.join(current,filename)
                        if excluded_path(p,exclusions.get(src,[])):continue
                        if os.path.islink(p) and os.path.commonpath([os.path.realpath(src),os.path.realpath(p)])!=os.path.realpath(src):raise ValueError('Mount contains a symlink to uncaptured external data')
            mounts.append(m)
    for c in inspect(others) if others else []:
        if c['Id'] in selected:continue
        for m in c['Mounts']:
            for ours in mounts:
                a,b=os.path.realpath(m['Source']),os.path.realpath(ours['Source'])
                if os.path.commonpath([a,b]) in [a,b]:raise ValueError('A running container outside the site shares a mount')
    for filename in cfg.get('composeFiles',[])+cfg.get('configFiles',[]):
        p=pathlib.Path(filename)
        if not p.is_absolute() or '..' in p.parts or not p.is_file() or p.is_symlink() or not os.access(p,os.R_OK):raise ValueError('Explicit configuration file is unreadable or invalid')
        classify_source(filename)
    if cfg.get('externalSources'):raise ValueError('External sources require a capture adapter')
    if os.geteuid()!=0:raise ValueError('Root SSH required to preserve ownership and read volume data')
    return cs
def readiness(cfg):
    checks=[]
    def check(name,fn):
        try:
            fn();checks.append({'name':name,'ok':True,'message':'Ready'})
        except Exception as error:
            message=str(error) if isinstance(error,ValueError) else 'Could not verify this check. Review the source server connection and URL.'
            checks.append({'name':name,'ok':False,'message':message})
    check('Website files and configuration' if cfg.get('kind')=='static' else 'Containers and configuration files',lambda:preflight(cfg))
    if cfg.get('kind')!='static':
        def contracts():
            backup_plan(cfg,preflight(cfg))
        check('Per-service database consistency contracts',contracts)
    def direct_health():
        try:healthy=health(cfg['containers'],cfg.get('healthUrl') or cfg.get('maintenance',{}).get('healthUrl'),cfg.get('domains',()))
        except ProbePolicyError as error:raise ValueError("Probe URL policy: %s. Update the site's health URL."%error)
        if not healthy:raise ValueError('Application health URL must return HTTP 200 from the source server. Check the URL and that all selected services are running.')
    check('Application health',direct_health)
    if cfg.get('kind')=='static':
        checks[-1]['required']=False
        if not checks[-1]['ok']:checks[-1]['message']='Public website access could not be verified from this server, possibly because of its CDN. Static files can still be captured and verified without changing hosting; check visitor access separately.'
    def proxy():
        m=cfg.get('maintenance',{})
        if not m.get('required'):raise ValueError('Enable maintenance protection before backing up a live site.')
        directory=pathlib.Path(m.get('directory',''))
        if not (directory/'ready').is_file() or not (directory/'maintenance.html').is_file():raise ValueError('Deploy the maintenance page and integrate it with the source proxy. The proxy readiness marker is missing.')
        if (directory/'enabled').exists():raise ValueError('Maintenance is currently enabled. Restore normal access before the readiness check.')
        try:status,body=public_probe(m,cfg.get('domains',()))
        except ProbePolicyError as error:raise ValueError("Probe URL policy: %s. Update the site's public maintenance URL."%error)
        if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('Website probe must return HTTP 200. If a CDN blocks server probes, choose the local origin probe after verifying the source proxy.')
    if cfg.get('kind')!='static':check('Maintenance proxy and website',proxy)
    return {'ready':all(item['ok'] or item.get('required') is False for item in checks),'checks':checks,'readOnly':True,'maintenanceActivationTested':False}
def capture(req,output=None):
    if req['config'].get('kind')=='static':
        if output is not None:return capture_static_stream(req,output)
        return capture_static(req)
    cfg=req['config'];skip_refused_probes(cfg);cs=preflight(cfg);plan=backup_plan(cfg,cs)
    if req.get('planFingerprint') and req['planFingerprint']!=plan['fingerprint']:raise ValueError('Backup plan changed; review configuration before capture')
    base=pathlib.Path(cfg.get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts:raise ValueError('Staging path must be absolute')
    job=req['job']
    uuid.UUID(job)
    root=base/job
    if root.exists():raise ValueError('Staging already exists; inspect retained job before retry')
    for c in cs:
        for m in c['Mounts']:
            a,b=os.path.realpath(base),os.path.realpath(m['Source'])
            if os.path.commonpath([a,b]) in [a,b]:raise ValueError('Staging and source paths cannot overlap')
    online_sqlite_checks(plan.get('services',[]),cs,cfg)
    mode=sqlite_check_mode(cfg)
    # Recorded in the manifest plan so restore verification produces the same evidence.
    for service in plan.get('services',[]):
        if service.get('sqliteFiles'):service['sqliteCheckMode']=mode
    create_staging_root(root)
    original_ids=list({c['Image'] for c in cs})
    original_images=json.loads(docker('image','inspect',*original_ids))
    exclusions=mount_exclusions(cfg,cs)
    # Shared sources are archived once; account for images/configs and packing.
    needed=capture_size(cs,cfg.get('composeFiles',[])+cfg.get('configFiles',[]),exclusions,original_images) if exclusions else sum(int(run(['du','-sb',m['Source']]).split()[0]) for c in cs for m in c['Mounts'])+sum(c.get('SizeRw',0) or 0 for c in cs)
    if output is None:
        if shutil.disk_usage(root).free<needed*2+1024**3:raise ValueError('Insufficient staging capacity')
    else:
        if shutil.disk_usage(root).free<1024**3:raise ValueError('Insufficient recovery journal capacity')
        docker_root=docker('info','--format','{{.DockerRootDir}}').decode().strip()
        if shutil.disk_usage(docker_root).free<sum(c.get('SizeRw',0) or 0 for c in cs)+1024**3:raise ValueError('Insufficient Docker snapshot capacity')
        # images.tar is spooled once in the staging root; budget it before any service stops.
        image_bytes=sum(int(image.get('Size',0) or 0) for image in original_images)+sum(c.get('SizeRw',0) or 0 for c in cs)
        if shutil.disk_usage(root).free<image_bytes*2+1024**3:raise ValueError('Insufficient staging capacity for the image archive')
    running=[cid for cid in plan['restartOrder'] if any(c['Id']==cid and c['State']['Running'] for c in cs)]
    cfg['_runningContainers']=running
    cfg['_serviceContracts']=plan['services']
    if output is not None:cfg['_directDelivery']=True
    atomic_json(root/'recovery-plan.json',{'running':running,'containers':[c['Id'] for c in cs]})
    atomic_json(root/'boot-recovery.json',{'version':1,'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'running':running,'identities':{c['Id']:c['Image'] for c in cs},'config':cfg})
    stop_timeout=int(cfg.get('stopTimeout',60))
    if stop_timeout<5 or stop_timeout>600:raise ValueError('Stop timeout must be 5..600 seconds')
    deadline=time.time()+int(cfg.get('captureTimeout',7200 if output is not None else 1800))+stop_timeout*len(running)+120
    # Forked watchdog survives SSH loss, cannot remove maintenance until health succeeds.
    parent=os.getpid()
    if os.getpgrp()!=parent:os.setsid()
    pid=os.fork()
    if pid==0:
        global CAPTURE_DIAGNOSTICS
        CAPTURE_DIAGNOSTICS=False
        os.setsid()
        for fd in [0,1,2]:
            try:os.close(fd)
            except OSError:pass
        try:recover(root,running,cfg,deadline,parent)
        finally:
            try:(root/'watchdog.done').touch(mode=0o600)
            except Exception:pass
        os._exit(0)
    stopped_at=None;visitor_start=None;captured=None;images=[];archive=None;inventory=None
    try:
        emit(stage='stopping')
        visitor_start=time.time()
        maintenance(cfg,True)
        if backup_plan(cfg,preflight(cfg))['fingerprint']!=plan['fingerprint']:raise ValueError('Docker configuration changed after planning; capture blocked')
        stopped_at=time.time()
        for cid in reversed(running):
            service=next(s for s in plan['services'] if s['container']==cid)
            if service['engine']!='generic':service['expectedChecks']=data_checks(cid,service)
            prepare_database_shutdown(service)
            docker('stop','--time',str(stop_timeout),cid)
        shutdown_proof=shutdown_evidence(plan['services'],cs,stopped_at,root)
        emit(stage='copying')
        revalidate_sources(plan)
        archives={};specs=[]
        for i,c in enumerate(cs):
            # commit captures the writable layer; mounted data is archived separately.
            image=docker('commit',c['Id']).decode().strip();images.append(image)
            if output is not None:atomic_json(root/'snapshot-images.json',images)
            for j,m in enumerate(c['Mounts']):
                source=m['Source'];target=root/('mount-%d-%d.tar'%(i,j))
                if output is not None:
                    link=archives.get(source) if exclusions else None
                    specs.append((target.name,None if link else source_archive_command(source,exclusions.get(source,[])),link))
                    archives[source]=link or target.name
                elif exclusions and source in archives:os.link(archives[source],target)
                else:source_archive(source,target,exclusions.get(source,[]));archives[source]=target
        for i,filename in enumerate(cfg.get('composeFiles',[])+cfg.get('configFiles',[])):
            source=pathlib.Path(filename)
            if output is not None:specs.append(('config-%d.tar'%i,source_archive_command(source),None))
            else:run(['tar','--xattrs','--acls','--numeric-owner','-cpf',str(root/('config-%d.tar'%i)),'-C',str(source.parent),'--',source.name])
        if output is not None:
            level=int(cfg.get('streamCompressLevel',1))
            if level<1 or level>9:raise ValueError('Stream compression level must be 1..9')
            # Direct capture compresses while services are stopped; favour speed.
            archive=open_stream_archive(output,level)
            inventory=stream_artifacts(archive,[('images.tar',['docker','save',*original_ids,*images],None),*specs],root,{'images.tar'})
            revalidate_sources(plan)
        captured=time.time()
    except BaseException:
        # Abandon buffered payload bytes on a failed stream. Recovery below is
        # independent of whether the destination can accept any more output.
        if archive is not None:archive.fileobj.closed=True;archive.closed=True
        raise
    finally:
        emit(stage='restarting')
        try:
            restart_services(running,plan['services'])
            until=time.time()+120
            while running and time.time()<until and not health(running,probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):time.sleep(2)
            if running and not health(running,probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):raise ValueError('RESTART_FAILED: watchdog remains armed, maintenance retained')
            maintenance(cfg,False)
            complete_recovery(root)
            emit(stage='source_ready')
        except Exception:raise ValueError('RESTART_FAILED: inspect remote watchdog and recovery.json')
    restarted=time.time()
    emit(stage='packing')
    if output is None:docker('save','-o',str(root/'images.tar'),*original_ids,*images)
    manifest={'formatVersion':1,'capturedAt':captured,'downtimeSeconds':restarted-stopped_at,'containerDowntimeSeconds':restarted-stopped_at,'visitorDowntimeSeconds':restarted-visitor_start,'architecture':docker('info','--format','{{.Architecture}}').decode().strip(),'containers':cs,'snapshotImages':images,'originalImages':original_images,'shutdownEvidence':shutdown_proof,'configurationFiles':cfg.get('composeFiles',[])+cfg.get('configFiles',[]),'complete':True,'restoreTested':False}
    manifest['temporaryMemoryFolders']=cfg.get('temporaryMemoryFolders',[])
    if PROBE_POLICY_FALLBACKS:manifest['probePolicyFallback']=sorted(set(PROBE_POLICY_FALLBACKS))
    manifest['backupPlan']=plan
    if cfg.get('restoreReferences'):manifest['restoreReferences']=cfg['restoreReferences']
    if exclusions:
        manifest['backupScope']='application-and-local-state'
        manifest['excludedPaths']=cfg['mountExclusions']
    manifest['artifacts']=inventory if output is not None else artifact_inventory(root)
    manifest['deliveryMode']='direct' if output is not None else 'staged'
    manifest['consistency']={'status':'declared' if any(s['engine']=='generic' for s in plan['services']) else 'passed','method':'offline native shutdown evidence plus declared writer quiescence','scope':'selected services and mounts','services':shutdown_proof}
    (root/'manifest.json').write_text(json.dumps(manifest));os.chmod(root/'manifest.json',0o600)
    (root/'restore-guide.md').write_text(RESTORE_GUIDE)
    if exclusions:
        with (root/'restore-guide.md').open('a') as guide:
            guide.write('\n# Selected backup scope\nThis package intentionally excludes the paths listed in manifest.excludedPaths. Recover or reattach that external data separately after validating the isolated application copy. Never replace external storage contents with empty restored directories. Retention of this package does not protect excluded data.\n')
    if output is not None:
        stream_document(archive,'manifest.json',json.dumps(manifest))
        stream_document(archive,'restore-guide.md',(root/'restore-guide.md').read_text())
        archive.close();output.flush()
    else:run(['tar','-czf',str(root/'payload.tar.gz'),'-C',str(root),'images.tar','manifest.json','restore-guide.md',*[p.name for p in root.glob('mount-*.tar')],*[p.name for p in root.glob('config-*.tar')]])
    for image in images:
        try:docker('image','rm',image)
        except Exception:pass
    emit(result={**({'streamed':True} if output is not None else {'remotePath':str(root/'payload.tar.gz')}),'root':str(root),'manifest':manifest})

def owned_job_root(req):
    job=req['job'];uuid.UUID(job)
    base=pathlib.Path('/var/lib/docker-backup-manager/restore')
    return base/job

def verify_recovery(req):
    cfg=req['config'];job=req['job'];uuid.UUID(job)
    if cfg.get('kind')=='static':emit(result={'recoveryReviewed':True,'hostingUnchanged':True});return
    root=pathlib.Path(cfg.get('stagingRoot','/var/lib/docker-backup-manager'))/job
    if not (root/'recovery-plan.json').is_file():raise ValueError('Recovery journal is missing; offline review required')
    plan=json.loads((root/'recovery-plan.json').read_text())
    recovered=json.loads((root/'recovery.json').read_text()).get('recovered') if (root/'recovery.json').is_file() else False
    if not (root/'watchdog.done').exists() or not ((root/'disarmed').exists() or recovered):raise ValueError('Local recovery has not finished successfully')
    states=inspect(plan['containers'])
    if any(bool(c['State']['Running'])!=(c['Id'] in plan['running']) for c in states):raise ValueError('Container states do not match the pre-backup state')
    skip_refused_probes(cfg)
    if not health(plan['running'],probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):raise ValueError('Application health has not recovered')
    m=cfg.get('maintenance',{})
    if m.get('required'):
        if (pathlib.Path(m['directory'])/'enabled').exists():raise ValueError('Maintenance remains enabled')
        if 'public' not in cfg['_skippedProbes']:
            if not m.get('publicUrl'):raise ValueError('Public health probe required')
            status,body=public_probe(m,cfg.get('domains',()))
            if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('Public access has not recovered')
    emit(result={'recoveryReviewed':True,'healthVerified':True,'originalStatesPreserved':True,**({'probePolicyFallback':sorted(set(PROBE_POLICY_FALLBACKS))} if PROBE_POLICY_FALLBACKS else {})})

def verify_restore_recovery(req):
    job=req['job'];uuid.UUID(job)
    ids=docker('ps','-aq','--filter','label=docker-backup-manager.restore='+job).decode().split()
    if ids and any(c['State']['Running'] for c in inspect(ids)):raise ValueError('Stop the interrupted isolated restore containers on the target before acknowledging recovery')
    emit(result={'recoveryReviewed':True,'targetContainersStopped':True,'stagingRetained':True})
def safe_extract(archive,destination):
    if destination.is_symlink():raise ValueError('Restore destination cannot be a symlink')
    destination.mkdir(parents=True,exist_ok=True,mode=0o700)
    if any(destination.iterdir()):raise ValueError('Restore destination must be empty')
    root=destination.resolve()
    with tarfile.open(archive,'r:*') as tar:
        members=tar.getmembers()
        symlinks={pathlib.PurePosixPath(m.name) for m in members if m.issym()}
        regular={pathlib.PurePosixPath(m.name) for m in members if m.isfile()}
        seen=set()
        for member in members:
            p=pathlib.PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Unsafe archive member or link; use reviewed offline restore adapter')
            if p in seen or any(parent in symlinks for parent in p.parents):raise ValueError('Duplicate archive path or write through archive symlink')
            seen.add(p)
            target=(root/member.name).resolve()
            if os.path.commonpath([str(root),str(target)])!=str(root):raise ValueError('Archive path escapes destination')
            if member.issym() or member.islnk():
                link=pathlib.PurePosixPath(member.linkname)
                if link.is_absolute():raise ValueError('Absolute archive link is not portable')
                linked=(target.parent/member.linkname).resolve() if member.issym() else (root/member.linkname).resolve()
                if os.path.commonpath([str(root),str(linked)])!=str(root):raise ValueError('Archive link escapes destination')
                if member.islnk() and (link not in regular or any(parent in symlinks for parent in link.parents)):raise ValueError('Hard link must target an archived regular file')
        if os.name=='posix':
            run(['tar','--xattrs','--acls','--numeric-owner','-xpf',str(archive),'-C',str(destination)])
        else:tar.extractall(destination,filter='fully_trusted')
def prepare_restore(req):
    root=owned_job_root(req)
    if root.exists():raise ValueError('Restore staging already exists')
    root.mkdir(parents=True,mode=0o700)
    emit(result={'root':str(root),'remotePath':str(root/'payload.tar.gz')})
def restore_network_plan(containers):
    if not 1<=len(containers)<=30:raise ValueError('Restore requires 1 to 30 containers')
    plans=[]
    for c in containers:
        hc=c['HostConfig'];mode=hc.get('NetworkMode','')
        if hc.get('Privileged') or hc.get('Devices') or hc.get('CapAdd') or hc.get('PidMode')=='host' or hc.get('IpcMode')=='host' or mode=='host' or mode.startswith('container:'):raise ValueError('Host privileges or shared namespace networking cannot be restored automatically')
        networks={}
        for name,n in c.get('NetworkSettings',{}).get('Networks',{}).items():
            if name=='none':continue
            if n.get('IPAMConfig'):raise ValueError('Static IP assignments require a reviewed offline restore')
            aliases=list(dict.fromkeys([c['Name'].lstrip('/'),c.get('Config',{}).get('Hostname','')]+(n.get('Aliases') or [])))
            if any(not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',alias) for alias in aliases if alias):raise ValueError('Unsupported network alias requires offline restore')
            networks[name]=[alias for alias in aliases if alias]
        plans.append(networks if len(containers)>1 else {})
    if len({name for networks in plans for name in networks})>30:raise ValueError('Too many restore networks')
    return plans

EXTERNAL_RESTORE_ROOT=pathlib.Path('/var/lib/docker-backup-manager/external-restore')

def external_restore_plan(manifest,references,metadata_only=False):
    if not isinstance(references,list) or len(references)>50:raise ValueError('External restore references must be a reviewed list')
    excluded=manifest.get('excludedPaths',manifest.get('backupPlan',{}).get('coverage',{}).get('excludedPaths',[]))
    declared={item['path']:item for item in excluded};table=mount_table() if references else []
    plans=[];seen=set()
    for item in references:
        if not isinstance(item,dict) or set(item)!={'capturedPath','source'}:raise ValueError('External restore references require capturedPath and source only')
        captured=item['capturedPath'];source=item['source']
        if not isinstance(captured,str) or captured not in declared or captured in seen:raise ValueError('External restore path must be an exact declared exclusion')
        if any(excluded_path(captured,[p]) or excluded_path(p,[captured]) for p in seen):raise ValueError('Overlapping external restore references are unsupported')
        seen.add(captured)
        if not isinstance(source,str) or not re.fullmatch(r'/[a-zA-Z0-9_./-]+',source) or str(pathlib.PurePosixPath(source))!=source or '..' in pathlib.PurePosixPath(source).parts:raise ValueError('External restore source must be a regular absolute directory')
        path=pathlib.Path(source)
        if not path.is_relative_to(EXTERNAL_RESTORE_ROOT) or path==EXTERNAL_RESTORE_ROOT or path.resolve()!=path or not path.is_dir():raise ValueError('Prepare external storage under the dedicated external-restore directory without links')
        covering=[m for m in table if source==m['path'] or source.startswith(m['path'].rstrip('/')+'/')]
        if not covering:raise ValueError('External restore filesystem could not be inspected')
        mount=max(covering,key=lambda m:len(m['path']))
        if not mount.get('readOnly') or any(not m.get('readOnly') for m in table if m['path'].startswith(source.rstrip('/')+'/')):raise ValueError('External restore storage must already be mounted read-only on the host')
        destinations=[]
        for c in ([] if metadata_only else manifest.get('containers',[])):
            for m in c['Mounts']:
                if m['Source']==declared[captured]['source'] and captured.startswith(m['Source'].rstrip('/')+'/'):
                    destination=str(pathlib.PurePosixPath(m['Destination'])/os.path.relpath(captured,m['Source']))
                    if ',' in destination:raise ValueError('External restore destinations with commas are unsupported')
                    destinations.append({'container':c['Id'],'destination':destination})
        if not metadata_only and not destinations:raise ValueError('External restore exclusion is not inside a selected mount')
        stat=path.stat();plans.append({'capturedPath':captured,'source':source,'destinations':destinations,'readOnly':True,'mountId':mount['id'],'device':stat.st_dev,'inode':stat.st_ino})
    if any(item.get('requiredForRestore') and item['path'] not in seen for item in excluded):raise ValueError('Required external storage is missing; prepare reviewed read-only restore references')
    identities=[{k:v for k,v in plan.items() if k!='destinations'} for plan in plans]
    fingerprint=hashlib.sha256(json.dumps(sorted(identities,key=lambda p:p['capturedPath']),sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'references':plans,'fingerprint':fingerprint}

def restore(req):
    root=owned_job_root(req)
    payload=root/'payload.tar.gz'
    digest=__import__('hashlib').sha256()
    with open(payload,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
    if digest.hexdigest()!=req['plaintextChecksum']:raise ValueError('Restore transfer checksum mismatch')
    unpacked=root/'unpacked';safe_extract(payload,unpacked)
    manifest=json.loads((unpacked/'manifest.json').read_text())
    if manifest.get('formatVersion')!=VERSION or not manifest.get('complete'):raise ValueError('Unsupported or incomplete backup')
    artifacts_verified=verify_artifacts(unpacked,manifest)
    external=external_restore_plan(manifest,req.get('externalReadOnly',[]))
    if req.get('externalFingerprint') and external['fingerprint']!=req['externalFingerprint']:raise ValueError('External restore mount identity changed after planning')
    if manifest.get('kind')=='static':
        if manifest.get('containers'):raise ValueError('Invalid static backup manifest')
        directory=root/'static-site';safe_extract(unpacked/'static-files.tar',directory)
        entries=list(directory.iterdir())
        if len(entries)!=1 or not entries[0].is_dir():raise ValueError('Static archive must have one website directory')
        if tree_digest(entries[0])!=manifest.get('staticFiles'):raise ValueError('Restored static files differ from the captured website')
        for i,_ in enumerate(manifest.get('configurationFiles',[])):safe_extract(unpacked/('config-%d.tar'%i),root/('configuration-%d'%i))
        emit(result={'kind':'static','root':str(root),'documentRoot':str(entries[0]),'filesVerified':True,'fileCount':manifest['staticFiles']['files'],'hostingUnchanged':True,'externallyAccessible':False,'restoreTested':True,'verification':{'isolatedRestore':{'status':'passed','method':'fresh private directory','artifactsVerified':artifacts_verified},'application':{'status':'passed','scope':'static file contents and metadata; no visitor workflow','method':'captured tree digest'}},'access':'Review files at '+str(entries[0])+'; configure nginx only after validation.'});return
    if manifest['architecture']!=docker('info','--format','{{.Architecture}}').decode().strip():raise ValueError('Architecture mismatch')
    containers=manifest['containers'];plans=restore_network_plan(containers)
    if len(manifest.get('snapshotImages',[]))!=len(containers):raise ValueError('Missing snapshot images')
    multi=len(containers)>1
    if multi and int(docker('version','--format','{{.Server.Version}}').decode().split('.')[0])<28:raise ValueError('Grouped isolated restores require Docker 28 or newer')
    if shutil.disk_usage(root).free<sum(p.stat().st_size for p in unpacked.glob('mount-*.tar'))+1024**3:raise ValueError('Insufficient target capacity for extracted data')
    definitions=[];sources={}
    for i,c in enumerate(containers):
        name='dbm-restore-'+req['job'][:12]+('-'+str(i) if multi else '')
        args=['create','--name',name,'--network','none','--restart','no','--label','docker-backup-manager.restore='+req['job']]
        # A copy must never remain a member of the source's Compose project.
        args+=['--label','com.docker.compose.project=docknest-restore-'+req['job'][:12],'--label','com.docker.compose.project.working_dir=','--label','com.docker.compose.project.config_files=']
        if multi and plans[i]:args+=['--dns','127.0.0.1']
        for destination,options in temporary_mounts(c,manifest.get('temporaryMemoryFolders',[])):args+=['--tmpfs',destination+':'+options]
        for j,m in enumerate(c['Mounts']):
            key=(m['Type'],m['Source'])
            if key not in sources:
                for _,existing in sources:
                    a,b=os.path.normpath(existing),os.path.normpath(m['Source'])
                    if os.path.commonpath([a,b]) in [a,b]:raise ValueError('Overlapping mount paths require offline restore')
                directory=root/('data-%d-%d'%(i,j))
                safe_extract(unpacked/('mount-%d-%d.tar'%(i,j)),directory)
                entries=list(directory.iterdir())
                if len(entries)!=1:raise ValueError('Mount archive must have exactly one source entry')
                sources[key]=entries[0]
            source=sources[key]
            if ',' in str(source) or ',' in m['Destination']:raise ValueError('Mount paths with commas require offline restore')
            mount='type=bind,src='+str(source)+',dst='+m['Destination']
            if not m.get('RW',True):mount+=',readonly'
            args+=['--mount',mount]
        for reference in external['references']:
            for destination in reference['destinations']:
                if destination['container']==c['Id']:args+=['--mount','type=bind,src='+reference['source']+',dst='+destination['destination']+',readonly']
        definitions.append((name,args+[manifest['snapshotImages'][i]]))
    sqlite_checks=[];sqlite_cache={}
    for service in manifest.get('backupPlan',{}).get('services',[]):
        if not service.get('sqliteFiles'):continue
        original=next(c for c in containers if c['Id']==service['container'])
        restored={**original,'Mounts':[{**mount,'Source':str(sources[(mount['Type'],mount['Source'])])} for mount in original['Mounts']]}
        actual=cached_sqlite_file_proof(sqlite_cache,service,restored)
        if actual!=service.get('expectedSqliteChecks'):raise ValueError('Isolated offline SQLite checks differ from capture')
        sqlite_checks.extend({'container':service['container'],'name':check['path'],'method':check['method'],'status':'passed'} for check in actual)
    docker('load','-i',str(unpacked/'images.tar'))
    created=[];networks={};running=[]
    try:
        for index,original in enumerate(dict.fromkeys(name for plan in plans for name in plan)):
            name='dbm-restore-'+req['job'][:12]+'-net-'+str(index)
            docker('network','create','--internal','--driver','bridge','--opt','com.docker.network.bridge.gateway_mode_ipv4=isolated','--opt','com.docker.network.bridge.gateway_mode_ipv6=isolated','--label','docker-backup-manager.restore='+req['job'],name)
            networks[original]=name
            n=json.loads(docker('network','inspect',name))[0]
            if not n['Internal'] or n.get('EnableIPv6') or n.get('Options',{}).get('com.docker.network.bridge.gateway_mode_ipv4')!='isolated':raise ValueError('Target did not create an isolated restore network')
        for i,(name,args) in enumerate(definitions):
            if plans[i]:
                original=next(iter(plans[i]));args[args.index('--network')+1]=networks[original]
                args[1:1]=[part for alias in plans[i][original] for part in ['--network-alias',alias]]
            cid=docker(*args).decode().strip();created.append(cid)
            if plans[i]:
                for original,aliases in list(plans[i].items())[1:]:
                    flags=[part for alias in aliases for part in ['--alias',alias]]
                    docker('network','connect',*flags,networks[original],cid)
        contracts=manifest.get('backupPlan',{}).get('services',[])
        ordered=manifest.get('backupPlan',{}).get('restartOrder',[c['Id'] for c in containers])
        mapping={c['Id']:cid for c,cid in zip(containers,created)}
        running=[mapping[original_id] for original_id in ordered if next(c for c in containers if c['Id']==original_id)['State'].get('Running')]
        restart_services(running,[{**service,'container':mapping[service['container']],'dependsOn':[mapping[cid] for cid in service.get('dependsOn',[])]} for service in contracts])
        until=time.time()+120
        while time.time()<until and not health(running):time.sleep(2)
        if not health(running):raise ValueError('Restored container health check failed')
        checks=list(sqlite_checks)
        for service in contracts:
            if service['engine']=='generic':continue
            actual=data_checks(mapping[service['container']],service)
            if actual!=service.get('expectedChecks',[]):raise ValueError('Isolated database data checks differ from capture')
            checks.extend({'container':service['container'],'name':check['name'],'method':check['method'],'status':'passed'} for check in actual)
    except Exception:
        try:
            if created:docker('stop','--time','30',*created)
        except Exception:pass
        raise
    application_complete=bool(contracts) and all(s['engine']!='generic' and s.get('expectedChecks') for s in contracts)
    emit(result={'containerId':created[0],'containerIds':created,'name':definitions[0][0],'networkMode':'isolated-internal' if networks else 'none','networks':list(networks.values()),'root':str(root),'access':'docker exec '+definitions[0][0]+' sh','externallyAccessible':False,'restoreTested':application_complete,'containerHealthVerified':True,'originalStatesPreserved':True,'externalReferences':external,'verification':{'isolatedRestore':{'status':'passed','method':'fresh mounts and isolated networks','artifactsVerified':artifacts_verified,'externalDataReadOnly':bool(external['references'])},'application':{'status':'passed' if application_complete else 'partial' if checks else 'not-tested','method':'named read-only native database checks','checks':checks,'scope':'configured database checks; application workflows require separate review'}}})
def deploy_maintenance(req):
    cfg=req['config'];m=cfg.get('maintenance',{})
    p=pathlib.Path(m.get('directory',''))
    if not p.is_absolute() or '..' in p.parts:raise ValueError('Absolute maintenance directory required')
    if p.exists() and not p.is_dir():raise ValueError('Maintenance directory is not a directory')
    p.mkdir(parents=True,exist_ok=True,mode=0o755)
    content=__import__('base64').b64decode(req['html'])
    if len(content)>256*1024:raise ValueError('Maintenance asset exceeds size limit')
    temp=p/'maintenance.html.tmp'
    with open(temp,'wb') as f:f.write(content)
    os.chmod(temp,0o644);os.replace(temp,p/'maintenance.html')
    emit(result={'distributed':True,'helperVersion':VERSION,'ready':False,'proxyIntegrationRequired':True,'directory':str(p)})

def install_boot_recovery(req):
    if os.geteuid()!=0:raise ValueError('Boot recovery installation requires root')
    base=pathlib.Path(req['config'].get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts or base.resolve()!=base or str(base) in ['/','/var','/var/lib','/root','/home','/srv','/opt','/etc','/tmp']:raise ValueError('Dedicated root-owned staging directory required')
    base.mkdir(parents=True,exist_ok=True,mode=0o700)
    if base.stat().st_uid!=0 or base.stat().st_mode&0o077:raise ValueError('Staging directory must be root-owned with mode 0700')
    library=pathlib.Path('/usr/local/lib/docknest');registry=pathlib.Path('/etc/docknest')
    for directory in [library,registry]:
        if directory.resolve()!=directory:raise ValueError('Recovery installation paths cannot be symbolic links')
        directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        if directory.stat().st_uid!=0 or directory.stat().st_mode&0o077:raise ValueError('Recovery installation directory must be private and root-owned')
    for name,key_name in [('helper.py','helper'),('boot_recovery.py','bootHelper')]:
        content=__import__('base64').b64decode(req[key_name],validate=True)
        if len(content)>512*1024:raise ValueError('Recovery helper exceeds size limit')
        temporary=library/(name+'.new')
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as output:output.write(content);output.flush();os.fsync(output.fileno())
        os.replace(temporary,library/name)
    file=registry/'recovery-roots.json'
    roots=json.loads(file.read_text()).get('roots',[]) if file.exists() else []
    atomic_json(file,{'version':1,'roots':list(dict.fromkeys(roots+[str(base)]))})
    unit=pathlib.Path('/etc/systemd/system/docknest-source-recovery.service')
    if unit.is_symlink():raise ValueError('Recovery unit cannot be a symbolic link')
    unit.write_text('[Unit]\nDescription=DockNest interrupted source recovery\nAfter=docker.service network-online.target\nWants=network-online.target\nRequires=docker.service\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /usr/local/lib/docknest/boot_recovery.py\nTimeoutStartSec=1800\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n')
    os.chmod(unit,0o644);run(['systemctl','daemon-reload']);run(['systemctl','enable','docknest-source-recovery.service'])
    emit(result={'installed':True,'enabled':True,'startsOnNextBoot':True,'helperVersion':VERSION})

def main(req):
    global EVENT_STREAM,CAPTURE_DIAGNOSTICS
    op=req['operation']
    CAPTURE_DIAGNOSTICS=op in ['capture','capture-stream'] and bool(req.get('diagnostics'))
    if op=='capture-stream':EVENT_STREAM=sys.stderr
    if op=='readiness':emit(result=readiness(req['config']))
    elif op=='plan':emit(result=public_plan(backup_plan(req['config'])))
    elif op=='install-boot-recovery':install_boot_recovery(req)
    elif op=='test':
        emit(result={'helperVersion':VERSION,'docker':docker('version','--format','{{.Server.Version}}').decode().strip(),'architecture':docker('info','--format','{{.Architecture}}').decode().strip(),'freeBytes':shutil.disk_usage('/').free,'uid':os.geteuid()})
    elif op=='discover':
        ids=docker('ps','-aq').decode().split()
        cs=inspect(ids) if ids else []
        # Do not expose environment secrets to dashboard.
        routes=nginx_sites()
        emit(result={'staticSites':[site for site in routes if site['kind']=='static'],'containers':[{'id':c['Id'],'name':c['Name'].lstrip('/'),'image':c['Config']['Image'],'state':c['State']['Status'],'running':c['State']['Running'],'health':c['State'].get('Health',{}).get('Status'),'labels':c['Config'].get('Labels',{}),'mounts':c['Mounts'],'temporaryMemoryFolders':list(c.get('HostConfig',{}).get('Tmpfs',{})),'ports':c['NetworkSettings']['Ports'],'webHints':web_hints(c,routes),'backupConfiguration':configuration_paths(c)} for c in cs]})
    elif op=='list-project-files':emit(result=list_project_files(req['containers'],req.get('directory')))
    elif op=='capture':capture(req)
    elif op=='capture-stream':capture(req,sys.stdout.buffer)
    elif op=='prepare-restore':prepare_restore(req)
    elif op=='restore':restore(req)
    elif op=='plan-external-restore':emit(result=external_restore_plan(req['manifest'],req.get('externalReadOnly',[]),metadata_only=True))
    elif op=='verify-recovery':verify_recovery(req)
    elif op=='verify-restore-recovery':verify_restore_recovery(req)
    elif op=='deploy-maintenance':deploy_maintenance(req)
    elif op=='maintenance':
        req['config'].setdefault('maintenance',{})['required']=True
        refused=skip_refused_probes(req['config'])
        if req['enabled'] and 'public' in refused:raise ValueError("Probe URL policy: %s. Update the site's public maintenance URL before enabling maintenance."%refused['public'])
        maintenance(req['config'],req['enabled']);emit(result={'enabled':req['enabled']})
    elif op=='cleanup':
        root=pathlib.Path(req['root']);uuid.UUID(root.name)
        if not (root/'disarmed').exists() or not (root/'watchdog.done').exists():raise ValueError('Recovery watchdog has not acknowledged disarm')
        shutil.rmtree(root);emit(result={'removed':True})
    else:raise ValueError('Unsupported helper operation')
if __name__=='__main__':
    try:main(json.loads(sys.stdin.readline()))
    except Exception as e:
        diagnostic(phase='helper-failure',exceptionType=type(e).__name__)
        emit(error=str(e));sys.exit(1)
