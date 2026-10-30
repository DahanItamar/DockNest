#!/usr/bin/env python3
"""Versioned Linux helper. No request values are interpolated into shell commands."""
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
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

INCREMENTAL_GUIDE="""
# Incremental backups (format v2)
manifest.backupKind says whether this package is a full backup or an increment. manifest.chain names the chain, this
package's position and, for an increment, the backup ID and ciphertext SHA-256 of the package before it. An increment
holds only the files that changed. With the recovery kit, as root on Linux with GNU tar:
  node decrypt-backup.js --chain <backup_...--ID.tar.gz.enc or a chain download folder> <master.key> <new folder>
  python3 helper.py restore-chain <that folder> <another new folder>
The first step finds and verifies every package of the chain (full backup first) and every link; the second rebuilds
each mount with the same checks as DockNest and lists the images.tar files to load, in order.
By hand: decrypt and verify every package of the chain first and check that each manifest.chain.parentSha256 matches
the package before it. Check every archive for unsafe paths, including the names in GNU.dumpdir records. Then, for each
mount, go into a new empty directory and extract the full backup's mount-I-J.tar, then the same mount of each increment
in order, from inside that directory (not with -C: GNU tar makes the temporary folder of a folder-name swap relative
to the working directory):
  cd NEW_DIRECTORY && tar --listed-incremental=/dev/null --xattrs --acls --numeric-owner -xpf /path/to/mount-I-J.tar
This also applies deletions and renames. Where an earlier archive restored a symlink and a later one has a real folder
at that path, remove the symlink before extracting that later archive (tar would follow it). Run docker load -i
images.tar for every package of the chain, in order. The snapshot-*.snar files are GNU tar snapshot files; a restore
does not need them.
"""

EVENT_STREAM=sys.stdout
NOFOLLOW=getattr(os,'O_NOFOLLOW',0)
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
def run(args,timeout=3600,input=None,cwd=None):
    if STOPPING:raise ValueError('DockNest stopped this step.')
    started=time.monotonic();label=pathlib.Path(args[0]).name+(' '+str(args[1]) if len(args)>1 and args[0]=='docker' else '')
    diagnostic(command=label,phase='start')
    try:
        result=subprocess.check_output(args,stderr=subprocess.DEVNULL,timeout=timeout,input=input,cwd=cwd)
        diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='ok')
        return result
    except subprocess.TimeoutExpired:
        diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='timeout',timeoutSeconds=timeout)
        raise
    except subprocess.CalledProcessError as error:
        diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='exit',exitCode=error.returncode)
        raise
def docker(*args): return run(['docker',*args])
def inspect(ids): return [tmpfs_as_host_config(c) for c in json.loads(docker('inspect',*ids))]
# Compose long-syntax tmpfs mounts appear in Mounts; fold them into HostConfig.Tmpfs so capture and restore see one RAM folder form.
def tmpfs_as_host_config(c):
    host=c.get('HostConfig') or {};tmpfs=dict(host.get('Tmpfs') or {})
    specs={m.get('Target'):m.get('TmpfsOptions') or {} for m in host.get('Mounts') or [] if m.get('Type')=='tmpfs'}
    for m in c.get('Mounts') or []:
        if m.get('Type')!='tmpfs' or m.get('Destination') in tmpfs:continue
        spec=specs.get(m.get('Destination'),{});mode=spec.get('Mode') or 0
        options=(['size=%d'%spec['SizeBytes']] if spec.get('SizeBytes') else [])+(['mode=%o'%((mode&0o777)|(0o1000 if mode&(0o1000|1<<20) else 0))] if mode else [])+([] if m.get('RW',True) else ['ro'])
        tmpfs[m.get('Destination')]=','.join(options)
    return {**c,'HostConfig':{**host,'Tmpfs':tmpfs},'Mounts':[m for m in c.get('Mounts') or [] if m.get('Type')!='tmpfs']}

# A Docker bind path can conceal a remote filesystem. Unknown filesystems fail closed.
LOCAL_FILESYSTEMS={'ext2','ext3','ext4','xfs','btrfs','zfs','overlay'}
# Credentials, SSH and GPG keys and kernel interfaces are never captured, whoever configured the site.
PROTECTED_FILES={'/etc/shadow','/etc/shadow-','/etc/gshadow','/etc/gshadow-'}
PROTECTED_TREES=('/root/.ssh','/proc','/sys','/dev')
# A directory source that contains any of these would capture them too.
PROTECTED_CONTENT=tuple(PROTECTED_FILES)+PROTECTED_TREES+('/etc/ssh','/etc/sudoers','/etc/sudoers.d')
# Per-user key folders: an entry with one of these names is never captured, wherever it is (a /home/<user> bind mount
# would otherwise carry ~/.ssh and ~/.gnupg). Only private key stores; tokens such as ~/.aws stay application data.
PROTECTED_NAMES=('.ssh','.gnupg')
def lexical(value):
    # The helper runs on Linux; the separator swap only lets the unit tests run on a Windows workstation.
    path=posixpath.normpath(str(value).replace(os.sep,'/'))
    # POSIX keeps a leading '//' after normpath; on Linux it names the same file as '/'.
    return '/'+path.lstrip('/') if path.startswith('/') else path
def within(path,root):
    root=root.rstrip('/') or '/'
    return path==root or root=='/' or path.startswith(root+'/')
def resolved(value):
    # Both the written path and the path after following symlinks (parent links included) are checked.
    path=lexical(value)
    return [path,lexical(os.path.realpath(path))] if path.startswith('/') else [path]
def protected_lexical(path):
    return path in PROTECTED_FILES or path.startswith('/etc/sudoers') or bool(re.fullmatch(r'/etc/ssh/[^/]*_key',path)) or any(within(path,root) for root in PROTECTED_TREES) or any(part in PROTECTED_NAMES for part in pathlib.PurePosixPath(path).parts)
def protected_path(value):
    return any(protected_lexical(path) for path in resolved(value))
def protected_content(value):
    return any(any(within(item,path) for item in PROTECTED_CONTENT) for path in resolved(value) if os.path.isdir(path))
def refuse_protected_sources(cfg):
    for value in ([cfg['documentRoot']] if cfg.get('kind')=='static' and cfg.get('documentRoot') else [])+cfg.get('composeFiles',[])+cfg.get('configFiles',[]):
        if protected_path(value) or protected_content(value):raise ValueError('Protected system path refused: %s. Password databases, sudoers, SSH and GPG keys, /proc, /sys and /dev are never captured.'%value)
def protected_mount(source):
    return bool(source) and (protected_path(source) or protected_content(source))
def protected_mounts(containers):
    """Bind mounts of password databases, sudoers, SSH or GPG keys (or folders holding them) are never copied: the backup keeps
    an empty placeholder in their place and records them here, so they are recovered separately like external data."""
    return [{'container':c.get('Name','').lstrip('/'),'source':m['Source'],'destination':m.get('Destination','')} for c in containers for m in c.get('Mounts') or [] if m.get('Type')=='bind' and protected_mount(m.get('Source'))]
def protected_mount_warning(items):
    return 'Not copied: %s. These mounts hold passwords, sudo rules or SSH or GPG keys, which DockNest never copies; recover them separately before using a restored copy.'%'; '.join('%s (mounted into %s)'%(item['source'],item['container'] or 'a container') for item in items)
# The readiness check stops walking a mount after this many entries; capture always walks it all.
READINESS_SCAN_ENTRIES=200000
def protected_subpaths(source,excluded=(),limit=None):
    """Entries named .ssh or .gnupg inside a copied bind mount (2.12.1), at any depth, and whether the walk finished
    (it stops after `limit` entries). tar leaves out every entry with these names whatever this walk finds (guarded
    archives); the list names them in the warning and the manifest."""
    found=[];seen=0
    if not source or not os.path.isdir(source) or os.path.islink(source):return found,True
    for current,dirs,files in os.walk(source,followlinks=False):
        seen+=len(dirs)+len(files)
        if limit is not None and seen>limit:return found,False
        dirs.sort()
        for name in sorted(dirs+files):
            path=lexical(os.path.join(current,name))
            if name in PROTECTED_NAMES and not excluded_path(path,excluded):found.append(path)
        dirs[:]=[name for name in dirs if name not in PROTECTED_NAMES and not excluded_path(lexical(os.path.join(current,name)),excluded)]
    return found,True
def guarded_mount(m):
    """A copied bind mount: its archive leaves out every .ssh and .gnupg entry. Volumes are the container's own data."""
    return m.get('Type')=='bind' and not protected_mount(m.get('Source'))
def protected_paths(containers,exclusions=None,limit=None):
    """Key folders left out of copied bind mounts, one record per mount source (the first container that mounts it),
    and the sources whose walk stopped at `limit`."""
    result=[];seen=set();unscanned=[]
    for c in containers:
        for m in c.get('Mounts') or []:
            source=m.get('Source')
            if source in seen or not guarded_mount(m):continue
            seen.add(source)
            found,complete=protected_subpaths(source,(exclusions or {}).get(source,[]),limit)
            if not complete:unscanned.append(source)
            result+=[{'container':c.get('Name','').lstrip('/'),'source':source,'path':path} for path in found]
    return result,unscanned
def protected_path_warning(items,unscanned=()):
    more=' and %d more'%(len(items)-20) if len(items)>20 else ''
    text='Not copied: %s%s. These folders hold SSH or GPG keys, which DockNest never copies; recover them separately before using a restored copy.'%('; '.join('%s (mounted into %s)'%(item['path'],item['container'] or 'a container') for item in items[:20]),more) if items else ''
    if unscanned:text+=(' ' if text else '')+'Not fully scanned: %s. Backups leave out every .ssh and .gnupg folder in them anyway.'%'; '.join(unscanned[:20])
    return text
# The maintenance page belongs in the site's staging root, its project folders or a web root, never in system folders.
MAINTENANCE_ROOTS=('/var/lib/docknest','/var/www','/srv','/usr/share/nginx')
SYSTEM_TREES=('/etc','/root','/boot','/proc','/sys','/dev','/bin','/sbin','/lib','/lib32','/lib64','/usr/bin','/usr/sbin','/usr/lib','/usr/local/bin','/usr/local/sbin','/var/spool','/var/log','/run')
def maintenance_link_escape(directory):
    # A symlink from an allowed folder into a system folder is refused outright, even for an existing deployment.
    path=lexical(directory);real=lexical(os.path.realpath(path))
    return real!=path and real.startswith('/') and (protected_lexical(real) or any(within(real,root) for root in SYSTEM_TREES))
def system_path(value):
    return any(protected_lexical(path) or any(within(path,root) for root in SYSTEM_TREES) for path in resolved(value))
def maintenance_directory_problem(cfg,directory):
    path=lexical(directory)
    # Symlinks are followed for the system-folder check, so /var/www/x -> /etc/cron.d is refused.
    if system_path(path):return 'Maintenance directory %s is inside a system folder'%path
    roots=list(MAINTENANCE_ROOTS)+[cfg.get('stagingRoot') or '']+[posixpath.dirname(value) for value in cfg.get('composeFiles',[])]+([cfg['documentRoot']] if cfg.get('documentRoot') else [])
    if any(root and lexical(root)!='/' and within(path,lexical(root)) for root in roots):return None
    return "Maintenance directory %s is outside the site's staging root, project folders and web roots (/var/www, /srv, /usr/share/nginx)"%path
def warn(message):emit(warning=message)
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

def exclude_options(source,excluded=(),guard=False):
    options=['--no-wildcards','--anchored',*('--exclude='+source.name+'/'+os.path.relpath(path,source) for path in excluded)] if excluded else []
    # Unanchored, literal: any member whose last component is .ssh or .gnupg (and all below it), at any depth.
    if guard:options+=['--no-wildcards','--no-anchored',*('--exclude='+name for name in PROTECTED_NAMES)]
    return options

def source_archive(source,target,excluded=(),snapshot=None,guard=False):
    if snapshot is not None:
        # Incremental archives always use the POSIX format: GNU-format incremental headers keep atime/ctime where
        # ustar keeps the name prefix, so the restore path checks would read different names than GNU tar extracts.
        command=source_archive_command(source,excluded,snapshot,guard);command[command.index('-cpf')+1]=str(target)
        run(command);return
    source=pathlib.Path(source)
    options=exclude_options(source,excluded,guard)
    run(['tar','--xattrs','--acls','--numeric-owner',*options,'-cpf',str(target),'-C',str(source.parent),'--',source.name])

def source_archive_command(source,excluded=(),snapshot=None,guard=False):
    source=pathlib.Path(source)
    options=exclude_options(source,excluded,guard)
    if snapshot is not None:options=['--listed-incremental='+str(snapshot),*options]
    # atime changes when the first pass reads data; ctime is not restored.
    return ['tar','--format=posix','--pax-option=delete=atime,delete=ctime,exthdr.name=%d/PaxHeaders/%f','--xattrs','--acls','--numeric-owner',*options,'-cpf','-','-C',str(source.parent),'--',source.name]

TRANSFER=None
def transfer_progress(count,final=False):
    # Uncompressed bytes added to the outgoing archive; total comes from the inventory pass.
    if TRANSFER is None:return
    TRANSFER['done']+=count;now=time.monotonic()
    if final or now-TRANSFER['emitted']>=2:
        TRANSFER['emitted']=now;emit(progress={'done':TRANSFER['done'],'total':TRANSFER['total']})

def command_artifact(command,archive=None,name=None,expected=None,spool=None,scan=None):
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
            if scan is not None:scan(archive_renames_safely(reader))
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

def stream_artifacts(archive,specs,spool_root=None,spooled=(),before=None,scans=None):
    # before: name -> callable run before each pass of that command (an incremental tar gets its parent snapshot back).
    before=before or {}
    inventory={};files={}
    try:
        for name,command,link in specs:
            if not link and name in before:before[name]()
            if link:inventory[name]=inventory[link]
            elif spool_root is not None and name in spooled:
                files[name]=pathlib.Path(spool_root)/('spool-'+name)
                inventory[name]=command_artifact(command,spool=files[name])
            else:inventory[name]=command_artifact(command,scan=(scans or {}).get(name))
        emit(stage='transferring')
        global TRANSFER
        TRANSFER={'done':0,'total':sum(inventory[name]['bytes'] for name,_,link in specs if not link),'emitted':0}
        transfer_progress(0,True)
        for name,command,link in specs:
            if link:
                info=tarfile.TarInfo(name);info.type=tarfile.LNKTYPE;info.linkname=link;info.mode=0o600;archive.addfile(info)
            elif name in files:command_artifact(['cat','--',str(files[name])],archive,name,inventory[name])
            else:
                if name in before:before[name]()
                command_artifact(command,archive,name,inventory[name])
        transfer_progress(0,True)
    finally:
        TRANSFER=None
        for path in files.values():path.unlink(missing_ok=True)
    return inventory

def archive_has_renames(fileobj):
    """True when a GNU tar archive holds a directory rename record (R or T in a GNU.dumpdir). GNU tar keeps writing a
    rename's records into later increments of the same snapshot file, where a restore would replay them; so after an
    increment with renames the next backup must be full (see the engine's `folders-renamed`)."""
    with tarfile.open(fileobj=fileobj,mode='r|') as tar:
        for member in tar:
            value=member.pax_headers.get('GNU.dumpdir')
            if isinstance(value,str) and any(entry[:1] in ('R','T') for entry in value.split('\0') if entry):return True
    return False
def archive_renames_safely(fileobj):
    # An archive this scan cannot read counts as renamed: the next backup is then full, never a wrong increment.
    try:return archive_has_renames(fileobj)
    except (tarfile.TarError,OSError,EOFError,ValueError):return True
def stream_file(archive,name,path,expected):
    size=path.stat().st_size;info=tarfile.TarInfo(name);info.size=size;info.mode=0o600
    with open(path,'rb') as source:archive.addfile(info,source)
    if file_sha256(path)!=expected or path.stat().st_size!=size:raise ValueError('Snapshot file changed during capture')
    return {'bytes':size,'sha256':expected}
def stream_document(archive,name,value):
    data=value.encode();info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o600
    archive.addfile(info,io.BytesIO(data))

def capture_size(containers,configuration,exclusions,images):
    sources={m['Source'] for c in containers for m in c['Mounts'] if not (m['Type']=='bind' and protected_mount(m['Source']))}
    sources.update(configuration)
    size=0
    for source in sources:
        options=['--exclude='+path for path in exclusions.get(source,[])]
        size+=int(run(['du','-sb',*options,'--',source]).split()[0])
    return size+sum(c.get('SizeRw',0) or 0 for c in containers)+sum(image['Size'] for image in images)

def backup_plan(cfg,containers=None):
    refuse_protected_sources(cfg)
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
    return {'version':1,'kind':cfg.get('kind','docker'),'fingerprint':fingerprint,'chainFingerprint':chain_fingerprint(cfg,containers,exclusions),'sources':sources,'containerIds':[c['Id'] for c in containers],'services':services,'restartOrder':service_order(services),'coverage':{'status':'scoped' if exclusions else 'declared','externalWritersConfirmed':bool(cfg.get('exclusiveSourcesConfirmed')),'excludedPaths':cfg.get('mountExclusions',[]),'externalDataIncluded':not bool(exclusions)},'unresolvedDependencies':[]}

def chain_fingerprint(cfg,containers,exclusions):
    """What an increment depends on, from facts that survive a container restart: container ids and names, original
    image ids, mounts, exclusions, network names and aliases, configuration files. `fingerprint` also hashes per-start
    network state (endpoint, MAC, IP), so it changes on every backup and cannot decide whether a chain continues."""
    def networks(c):
        return {str(name):sorted(str(alias) for alias in (n or {}).get('Aliases') or []) for name,n in ((c.get('NetworkSettings') or {}).get('Networks') or {}).items()}
    stable={'kind':cfg.get('kind','docker'),
        'containers':sorted(({'id':c['Id'],'name':c.get('Name'),'image':c['Image'],'networks':networks(c),
            'mounts':sorted(({'type':m.get('Type'),'name':m.get('Name'),'source':m.get('Source'),'destination':m.get('Destination'),'rw':m.get('RW',True)} for m in c.get('Mounts') or []),key=lambda m:(str(m['destination']),str(m['source'])))} for c in containers),key=lambda c:c['id']),
        'exclusions':{source:sorted(paths) for source,paths in (exclusions or {}).items()},
        'configuration':list(cfg.get('composeFiles',[]))+list(cfg.get('configFiles',[]))}
    if cfg.get('kind')=='static':stable['documentRoot']=cfg.get('documentRoot')
    return hashlib.sha256(json.dumps(stable,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def v1_plan(plan):
    """Format v1 manifests keep the plan exactly as before chain fingerprints existed."""
    return {k:v for k,v in plan.items() if k!='chainFingerprint'}
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

def artifact_inventory(root):
    result={}
    for p in sorted(root.iterdir()):
        if p.name=='images.tar' or re.fullmatch(r'(?:mount-\d+-\d+|config-\d+|static-files)\.tar|snapshot-[0-9a-f]{64}\.snar',p.name):
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
    if manifest.get('formatVersion')==2:
        # Format v2 (incremental-enabled sites) also carries the tar snapshot file of every source after this backup.
        for key,item in manifest_snapshots(manifest).items():
            name='snapshot-%s.snar'%key;names.add(name)
            if actual.get(name,{}).get('sha256')!=item['sha256']:raise ValueError('Backup snapshot file differs from its manifest')
    if set(actual)!=names:raise ValueError('Artifact inventory does not cover all manifest dependencies')
    return True

# ---- Incremental backups (docs/incremental-backups.md) ----
# A site with incremental backups gets format v2 packages: a full package (level 0), then increments made with GNU tar
# --listed-incremental. The snapshot (.snar) file of every mount source lives in INCREMENTAL_ROOT/<siteKey>/; capture
# works on copies in the job root, and only incremental-commit (called after the package is stored and verified) moves
# them into the state folder. Protected (holder) mounts and configuration files are always complete.
INCREMENTAL_ROOT=pathlib.Path('/var/lib/docknest/incremental')
SITE_KEY=re.compile(r'[A-Za-z0-9-]{1,64}')
CHAIN_ID=re.compile(r'[A-Za-z0-9-]{1,64}')
HEX64=re.compile(r'[0-9a-f]{64}')
IMAGE_ID=re.compile(r'sha256:[0-9a-f]{64}')
FORMAT_VERSIONS=(1,2)
MAX_CHAIN=31
FALLBACK_TEXT={'snapshot-missing':'the snapshot file of a mount is missing on this server','snapshot-mismatch':'the snapshot file of a mount does not match the previous backup','mount-set-changed':'the set of mounts changed since the previous backup'}
def snapshot_key(source):return hashlib.sha256(str(source).encode()).hexdigest()
def incremental_request(req):
    """Validated copy of the engine's `incremental` field, or None (format v1, unchanged)."""
    inc=req.get('incremental')
    if inc is None:return None
    def bad(what):raise ValueError('Invalid incremental backup request: '+what)
    if not isinstance(inc,dict) or inc.get('mode') not in ('full','incremental'):bad('mode')
    if not isinstance(inc.get('siteKey'),str) or not SITE_KEY.fullmatch(inc['siteKey']):bad('site key')
    if not isinstance(inc.get('chainId'),str) or not CHAIN_ID.fullmatch(inc['chainId']):bad('chain id')
    position=inc.get('position')
    if not isinstance(position,int) or isinstance(position,bool) or not 0<=position<MAX_CHAIN:bad('position')
    images=inc.get('parentImageIds') or []
    if not isinstance(images,list) or len(images)>1000 or any(not isinstance(i,str) or not IMAGE_ID.fullmatch(i) for i in images):bad('chain images')
    snapshots=inc.get('parentSnapshots') or {}
    if not isinstance(snapshots,dict) or len(snapshots)>1000 or any(not isinstance(k,str) or not HEX64.fullmatch(k) or not isinstance(v,str) or not HEX64.fullmatch(v) for k,v in snapshots.items()):bad('parent snapshots')
    result={'mode':inc['mode'],'siteKey':inc['siteKey'],'chainId':inc['chainId'],'position':position,'parentImageIds':list(images),'parentSnapshots':dict(snapshots)}
    if inc['mode']=='full':
        if position!=0:bad('a full backup has position 0')
        result.update(parentBackupId=None,parentSha256=None,fallbackChainId=inc.get('fallbackChainId'))
        return result
    if position<1:bad('an increment has position 1 or more')
    if not isinstance(inc.get('parentBackupId'),str) or not CHAIN_ID.fullmatch(inc['parentBackupId']):bad('parent backup')
    if not isinstance(inc.get('parentSha256'),str) or not HEX64.fullmatch(inc['parentSha256']):bad('parent checksum')
    fallback=inc.get('fallbackChainId')
    if not isinstance(fallback,str) or not CHAIN_ID.fullmatch(fallback) or fallback==inc['chainId']:bad('fallback chain id')
    result.update(parentBackupId=inc['parentBackupId'],parentSha256=inc['parentSha256'],fallbackChainId=fallback)
    return result
def private_directory(path):
    """A root-only folder that is never a symbolic link."""
    path=pathlib.Path(path)
    if path.is_symlink():raise ValueError('Incremental state folder cannot be a symbolic link')
    path.mkdir(mode=0o700,exist_ok=True)
    if path.is_symlink() or not path.is_dir():raise ValueError('Incremental state folder cannot be a symbolic link')
    if os.name=='posix':os.chmod(path,0o700)
    return path
def incremental_root():
    for parent in reversed(INCREMENTAL_ROOT.parents):
        if parent.is_symlink():raise ValueError('Incremental state folder cannot be a symbolic link')
    INCREMENTAL_ROOT.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    return private_directory(INCREMENTAL_ROOT)
def site_state(site,create=False):
    if not isinstance(site,str) or not SITE_KEY.fullmatch(site):raise ValueError('Invalid incremental site key')
    if create:incremental_root();return private_directory(INCREMENTAL_ROOT/site)
    if any(parent.is_symlink() for parent in INCREMENTAL_ROOT.parents) or INCREMENTAL_ROOT.is_symlink() or (INCREMENTAL_ROOT/site).is_symlink():raise ValueError('Incremental state folder cannot be a symbolic link')
    return INCREMENTAL_ROOT/site
def copy_private(source,target):
    """Copy a regular file (never through a link) to a new 0600 file and fsync it."""
    flags=os.O_RDONLY|NOFOLLOW
    fd=os.open(source,flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('Snapshot file is not a regular file')
        out=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_BINARY',0),0o600)
        try:
            with os.fdopen(fd,'rb',closefd=False) as reader,os.fdopen(out,'wb',closefd=False) as writer:
                shutil.copyfileobj(reader,writer,1024*1024);writer.flush();os.fsync(writer.fileno())
        finally:os.close(out)
    finally:os.close(fd)
def incremental_sources(containers):
    """source -> snapshot key for every mount that gets a snapshot file. Protected mounts are archived from an empty
    holder and are never incremental; a source mounted twice shares one archive and one snapshot file."""
    result={}
    for c in containers:
        for m in c['Mounts']:
            if m['Type']=='bind' and protected_mount(m['Source']):continue
            result.setdefault(m['Source'],snapshot_key(m['Source']))
    return result
def plan_incremental(inc,sources,root,exclusions=None):
    """Decide full or increment before any service stops, and copy each parent snapshot into the job root.
    Any missing or mismatched snapshot, or a changed set of mounts, turns the whole package into a full one."""
    work=root/'incremental';work.mkdir(mode=0o700)
    keys=sorted(set(sources.values()));reason=None
    # Excluded paths change what tar sees: a different exclusion list is a different mount set.
    excluded={key:sorted((exclusions or {}).get(source,[])) for source,key in sources.items()}
    if inc['mode']=='incremental':
        state=site_state(inc['siteKey'])
        marker=state/'state.json'
        committed=json.loads(marker.read_text()) if is_regular(marker) else None
        if set(keys)!=set(inc['parentSnapshots']):reason='mount-set-changed'
        elif committed is None:reason='snapshot-missing'
        elif (committed.get('exclusions') or {})!=excluded:reason='mount-set-changed'
        else:
            for key in keys:
                path=state/(key+'.snar')
                if not is_regular(path):reason='snapshot-missing';break
                base=work/(key+'.base');copy_private(path,base)
                # The copy is what tar reads, so the copy is what must match the parent package.
                if file_sha256(base)!=inc['parentSnapshots'][key]:reason='snapshot-mismatch';break
        if reason:
            for base in work.glob('*.base'):base.unlink()
            warn('This backup is a full backup instead of an increment: %s.'%FALLBACK_TEXT[reason])
    level=0 if inc['mode']=='full' or reason else 1
    if level:chain={'id':inc['chainId'],'position':inc['position'],'parentBackupId':inc['parentBackupId'],'parentSha256':inc['parentSha256']}
    else:chain={'id':inc['fallbackChainId'] if reason else inc['chainId'],'position':0,'parentBackupId':None,'parentSha256':None}
    return {'level':level,'chain':chain,'reason':reason,'work':work,'keys':keys,'siteKey':inc['siteKey'],'exclusions':excluded,'renames':{},'parentImageIds':set(inc['parentImageIds']) if level else set()}
def reset_snapshot(state,key):
    """Before every tar run (a direct capture runs each tar twice): the working copy starts from the parent snapshot,
    or does not exist for a level-0 archive, so both runs make the same archive."""
    work=state['work']/(key+'.snar');work.unlink(missing_ok=True)
    if state['level']:copy_private(state['work']/(key+'.base'),work)
    return work
def snapshot_records(state):
    """Snapshot files after this capture: key -> sha256. tar must have written every one of them."""
    result={}
    for key in state['keys']:
        path=state['work']/(key+'.snar')
        if not is_regular(path):raise ValueError('tar did not write the snapshot file of a mount')
        result[key]=file_sha256(path)
    return result
def annotate_mounts(containers,sources,state,snapshots):
    return [{**c,'Mounts':[{**m,'incremental':{'snapshotKey':sources[m['Source']],'level':state['level'],'snapshotSha256':snapshots[sources[m['Source']]],'renames':bool(state['renames'].get(sources[m['Source']]))}} if m['Source'] in sources and not (m['Type']=='bind' and protected_mount(m['Source'])) else m for m in c['Mounts']]} for c in containers]
def manifest_snapshots(manifest):
    """snapshot key -> {archive, level, sha256} from a v2 manifest; the first archive of a shared source holds the data."""
    result={}
    for i,c in enumerate(manifest.get('containers') or []):
        for j,m in enumerate(c.get('Mounts') or []):
            info=m.get('incremental') if isinstance(m,dict) else None
            if info is None:continue
            if not isinstance(info,dict) or not isinstance(info.get('snapshotKey'),str) or not HEX64.fullmatch(info['snapshotKey']) or info.get('level') not in (0,1) or isinstance(info.get('level'),bool) or not isinstance(info.get('snapshotSha256'),str) or not HEX64.fullmatch(info['snapshotSha256']):raise ValueError('Invalid incremental mount record')
            key=info['snapshotKey']
            if key in result:
                if (result[key]['level'],result[key]['sha256'])!=(info['level'],info['snapshotSha256']):raise ValueError('Invalid incremental mount record')
                continue
            result[key]={'archive':'mount-%d-%d.tar'%(i,j),'level':info['level'],'sha256':info['snapshotSha256']}
    return result
def site_lock(site):
    """Serialises capture planning, commit and discard for one site's snapshot files (no-op without fcntl)."""
    try:import fcntl
    except ImportError:return None
    site_state(site);incremental_root()
    handle=open(INCREMENTAL_ROOT/('.lock-'+site),'a')
    fcntl.flock(handle,fcntl.LOCK_EX)
    return handle
def incremental_commit(req):
    """Move a stored job's snapshot copies into the site state. Called only after the package is stored,
    authenticated and published. Idempotent; an older job never replaces a newer committed one."""
    job=req.get('job')
    if not isinstance(job,str) or not JOB_DIRECTORY.fullmatch(job):raise ValueError('Invalid job')
    site=req.get('siteKey')
    if not isinstance(site,str) or not SITE_KEY.fullmatch(site):raise ValueError('Invalid incremental site key')
    root=staging_base(req.get('config') or {})/str(job)
    work=root/'incremental';ready=work/'ready.json'
    if root.is_symlink() or work.is_symlink() or not is_regular(ready):raise ValueError('This job has no snapshot files to commit')
    record=json.loads(ready.read_text())
    if record.get('siteKey')!=site:raise ValueError('This job belongs to another site')
    snapshots=record.get('snapshots') or {}
    lock=site_lock(site)
    try:
        state=site_state(site,create=True);marker=state/'state.json'
        current=json.loads(marker.read_text()) if is_regular(marker) else {}
        if current.get('job')==str(job):
            if all(is_regular(state/(key+'.snar')) and file_sha256(state/(key+'.snar'))==sha for key,sha in snapshots.items()):
                emit(result={'committed':True,'alreadyCommitted':True,'snapshots':len(snapshots)});return
        elif current.get('capturedAt') is not None and float(current['capturedAt'])>float(record.get('capturedAt') or 0):
            raise ValueError('A newer backup already committed its snapshot files')
        for key,sha in snapshots.items():
            if not HEX64.fullmatch(key):raise ValueError('Invalid snapshot key')
            source=work/(key+'.snar')
            if not is_regular(source) or file_sha256(source)!=sha:raise ValueError('A snapshot file of this job is missing or changed')
        for key in snapshots:
            temporary=state/('.%s.%s.tmp'%(key,uuid.uuid4().hex))
            try:
                copy_private(work/(key+'.snar'),temporary)
                if file_sha256(temporary)!=snapshots[key]:raise ValueError('A snapshot file changed while it was committed')
                os.replace(temporary,state/(key+'.snar'))
            finally:temporary.unlink(missing_ok=True)
        # The state holds exactly this job's sources: snapshots of removed mounts go.
        for path in state.glob('*.snar'):
            if path.name[:-5] not in snapshots:path.unlink()
        atomic_json(marker,{'job':str(job),'chainId':record.get('chainId'),'position':record.get('position'),'capturedAt':record.get('capturedAt'),'snapshots':snapshots,'exclusions':record.get('exclusions') or {}})
        sync_directory(state)
    finally:
        if lock:lock.close()
    emit(result={'committed':True,'alreadyCommitted':False,'snapshots':len(snapshots)})
def incremental_discard(req):
    """Forget a site's snapshot files (feature turned off, site moved or archived). The next backup is full."""
    site=req.get('siteKey')
    state=site_state(site)
    lock=site_lock(site)
    try:
        existed=state.exists()
        if existed:
            if not getattr(shutil.rmtree,'avoids_symlink_attacks',False) and os.name=='posix':raise ValueError('Safe directory removal is unavailable on this host')
            shutil.rmtree(state)
            if os.name=='posix':sync_directory(INCREMENTAL_ROOT)
    finally:
        # The lock file stays: removing it could let two processes lock different files for the same site.
        if lock:lock.close()
    emit(result={'discarded':True,'existed':existed})
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
# Decided explicitly rather than through is_global, whose IPv6 tables differ between Python releases.
NAT64=ipaddress.ip_network('64:ff9b::/96')
REFUSED_IPV6=[ipaddress.ip_network(n) for n in ['::/96','64:ff9b:1::/48','2001::/32','2001:db8::/32','100::/64']]
def embedded_ipv4(address):
    """IPv4 carried inside a 6to4 or NAT64 address; the probe would effectively reach it."""
    if address.version!=6:return None
    return address.sixtofour or (ipaddress.IPv4Address(int(address)&0xffffffff) if address in NAT64 else None)
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
            embedded=embedded_ipv4(address)
            if address.version==6 and any(address in network for network in REFUSED_IPV6):raise ProbePolicyError('the URL resolves to a link-local, cloud metadata or reserved address')
            if embedded is not None:
                # Only a public IPv4 may be reached through 6to4 or NAT64; loopback and private never apply.
                if embedded in METADATA_ADDRESSES or not embedded.is_global or embedded in THIS_NETWORK:raise ProbePolicyError('the URL resolves to a link-local, cloud metadata or reserved address')
                if str(address) not in chosen:chosen.append(str(address))
                continue
            if address in METADATA_ADDRESSES or address.is_link_local or address.is_multicast or address.is_unspecified or address.is_reserved or getattr(address,'is_site_local',False) or (address.version==4 and address in THIS_NETWORK):raise ProbePolicyError('the URL resolves to a link-local, cloud metadata or reserved address')
            if not address.is_global and not (configured and local_address(address)):raise ProbePolicyError('the URL resolves to a private address that does not belong to this server; use the site domain, a loopback port or a public address')
        if str(address) not in chosen:chosen.append(str(address))
    if not chosen:raise ValueError('Probe host could not be resolved from the source server')
    return chosen
def fetch(url,timeout,domains=(),redirects=5):
    """GET with every hop resolved, validated and pinned. Redirects are followed only to the same
    host or to another configured site domain, keeping the scheme (or upgrading HTTP to HTTPS) and the
    port (or moving to the default port on an upgrade or for a configured domain); otherwise the redirect
    response itself is returned. Only the stored URL can raise ProbePolicyError: a refused redirect target
    returns the redirect, which callers treat as a failed probe, so a site cannot turn its own probe into
    a policy skip. timeout is a total budget for the whole probe: every connect attempt, redirect and body read."""
    allowed={str(d).lower().rstrip('.') for d in domains or ()};origin=None;previous=None;deadline=time.monotonic()+timeout
    for _ in range(redirects+1):
        parsed=urllib.parse.urlsplit(url)
        try:
            if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password:raise ProbePolicyError('use an HTTP(S) URL without login details')
            host=parsed.hostname.lower().rstrip('.');origin=origin or host
            port=parsed.port or (443 if parsed.scheme=='https' else 80)
            if previous:
                scheme,last_port=previous;upgrade=scheme=='http' and parsed.scheme=='https';default=port==(443 if parsed.scheme=='https' else 80)
                if host!=origin and host not in allowed:return status,body
                if parsed.scheme!=scheme and not upgrade:return status,body
                if not ((parsed.scheme==scheme and port==last_port) or (default and (upgrade or host in allowed))):return status,body
            addresses=probe_addresses(host,port,domains)
        except ProbePolicyError:
            if previous is None:raise
            return status,body
        except ValueError:
            if previous is None:raise
            return status,body
        previous=(parsed.scheme,port)
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
    # Same rule as src/probe-url.js: the public probe runs only when maintenance is explicitly required.
    if m.get('required') is True and not m.get('probeOrigin'):targets.append(('public',m.get('publicUrl')))
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
class MaintenanceOptional(ValueError):pass
MAINTENANCE_NOT_SET_UP='The maintenance page is not set up for this site, so visitors may see an error for the few seconds its containers are stopped.'
def maintenance(cfg,enabled):
    m=cfg.get('maintenance',{})
    if not m.get('required'):return
    directory=pathlib.Path(m['directory'])
    if not directory.is_absolute() or '..' in directory.parts:raise ValueError('Invalid maintenance directory')
    # The maintenance page is optional: without the proxy integration a backup still runs, visitors just see the
    # origin's own error while containers are stopped. There is then nothing to switch on or off.
    if not (directory/'ready').is_file():
        if enabled:warn(MAINTENANCE_NOT_SET_UP)
        return
    problem=maintenance_directory_problem(cfg,directory)
    # Leaving maintenance is never blocked, so a site can always return to service.
    if enabled and maintenance_link_escape(directory):raise ValueError(problem+'. The maintenance directory links into a system folder.')
    if problem:warn(problem+'; kept because the maintenance proxy is already integrated there')
    def enable_flag():
        # The proxy may share this directory; never follow a planted link as root.
        flag=directory/'enabled'
        if flag.is_symlink():raise ValueError('Maintenance flag cannot be a symbolic link')
        # O_NONBLOCK: a planted FIFO must fail at once instead of blocking the helper.
        try:fd=os.open(flag,os.O_WRONLY|os.O_CREAT|NOFOLLOW|getattr(os,'O_NONBLOCK',0),0o600)
        except OSError:raise ValueError('Maintenance flag must be a regular file')
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('Maintenance flag must be a regular file')
            if m.get('readableFlag'):
                if hasattr(os,'fchmod'):os.fchmod(fd,0o644)
                else:os.chmod(flag,0o644)
        finally:os.close(fd)
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

# A RAM folder is empty after every container restart, so restore recreates it empty with its original options.
TMPFS_OPTION=r'(?:size=\d+[kKmMgG%]?|mode=0?[0-7]{3,4}|uid=\d+|gid=\d+|nr_inodes=\d+[kKmMgG]?|nr_blocks=\d+[kKmMgG]?|ro|rw|nosuid|suid|nodev|dev|noexec|exec|noatime|atime|relatime|norelatime|strictatime|nodiratime|diratime|huge=(?:never|always|within_size|advise))'
def temporary_mounts(c):
    result=[]
    for destination,options in (c.get('HostConfig',{}).get('Tmpfs') or {}).items():
        name=c.get('Name','').lstrip('/') or c.get('Id','')
        if not re.fullmatch(r'/[A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*',destination) or '..' in destination.split('/'):raise ValueError('Container '+name+' has a RAM folder at an unusual path ('+destination+'). DockNest cannot recreate it safely.')
        options=options or ''
        if options and not re.fullmatch(TMPFS_OPTION+'(?:,'+TMPFS_OPTION+')*',options):raise ValueError('Container '+name+' RAM folder '+destination+' uses options DockNest does not recognize ('+options+'). Remove or simplify them in the Compose file.')
        result.append((destination,options))
    return result
def tmpfs_argument(destination,options):return destination+':'+options if options else destination

def static_preflight(cfg):
    if cfg.get('unresolvedDependencies'):raise ValueError('Resolve required external dependencies before capture')
    refuse_protected_sources(cfg)
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
            # A restore strips setuid and setgid from files (strip_privileges), so the digest leaves those bits out.
            mode=stat.S_IMODE(s.st_mode)&~(PRIVILEGE_BITS if stat.S_ISREG(s.st_mode) else 0)
            record=[relative,mode,s.st_uid,s.st_gid,'directory' if p.is_dir() else 'file']
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
    revalidate_sources(plan);manifest['backupPlan']=v1_plan(plan);manifest['artifacts']=artifact_inventory(root)
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
        manifest={'formatVersion':1,'kind':'static','complete':True,'deliveryMode':'direct','capturedAt':time.time(),'architecture':'portable-static','containers':[],'originalImages':[],'snapshotImages':[],'documentRoot':str(source),'staticFiles':before,'configurationFiles':cfg.get('configFiles',[]),'downtimeSeconds':0,'containerDowntimeSeconds':0,'visitorDowntimeSeconds':0,'restoreTested':False,'backupPlan':v1_plan(plan),'artifacts':inventory,'consistency':{'status':'passed','method':'stable source tree and streamed artifact digests','scope':'static files'}}
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
        temporary_mounts(c)
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
            # A protected mount is not copied (an empty placeholder takes its place), so its contents are not walked.
            if os.path.isdir(src) and not (m['Type']=='bind' and protected_mount(src)):
                for current,dirs,files in os.walk(src,followlinks=False):
                    dirs[:]=[name for name in dirs if not excluded_path(os.path.join(current,name),exclusions.get(src,[]))]
                    for filename in dirs+files:
                        p=os.path.join(current,filename)
                        if excluded_path(p,exclusions.get(src,[])):continue
                        if os.path.islink(p) and os.path.commonpath([os.path.realpath(src),os.path.realpath(p)])!=os.path.realpath(src):raise ValueError('Mount contains a symlink to uncaptured external data')
            # A protected mount is not copied, so another container sharing it does not make the copy inconsistent.
            if not (m['Type']=='bind' and protected_mount(src)):mounts.append(m)
    for c in inspect(others) if others else []:
        if c['Id'] in selected:continue
        for m in c['Mounts']:
            for ours in mounts:
                a,b=os.path.realpath(m['Source']),os.path.realpath(ours['Source'])
                if os.path.commonpath([a,b]) in [a,b]:raise ValueError('A running container outside the site shares a mount')
    refuse_protected_sources(cfg)
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
    selected={}
    check('Website files and configuration' if cfg.get('kind')=='static' else 'Containers and configuration files',lambda:selected.update(containers=preflight(cfg)))
    if cfg.get('kind')!='static':
        def contracts():
            backup_plan(cfg,preflight(cfg))
        check('Per-service database consistency contracts',contracts)
    def direct_health():
        try:healthy=health(cfg['containers'],cfg.get('healthUrl') or cfg.get('maintenance',{}).get('healthUrl'),cfg.get('domains',()))
        except ProbePolicyError as error:raise ValueError("Probe URL policy: %s. Update the site's health URL."%error)
        if not healthy:raise ValueError('Application health URL must return HTTP 200 from the source server. Check the URL and that all selected services are running.')
    if cfg.get('kind')!='static':
        protected=protected_mounts(selected.get('containers') or [])
        if protected:checks.append({'name':'Mounts that are not copied','ok':False,'required':False,'message':protected_mount_warning(protected)})
        try:keys,unscanned=protected_paths(selected.get('containers') or [],mount_exclusions(cfg,selected.get('containers') or []),READINESS_SCAN_ENTRIES)
        except ValueError:keys,unscanned=[],[]  # the configuration check above already names the problem
        if keys or unscanned:checks.append({'name':'Key folders that are not copied','ok':False,'required':False,'message':protected_path_warning(keys,unscanned)})
    check('Application health',direct_health)
    if cfg.get('kind')=='static':
        checks[-1]['required']=False
        if not checks[-1]['ok']:checks[-1]['message']='Public website access could not be verified from this server, possibly because of its CDN. Static files can still be captured and verified without changing hosting; check visitor access separately.'
    def proxy():
        m=cfg.get('maintenance',{})
        if not m.get('required'):raise ValueError('Enable maintenance protection before backing up a live site.')
        directory=pathlib.Path(m.get('directory',''))
        if not (directory/'ready').is_file() or not (directory/'maintenance.html').is_file():raise MaintenanceOptional(MAINTENANCE_NOT_SET_UP)
        if (directory/'enabled').exists():raise ValueError('Maintenance is currently enabled. Restore normal access before the readiness check.')
        try:status,body=public_probe(m,cfg.get('domains',()))
        except ProbePolicyError as error:raise ValueError("Probe URL policy: %s. Update the site's public maintenance URL."%error)
        if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('Website probe must return HTTP 200. If a CDN blocks server probes, choose the local origin probe after verifying the source proxy.')
    if cfg.get('kind')!='static':
        check('Maintenance proxy and website',proxy)
        if checks[-1]['message']==MAINTENANCE_NOT_SET_UP:checks[-1]['required']=False
    return {'ready':all(item['ok'] or item.get('required') is False for item in checks),'checks':checks,'readOnly':True,'maintenanceActivationTested':False}
def capture(req,output=None):
    if req['config'].get('kind')=='static':
        if output is not None:return capture_static_stream(req,output)
        return capture_static(req)
    inc=incremental_request(req)
    cfg=req['config'];skip_refused_probes(cfg);cs=preflight(cfg);plan=backup_plan(cfg,cs)
    if req.get('planFingerprint') and req['planFingerprint']!=plan['fingerprint']:raise ValueError('Backup plan changed; review configuration before capture')
    base=pathlib.Path(cfg.get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts:raise ValueError('Staging path must be absolute')
    if inc is not None and (within(lexical(base),lexical(INCREMENTAL_ROOT)) or within(lexical(INCREMENTAL_ROOT),lexical(base/req['job']))):raise ValueError('The staging folder cannot hold the incremental state folder')
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
    # .ssh and .gnupg entries inside copied bind mounts are left out (2.12.1). The ones found join the incremental
    # exclusion record, so a chain whose earlier archives still hold them restarts with a full backup.
    keys_left_out,_=protected_paths(cs,exclusions)
    increment=None;snapshot_sources={}
    if inc is not None:
        snapshot_sources=incremental_sources(cs)
        lock=site_lock(inc['siteKey'])
        recorded={source:list(paths) for source,paths in exclusions.items()}
        for item in keys_left_out:recorded.setdefault(item['source'],[]).append(item['path'])
        try:increment=plan_incremental(inc,snapshot_sources,root,recorded)
        finally:
            if lock:lock.close()
    # A source mounted twice is archived once; with snapshot files this keeps one snapshot per source.
    share=bool(exclusions) or increment is not None
    # Original images already stored earlier in the chain are not saved again; committed snapshots always are.
    saved_ids=[image for image in original_ids if image not in increment['parentImageIds']] if increment else original_ids
    # Shared sources are archived once; account for images/configs and packing.
    needed=capture_size(cs,cfg.get('composeFiles',[])+cfg.get('configFiles',[]),exclusions,original_images) if exclusions else sum(int(run(['du','-sb',m['Source']]).split()[0]) for c in cs for m in c['Mounts'] if not (m['Type']=='bind' and protected_mount(m['Source'])))+sum(c.get('SizeRw',0) or 0 for c in cs)
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
        archives={};specs=[];prepare={};scans={}
        for i,c in enumerate(cs):
            # commit captures the writable layer; mounted data is archived separately.
            image=docker('commit',c['Id']).decode().strip();images.append(image)
            if output is not None:atomic_json(root/'snapshot-images.json',images)
            for j,m in enumerate(c['Mounts']):
                source=m['Source'];target=root/('mount-%d-%d.tar'%(i,j));guard=guarded_mount(m)
                if m['Type']=='bind' and protected_mount(source):
                    # Never copied: the archive holds an empty folder or file of the same name instead.
                    holder=root/('protected-%d-%d'%(i,j))/(pathlib.PurePosixPath(source).name or 'root');holder.parent.mkdir(mode=0o700)
                    if os.path.isdir(source):holder.mkdir(mode=0o700)
                    else:holder.touch(mode=0o600)
                    source=str(holder)
                key=snapshot_sources.get(source) if increment else None
                snapshot=increment['work']/(key+'.snar') if key else None
                if output is not None:
                    link=archives.get(source) if share else None
                    specs.append((target.name,None if link else source_archive_command(source,exclusions.get(source,[]),snapshot,guard),link))
                    if key and not link:prepare[target.name]=lambda key=key:reset_snapshot(increment,key)
                    if key and not link and increment['level']:scans[target.name]=lambda found,key=key:increment['renames'].__setitem__(key,found)
                    archives[source]=link or target.name
                elif share and source in archives:os.link(archives[source],target)
                else:
                    if key:reset_snapshot(increment,key)
                    source_archive(source,target,exclusions.get(source,[]),snapshot,guard);archives[source]=target
                    if key and increment['level']:
                        with open(target,'rb') as written:increment['renames'][key]=archive_renames_safely(written)
        for i,filename in enumerate(cfg.get('composeFiles',[])+cfg.get('configFiles',[])):
            source=pathlib.Path(filename)
            if output is not None:specs.append(('config-%d.tar'%i,source_archive_command(source),None))
            else:run(['tar','--xattrs','--acls','--numeric-owner','-cpf',str(root/('config-%d.tar'%i)),'-C',str(source.parent),'--',source.name])
        if output is not None:
            level=int(cfg.get('streamCompressLevel',1))
            if level<1 or level>9:raise ValueError('Stream compression level must be 1..9')
            # Direct capture compresses while services are stopped; favour speed.
            archive=open_stream_archive(output,level)
            inventory=stream_artifacts(archive,[('images.tar',['docker','save',*saved_ids,*images],None),*specs],root,{'images.tar'},prepare,scans)
            revalidate_sources(plan)
        captured=time.time()
    except BaseException:
        # Abandon buffered payload bytes on a failed stream. Recovery below is
        # independent of whether the destination can accept any more output.
        if archive is not None:archive.fileobj.closed=True;archive.closed=True
        raise
    finally:
        # Site move final copy: after a complete capture the source stays stopped behind its maintenance page.
        # Any failure (captured is None) restarts it exactly as an ordinary backup does.
        keep_stopped=bool(req.get('keepStopped')) and captured is not None
        if keep_stopped:
            complete_recovery(root);emit(stage='source_ready')
        else:emit(stage='restarting')
        if not keep_stopped:
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
    if output is None:docker('save','-o',str(root/'images.tar'),*saved_ids,*images)
    snapshots=snapshot_records(increment) if increment else {}
    if increment and output is None:
        for key in increment['keys']:copy_private(increment['work']/(key+'.snar'),root/('snapshot-%s.snar'%key))
    if increment and output is not None:
        for key in increment['keys']:inventory['snapshot-%s.snar'%key]=stream_file(archive,'snapshot-%s.snar'%key,increment['work']/(key+'.snar'),snapshots[key])
    manifest={'formatVersion':1,'capturedAt':captured,'downtimeSeconds':restarted-stopped_at,'containerDowntimeSeconds':restarted-stopped_at,'visitorDowntimeSeconds':restarted-visitor_start,'architecture':docker('info','--format','{{.Architecture}}').decode().strip(),'containers':cs,'snapshotImages':images,'originalImages':original_images,'shutdownEvidence':shutdown_proof,'configurationFiles':cfg.get('composeFiles',[])+cfg.get('configFiles',[]),'complete':True,'restoreTested':False}
    # Restore reads RAM folders from the container record; this list keeps backups restorable by older helpers.
    manifest['temporaryMemoryFolders']=[{'container':c.get('Name','').lstrip('/'),'destination':destination} for c in manifest['containers'] for destination,_ in temporary_mounts(c)]
    if PROBE_POLICY_FALLBACKS:manifest['probePolicyFallback']=sorted(set(PROBE_POLICY_FALLBACKS))
    manifest['backupPlan']=plan if increment else v1_plan(plan)
    if cfg.get('restoreReferences'):manifest['restoreReferences']=cfg['restoreReferences']
    if exclusions:
        manifest['backupScope']='application-and-local-state'
        manifest['excludedPaths']=cfg['mountExclusions']
    protected=protected_mounts(cs)
    if protected:manifest['protectedMounts']=protected
    if keys_left_out:manifest['protectedPaths']=keys_left_out
    manifest['artifacts']=inventory if output is not None else artifact_inventory(root)
    manifest['deliveryMode']='direct' if output is not None else 'staged'
    manifest['consistency']={'status':'declared' if any(s['engine']=='generic' for s in plan['services']) else 'passed','method':'offline native shutdown evidence plus declared writer quiescence','scope':'selected services and mounts','services':shutdown_proof}
    if increment:
        manifest['formatVersion']=2
        manifest['backupKind']='incremental' if increment['level'] else 'full'
        manifest['chain']=increment['chain']
        if plan.get('chainFingerprint'):manifest['chainFingerprint']=plan['chainFingerprint']
        manifest['containers']=annotate_mounts(cs,snapshot_sources,increment,snapshots)
        manifest['chainImages']=[image for image in original_ids if image not in saved_ids]
        manifest['snapshots']=snapshots
        # An increment whose archives carry directory renames ends the chain: the engine makes the next backup full.
        manifest['renamesSeen']=any(increment['renames'].values())
        if increment['reason']:manifest['fallback']={'reason':increment['reason']}
    (root/'manifest.json').write_text(json.dumps(manifest));os.chmod(root/'manifest.json',0o600)
    (root/'restore-guide.md').write_text(RESTORE_GUIDE)
    if exclusions:
        with (root/'restore-guide.md').open('a') as guide:
            guide.write('\n# Selected backup scope\nThis package intentionally excludes the paths listed in manifest.excludedPaths. Recover or reattach that external data separately after validating the isolated application copy. Never replace external storage contents with empty restored directories. Retention of this package does not protect excluded data.\n')
    if protected:
        with (root/'restore-guide.md').open('a') as guide:
            guide.write('\n# Mounts that were not copied\nThe bind mounts listed in manifest.protectedMounts hold passwords, sudo rules or SSH or GPG keys. DockNest never copies them; their archives hold an empty placeholder. Recover them separately and never restore the placeholder over the real files.\n')
    if keys_left_out:
        with (root/'restore-guide.md').open('a') as guide:
            guide.write('\n# Key folders that were not copied\nThe .ssh and .gnupg entries listed in manifest.protectedPaths sit inside copied bind mounts and hold SSH or GPG keys. DockNest never copies them; the restored mount has no such entry. Recover them separately and never delete the real folders when putting restored data back.\n')
    if increment:
        with (root/'restore-guide.md').open('a') as guide:guide.write(INCREMENTAL_GUIDE)
    if output is not None:
        stream_document(archive,'manifest.json',json.dumps(manifest))
        stream_document(archive,'restore-guide.md',(root/'restore-guide.md').read_text())
        archive.close();output.flush()
    else:run(['tar','-czf',str(root/'payload.tar.gz'),'-C',str(root),'images.tar','manifest.json','restore-guide.md',*[p.name for p in root.glob('mount-*.tar')],*[p.name for p in root.glob('config-*.tar')],*sorted(p.name for p in root.glob('snapshot-*.snar'))])
    for image in images:
        try:docker('image','rm',image)
        except Exception:pass
    # Only incremental-commit, after the package is stored and verified, moves these snapshot copies into the state.
    if increment:atomic_json(increment['work']/'ready.json',{'siteKey':increment['siteKey'],'chainId':increment['chain']['id'],'position':increment['chain']['position'],'capturedAt':captured,'snapshots':snapshots,'exclusions':increment['exclusions']})
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
    # A watchdog that is still waiting could act later, so it must have finished. A failed automatic recovery is
    # accepted here only because every live check below must pass before the site is unlocked.
    if not (root/'watchdog.done').exists() and not (root/'disarmed').exists():raise ValueError('Automatic recovery is still waiting on the server. Try again in a few minutes.')
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
    complete_recovery(root)
    emit(result={'recoveryReviewed':True,'healthVerified':True,'originalStatesPreserved':True,**({'probePolicyFallback':sorted(set(PROBE_POLICY_FALLBACKS))} if PROBE_POLICY_FALLBACKS else {})})

def verify_restore_recovery(req):
    job=req['job'];uuid.UUID(job)
    ids=docker('ps','-aq','--filter','label=docker-backup-manager.restore='+job).decode().split()
    if ids and any(c['State']['Running'] for c in inspect(ids)):raise ValueError('Stop the interrupted isolated restore containers on the target before acknowledging recovery')
    emit(result={'recoveryReviewed':True,'targetContainersStopped':True,'stagingRetained':True})
EXTRACT_RESERVE_BYTES=64*1024**2
def archive_link_escapes(start,linkname,symlinks):
    """Follow a relative link through the archive's own symlinks, as the kernel will after extraction."""
    stack=list(start);pending=list(pathlib.PurePosixPath(linkname).parts);expansions=0
    while pending:
        part=pending.pop(0)
        if part=='.':continue
        if part=='..':
            if not stack:return True
            stack.pop();continue
        stack.append(part)
        target=symlinks.get(tuple(stack))
        if target is not None:
            expansions+=1
            # Absolute targets and link loops cannot be proven to stay inside the destination.
            if expansions>40 or target.startswith('/'):return True
            stack.pop();pending=list(pathlib.PurePosixPath(target).parts)+pending
    return False
PRIVILEGE_BITS=stat.S_ISUID|stat.S_ISGID
def strip_privileges(root):
    """Restored files never keep setuid or setgid bits or file capabilities (2.12.1). A backup archive comes from a
    managed server, and a restored mount can end up on a path other users reach (a move places it at the site's own
    path), so a planted setuid-root binary must not become one. There is no opt-out: images restore their own binaries
    through Docker, and data folders do not need privileged executables. Directories keep setgid (group inheritance
    for shared folders, no privilege) and the sticky bit (it only restricts deletion). Fails closed: any file that
    cannot be checked or changed stops the restore."""
    if os.name!='posix':return 0
    changed=0
    def refuse(error):raise ValueError('Restored files could not be checked for setuid bits: %s'%error)
    for current,dirs,files in os.walk(root,followlinks=False,onerror=refuse):
        for name in files:
            path=os.path.join(current,name)
            mode=os.lstat(path).st_mode
            if not stat.S_ISREG(mode):continue
            # Never follows a link: l*xattr calls, and the mode is changed through a descriptor opened with O_NOFOLLOW.
            # Read first: removing security.capability needs CAP_SETFCAP even when the file has none.
            try:capability=os.getxattr(path,'security.capability',follow_symlinks=False)
            except OSError as error:
                if error.errno not in (errno.ENODATA,errno.ENOTSUP,errno.EOPNOTSUPP):raise
                capability=None
            if capability is not None:os.removexattr(path,'security.capability',follow_symlinks=False);changed+=1
            if not mode&PRIVILEGE_BITS:continue
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|getattr(os,'O_CLOEXEC',0))
            try:
                mode=os.fstat(fd).st_mode
                if stat.S_ISREG(mode) and mode&PRIVILEGE_BITS:os.fchmod(fd,stat.S_IMODE(mode)&~PRIVILEGE_BITS);changed+=1
            finally:os.close(fd)
    return changed
def safe_extract(archive,destination):
    if destination.is_symlink():raise ValueError('Restore destination cannot be a symlink')
    destination.mkdir(parents=True,exist_ok=True,mode=0o700)
    if any(destination.iterdir()):raise ValueError('Restore destination must be empty')
    root=destination.resolve()
    with tarfile.open(archive,'r:*') as tar:
        members=tar.getmembers()
        links={pathlib.PurePosixPath(m.name).parts:m.linkname for m in members if m.issym()}
        symlinks={pathlib.PurePosixPath(*parts) for parts in links}
        regular={pathlib.PurePosixPath(m.name) for m in members if m.isfile()}
        # Bound extraction by the archive's declared sizes before writing anything; a highly
        # compressible package must not fill the target filesystem part-way through.
        if shutil.disk_usage(destination).free<sum(m.size for m in members if m.isfile())+EXTRACT_RESERVE_BYTES:raise ValueError('Insufficient target capacity to extract the archive')
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
                # A chain of individually contained links (d -> ../.., l -> d/../..) can still leave the destination.
                if member.issym() and archive_link_escapes(p.parent.parts,member.linkname,links):raise ValueError('Archive link escapes destination')
                if member.islnk() and (link not in regular or any(parent in symlinks for parent in link.parents)):raise ValueError('Hard link must target an archived regular file')
        if os.name=='posix':
            run(['tar','--xattrs','--acls','--numeric-owner','-xpf',str(archive),'-C',str(destination)])
        else:tar.extractall(destination,filter='fully_trusted')
    strip_privileges(destination)
def prepare_restore(req):
    root=owned_job_root(req);chain=chain_paths(req,root)
    if root.exists():raise ValueError('Restore staging already exists')
    root.mkdir(parents=True,mode=0o700)
    emit(result={'root':str(root),'remotePath':str(root/'payload.tar.gz'),**chain})
def chain_length(req):
    n=req.get('chainLength')
    if n is None:return None
    if not isinstance(n,int) or isinstance(n,bool) or not 1<=n<=MAX_CHAIN:raise ValueError('A backup chain holds 1 to %d packages'%MAX_CHAIN)
    return n
def chain_paths(req,root):
    """Remote paths for a chain restore: payload-0.tar.gz (the full backup) up to payload-<n-1>.tar.gz."""
    n=chain_length(req)
    return {} if n is None else {'remotePaths':[str(root/('payload-%d.tar.gz'%k)) for k in range(n)]}
def restore_network_plan(containers):
    if not 1<=len(containers)<=30:raise ValueError('Restore requires 1 to 30 containers')
    plans=[]
    for c in containers:
        hc=c['HostConfig'];mode=hc.get('NetworkMode','')
        if hc.get('Privileged') or hc.get('Devices') or hc.get('CapAdd') or hc.get('PidMode')=='host' or hc.get('IpcMode')=='host' or mode=='host' or mode.startswith('container:'):raise ValueError('Host privileges or shared namespace networking cannot be restored automatically')
        networks={}
        for name,n in c.get('NetworkSettings',{}).get('Networks',{}).items():
            if name=='none':continue
            # A network key names the network a copy joins: host or another container's namespace is refused here too.
            if name=='host' or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*',str(name)):raise ValueError('Host privileges or shared namespace networking cannot be restored automatically')
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

def unpack_verified(req,root):
    """Shared by isolated restore, restore tests and the move deploy: check the transfer, unpack and verify every artifact."""
    if req.get('chain') is not None:return unpack_chain(req,root)
    payload=root/'payload.tar.gz'
    digest=__import__('hashlib').sha256()
    with open(payload,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
    if digest.hexdigest()!=req['plaintextChecksum']:raise ValueError('Restore transfer checksum mismatch')
    unpacked=root/'unpacked';safe_extract(payload,unpacked)
    manifest=json.loads((unpacked/'manifest.json').read_text())
    if manifest.get('formatVersion') not in FORMAT_VERSIONS or not manifest.get('complete'):raise ValueError('Unsupported or incomplete backup')
    # A v2 full package stands alone; an increment needs its whole chain.
    if manifest['formatVersion']==2 and (manifest.get('backupKind')!='full' or (manifest.get('chain') or {}).get('position')!=0):raise ValueError('This backup is incremental; restore it together with its chain.')
    return unpacked,manifest,verify_artifacts(unpacked,manifest)

# ---- Chain restore ----
# Every package's transfer checksum and every manifest link are checked before any archive is extracted. Each mount is
# then rebuilt in one fresh directory: the full archive, then each increment in order with --listed-incremental=/dev/null
# (which applies deletions and renames), after the same path checks as safe_extract plus the GNU.dumpdir names.
CHAIN_LINKS={}
MAX_MANIFEST_BYTES=64*1024*1024
def chain_request(value):
    if not isinstance(value,list) or not 1<=len(value)<=MAX_CHAIN:raise ValueError('A backup chain holds 1 to %d packages'%MAX_CHAIN)
    for link in value:
        if not isinstance(link,dict) or not isinstance(link.get('plaintextChecksum'),str) or not HEX64.fullmatch(link['plaintextChecksum']) or not isinstance(link.get('backupId'),str) or not CHAIN_ID.fullmatch(link['backupId']) or not isinstance(link.get('sha256'),str) or not HEX64.fullmatch(link['sha256']):raise ValueError('Invalid backup chain request')
    if len({link['backupId'] for link in value})!=len(value):raise ValueError('Invalid backup chain request')
    return value
def payload_manifest(payload):
    """The manifest of a plaintext package, read without extracting anything to disk."""
    found=None
    with tarfile.open(payload,'r:gz') as tar:
        for member in tar:
            if member.name!='manifest.json':continue
            if found is not None or not member.isfile() or member.size>MAX_MANIFEST_BYTES:raise ValueError('Invalid backup manifest')
            found=json.loads(tar.extractfile(member).read())
    if not isinstance(found,dict):raise ValueError('Backup has no manifest')
    return found
def broken_link(chain,k):
    return 'This backup depends on backup %s, which is missing or damaged. Restore %s\'s chain from an earlier point, or pick a full backup.'%(chain[k]['backupId'],chain[k]['backupId'])
def chain_problem(manifests,chain):
    """None when manifests[0..n-1] form one verified chain in order, else the reason."""
    first=manifests[0]
    if first.get('formatVersion') not in FORMAT_VERSIONS:return 'Unsupported or incomplete backup'
    if first.get('formatVersion')!=2 or first.get('backupKind')!='full':return 'The first backup of the chain is not a full backup.'
    chain_id=(first.get('chain') or {}).get('id')
    try:keys=manifest_snapshots(first)
    except ValueError:return broken_link(chain,0)
    for k,manifest in enumerate(manifests):
        record=manifest.get('chain')
        if manifest.get('formatVersion')!=2 or not manifest.get('complete'):return 'Unsupported or incomplete backup'
        if not isinstance(record,dict) or not isinstance(chain_id,str) or record.get('id')!=chain_id or record.get('position')!=k or isinstance(record.get('position'),bool):return broken_link(chain,max(k-1,0))
        if manifest.get('backupKind')!=('full' if k==0 else 'incremental'):return broken_link(chain,max(k-1,0))
        if k==0 and (record.get('parentBackupId') is not None or record.get('parentSha256') is not None):return broken_link(chain,0)
        if k>0 and (record.get('parentBackupId')!=chain[k-1]['backupId'] or record.get('parentSha256')!=chain[k-1]['sha256']):return broken_link(chain,k-1)
        try:snapshots=manifest_snapshots(manifest)
        except ValueError:return broken_link(chain,k)
        # Same sources in every link; the full is level 0 and every increment level 1.
        if set(snapshots)!=set(keys) or any(item['level']!=(0 if k==0 else 1) for item in snapshots.values()):return broken_link(chain,max(k-1,0))
    return None
def unpack_chain(req,root,payloads=None):
    chain=chain_request(req.get('chain'))
    if req.get('plaintextChecksum') is not None and req['plaintextChecksum']!=chain[-1]['plaintextChecksum']:raise ValueError('Restore transfer checksum mismatch')
    payloads=payloads or [root/('payload-%d.tar.gz'%k) for k in range(len(chain))]
    for k,payload in enumerate(payloads):
        if not is_regular(payload) or file_sha256(payload)!=chain[k]['plaintextChecksum']:
            raise ValueError('Restore transfer checksum mismatch' if k==len(chain)-1 else broken_link(chain,k))
    manifests=[]
    for k,payload in enumerate(payloads):
        try:manifests.append(payload_manifest(payload))
        except (tarfile.TarError,ValueError,OSError,EOFError):raise ValueError('Restore transfer checksum mismatch' if k==len(chain)-1 else broken_link(chain,k))
    problem=chain_problem(manifests,chain)
    if problem:raise ValueError(problem)
    directories=[]
    for k,payload in enumerate(payloads):
        directory=root/('unpacked' if k==len(chain)-1 else 'chain-%d'%k);safe_extract(payload,directory)
        if json.loads((directory/'manifest.json').read_text())!=manifests[k]:raise ValueError('Backup package changed during restore')
        if not verify_artifacts(directory,manifests[k]):raise ValueError('Backup artifacts are missing, changed or unexpected')
        directories.append(directory)
    CHAIN_LINKS[str(directories[-1])]={'directories':directories,'manifests':manifests,'snapshots':[manifest_snapshots(m) for m in manifests]}
    return directories[-1],manifests[-1],True
def mount_archive(unpacked,i,j):
    """The archive (v1 and full packages) or the ordered archive list (a chain) that rebuilds mount j of container i."""
    name='mount-%d-%d.tar'%(i,j);chain=CHAIN_LINKS.get(str(unpacked))
    if not chain:return unpacked/name
    info=chain['manifests'][-1]['containers'][i]['Mounts'][j].get('incremental')
    if not info:return unpacked/name  # protected placeholder: always complete
    return [directory/snapshots[info['snapshotKey']]['archive'] for directory,snapshots in zip(chain['directories'],chain['snapshots'])]
def mount_bytes(unpacked):
    chain=CHAIN_LINKS.get(str(unpacked))
    return sum(p.stat().st_size for directory in (chain['directories'] if chain else [unpacked]) for p in directory.glob('mount-*.tar'))
def image_archives(unpacked):
    """Every images.tar to load, in chain order (one for a single package)."""
    chain=CHAIN_LINKS.get(str(unpacked))
    return [directory/'images.tar' for directory in chain['directories']] if chain else [unpacked/'images.tar']
def extract_archives(archive,destination):
    if isinstance(archive,list):return chain_extract(archive,destination)
    return safe_extract(archive,destination)
class MountLayoutError(ValueError):
    """A mount layout a restore cannot rebuild: 'overlap' (one mount source inside another) or 'entries' (an archive
    without exactly one top-level entry)."""
    def __init__(self,kind):
        super().__init__('Overlapping mount paths require offline restore' if kind=='overlap' else 'Mount archive must have exactly one source entry');self.kind=kind
def extract_mount(unpacked,i,j,m,sources,root):
    """Mount j of container i, extracted once per (type, source) into root/data-I-J (a chain: full backup, then each
    increment). `sources` maps (type, source) to the folder already made. Returns the source folder for the mount.
    Extraction refusals raise ValueError; layout problems raise MountLayoutError."""
    key=(m.get('Type'),m.get('Source'))
    if key not in sources:
        for _,existing in sources:
            a,b=os.path.normpath(existing),os.path.normpath(m['Source'])
            if os.path.commonpath([a,b]) in [a,b]:raise MountLayoutError('overlap')
        directory=root/('data-%d-%d'%(i,j))
        extract_archives(mount_archive(unpacked,i,j),directory)
        entries=list(directory.iterdir())
        if len(entries)!=1:raise MountLayoutError('entries')
        sources[key]=entries[0]
    return sources[key]
CHAIN_PACKAGE_NAME=re.compile(r'[0-9]{2}-[A-Za-z0-9-]{1,64}\.tar\.gz')
def restore_chain_offline(folder,output):
    """Recovery kit, without DockNest (docs/incremental-backups.md): rebuild the files of an incremental chain from the
    packages `node decrypt-backup.js --chain` wrote and its CHAIN.json, with the same link, artifact and path checks as a
    DockNest restore. Writes data-I-J (one folder per mount source, as a restore does) and prints where each mount, each
    images.tar (load them in this order) and each configuration archive is. Nothing is started; no Docker command runs."""
    if os.name!='posix':raise ValueError('Restoring an incremental backup needs GNU tar on Linux')
    folder=pathlib.Path(folder).resolve();output=pathlib.Path(output)
    listing=json.loads((folder/'CHAIN.json').read_text())
    packages=listing.get('packages') if isinstance(listing,dict) else None
    if not isinstance(packages,list) or not 1<=len(packages)<=MAX_CHAIN:raise ValueError('CHAIN.json lists no packages')
    payloads=[];chain=[]
    for item in packages:
        name=item.get('file') if isinstance(item,dict) else None
        if not isinstance(name,str) or not CHAIN_PACKAGE_NAME.fullmatch(name):raise ValueError('CHAIN.json has an invalid entry; it was not written by decrypt-backup.js')
        payload=folder/name
        if not is_regular(payload):raise ValueError('A package listed in CHAIN.json is missing: '+name)
        payloads.append(payload);chain.append({'backupId':item.get('backupId'),'sha256':item.get('sha256'),'plaintextChecksum':file_sha256(payload)})
    if output.is_symlink():raise ValueError('The output folder cannot be a symlink')
    if output.exists() and any(output.iterdir()):raise ValueError('The output folder must be new or empty')
    created=not output.exists()
    output.mkdir(parents=True,exist_ok=True,mode=0o700)
    try:
        unpacked,manifest,_=unpack_chain({'chain':chain},output/'packages',payloads)
        if shutil.disk_usage(output).free<mount_bytes(unpacked)+1024**3:raise ValueError('Insufficient target capacity for extracted data')
        mounts=[];sources={}
        for i,c in enumerate(manifest.get('containers') or []):
            for j,m in enumerate(c.get('Mounts') or []):
                source=extract_mount(unpacked,i,j,m,sources,output)
                mounts.append({'container':c.get('Name'),'type':m.get('Type'),'destination':m.get('Destination'),'path':str(source)})
    except BaseException:
        # A refusal leaves nothing behind: everything under the output folder was written by this step (it was empty).
        # rmtree never follows the restored symlinks.
        for entry in list(output.iterdir()):
            if entry.is_dir() and not entry.is_symlink():shutil.rmtree(entry,ignore_errors=True)
            else:entry.unlink(missing_ok=True)
        if created:
            try:output.rmdir()
            except OSError:pass
        raise
    emit(result={'chainId':(manifest.get('chain') or {}).get('id'),'packages':len(payloads),'mounts':mounts,'images':[str(p) for p in image_archives(unpacked)],'configurationArchives':[str(unpacked/('config-%d.tar'%i)) for i,_ in enumerate(manifest.get('configurationFiles') or [])],'manifest':str(unpacked/'manifest.json')})
DUMPDIR_CODES='YNDRTX'
def dumpdir_problem(value,top):
    """GNU.dumpdir lists a directory's entries (Y, N, D: one name each) and directory renames (R, T, X: paths from the
    archive root). In a rename cycle GNU tar writes R or T with an empty name (the temporary X folder stands in).
    Every non-empty name must stay inside the archive's one top-level entry."""
    if not isinstance(value,str):return True
    entries=value.split('\0')
    while entries and entries[-1]=='':entries.pop()
    for entry in entries:
        if not entry or entry[0] not in DUMPDIR_CODES:return True
        name=entry[1:]
        if not name:
            if entry[0] in 'RT':continue
            return True
        if entry[0] in 'YND':
            if '/' in name or name in ('.','..'):return True
        else:
            p=pathlib.PurePosixPath(name)
            if not p.parts or p.is_absolute() or '..' in p.parts or str(p)!=name or p.parts[0]!=top:return True
    return False
RENAME_TEMPORARY=('\0rename',)
def dumpdir_renames(value):
    """(source, target) directory renames of one GNU.dumpdir record, in order; '' is the cycle's temporary folder."""
    result=[];source=None
    for entry in [e for e in value.split('\0') if e]:
        if entry[0]=='R':
            if source is not None:raise ValueError('Unsafe directory listing in incremental archive (unpaired rename)')
            source=entry[1:]
        elif entry[0]=='T':
            if source is None:raise ValueError('Unsafe directory listing in incremental archive (unpaired rename)')
            result.append((source,entry[1:]));source=None
    if source is not None:raise ValueError('Unsafe directory listing in incremental archive (unpaired rename)')
    return result
def rename_links(links,renames):
    """Where GNU tar's directory renames move the symlinks an earlier link restored."""
    for source,target in renames:
        old=tuple(pathlib.PurePosixPath(source).parts) if source else RENAME_TEMPORARY
        new=tuple(pathlib.PurePosixPath(target).parts) if target else RENAME_TEMPORARY
        links={(new+key[len(old):] if key[:len(old)]==old else key):value for key,value in links.items()}
    return links
def disk_symlinks(root):
    links={}
    for current,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            path=os.path.join(current,name)
            if os.path.islink(path):links[pathlib.PurePosixPath(*pathlib.Path(os.path.relpath(path,root)).parts).parts]=os.readlink(path)
    return links
def incremental_archive_check(archive,root,top=None,replace=None):
    """safe_extract's checks for one archive of a chain, against what the earlier archives already put on disk.
    Returns the archive's top-level name. `replace` collects the restored symlinks this archive turns into folders
    (removed before tar runs). Refusals name the rule that refused, never a path."""
    with tarfile.open(archive,'r:') as tar,open(archive,'rb') as raw:
        members=tar.getmembers()
        if not members:raise ValueError('Empty mount archive in the backup chain')
        # A pax global header would change how every later member is read; DockNest never writes one.
        if tar.pax_headers:raise ValueError('Incremental archive must not carry global tar headers')
        for member in members:
            # Only POSIX headers: GNU-format incremental headers reuse the ustar name prefix for atime/ctime.
            raw.seek(member.offset);header=raw.read(512)
            if header[257:263]!=b'ustar\x00':raise ValueError('Incremental archive must use the POSIX tar format')
        archived={pathlib.PurePosixPath(m.name) for m in members if m.issym()}
        if shutil.disk_usage(root).free<sum(m.size for m in members if m.isfile())+EXTRACT_RESERVE_BYTES:raise ValueError('Insufficient target capacity to extract the archive')
        # The symlink map follows GNU tar step by step, in archive order: a directory's dumpdir renames apply when tar
        # reaches that directory, then the member replaces or adds a path. Every member is checked against the map as
        # it stands at that point, and after every rename record each link must still resolve inside the destination.
        on_disk=disk_symlinks(root);links=dict(on_disk)
        # Every folder a rename in this archive names (source or target); a link at or below one may move during tar.
        renamed=set()
        for m in members:
            dumpdir=m.pax_headers.get('GNU.dumpdir')
            if not (m.isdir() and isinstance(dumpdir,str)):continue
            for entry in [e for e in dumpdir.split('\0') if e]:
                if entry[0] in 'RT' and entry[1:]:renamed.add(tuple(pathlib.PurePosixPath(entry[1:]).parts))
        has_renames=any(m.isdir() and isinstance(m.pax_headers.get('GNU.dumpdir'),str) and any(e[:1] in ('R','T') for e in m.pax_headers['GNU.dumpdir'].split('\0')) for m in members)
        def unsafe_listing(rule):raise ValueError('Unsafe directory listing in incremental archive (%s)'%rule)
        def all_inside():
            if any(RENAME_TEMPORARY[0] in key for key in links):unsafe_listing('rename cycle left a temporary folder')
            for key,value in links.items():
                if archive_link_escapes(key[:-1],value,links):raise ValueError('Archive link escapes destination')
        seen=set();regular=set()
        for member in members:
            p=pathlib.PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or not p.parts or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Unsafe archive member or link; use reviewed offline restore adapter')
            top=top or p.parts[0]
            if p.parts[0]!=top:raise ValueError('Mount archive must have exactly one source entry')
            if p in seen or any(parent in archived for parent in p.parents):raise ValueError('Duplicate archive path or write through archive symlink')
            seen.add(p)
            # Never through a link: one an earlier archive restored (wherever renames moved it) or one this archive made.
            if any(parent.parts in links for parent in p.parents):raise ValueError('Duplicate archive path or write through archive symlink')
            dumpdir=member.pax_headers.get('GNU.dumpdir')
            if dumpdir is not None:
                if not member.isdir():unsafe_listing('listing on a non-folder')
                if dumpdir_problem(dumpdir,top):unsafe_listing('entry outside the archive or unknown code')
                renames=dumpdir_renames(dumpdir)
                for source,target in renames:
                    for path in (source,target):
                        parts=tuple(pathlib.PurePosixPath(path).parts) if path else ()
                        # renameat follows a symlink in the path: a rename through or of a link is never modelled.
                        if any(parts[:k] in links for k in range(1,len(parts)+1)):unsafe_listing('rename through a symlink')
                    links=rename_links(links,[(source,target)])
                if renames:all_inside()
            target=(root/member.name).resolve()
            if os.path.commonpath([str(root),str(target)])!=str(root):raise ValueError('Archive path escapes destination')
            if member.isdir():
                # tar would follow a link it finds at a folder's path, so the link is removed before tar runs. That is
                # exact only for a link still where an earlier archive restored it, at a path no rename touches (a rename
                # of an unrelated folder in the same archive, as in a swap, does not move it).
                if p.parts in links:
                    if p.parts not in on_disk or links[p.parts]!=on_disk[p.parts] or any(p.parts[:len(r)]==r for r in renamed):unsafe_listing('folder replaces a moved symlink')
                    if replace is not None:replace.append(p)
                links.pop(p.parts,None)
            elif member.issym():
                link=pathlib.PurePosixPath(member.linkname)
                if link.is_absolute():raise ValueError('Absolute archive link is not portable')
                linked=(target.parent/member.linkname).resolve()
                if os.path.commonpath([str(root),str(linked)])!=str(root):raise ValueError('Archive link escapes destination')
                links[p.parts]=member.linkname
                if archive_link_escapes(p.parent.parts,member.linkname,links):raise ValueError('Archive link escapes destination')
            else:
                links.pop(p.parts,None)
                if member.islnk():
                    link=pathlib.PurePosixPath(member.linkname)
                    if link.is_absolute():raise ValueError('Absolute archive link is not portable')
                    linked=(root/member.linkname).resolve()
                    if os.path.commonpath([str(root),str(linked)])!=str(root):raise ValueError('Archive link escapes destination')
                    # A hard link targets a file this archive already wrote, or (without renames) one an earlier archive restored.
                    restored=not has_renames and link not in seen and is_regular(root/str(link)) and not any(parent.parts in on_disk for parent in link.parents)
                    if '..' in link.parts or not (link in regular or restored) or any(parent.parts in links for parent in link.parents) or any(parent in archived for parent in link.parents):raise ValueError('Hard link must target an archived regular file')
                else:regular.add(p)
        all_inside()
        return top
def replace_directory_links(folders,root):
    """A symlink an earlier link restored where this archive has a real folder: GNU tar would follow it (and purge the
    folder it points at), so the link itself is removed first. Only the links the check approved; never followed."""
    for folder in sorted(folders,key=lambda p:len(p.parts)):
        path=root/str(folder)
        if path.is_symlink():path.unlink()
REPEATED_RENAMES='This backup cannot be restored safely: two backups in a row of its chain repeat the same folder renames (repeated rename records). Restore an earlier point of the chain, or pick a full backup.'
def chain_rename_problem(archives):
    """Chains made before DockNest ended a chain after a rename: GNU tar repeats a rename's records in the next increment
    and a restore would replay them (a wrong tree or a tar error). Two increments in a row with renames are refused."""
    found=[]
    for archive in archives:
        with open(archive,'rb') as handle:found.append(archive_renames_safely(handle))
    return REPEATED_RENAMES if any(found[k] and found[k-1] for k in range(2,len(found))) else None
def chain_extract(archives,destination):
    """Rebuild one mount from a chain: the full archive, then each increment in order."""
    if os.name!='posix':raise ValueError('Restoring an incremental backup needs GNU tar on Linux')
    problem=chain_rename_problem(archives)
    if problem:raise ValueError(problem)
    if destination.is_symlink():raise ValueError('Restore destination cannot be a symlink')
    destination.mkdir(parents=True,exist_ok=True,mode=0o700)
    if any(destination.iterdir()):raise ValueError('Restore destination must be empty')
    root=destination.resolve();top=None
    for archive in archives:
        replace=[];top=incremental_archive_check(archive,root,top,replace)
        replace_directory_links(replace,root)
        # Run inside the destination, not with -C: GNU tar creates the temporary folder of a directory-rename cycle
        # from a relative template, which -C (openat-based) does not move.
        run(['tar','--listed-incremental=/dev/null','--xattrs','--acls','--numeric-owner','-xpf',str(pathlib.Path(archive).resolve())],cwd=str(destination))
    strip_privileges(destination)
def restore(req):
    root=owned_job_root(req)
    unpacked,manifest,artifacts_verified=unpack_verified(req,root)
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
    if shutil.disk_usage(root).free<mount_bytes(unpacked)+1024**3:raise ValueError('Insufficient target capacity for extracted data')
    definitions=[];sources={}
    for i,c in enumerate(containers):
        name='dbm-restore-'+req['job'][:12]+('-'+str(i) if multi else '')
        args=['create','--name',name,'--network','none','--restart','no','--label','docker-backup-manager.restore='+req['job']]
        # A copy must never remain a member of the source's Compose project.
        args+=['--label','com.docker.compose.project=docknest-restore-'+req['job'][:12],'--label','com.docker.compose.project.working_dir=','--label','com.docker.compose.project.config_files=']
        if multi and plans[i]:args+=['--dns','127.0.0.1']
        for destination,options in temporary_mounts(c):args+=['--tmpfs',tmpfs_argument(destination,options)]
        for j,m in enumerate(c['Mounts']):
            source=extract_mount(unpacked,i,j,m,sources,root)
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
    for archive in image_archives(unpacked):load_images_keeping_tags(archive)
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
    problem=maintenance_directory_problem(cfg,p)
    if problem:
        # A page deployed there by an earlier release keeps working; a new location or a link into a system folder is refused.
        if maintenance_link_escape(p) or not (p/'maintenance.html').is_file():raise ValueError(problem+'. Choose a directory under the staging root or a web root.')
        warn(problem+'; kept because a maintenance page is already deployed there')
    p.mkdir(parents=True,exist_ok=True,mode=0o755)
    content=__import__('base64').b64decode(req['html'])
    if len(content)>256*1024:raise ValueError('Maintenance asset exceeds size limit')
    temp=p/('maintenance.html.tmp-'+str(uuid.uuid4()))
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o644)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(content)
            if hasattr(os,'fchmod'):os.fchmod(f.fileno(),0o644)
        os.replace(temp,p/'maintenance.html')
    finally:temp.unlink(missing_ok=True)
    emit(result={'distributed':True,'helperVersion':VERSION,'ready':False,'proxyIntegrationRequired':True,'directory':str(p)})

# Automatic maintenance page for host nginx. DockNest writes its own snippet file and adds one include line after
# server_name in each server block that serves the site's domains. Nothing else in the site's config changes.
MAINTENANCE_SNIPPETS=pathlib.Path('/etc/nginx/docknest')
NGINX_SITE_FOLDERS=('/etc/nginx/sites-enabled','/etc/nginx/conf.d','/etc/nginx/http.d')
def nginx_server_blocks(text):
    """Server blocks in an nginx file: names, offset just after server_name's semicolon, whether it returns, body."""
    blocks=[];stack=[];i=0;n=len(text);words=[];word_start=None
    def flush_word(end):
        nonlocal word_start
        if word_start is not None:words.append(text[word_start:end]);word_start=None
    while i<n:
        ch=text[i]
        if ch=='#' and word_start is None:
            while i<n and text[i]!='\n':i+=1
            continue
        if ch in '"\'':
            quote=ch;start=i;i+=1
            while i<n and text[i]!=quote:i+=2 if text[i]=='\\' else 1
            if word_start is None:word_start=start
            i+=1;continue
        if ch.isspace():flush_word(i);i+=1;continue
        if ch in '{};':
            flush_word(i)
            if ch=='{':stack.append({'name':words[0] if words else '','start':i+1,'names':set(),'insert':None,'returns':False})
            elif ch==';' and words and stack and stack[-1]['name']=='server':
                frame=stack[-1]
                if words[0]=='server_name':
                    frame['names'].update(w.strip('"\'').lower() for w in words[1:])
                    if frame['insert'] is None:frame['insert']=i+1
                if words[0]=='return':frame['returns']=True
            elif ch=='}' and stack:
                frame=stack.pop()
                if frame['name']=='server':blocks.append({'names':frame['names'],'insert':frame['insert'],'returns':frame['returns'],'body':text[frame['start']:i]})
            words=[];i+=1;continue
        if word_start is None:word_start=i
        i+=1
    return blocks
def maintenance_snippet(site,directory):
    suffix=site.replace('-','')[:12]
    return ('# Managed by DockNest: maintenance page for site %s. DockNest switches it on only during a backup.\n'
        'set $dn_maint_%s 0;\nif (-f %s/enabled) { set $dn_maint_%s 1; }\n'
        'if ($uri = /__docknest_maintenance.html) { set $dn_maint_%s 0; }\nif ($dn_maint_%s) { return 503; }\n'
        'error_page 503 /__docknest_maintenance.html;\n'
        'location = /__docknest_maintenance.html { internal; alias %s/maintenance.html; default_type text/html; add_header Retry-After 30 always; add_header Cache-Control no-store always; }\n')%(site,suffix,directory,suffix,suffix,suffix,directory)
def maintenance_nginx_edits(domains,include_line,folders=NGINX_SITE_FOLDERS,root='/etc/nginx'):
    """Planned edits {path: new text}. Only files under /etc/nginx; redirect-only blocks are left alone."""
    wanted={d.lower() for d in domains};edits={};found=False
    for folder in folders:
        directory=pathlib.Path(folder)
        if not directory.is_dir():continue
        for entry in sorted(directory.iterdir()):
            if entry.name.startswith(('docknest-','.')):continue
            real=pathlib.Path(os.path.realpath(entry))
            if not real.is_file() or not real.is_relative_to(os.path.realpath(root)) or real.stat().st_size>1024*1024:continue
            text=edits.get(str(real)) or real.read_text()
            blocks=[b for b in nginx_server_blocks(text) if b['names']&wanted]
            if not blocks:continue
            found=True
            for block in sorted((b for b in blocks if not b['returns'] and b['insert']),key=lambda b:b['insert'],reverse=True):
                if include_line in block['body'] or 'docknest/maintenance' in block['body']:continue
                text=text[:block['insert']]+'\n    '+include_line+text[block['insert']:]
            if text!=real.read_text():edits[str(real)]=text
    if not found:raise ValueError('The site\'s domains were not found in this server\'s nginx configuration.')
    return edits
def setup_maintenance(req):
    cfg=req['config'];m=cfg.get('maintenance',{});site=str(req['siteId']);uuid.UUID(site)
    if os.geteuid()!=0:raise ValueError('Setting up the maintenance page requires root on the server')
    directory=pathlib.Path(m.get('directory',''))
    if not directory.is_absolute() or '..' in directory.parts or re.search(r'[\s;{}"\'$\\]',str(directory)):raise ValueError('Unsupported maintenance directory')
    if (directory/'ready').is_file():emit(result={'configured':True,'alreadySetUp':True});return
    if not (directory/'maintenance.html').is_file():raise ValueError('Deploy the maintenance page before setting it up')
    domains=[d for d in cfg.get('domains',[]) if isinstance(d,str) and DOMAIN.fullmatch(d)]
    if not domains:raise ValueError('Add the site\'s domain in Edit configuration first')
    if not m.get('publicUrl'):raise ValueError('Public maintenance probe URL required')
    if not shutil.which('nginx') or not process_running('nginx'):raise ValueError('nginx is not running on this server. Set up the maintenance page by hand under Advanced options.')
    try:run(['nginx','-t'],timeout=60)
    except Exception:raise ValueError('nginx reports a configuration error already, so DockNest did not change it. Fix nginx first.')
    snippet=MAINTENANCE_SNIPPETS/(site+'.conf');include_line='include %s;'%snippet
    edits=maintenance_nginx_edits(domains,include_line)
    originals={path:pathlib.Path(path).read_text() for path in edits}
    snippet_existed=snippet.exists();flag=directory/'enabled'
    def write(path,text):
        target=pathlib.Path(path);info=target.stat() if target.exists() else None
        temporary=target.with_name('.'+target.name+'.docknest-tmp');temporary.write_text(text)
        if info:os.chmod(temporary,stat.S_IMODE(info.st_mode));os.chown(temporary,info.st_uid,info.st_gid)
        else:os.chmod(temporary,0o644)
        os.replace(temporary,target)
    try:
        MAINTENANCE_SNIPPETS.mkdir(mode=0o755,exist_ok=True)
        write(snippet,maintenance_snippet(site,directory))
        for path,text in edits.items():write(path,text)
        try:nginx_reload()
        except Exception:raise ValueError('nginx rejected the maintenance page settings, so DockNest put the configuration back.')
        flag.touch(mode=0o644)
        status,body=public_probe(m,domains)
        if status!=503 or b'dbm-maintenance-v1' not in body:raise ValueError('Visitors did not get the maintenance page during the test (HTTP %d), so DockNest put the configuration back. A CDN or another proxy in front of nginx can cause this.'%status)
        flag.unlink()
        status,body=public_probe(m,domains)
        if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('The site did not come back normally after the test (HTTP %d), so DockNest put the configuration back.'%status)
    except BaseException:
        flag.unlink(missing_ok=True)
        for path,text in originals.items():
            try:write(path,text)
            except Exception:pass
        if not snippet_existed:snippet.unlink(missing_ok=True)
        try:nginx_reload()
        except Exception:pass
        raise
    (directory/'ready').touch(mode=0o644)
    emit(result={'configured':True,'files':sorted(edits),'snippet':str(snippet)})

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

JOB_DIRECTORY=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
FORBIDDEN_STAGING=['/']
def staging_base(cfg):
    base=pathlib.Path(cfg.get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts or str(base) in FORBIDDEN_STAGING:raise ValueError('Use a dedicated absolute staging directory')
    return base
def is_regular(path):
    try:return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:return False
def job_folder_finished(path):
    """A real job directory (never a link) whose recovery completed and whose watchdog acknowledged it."""
    try:folder=os.lstat(path)
    except OSError:return False
    return stat.S_ISDIR(folder.st_mode) and is_regular(path/'disarmed') and is_regular(path/'watchdog.done')
def list_staging(cfg,now=None,limit=200):
    """Report job folders in the staging root for DockNest to decide on. Never deletes and never follows links."""
    now=time.time() if now is None else now
    base=staging_base(cfg);jobs=[]
    try:info=os.lstat(base)
    except FileNotFoundError:return {'root':str(base),'jobs':jobs}
    if not stat.S_ISDIR(info.st_mode) or base.resolve()!=base:raise ValueError('Staging directory cannot be a symbolic link')
    for entry in sorted(os.scandir(base),key=lambda item:item.name):
        if not JOB_DIRECTORY.fullmatch(entry.name) or not entry.is_dir(follow_symlinks=False):continue
        path=base/entry.name;finished=job_folder_finished(path);size=0;latest=os.lstat(path).st_mtime
        for current,dirs,files in os.walk(path,followlinks=False):
            for name in dirs+files:
                try:item=os.lstat(os.path.join(current,name));size+=item.st_size;latest=max(latest,item.st_mtime)
                except OSError:pass
        jobs.append({'job':entry.name,'finished':finished,'ageSeconds':max(0,int(now-latest)),'bytes':size})
        if len(jobs)>=limit:break
    return {'root':str(base),'jobs':jobs}
def cleanup_staging(req):
    root=pathlib.Path(req['root'])
    if not JOB_DIRECTORY.fullmatch(root.name) or str(root.parent)!=str(staging_base({'stagingRoot':str(root.parent)})):raise ValueError('Cleanup requires a job folder in the staging directory')
    if not job_folder_finished(root):raise ValueError('Recovery watchdog has not acknowledged disarm')
    # fd-based removal never follows a link planted inside the folder.
    if not getattr(shutil.rmtree,'avoids_symlink_attacks',False):raise ValueError('Safe directory removal is unavailable on this host')
    shutil.rmtree(root)
# ---- Site moves (docs/moving-sites.md) ----
# Rules: facts are read-only and never include env values (masked host and port only); a deploy journals every
# resource on the target BEFORE creating it, so deploy-teardown removes exactly what this move created and nothing
# else; existing files, folders, containers, volumes and networks are never replaced; the source is never edited.
MOVES_ROOT=pathlib.Path('/var/lib/docknest/moves')
NGINX_CONF_DIRS=['/etc/nginx/conf.d','/etc/nginx/http.d','/etc/nginx/sites-enabled']
ACME_ROOT=pathlib.Path('/var/lib/docknest/acme')
SAFE_NAME=re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}')
DOMAIN=re.compile(r'(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)+')
PROTECTED_PATHS={'/','/bin','/boot','/dev','/etc','/home','/lib','/lib64','/media','/mnt','/opt','/proc','/root','/run','/sbin','/srv','/sys','/tmp','/usr','/var','/var/lib','/var/lib/docker','/var/lib/docker/volumes','/var/www','/var/lib/docknest','/var/lib/docker-backup-manager'}
MAIL_PORTS='25,465,587'
def move_id(req):
    value=str(req.get('moveId',''));uuid.UUID(value);return value
# A move never writes into system folders, Docker's own storage or another program's configuration, even when a site
# mounted such a path on its old server. Only the move's own DockNest folders below /var/lib/docknest are allowed there.
MOVE_FORBIDDEN=SYSTEM_TREES+('/usr','/var/lib/docker','/var/lib/containerd','/var/lib/docker-backup-manager','/var/lib/docknest','/var/spool','/var/mail','/var/cache')
MOVE_OWN_ROOTS=('/var/lib/docknest/moves','/var/lib/docknest/acme','/var/lib/docknest/maintenance')
# Paths named by a backup are created only below application roots: any non-standard top-level folder (/opt, /srv,
# /data, /mnt ...), /var/www, /var/opt, and non-hidden folders in a home directory (also /var/home, /var/srv and friends
# on image-based systems). Package state such as /var/lib/cloud and start-up files such as ~/.profile are never written.
MOVE_CLOSED_TOP={'bin','boot','cdrom','dev','efi','etc','gnu','home','lib','lib32','lib64','libx32','lost+found','nix','proc','root','run','sbin','snap','sys','tmp','usr','var'}
# /var/lib/<app> is allowed, except state that belongs to the OS, package managers, init, container runtimes and cloud-init.
MOVE_VAR_LIB_DENIED={'AccountsService','PackageKit','apk','apt','aptitude','authselect','chrony','cloud','cni','containerd','containers','dbus','dhcp','dnf','docker','docker-backup-manager','docknest','dpkg','firewalld','flatpak','fwupd','grub','incus','initramfs-tools','iptables','k3s','kubelet','landscape','libvirt','logrotate','lxc','lxcfs','lxd','machines','misc','NetworkManager','nftables','nix','os-prober','pacman','pam','plymouth','polkit-1','portables','private','rancher','rpm','selinux','shim-signed','snapd','sss','sudo','systemd','tpm','ubuntu-advantage','ucf','udisks2','ufw','update-manager','update-notifier','upower','yum'}
def move_root_allowed(path):
    parts=pathlib.PurePosixPath(path).parts[1:]
    if parts and parts[0]=='var' and len(parts)>1 and parts[1] in ('home','srv','opt','mnt','www'):parts=parts[1:]
    if not parts or any(part.startswith('.') for part in parts[:1]):return False
    if parts[0]=='home':return len(parts)>=3 and not parts[2].startswith('.') and parts[2]!='bin'
    if parts[:2]==('var','lib'):return len(parts)>=3 and not parts[2].startswith('.') and parts[2] not in MOVE_VAR_LIB_DENIED
    return parts[0] not in MOVE_CLOSED_TOP
def move_path(value,own=False):
    """An absolute, normalised, non-system path a move may create (and later remove). Symlinks in the existing part of
    the path are followed for the check, so /srv/x -> /etc is refused too. `own` admits DockNest's own move folders."""
    text=str(value)
    p=pathlib.PurePosixPath(text)
    if not p.is_absolute() or '..' in p.parts or str(p)!=text or text in PROTECTED_PATHS or len(p.parts)<2:raise ValueError('Unsupported path for a move: '+text)
    for path in resolved(text):
        if not path.startswith('/'):continue
        allowed=own and any(within(path,root) and path!=root for root in MOVE_OWN_ROOTS)
        if protected_lexical(path) or (not allowed and any(within(path,root) for root in MOVE_FORBIDDEN)):raise ValueError('%s is a system or protected location; DockNest never writes there during a move.'%text)
    return pathlib.Path(text)
def move_state(mid,create=False):
    d=MOVES_ROOT/mid
    if create:MOVES_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700);d.mkdir(exist_ok=True,mode=0o700)
    if d.is_symlink():raise ValueError('Move folder cannot be a symbolic link')
    file=d/'resources.json'
    state=json.loads(file.read_text()) if file.is_file() else {}
    state.setdefault('created',{});state.setdefault('deployed',{})
    for kind in ['paths','volumes','networks','containers','images','staging','firewall','nginx']:state['created'].setdefault(kind,[])
    return d,state
def journal_resource(d,state,kind,value):
    """Written before the effect: a crash after this line leaves a record teardown can act on."""
    if value not in state['created'][kind]:state['created'][kind].append(value)
    atomic_json(d/'resources.json',state)
def save_state(d,state):atomic_json(d/'resources.json',state)
def tool_version(args):
    try:return run(args,timeout=30).decode().strip().splitlines()[0].strip()[:40] or None
    except Exception:return None
def listening_ports():
    ports=set()
    for name in ['/proc/net/tcp','/proc/net/tcp6']:
        try:lines=pathlib.Path(name).read_text().splitlines()[1:]
        except OSError:continue
        for line in lines:
            parts=line.split()
            if len(parts)>3 and parts[3]=='0A':
                try:ports.add(int(parts[1].rsplit(':',1)[1],16))
                except ValueError:pass
    try:
        for line in docker('ps','--format','{{.Ports}}').decode().splitlines():
            for match in re.finditer(r':(\d+)->',line):ports.add(int(match[1]))
    except Exception:pass
    return sorted(ports)
def host_addresses():
    found=[]
    try:
        for line in run(['ip','-o','addr','show','scope','global'],timeout=10).decode().splitlines():
            fields=line.split()
            if len(fields)<4 or fields[1].startswith(('docker','br-','veth','cni','flannel','virbr')):continue
            match=re.search(r'\binet6? ([0-9a-fA-F.:]+)/',line)
            if match and match[1] not in found:found.append(match[1])
    except Exception:pass
    return found[:20]
def process_running(name):
    try:
        for entry in os.scandir('/proc'):
            if entry.name.isdigit():
                try:
                    if pathlib.Path(entry.path,'comm').read_text().strip()==name:return True
                except OSError:pass
    except OSError:pass
    return False
def nginx_conf_dir():
    try:text=pathlib.Path('/etc/nginx/nginx.conf').read_text(errors='replace')
    except OSError:return None
    for d in NGINX_CONF_DIRS:
        if re.search(r'^\s*include\s+'+re.escape(d)+r'/\*(?:\.conf)?\s*;',text,re.M) and pathlib.Path(d).is_dir():return d
    return None
def nginx_facts():
    if not shutil.which('nginx'):return {'installed':False}
    try:run(['nginx','-t'],timeout=30);ok=True
    except Exception:ok=False
    return {'installed':True,'configOk':ok,'running':process_running('nginx'),'confDir':nginx_conf_dir(),'serverNames':sorted({d.lower() for site in nginx_sites() for d in site['domains']})}
# Directives the DockNest-owned server block provides itself; others found in the source block are listed (names only).
COPIED_DIRECTIVES={'listen','server_name','root','index','location','proxy_pass','proxy_set_header','proxy_http_version','try_files','ssl_certificate','ssl_certificate_key','include','return','error_page','set','if','add_header','default_type','internal','access_log','error_log','ssl_protocols','ssl_ciphers','ssl_prefer_server_ciphers','ssl_session_cache','ssl_session_timeout','ssl_dhparam','http2','proxy_redirect','charset'}
def nginx_domain_facts(domains):
    """Names of directives in the domain's server blocks and the loopback upstream port. Never contents."""
    wanted={d.lower() for d in domains};names=set();ports=[]
    for folder in ['/etc/nginx/sites-enabled','/etc/nginx/conf.d','/etc/nginx/http.d']:
        directory=pathlib.Path(folder)
        if not directory.is_dir():continue
        for file in sorted(directory.iterdir()):
            if not file.is_file() or file.stat().st_size>1024*1024 or file.name.startswith('docknest-'):continue
            try:lexer=shlex.shlex(file.read_text(),posix=True,punctuation_chars='{};');lexer.whitespace_split=True;tokens=list(lexer)
            except (ValueError,OSError):continue
            depth=0;stack=[];words=[];blocks=[]
            for token in tokens:
                if token=='{':stack.append(words[0] if words else '');blocks.append((words[0] if words else '',words[1:]));words=[]
                elif token=='}':stack and stack.pop();words=[]
                elif token==';':
                    if words:blocks.append((words[0],words[1:]))
                    words=[]
                else:words.append(token)
            # Group directives per top-level server block.
            current=None;servers=[]
            for name,args in blocks:
                if name=='server':current={'names':set(),'directives':set(),'upstreams':[]};servers.append(current);continue
                if current is None:continue
                if name=='server_name':current['names'].update(a.lower() for a in args)
                current['directives'].add(name)
                if name=='proxy_pass' and args:current['upstreams'].append(args[0])
            for server in servers:
                if not server['names']&wanted:continue
                names.update(n for n in server['directives'] if re.fullmatch(r'[a-z_0-9]+',n) and n not in COPIED_DIRECTIVES)
                for upstream in server['upstreams']:
                    match=re.fullmatch(r'https?://(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)(?:/.*)?',upstream)
                    if match:ports.append(int(match[1]))
    return {'directives':sorted(names)[:50],'upstreamPorts':list(dict.fromkeys(ports))}
def is_ip(value):
    try:ipaddress.ip_address(value);return True
    except ValueError:return False
def mask_value(value,token):
    """Scheme, host and port only: userinfo, paths, queries and every other part of the value are dropped."""
    parts=urllib.parse.urlsplit(value) if '://' in value else None
    if parts and parts.hostname:
        try:port=parts.port
        except ValueError:port=None
        return parts.scheme+'://'+parts.hostname+(':%d'%port if port else '')
    match=re.search(re.escape(token)+r'(:\d{1,5})?',value)
    return token+(match[1] or '' if match else '')
def env_token(value,tokens):
    for token in tokens:
        if token and re.search(r'(?<![A-Za-z0-9.-])'+re.escape(token)+r'(?![A-Za-z0-9-])',value):return token
    return None
def env_findings(containers,files,tokens):
    findings=[];seen=set()
    def scan(key,value,where):
        token=env_token(value,tokens)
        if token and (key,where) not in seen and SAFE_NAME.fullmatch(key):
            seen.add((key,where));findings.append({'key':key,'where':where,'kind':'ip' if is_ip(token) else 'host','masked':mask_value(value,token)})
    for c in containers:
        for item in c.get('Config',{}).get('Env') or []:
            key,_,value=item.partition('=');scan(key,value,'container '+c['Name'].lstrip('/'))
    for filename in files:
        p=pathlib.Path(filename)
        if not (p.name=='.env' or p.name.endswith('.env')) or not p.is_file() or p.is_symlink():continue
        try:lines=p.read_text(errors='replace').splitlines()[:5000]
        except OSError:continue
        for line in lines:
            match=re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$',line)
            if match:scan(match[1],match[2].strip().strip('"\''),'file '+str(p))
    return findings[:100]
def port_bindings(c):
    result=[]
    for internal,bindings in (c.get('HostConfig',{}).get('PortBindings') or {}).items():
        port,_,protocol=internal.partition('/')
        for binding in bindings or []:
            host=str(binding.get('HostPort') or '')
            if host.isdigit() and port.isdigit():result.append({'container':c['Name'].lstrip('/'),'hostIp':binding.get('HostIp') or '0.0.0.0','hostPort':int(host),'containerPort':int(port),'protocol':protocol or 'tcp'})
    return result
def source_site_facts(cfg,tokens):
    domains=[d for d in cfg.get('domains',[]) if isinstance(d,str) and DOMAIN.fullmatch(d)]
    nginx=nginx_domain_facts(domains) if domains else {'directives':[],'upstreamPorts':[]}
    m=cfg.get('maintenance',{})
    ready=bool(m.get('directory')) and pathlib.Path(m['directory'],'ready').is_file()
    if cfg.get('kind')=='static':
        root=cfg.get('documentRoot','')
        return {'kind':'static','domains':domains,'documentRoot':root,'bindPaths':[root],'names':{},'ports':[],'networks':[],'running':[],'containerCount':0,'nginxDirectives':nginx['directives'],'web':None,'maintenanceReady':True,'env':[]}
    cs=inspect(cfg.get('containers',[]))
    compose=any((c.get('Config',{}).get('Labels') or {}).get('com.docker.compose.project') for c in cs)
    ports=[b for c in cs for b in port_bindings(c)]
    binds=list(dict.fromkeys([m['Source'] for c in cs for m in c['Mounts'] if m['Type']=='bind']+cfg.get('composeFiles',[])+cfg.get('configFiles',[])))
    networks={}
    for c in cs:
        for name in (c.get('NetworkSettings',{}).get('Networks') or {}):
            if name in ['bridge','host','none'] or name in networks:continue
            n=json.loads(docker('network','inspect',name))[0]
            networks[name]={'name':name,'driver':n.get('Driver'),'internal':bool(n.get('Internal')),'ipv6':bool(n.get('EnableIPv6')),'labels':{k:v for k,v in (n.get('Labels') or {}).items() if k.startswith('com.docker.compose.')}}
    # The web port nginx proxies to; then the configured loopback health URL; then the first published TCP port.
    web=None
    for port in nginx['upstreamPorts']:
        if any(b['hostPort']==port for b in ports):web=port;break
    if web is None and cfg.get('healthUrl'):
        match=re.fullmatch(r'http://(?:127\.0\.0\.1|localhost):(\d+)(?:/.*)?',cfg['healthUrl'])
        if match and any(b['hostPort']==int(match[1]) for b in ports):web=int(match[1])
    if web is None:web=next((b['hostPort'] for b in ports if b['protocol']=='tcp'),None)
    volumes=[]
    for name in dict.fromkeys(m['Name'] for c in cs for m in c['Mounts'] if m['Type']=='volume'):
        v=json.loads(docker('volume','inspect',name))[0]
        volumes.append({'name':name,'labels':{k:val for k,val in (v.get('Labels') or {}).items() if k.startswith('com.docker.compose.')}})
    # One Compose project with its files selected in the site: the move can use a Compose override on the target.
    project=None
    labels=[(c.get('Config',{}).get('Labels') or {}) for c in cs]
    names={l.get('com.docker.compose.project') for l in labels}
    files=[f.strip() for f in (labels[0].get('com.docker.compose.project.config_files','') if labels else '').split(',') if f.strip()]
    if compose and len(names)==1 and all(l.get('com.docker.compose.service') for l in labels) and files and all(f in cfg.get('composeFiles',[]) for f in files):
        project={'project':labels[0]['com.docker.compose.project'],'workingDir':labels[0].get('com.docker.compose.project.working_dir',''),'files':files,'services':{c['Name'].lstrip('/'):l['com.docker.compose.service'] for c,l in zip(cs,labels)}}
    return {'compose':project,'volumes':volumes,'kind':'compose' if compose else 'container','domains':domains,'containerCount':len(cs),'architecture':docker('info','--format','{{.Architecture}}').decode().strip(),
        'ports':ports,'bindPaths':binds,'names':{'containers':[c['Name'].lstrip('/') for c in cs],'volumes':list(dict.fromkeys(m['Name'] for c in cs for m in c['Mounts'] if m['Type']=='volume')),'networks':list(networks)},
        'networks':list(networks.values()),'running':[c['Id'] for c in cs if c['State'].get('Running')],'nginxDirectives':nginx['directives'],'web':web,'maintenanceReady':ready if m.get('required',True) else None,
        'env':env_findings(cs,cfg.get('composeFiles',[])+cfg.get('configFiles',[]),tokens)}
def target_probe(probe):
    paths=[]
    for value in (probe.get('paths') or [])[:200]:
        p=pathlib.Path(str(value))
        if not p.is_absolute() or '..' in p.parts:continue
        if p.exists() or p.is_symlink():paths.append({'path':str(value),'empty':p.is_dir() and not p.is_symlink() and not any(p.iterdir())})
    names=probe.get('names') or {}
    existing={'containers':docker('ps','-a','--format','{{.Names}}').decode().split(),'volumes':docker('volume','ls','-q').decode().split(),'networks':docker('network','ls','--format','{{.Name}}').decode().split()}
    conflicts={kind:sorted(set(names.get(kind) or [])&set(values)) for kind,values in existing.items()}
    project=names.get('composeProject')
    if isinstance(project,str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}',project):conflicts['composeProjects']=[project] if docker('ps','-aq','--filter','label=com.docker.compose.project='+project).decode().split() else []
    return {'existingPaths':paths,'conflicts':conflicts}
def move_facts(req):
    """Read-only facts for the move preflight (src/moves/preflight.js decides). Never returns env values."""
    cfg=req.get('config') or {}
    staging=pathlib.Path(cfg.get('stagingRoot','/var/lib/docknest'))
    existing=next((p for p in [staging,*staging.parents] if p.exists()),pathlib.Path('/'))
    usage=shutil.disk_usage(existing);ports=listening_ports();nginx=nginx_facts()
    facts={'helperVersion':VERSION,'uid':os.geteuid(),'dockerVersion':tool_version(['docker','version','--format','{{.Server.Version}}']),'composeVersion':tool_version(['docker','compose','version','--short']),
        'freeBytes':usage.free,'totalBytes':usage.total,'stagingWritable':os.access(existing,os.W_OK),'usedPorts':ports,'nginx':nginx,
        'webPortOwner':None if 80 not in ports else ('nginx' if nginx.get('running') else 'other'),
        'certbot':{'installed':bool(shutil.which('certbot')),'account':pathlib.Path('/etc/letsencrypt/accounts').is_dir()},'addresses':host_addresses()}
    facts['architecture']=tool_version(['docker','info','--format','{{.Architecture}}'])
    facts['firewall']={'mailBlocking':firewall_ready()}
    facts['os']=os_release();facts['packageManager']=package_manager(facts['os']['id'])
    facts['candidates']=install_candidates(facts['packageManager'])
    tokens=[t for t in req.get('hosts',[]) if isinstance(t,str) and re.fullmatch(r'[A-Za-z0-9.:-]{1,253}',t)]+[a for a in facts['addresses'] if not a.startswith(('127.','::1'))]
    if req.get('role')=='source':facts['site']=source_site_facts(cfg,list(dict.fromkeys(tokens)))
    if req.get('probe'):facts['probe']=target_probe(req['probe'])
    emit(result=facts)
# ---- Install on server (src/installs.js asks, this table decides). Distro packages only: no repositories are added, no
# scripts are downloaded, no config files are edited and nothing is removed (apt runs with --no-remove). DockNest sends
# only a package NAME; the argv below is fixed here and runs without a shell. Failures raise InstallError with a short
# CODE; src/install-plan.js turns each known code into a fixed sentence. Raw exception text and tool output never leave.
INSTALL_PLAN_JSON=r'''{"apt":{"nginx":["nginx"],"certbot":["certbot","python3-certbot-nginx"],"docker":["docker.io"],"compose":["docker-compose-v2"]},"dnf":{"nginx":["nginx"],"certbot":["certbot","python3-certbot-nginx"],"docker":["moby-engine"],"compose":[]}}'''
INSTALL_PLAN=json.loads(INSTALL_PLAN_JSON)
INSTALL_NAMES={'nginx':'nginx','docker':'Docker','compose':'Docker Compose','certbot':'certbot'}
# Packages from any source that mean the tool is already on the server. Never install over them.
INSTALL_PRESENT={'nginx':['nginx','nginx-core','nginx-full','nginx-light','nginx-extras'],'docker':['docker.io','docker-ce','docker-ce-cli','containerd.io','moby-engine','docker-engine','podman-docker'],'compose':['docker-compose-v2','docker-compose-plugin','docker-compose'],'certbot':['certbot']}
INSTALL_VERIFY={'nginx':[['nginx','-v'],['nginx','-t']],'docker':[['docker','version','--format','{{.Server.Version}}']],'compose':[['docker','compose','version']],'certbot':[['certbot','--version']]}
INSTALL_SERVICES={'nginx':'nginx','docker':'docker'}
INSTALL_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
INSTALL_UPDATE_TIMEOUT=300
INSTALL_TIMEOUT=900
INSTALL_KILL_WAIT=60
INSTALL_LOCK_PATH='/run/docknest-install.lock'
class InstallError(ValueError):
    """The message is a short code (see INSTALL_ERRORS in src/install-plan.js), never free text."""
def systemd_present():return pathlib.Path('/run/systemd/system').is_dir()
def os_release():
    values={'id':'','versionId':''}
    try:text=pathlib.Path('/etc/os-release').read_text(errors='replace')
    except OSError:return values
    for line in text.splitlines()[:100]:
        key,separator,value=line.partition('=')
        value=value.strip().strip('"').strip("'").lower()
        if not separator:continue
        if key=='ID' and re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,39}',value):values['id']=value
        elif key=='VERSION_ID' and re.fullmatch(r'[0-9][0-9.]{0,19}',value):values['versionId']=value
    return values
def package_manager(os_id):
    if os_id in ('debian','ubuntu'):return 'apt' if shutil.which('apt-get') else None
    if os_id in ('fedora','rhel','rocky','almalinux'):return 'dnf' if shutil.which('dnf') else None
    return None
def version_at_least(text,major,minor):
    match=re.match(r'(\d+)(?:\.(\d+))?',text or '')
    if not match:return False
    return (int(match.group(1)),int(match.group(2) or 0))>=(major,minor)
def install_supported(manager,os_id,version_id,name):
    """Keep in step with installSupported() in src/install-plan.js."""
    if manager not in INSTALL_PLAN or not INSTALL_PLAN[manager].get(name):return False
    if manager=='apt':
        if os_id not in ('debian','ubuntu'):return False
        if name=='compose':return os_id=='ubuntu' and version_at_least(version_id,22,4)
        return True
    if manager=='dnf':
        if os_id not in ('fedora','rhel','rocky','almalinux'):return False
        return name=='nginx' or (os_id=='fedora' and name in ('certbot','docker'))
    return False
def package_known(manager,package):
    """True when the package manager says this package is installed (any source)."""
    if manager=='apt':
        code,tail=run_fixed(['dpkg-query','-W','-f=${Status}',package],30)
        return code==0 and 'install ok installed' in tail
    if manager=='dnf':
        code,_=run_fixed(['rpm','-q',package],30)
        return code==0
    return False
def package_installed(name,manager=None):
    # The binary on the PATH, or any package from any source (docker-ce, containerd.io ...): either means "already there".
    if name=='compose':
        if tool_version(['docker','compose','version','--short']) is not None:return True
    elif shutil.which(name) is not None:return True
    return bool(manager) and any(package_known(manager,package) for package in INSTALL_PRESENT[name])
def version_head(text):
    """'5:27.5.1-1' or '26.1.3+dfsg' -> '27.5' (major.minor), else None. Only digits are ever kept."""
    match=re.match(r'(?:\d+:)?(\d{1,3})\.(\d{1,3})',text or '')
    return '%s.%s'%(match.group(1),match.group(2)) if match else None
def install_candidates(manager):
    """The Docker version this system's own package sources offer (read only, no update, may be stale)."""
    result={}
    if manager=='apt':
        code,tail=run_fixed(['apt-cache','policy','docker.io'],30)
        match=re.search(r'candidate:\s*(\S+)',tail) if code==0 else None
        if match:result['docker']=version_head(match.group(1))
    elif manager=='dnf':
        code,tail=run_fixed(['dnf','-q','info','moby-engine'],60)
        match=re.search(r'^version\s*:\s*(\S+)',tail,re.M) if code==0 else None
        if match:result['docker']=version_head(match.group(1))
    return {key:value for key,value in result.items() if value}
def install_status():
    osr=os_release();manager=package_manager(osr['id'])
    emit(result={'os':osr,'packageManager':manager,'installed':{name:package_installed(name,manager) for name in INSTALL_NAMES},'candidates':install_candidates(manager)})
def stop_group(process):
    """SIGTERM to the process group, up to INSTALL_KILL_WAIT seconds to finish, then SIGKILL."""
    try:os.killpg(process.pid,signal.SIGTERM)
    except OSError:pass
    try:process.wait(timeout=INSTALL_KILL_WAIT)
    except subprocess.TimeoutExpired:
        try:os.killpg(process.pid,signal.SIGKILL)
        except OSError:pass
        process.wait()
def run_fixed(argv,timeout):
    """One fixed argv, no shell, its own process group. Output is kept as a short lower-case tail that only picks a plain message; it is never returned."""
    exe=shutil.which(argv[0],path=INSTALL_PATH)
    if exe is None:return 127,''
    env={'PATH':INSTALL_PATH,'DEBIAN_FRONTEND':'noninteractive','NEEDRESTART_SUSPEND':'1','LC_ALL':'C','HOME':'/root'}
    with tempfile.TemporaryFile() as output:
        process=subprocess.Popen([exe]+list(argv[1:]),stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,env=env,shell=False,close_fds=True,start_new_session=True)
        try:code=process.wait(timeout=max(30,timeout))
        except subprocess.TimeoutExpired:
            stop_group(process);return -1,''
        size=output.seek(0,2);output.seek(max(0,size-4000))
        return code,output.read().decode('utf-8','replace').lower()
def install_failure(code,tail,manager,step):
    """step is 'update' or 'install'. Returns a code from INSTALL_ERRORS."""
    if code==-1:return ('TIMEOUT_APT_' if manager=='apt' else 'TIMEOUT_')+step.upper()
    if 'could not get lock' in tail or 'unable to acquire the dpkg' in tail or 'waiting for cache lock' in tail or 'another instance' in tail:return 'PACKAGE_TOOL_BUSY'
    if 'unable to locate package' in tail or 'no match for argument' in tail or 'has no installation candidate' in tail:return 'NOT_OFFERED'
    if 'temporary failure resolving' in tail or 'could not resolve' in tail or 'failed to fetch' in tail or 'cannot download' in tail or 'failed to download' in tail:return 'NO_NETWORK'
    if 'no space left' in tail:return 'NO_SPACE'
    # apt --no-remove ends with "Packages need to be removed but remove is disabled"; the plan above it may be cut off.
    if 'packages will be removed' in tail or 'remove is disabled' in tail or 'unmet dependencies' in tail:return 'CONFLICT'
    return 'UPDATE_FAILED' if step=='update' else 'INSTALL_FAILED'
def verify_install(name):
    unit=INSTALL_SERVICES.get(name)
    if unit and systemd_present():
        code,_=run_fixed(['systemctl','enable','--now',unit],120)
        if code!=0:raise InstallError('SERVICE_NOT_STARTED')
    attempts=6 if name=='docker' else 1
    for command in INSTALL_VERIFY[name]:
        for attempt in range(attempts):
            code,_=run_fixed(command,60)
            if code==0:break
            if attempt==attempts-1:raise InstallError('VERIFY_FAILED')
            time.sleep(3)
def install_package(req):
    try:install_guarded(req)
    except InstallError:raise
    except Exception:raise InstallError('GENERIC')
def install_guarded(req):
    import fcntl
    name=req.get('package')
    if not isinstance(name,str) or name not in INSTALL_NAMES:raise InstallError('UNKNOWN_PACKAGE')
    emit(stage='connected')
    if os.geteuid()!=0:raise InstallError('NOT_ROOT')
    lock=open(INSTALL_LOCK_PATH,'a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise InstallError('LOCKED')
    try:install_locked(name)
    finally:lock.close()
def install_locked(name):
    osr=os_release();manager=package_manager(osr['id'])
    if not install_supported(manager,osr['id'],osr['versionId'],name):raise InstallError('UNSUPPORTED')
    if package_installed(name,manager):raise InstallError('DOCKER_NOT_RUNNING' if name=='docker' else 'ALREADY_INSTALLED')
    if name=='nginx' and 80 in listening_ports():raise InstallError('PORT_80')
    names=list(INSTALL_PLAN[manager][name])
    emit(stage='update')
    if manager=='apt':
        code,tail=run_fixed(['apt-get','-o','DPkg::Lock::Timeout=120','update'],INSTALL_UPDATE_TIMEOUT)
        if code!=0:raise InstallError(install_failure(code,tail,manager,'update'))
        command=['apt-get','-o','DPkg::Lock::Timeout=120','install','-y','--no-install-recommends','--no-remove']+names
    else:command=['dnf','install','-y']+names
    emit(stage='install')
    code,tail=run_fixed(command,INSTALL_TIMEOUT)
    if code!=0:raise InstallError(install_failure(code,tail,manager,'install'))
    emit(stage='verify')
    verify_install(name)
    emit(result={'package':name,'installed':True})
IMAGE_BASED_LINKS=('home','srv','opt','mnt')
def image_based_form(path):
    """Fedora CoreOS, Silverblue and IoT link /home, /srv, /opt and /mnt to var/<x> at the root. Only that root-level
    link is rewritten to its /var form, and only when root owns it and neither /var nor /var/<x> is a link; any other
    link on the way stays a refusal."""
    parts=pathlib.PurePosixPath(path).parts
    if len(parts)<2 or parts[1] not in IMAGE_BASED_LINKS:return path
    top='/'+parts[1]
    try:
        if not os.path.islink(top) or os.lstat(top).st_uid!=0 or os.readlink(top)!='var/'+parts[1]:return path
        if os.path.islink('/var') or os.path.islink('/var/'+parts[1]):return path
    except OSError:return path
    return '/'.join(('/var',)+parts[1:])
def foreign_app_folder(path,state):
    """Below /var/lib, an application folder that already holds data belongs to another program unless this move made
    it (journalled). Other roots keep shared parents such as ~/docker or /opt/stacks, so they are not checked."""
    parts=pathlib.PurePosixPath(path).parts
    if parts[1:3]!=('var','lib') or len(parts)<4:return None
    app='/'.join(parts[:4])[1:]
    records=[record['path'] for record in (state or {}).get('created',{}).get('paths',[])]
    if any(within(app,record) for record in records):return None
    folder=pathlib.Path(app)
    if not folder.is_dir():return None
    # An entry this move placed (journalled) is not foreign: a second mount below an empty pre-existing folder is fine.
    return app if any(not any(within(lexical(str(entry)),record) for record in records) for entry in folder.iterdir()) else None
def place_tree(archive,target,d,state,mid):
    """Extract a one-entry archive to `target`, which must not exist (an empty folder is accepted and recreated on teardown)."""
    target=move_path(target)
    # The backup names this path, so it must also lie below an application root, through no symlink on this server.
    forms=resolved(str(target))
    if any(path.startswith('/') and not move_root_allowed(path) for path in forms):raise ValueError('%s is outside the folders a move may create (/opt, /srv, /var/www, /var/lib/<app>, a home folder or another top-level data folder); move this site by hand.'%target)
    if len(forms)==2 and forms[1].startswith('/') and forms[1]!=image_based_form(forms[0]):raise ValueError('%s goes through a symbolic link on this server; DockNest only creates paths without links during a move.'%target)
    app=foreign_app_folder(forms[0],state)
    if app:raise ValueError('%s already exists on this server and belongs to another program; DockNest never writes into it during a move.'%app)
    if target.is_symlink() or (target.exists() and not (target.is_dir() and not any(target.iterdir()))):raise ValueError('%s already exists on this server. DockNest never overwrites existing folders.'%target)
    empty=target.exists()
    missing=[p for p in reversed(target.parents) if not p.exists()]
    journal_resource(d,state,'paths',{'path':str(missing[0] if missing else target),'restoreEmpty':empty and not missing})
    for p in missing:p.mkdir(mode=0o755)
    if empty:target.rmdir()
    temporary=target.parent/('.docknest-move-%s-%s'%(mid[:8],uuid.uuid4().hex[:8]))
    if not missing:journal_resource(d,state,'paths',{'path':str(temporary),'restoreEmpty':False})
    extract_archives(archive,temporary)
    entries=list(temporary.iterdir())
    if len(entries)!=1:raise ValueError('Archive must hold exactly one entry')
    os.replace(entries[0],target);temporary.rmdir()
    return target
def place_volume(archive,name,d,state,mid,mode,labels=None):
    if not SAFE_NAME.fullmatch(name):raise ValueError('Unsupported volume name')
    if docker('volume','ls','-q','--filter','name=^'+re.escape(name)+'$').decode().split():raise ValueError('A volume named %s already exists on this server. DockNest never replaces it.'%name)
    journal_resource(d,state,'volumes',name)
    extra=[part for k,v in (labels or {}).items() if k.startswith('com.docker.compose.') and SAFE_NAME.fullmatch(k) and isinstance(v,str) and len(v)<256 for part in ['--label',k+'='+v]]
    docker('volume','create','--label','docknest.move='+mid,'--label','docknest.move.mode='+mode,*extra,name)
    mountpoint=pathlib.Path(json.loads(docker('volume','inspect',name))[0]['Mountpoint'])
    if any(mountpoint.iterdir()):raise ValueError('New volume is not empty')
    temporary=mountpoint.parent/('.docknest-move-'+uuid.uuid4().hex[:8])
    extract_archives(archive,temporary)
    entries=list(temporary.iterdir())
    if len(entries)!=1:raise ValueError('Archive must hold exactly one entry')
    mountpoint.rmdir();os.replace(entries[0],mountpoint);temporary.rmdir()
def rewrite_value(value,tokens,target):
    token=env_token(value,tokens)
    return re.sub(r'(?<![A-Za-z0-9.-])'+re.escape(token)+r'(?![A-Za-z0-9-])',target,value) if token else value
def placed_by_move(path,placed):
    real=lexical(os.path.realpath(path))
    return any(within(real,lexical(os.path.realpath(p))) for p in placed)
def rewrite_env_file(path,keys,tokens,target):
    p=pathlib.Path(path)
    if not p.is_file() or p.is_symlink():return 0
    lines=p.read_text(errors='replace').split('\n');changed=0
    for i,line in enumerate(lines):
        match=re.match(r'(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$',line)
        if match and match[2] in keys:
            new=rewrite_value(match[4],tokens,target)
            if new!=match[4]:lines[i]=match[1]+match[2]+match[3]+new;changed+=1
    if changed:
        info=p.stat();temporary=p.with_name(p.name+'.docknest-tmp')
        temporary.write_text('\n'.join(lines));os.chmod(temporary,info.st_mode&0o7777)
        if hasattr(os,'chown'):os.chown(temporary,info.st_uid,info.st_gid)
        os.replace(temporary,p)
    return changed
def mapped_port(port_map,binding,mode):
    for entry in port_map:
        if int(entry.get('from',-1))==binding['hostPort'] and int(entry.get('containerPort',-1))==binding['containerPort'] and entry.get('protocol','tcp')==binding['protocol']:
            to=int(entry['to'])
            break
    else:to=binding['hostPort']
    if not 1<=to<=65535:raise ValueError('Invalid port in the move plan')
    ip='127.0.0.1' if mode=='test' else binding['hostIp']
    if ip in ['','0.0.0.0']:host=''
    elif ':' in ip:host='['+ip+']:'
    else:host=ip+':'
    return host+str(to)+':'+str(binding['containerPort'])+'/'+binding['protocol'],to
def firewall_ready():
    """Docker's DOCKER-USER chain exists, so DockNest can reject SMTP from test containers without touching other rules."""
    if not shutil.which('iptables'):return False
    try:run(['iptables','-S','DOCKER-USER'],timeout=10);return True
    except Exception:return False
def block_mail(d,state,mid,subnets):
    """Test copies must not send mail. Before they start, reject outbound SMTP from the networks this move created
    (IPv4 with iptables, IPv6 with ip6tables, in Docker's DOCKER-USER chain). True only when every network is covered."""
    if not subnets or not firewall_ready():return False
    covered=True
    for subnet in subnets:
        tool='ip6tables' if ':' in subnet else 'iptables'
        try:ipaddress.ip_network(subnet);run([tool,'-S','DOCKER-USER'],timeout=10)
        except Exception:covered=False;continue
        journal_resource(d,state,'firewall',subnet)
        run([tool,'-I','DOCKER-USER','-s',subnet,'-p','tcp','-m','multiport','--dports',MAIL_PORTS,'-m','comment','--comment','docknest-move-'+mid,'-j','REJECT'],timeout=10)
    return covered
def unblock_mail(mid):
    for tool in ['iptables','ip6tables']:
        if not shutil.which(tool):continue
        try:rules=run([tool,'-S','DOCKER-USER'],timeout=10).decode().splitlines()
        except Exception:continue
        for rule in rules:
            if rule.startswith('-A DOCKER-USER') and 'docknest-move-'+mid in rule:
                try:run([tool,'-D',*shlex.split(rule)[1:]],timeout=10)
                except Exception:pass
def network_subnets(names):
    subnets=[]
    for name in names:
        try:subnets+=[c['Subnet'] for c in (json.loads(docker('network','inspect',name))[0].get('IPAM') or {}).get('Config') or [] if c.get('Subnet')]
        except Exception:pass
    return subnets
def nginx_site_conf(mid,n,tls=None):
    domains=[d for d in n.get('domains',[]) if DOMAIN.fullmatch(d)]
    if not domains:raise ValueError('A move with nginx needs at least one valid domain')
    site=str(n['siteId']);uuid.UUID(site);suffix=site.replace('-','')[:12]
    mdir=str(move_path(n['maintenanceDirectory'],own=True));acme=str(ACME_ROOT/site)
    if re.search(r'[\s;{}"\'$]',mdir):raise ValueError('Unsupported maintenance directory')
    if n.get('documentRoot'):
        root=str(move_path(n['documentRoot']))
        if re.search(r'[\s;{}"\'$]',root):raise ValueError('Unsupported document root')
        locations='  root %s;\n  index index.html;\n  location / { try_files $uri $uri/ =404; }\n'%root
        head=''
    else:
        port=int(n['upstreamPort'])
        if not 1<=port<=65535:raise ValueError('Invalid upstream port')
        proxy='proxy_pass http://127.0.0.1:%d; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $http_connection;'%port
        head='map $request_method $dn_safe_%s { default 0; GET 1; HEAD 1; }\nmap "$dn_safe_%s:$dn_maint_%s" $dn_reject_%s { default 0; "0:1" 1; }\n'%(suffix,suffix,suffix,suffix)
        locations=('  root %s;\n  set $dn_maint_%s 0;\n  if (-f %s/enabled) { set $dn_maint_%s 1; }\n  error_page 418 =503 @maintenance_api;\n'
            '  location @maintenance_api { default_type application/json; add_header Retry-After 30 always; add_header Cache-Control no-store always; return 503 \'{"maintenance":true,"error":"Site temporarily under maintenance"}\'; }\n'
            '  error_page 503 /maintenance.html;\n  location = /maintenance.html { internal; add_header Retry-After 30 always; add_header Cache-Control no-store always; }\n'
            '  location / { if ($dn_reject_%s) { return 418; } if ($dn_maint_%s) { return 503; } %s }\n')%(mdir,suffix,mdir,suffix,suffix,suffix,proxy)
    acme_location='  location /.well-known/acme-challenge/ { root %s; }\n'%acme
    servers='server {\n  listen 80;\n  listen [::]:80;\n  server_name %s;\n%s%s}\n'%(' '.join(domains),acme_location,locations)
    if tls:servers+='server {\n  listen 443 ssl;\n  listen [::]:443 ssl;\n  server_name %s;\n  ssl_certificate %s;\n  ssl_certificate_key %s;\n%s}\n'%(' '.join(domains),tls['cert'],tls['key'],locations)
    return '# Managed by DockNest move %s; safe to delete after the move is cleaned up.\n%s%s'%(mid,head,servers)
def nginx_reload():
    run(['nginx','-t'],timeout=60)
    try:run(['nginx','-s','reload'],timeout=60)
    except Exception:run(['systemctl','reload','nginx'],timeout=60)
def write_nginx(d,state,mid,n,tls=None):
    uuid.UUID(str(n.get('siteId','')))
    conf_dir=nginx_conf_dir()
    if not conf_dir:raise ValueError('nginx on this server does not include a conf.d folder DockNest can add its file to.')
    path=pathlib.Path(conf_dir)/('docknest-%s.conf'%n['siteId'])
    if path.exists() and not path.read_text(errors='replace').startswith('# Managed by DockNest move %s;'%mid):raise ValueError('%s already exists and was not written by this move.'%path)
    journal_resource(d,state,'nginx',str(path))
    acme=ACME_ROOT/str(n['siteId'])
    if not acme.exists():journal_resource(d,state,'paths',{'path':str(acme),'restoreEmpty':False});acme.mkdir(parents=True,mode=0o755)
    previous=path.read_text() if path.exists() else None
    temporary=path.with_name('.'+path.name+'.docknest-tmp')
    temporary.write_text(nginx_site_conf(mid,n,tls));os.chmod(temporary,0o644);os.replace(temporary,path)
    try:nginx_reload()
    except Exception:
        if previous is None:path.unlink(missing_ok=True)
        else:path.write_text(previous)
        try:nginx_reload()
        except Exception:pass
        raise ValueError('nginx refused the new site file, so DockNest removed it again. Check nginx on this server.')
    atomic_json(d/'nginx.json',n)
    return str(path)
def loopback_probe(port,host,path='/',timeout=10):
    connection=http.client.HTTPConnection('127.0.0.1',int(port),timeout=timeout)
    try:
        connection.request('GET',path or '/',headers={'Host':host,'User-Agent':'DockNest-helper/%d'%VERSION,'Cache-Control':'no-cache'})
        response=connection.getresponse();return response.status,response.read(PROBE_LIMIT)
    finally:connection.close()
def wait_probe(port,host,path,seconds=60):
    deadline=time.time()+seconds;last=(None,b'')
    while True:
        try:
            last=loopback_probe(port,host,path)
            if last[0] is not None and last[0]<400 and b'dbm-maintenance-v1' not in last[1]:return last
        except Exception:pass
        if time.time()>=deadline:return last
        time.sleep(2)
def deploy_maintenance_dir(d,state,n):
    mdir=move_path(n['maintenanceDirectory'],own=True)
    # On the new server the page always lives in DockNest's own folder, never in an existing web root.
    if not within(lexical(mdir),'/var/lib/docknest/maintenance') or lexical(mdir)=='/var/lib/docknest/maintenance':raise ValueError('The maintenance folder on the new server must be below /var/lib/docknest/maintenance')
    if not mdir.exists():journal_resource(d,state,'paths',{'path':str(mdir),'restoreEmpty':False})
    mdir.mkdir(parents=True,exist_ok=True,mode=0o755)
    content=__import__('base64').b64decode(n.get('maintenanceHtml') or '')
    if content:
        if len(content)>256*1024:raise ValueError('Maintenance asset exceeds size limit')
        (mdir/'maintenance.html').write_bytes(content);os.chmod(mdir/'maintenance.html',0o644)
    return mdir
def deploy_restore(req):
    """Live deploy of a verified backup on the move target (test: loopback ports, restart no, outbound mail blocked
    where possible; live: original bind addresses and restart policies plus a DockNest-owned nginx file)."""
    mid=move_id(req);mode=req.get('mode')
    if mode not in ['test','live']:raise ValueError('Unsupported deploy mode')
    d,state=move_state(mid,create=True)
    if (d/'finalized').exists():raise ValueError('This move already finished on this server')
    if mode in state['deployed']:emit(result=state['deployed'][mode]);return
    if any(state['created'][kind] for kind in ['paths','volumes','networks','containers','nginx']):raise ValueError('An earlier deploy of this move is incomplete; DockNest undoes it before trying again')
    root=owned_job_root(req);journal_resource(d,state,'staging',str(root))
    try:
        unpacked,manifest,artifacts_verified=unpack_verified(req,root)
        result=deploy_unpacked(req,mid,mode,d,state,unpacked,manifest)
        result['artifactsVerified']=artifacts_verified
    finally:
        # The unpacked payload holds plaintext site data; it never stays in the staging root.
        if root.exists():shutil.rmtree(root,ignore_errors=True)
    state['deployed'][mode]=result;save_state(d,state)
    emit(result=result)
def deploy_unpacked(req,mid,mode,d,state,unpacked,manifest):
    port_map=req.get('portMap') or [];rewrite=req.get('envRewrite') or {}
    keys=set(rewrite.get('keys') or []);tokens=[t for t in rewrite.get('from') or [] if isinstance(t,str) and t];target=str(rewrite.get('to') or '')
    if keys and (not tokens or not re.fullmatch(r'[A-Za-z0-9.:-]{1,253}',target)):raise ValueError('Settings rewrite needs the old and new server address')
    placed=[]
    if manifest.get('kind')=='static':
        if manifest.get('containers'):raise ValueError('Invalid static backup manifest')
        document=place_tree(unpacked/'static-files.tar',manifest['documentRoot'],d,state,mid)
        if tree_digest(document)!=manifest.get('staticFiles'):raise ValueError('Copied static files differ from the captured website')
        result={'mode':mode,'kind':'static','documentRoot':str(document),'containers':[],'ports':[],'mailBlocked':False}
        if mode=='live' and req.get('nginx'):
            n={**req['nginx'],'documentRoot':str(document)}
            deploy_maintenance_dir(d,state,n);result['nginx']=write_nginx(d,state,mid,n)
            status,_=wait_probe(80,n['domains'][0],'/',30)
            if status is None or status>=400:raise ValueError('nginx on this server did not serve the copied website')
        return result
    if manifest['architecture']!=docker('info','--format','{{.Architecture}}').decode().strip():raise ValueError('Architecture mismatch')
    containers=manifest['containers']
    if not 1<=len(containers)<=30:raise ValueError('Deploy requires 1 to 30 containers')
    for c in containers:restore_network_plan([c])  # refuses host privileges, shared namespaces and static IPs
    if len(manifest.get('snapshotImages',[]))!=len(containers):raise ValueError('Missing snapshot images')
    if shutil.disk_usage(unpacked).free<mount_bytes(unpacked)+1024**3:raise ValueError('Insufficient target capacity for extracted data')
    sources={};volume_labels={v.get('name'):v.get('labels') for v in req.get('volumes') or [] if isinstance(v,dict)}
    for i,c in enumerate(containers):
        for j,m in enumerate(c['Mounts']):
            key=(m['Type'],m.get('Name') if m['Type']=='volume' else m['Source'])
            if key in sources:continue
            if m['Type']=='bind':
                # A protected mount is never copied, so a move never writes it (nor binds the new server's own copy).
                if protected_mount(m['Source']) or any(item.get('source')==m['Source'] for item in manifest.get('protectedMounts') or [] if isinstance(item,dict)):raise ValueError('%s holds passwords, sudo rules or SSH or GPG keys, which DockNest does not copy; move this site by hand.'%m['Source'])
                for kind,existing in sources:
                    if kind!='bind':continue
                    a,b=os.path.normpath(existing),os.path.normpath(m['Source'])
                    if os.path.commonpath([a,b]) in [a,b]:raise ValueError('Overlapping mount paths need a manual move')
                placed.append(str(place_tree(mount_archive(unpacked,i,j),m['Source'],d,state,mid)))
            elif m['Type']=='volume':place_volume(mount_archive(unpacked,i,j),m['Name'],d,state,mid,mode,volume_labels.get(m['Name']))
            else:raise ValueError('Unsupported mount type')
            sources[key]=True
    configuration=[]
    for filename in manifest.get('configurationFiles',[]):
        # Relative names and '..' are refused; other spellings the site form accepts (//, ./, a trailing /) are
        # normalised, so the lexical containment test below compares like with like.
        if not isinstance(filename,str) or not filename.startswith('/') or '..' in pathlib.PurePosixPath(filename).parts:raise ValueError('Unsupported path for a move: %s'%filename)
        configuration.append(lexical(filename))
    for i,filename in enumerate(configuration):
        if any(filename==p or filename.startswith(p.rstrip('/')+'/') for p in placed):continue
        placed.append(str(place_tree(unpacked/('config-%d.tar'%i),filename,d,state,mid)))
    # Settings are rewritten only in files this move just placed, after following links.
    rewritten=sum(rewrite_env_file(f,keys,tokens,target) for f in configuration if pathlib.Path(f).name.endswith('.env') and placed_by_move(f,placed)) if keys else 0
    for network in req.get('networks') or []:
        name=network.get('name','')
        if not SAFE_NAME.fullmatch(name) or network.get('driver') not in [None,'bridge']:raise ValueError('Only bridge networks can be moved')
        if docker('network','ls','-q','--filter','name=^'+re.escape(name)+'$').decode().split():raise ValueError('A network named %s already exists on this server. DockNest never replaces it.'%name)
        journal_resource(d,state,'networks',name)
        labels=[part for k,v in (network.get('labels') or {}).items() if SAFE_NAME.fullmatch(k) and isinstance(v,str) and len(v)<256 for part in ['--label',k+'='+v]]
        docker('network','create','--driver','bridge',*(['--internal'] if network.get('internal') else []),*(['--ipv6'] if network.get('ipv6') else []),'--label','docknest.move='+mid,*labels,name)
    # The test copy never joins Docker's shared default bridge: containers from it get a network of this move, so its
    # outgoing mail can be blocked by subnet before anything starts.
    test_network='dn-test-'+mid[:12]
    if mode=='test':
        journal_resource(d,state,'networks',test_network)
        docker('network','create','--driver','bridge','--label','docknest.move='+mid,test_network)
    for image in manifest['snapshotImages']:journal_resource(d,state,'images',image)
    for archive in image_archives(unpacked):load_images_keeping_tags(archive)
    created=[];ports=[];names=[]
    try:
        compose=req.get('compose')
        if compose:created,names,ports,rewritten=compose_up(compose,mid,mode,d,state,manifest,port_map,keys,tokens,target,rewritten)
        for i,c in enumerate([] if compose else containers):
            name=c['Name'].lstrip('/')
            if not SAFE_NAME.fullmatch(name):raise ValueError('Unsupported container name')
            hc=c.get('HostConfig',{})
            policy='no' if mode=='test' else (hc.get('RestartPolicy') or {}).get('Name') or 'no'
            if policy not in ['no','always','unless-stopped','on-failure']:policy='no'
            networks=[n for n in (c.get('NetworkSettings',{}).get('Networks') or {}) if n!='none']
            primary=hc.get('NetworkMode') if hc.get('NetworkMode') in networks else (networks[0] if networks else 'none')
            if primary=='default':primary='bridge'
            if primary=='bridge' and mode=='test':primary=test_network
            args=['create','--name',name,'--restart',policy,'--label','docknest.move='+mid,'--label','docknest.move.mode='+mode,'--network',primary]
            def aliases(network):
                values=[a for a in (c['NetworkSettings']['Networks'][network].get('Aliases') or []) if a and a!=c['Id'][:12] and SAFE_NAME.fullmatch(a)]
                return [part for alias in dict.fromkeys(values) for part in ['--alias' if network!=primary else '--network-alias',alias]]
            if primary not in ['bridge','none'] and primary in networks:args+=aliases(primary)
            for binding in port_bindings(c):
                spec,to=mapped_port(port_map,binding,mode);args+=['-p',spec];ports.append({'container':name,'from':binding['hostPort'],'to':to,'containerPort':binding['containerPort'],'protocol':binding['protocol']})
            for destination,options in temporary_mounts(c):args+=['--tmpfs',tmpfs_argument(destination,options)]
            for m in c['Mounts']:
                if ',' in m['Source'] or ',' in m['Destination']:raise ValueError('Mount paths with commas need a manual move')
                mount=('type=volume,src='+m['Name'] if m['Type']=='volume' else 'type=bind,src='+m['Source'])+',dst='+m['Destination']
                if not m.get('RW',True):mount+=',readonly'
                args+=['--mount',mount]
            for host in hc.get('ExtraHosts') or []:
                if re.fullmatch(r'[A-Za-z0-9.-]+:[0-9a-fA-F.:]+|[A-Za-z0-9.-]+:host-gateway',host):args+=['--add-host',host]
            if hc.get('Init'):args.append('--init')
            for item in c.get('Config',{}).get('Env') or []:
                key,_,value=item.partition('=')
                if key in keys and tokens:
                    new=rewrite_value(value,tokens,target)
                    if new!=value:args+=['-e',key+'='+new];rewritten+=1
            journal_resource(d,state,'containers',name)
            created.append(docker(*args,manifest['snapshotImages'][i]).decode().strip());names.append(name)
            if primary not in ['bridge','none']:
                for other in networks:
                    # A test copy never joins Docker's shared default bridge.
                    if other!=primary and not (mode=='test' and other in ['bridge','default']):docker('network','connect',*aliases(other),other,created[-1])
        mapping={c['Id']:cid for c,cid in zip(containers,created)}
        contracts=manifest.get('backupPlan',{}).get('services',[])
        ordered=manifest.get('backupPlan',{}).get('restartOrder',[c['Id'] for c in containers])
        running=[mapping[o] for o in ordered if next(c for c in containers if c['Id']==o)['State'].get('Running')]
        mail_blocked=False
        if mode=='test':
            used={n for c in inspect(created) for n in (c.get('NetworkSettings',{}).get('Networks') or {})}
            mail_blocked=block_mail(d,state,mid,network_subnets(sorted(used))) and used<=set(state['created']['networks'])
        restart_services(running,[{**s,'container':mapping[s['container']],'dependsOn':[mapping[x] for x in s.get('dependsOn',[])]} for s in contracts if s.get('container') in mapping])
        until=time.time()+120
        while time.time()<until and not health(running):time.sleep(2)
        if not health(running):raise ValueError('The copied containers did not become healthy')
        result={'mode':mode,'kind':'docker','containers':names,'running':[names[created.index(cid)] for cid in running],'ports':ports,'paths':placed,'envRewritten':rewritten,'method':'compose-override' if compose else 'docker-create','mailBlocked':mail_blocked}
        if mode=='live' and req.get('nginx'):
            n=req['nginx'];deploy_maintenance_dir(d,state,n)
            result['nginx']=write_nginx(d,state,mid,n)
            status,_=wait_probe(80,n['domains'][0],n.get('path') or '/',60)
            if status is None or status>=400:raise ValueError('nginx on this server did not serve the moved site')
            (move_path(n['maintenanceDirectory'],own=True)/'ready').touch(mode=0o644)
        return result
    except Exception:
        try:
            if created:docker('stop','--time','30',*created)
        except Exception:pass
        raise
def yaml_str(value):return json.dumps(str(value))  # a JSON string is a valid YAML double-quoted scalar
def compose_override(compose,mid,mode,manifest,port_map,keys,tokens,target):
    """Override file for the site's own Compose files: snapshot image, remapped host ports (Compose 2.24+ !override),
    no restart for the test copy, DockNest labels and opted-in setting rewrites. The user's files are never edited."""
    lines=['# Written by DockNest move %s. The site\'s own Compose files are unchanged.'%mid,'services:'];ports=[];rewritten=0
    for i,c in enumerate(manifest['containers']):
        name=c['Name'].lstrip('/');service=compose['services'].get(name)
        if not service or not SAFE_NAME.fullmatch(service):raise ValueError('The Compose service of %s is unknown'%name)
        specs=[]
        for binding in port_bindings(c):
            spec,to=mapped_port(port_map,binding,mode);specs.append(spec)
            ports.append({'container':name,'from':binding['hostPort'],'to':to,'containerPort':binding['containerPort'],'protocol':binding['protocol']})
        lines+=['  %s:'%yaml_str(service),'    image: %s'%yaml_str(manifest['snapshotImages'][i]),'    pull_policy: never','    ports: !override'+('' if specs else ' []')]
        lines+=['      - %s'%yaml_str(spec) for spec in specs]
        if mode=='test':lines.append('    restart: "no"')
        lines+=['    labels:','      docknest.move: %s'%yaml_str(mid),'      docknest.move.mode: %s'%yaml_str(mode)]
        env=[]
        for item in c.get('Config',{}).get('Env') or []:
            key,_,value=item.partition('=')
            if key in keys and tokens:
                new=rewrite_value(value,tokens,target)
                if new!=value:env.append((key,new.replace('$','$$')))
        if env:lines+=['    environment:']+['      %s: %s'%(yaml_str(k),yaml_str(v)) for k,v in env];rewritten+=len(env)
    return '\n'.join(lines)+'\n',ports,rewritten
# Allow-lists for the merged Compose configuration (docker compose config). Anything not listed is refused, so a
# setting DockNest does not understand can never reach the new server.
COMPOSE_TOP_KEYS={'name','services','networks','volumes','secrets','configs'}
COMPOSE_SERVICE_KEYS={'image','build','command','entrypoint','environment','env_file','ports','expose','volumes','networks','depends_on','restart','healthcheck','labels','container_name','hostname','domainname','working_dir','user','stop_signal','stop_grace_period','tmpfs','logging','pull_policy','init','extra_hosts','mem_limit','mem_reservation','memswap_limit','cpus','cpu_shares','cpuset','shm_size','ulimits','read_only','stdin_open','tty','platform','profiles','links','dns','dns_search','deploy','secrets','configs','scale','oom_score_adj','pids_limit'}
COMPOSE_SERVICE_NETWORK_KEYS={'aliases','priority'}
COMPOSE_NETWORK_KEYS={'name','driver','internal','enable_ipv6','labels','attachable','ipam','external','driver_opts'}
COMPOSE_VOLUME_KEYS={'name','driver','labels','external','driver_opts'}
def compose_network_problem(item):
    # A network the project defines itself (including Compose's implicit `default`) with the bridge driver and no host
    # resources is fine. External networks, other drivers, driver options and fixed subnets are refused.
    if item.get('external'):return 'is external'
    if set(item)-COMPOSE_NETWORK_KEYS:return 'uses %s'%', '.join(sorted(set(item)-COMPOSE_NETWORK_KEYS))
    if (item.get('driver') or 'bridge')!='bridge':return 'uses the %s driver'%item.get('driver')
    if item.get('driver_opts'):return 'sets driver options'
    ipam=item.get('ipam') or {}
    if set(ipam)-{'driver','config','options'} or (ipam.get('driver') or 'default')!='default' or ipam.get('options') or ipam.get('config'):return 'sets fixed subnets or IP address management, which may clash on the new server'
    return None
def compose_volume_problem(item):
    if item.get('external'):return 'is external'
    if set(item)-COMPOSE_VOLUME_KEYS:return 'uses %s'%', '.join(sorted(set(item)-COMPOSE_VOLUME_KEYS))
    if (item.get('driver') or 'local')!='local' or item.get('driver_opts'):return 'uses a volume driver or driver options'
    return None
COMPOSE_MOUNT_KEYS={'type','source','target','read_only','bind','volume','tmpfs','consistency'}
def check_compose_config(config,services,manifest):
    # The site's Compose files come from the old server; the merged result may only describe what the backup holds.
    def refuse(text):raise ValueError(text+' DockNest does not move this site automatically.')
    binds={m['Source'] for c in manifest['containers'] for m in c['Mounts'] if m['Type']=='bind'}
    volumes={m.get('Name') for c in manifest['containers'] for m in c['Mounts'] if m['Type']=='volume'}
    networks={n for c in manifest['containers'] for n in (c.get('NetworkSettings',{}).get('Networks') or {})}
    unknown=set(config)-COMPOSE_TOP_KEYS
    if unknown:refuse('The Compose files use %s.'%', '.join(sorted(unknown)))
    for kind in ['secrets','configs']:
        for key,item in (config.get(kind) or {}).items():
            if not isinstance(item,dict) or item.get('file') or item.get('external') or set(item)-{'name','environment','content'}:refuse('The Compose %s %s reads a file or an external source.'%(kind[:-1],key))
    declared_networks=config.get('networks') or {}
    # A service without its own networks joins the project's default network.
    used_networks={network for name in services for network in (((config.get('services') or {}).get(name) or {}).get('networks') or {'default':None})}
    for key,item in declared_networks.items():
        problem=compose_network_problem(item or {})
        if problem and key in used_networks:refuse('The Compose network %s %s.'%(key,problem))
    declared=config.get('volumes') or {}
    for key,item in declared.items():
        problem=compose_volume_problem(item or {})
        if problem:refuse('The Compose volume %s %s.'%(key,problem))
    for name in services:
        service=(config.get('services') or {}).get(name)
        if not isinstance(service,dict):raise ValueError('The Compose service %s is missing from the Compose files'%name)
        extra=set(service)-COMPOSE_SERVICE_KEYS
        if extra:refuse('The Compose service %s uses %s.'%(name,', '.join(sorted(extra))))
        for network,options in (service.get('networks') or {}).items():
            real=((declared_networks.get(network) or {}).get('name') or network)
            if real not in networks:refuse('The Compose service %s joins the network %s, which the old copy did not use.'%(name,real))
            if set(options or {})-COMPOSE_SERVICE_NETWORK_KEYS:refuse('The Compose service %s sets a fixed address or other network settings.'%name)
        for volume in service.get('volumes') or []:
            kind=volume.get('type');source=volume.get('source')
            if set(volume)-COMPOSE_MOUNT_KEYS:refuse('The Compose service %s uses mount settings DockNest cannot move.'%name)
            if kind=='bind':
                if source not in binds:raise ValueError('The Compose service %s mounts %s, which is not in the backup.'%(name,source))
                move_path(source)
            elif kind=='volume':
                real=(declared.get(source) or {}).get('name',source)
                if real not in volumes:raise ValueError('The Compose service %s uses the volume %s, which is not in the backup.'%(name,real))
            elif kind!='tmpfs':raise ValueError('The Compose service %s uses a %s mount, which DockNest cannot move.'%(name,kind))
def compose_up(compose,mid,mode,d,state,manifest,port_map,keys,tokens,target,rewritten):
    project=str(compose.get('project',''))
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}',project):raise ValueError('Unsupported Compose project name')
    workdir=move_path(compose['workingDir']);files=[str(move_path(f)) for f in compose['files']]
    if not workdir.is_dir() or not all(pathlib.Path(f).is_file() for f in files):raise ValueError('The Compose project files were not copied to this server')
    text,ports,count=compose_override(compose,mid,mode,manifest,port_map,keys,tokens,target)
    override=d/('compose.%s.yaml'%mode)
    fd=os.open(override,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:f.write(text)
    names=[c['Name'].lstrip('/') for c in manifest['containers']]
    command=['docker','compose','-p',project,'--project-directory',str(workdir)]+[part for f in files for part in ['-f',f]]+['-f',str(override)]
    others=[cid for cid in docker('ps','-aq','--filter','label=com.docker.compose.project='+project).decode().split()]
    owned=docker('ps','-aq','--filter','label=com.docker.compose.project='+project,'--filter','label=docknest.move='+mid).decode().split()
    if set(others)-set(owned):raise ValueError('A Compose project named %s already exists on this server. DockNest never joins or replaces it.'%project)
    check_compose_config(json.loads(run(command+['config','--format','json'],timeout=120)),[compose['services'][n] for n in names],manifest)
    for name in names:journal_resource(d,state,'containers',name)
    # Created only; DockNest starts them in the recorded order and checks health like every restore.
    run(command+['up','--no-start','--no-build','--pull','never','--no-deps',*[compose['services'][n] for n in names]],timeout=1800)
    created=[]
    for name in names:
        ids=docker('ps','-aq','--filter','label=docknest.move='+mid,'--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+compose['services'][name]).decode().split()
        if len(ids)!=1:raise ValueError('Compose did not create %s as expected'%name)
        created.append(ids[0])
    return created,names,ports,rewritten+count
def remove_path(record):
    p=move_path(record['path'],own=True)
    if p.is_symlink() or p.is_file():p.unlink()
    elif p.is_dir():
        if not getattr(shutil.rmtree,'avoids_symlink_attacks',False) and os.name=='posix':raise ValueError('Safe directory removal is unavailable on this host')
        shutil.rmtree(p)
    if record.get('restoreEmpty'):p.mkdir(mode=0o755)
def deploy_teardown(req):
    """Undo a move's deploy on this server: removes only what this move journaled as created, gated by its label."""
    mid=move_id(req);d=MOVES_ROOT/mid
    if not d.exists():emit(result={'removed':True,'nothingToDo':True});return
    d,state=move_state(mid)
    if (d/'finalized').exists():raise ValueError('This move finished; DockNest never removes a moved site automatically.')
    unblock_mail(mid)
    ids=docker('ps','-aq','--filter','label=docknest.move='+mid).decode().split()
    if ids:docker('rm','-f',*ids)
    for path in state['created']['nginx']:
        p=pathlib.Path(path)
        if p.is_file() and p.read_text(errors='replace').startswith('# Managed by DockNest move %s;'%mid):
            p.unlink()
            try:nginx_reload()
            except Exception:pass
    for kind,listing in [('networks',['network','ls','-q']),('volumes',['volume','ls','-q'])]:
        owned=set(docker(*listing,'--filter','label=docknest.move='+mid).decode().split())
        for name in reversed(state['created'][kind]):
            if kind=='volumes' and name in owned:docker('volume','rm',name)
            elif kind=='networks':
                found=docker('network','ls','-q','--filter','name=^'+re.escape(name)+'$','--filter','label=docknest.move='+mid).decode().split()
                if found:docker('network','rm',*found)
    for record in reversed(state['created']['paths']):remove_path(record)
    for image in state['created']['images']:
        try:docker('image','rm',image)
        except Exception:pass
    for root in state['created']['staging']:
        p=pathlib.Path(root)
        if p.exists() and p.parent==pathlib.Path('/var/lib/docker-backup-manager/restore'):shutil.rmtree(p,ignore_errors=True)
    counts={kind:len(values) for kind,values in state['created'].items()}
    shutil.rmtree(d,ignore_errors=True)
    emit(result={'removed':True,'counts':counts})
def deploy_status(req):
    mid=move_id(req);d=MOVES_ROOT/mid
    if not d.exists():emit(result={'present':False,'deployed':[],'finalized':False});return
    d,state=move_state(mid)
    emit(result={'present':any(state['created'][k] for k in ['paths','volumes','networks','containers','nginx']),'deployed':sorted(state['deployed']),'finalized':(d/'finalized').exists()})
def move_test(req):
    """Checks the copy from the target itself: container health, then an HTTP request to the loopback port with the domain's Host header."""
    mid=move_id(req)
    ids=docker('ps','-aq','--filter','label=docknest.move='+mid).decode().split()
    expected=set(req.get('running') or [])
    states=inspect(ids) if ids else []
    running=[c['Id'] for c in states if c['Name'].lstrip('/') in expected]
    if len(running)!=len(expected):raise ValueError('Not every copied container is present on this server')
    healthy=health(running)
    result={'containersHealthy':healthy,'http':None}
    if not healthy:raise ValueError('The copied containers are not healthy')
    http=req.get('http')
    if http:
        if not DOMAIN.fullmatch(str(http.get('host',''))):raise ValueError('Invalid test domain')
        path=str(http.get('path') or '/')
        if not path.startswith('/') or any(ch in path for ch in '\r\n '):raise ValueError('Invalid test path')
        status,body=wait_probe(int(http['port']),http['host'],path,int(req.get('seconds',60)))
        result['http']={'port':int(http['port']),'status':status,'ok':status is not None and status<400 and b'dbm-maintenance-v1' not in body}
        if not result['http']['ok']:raise ValueError('The copy did not answer for %s (HTTP %s).'%(http['host'],status if status is not None else 'no response'))
    emit(result=result)
def move_resume_source(req):
    """Undo of the final copy: start the old site again in its recorded order, then clear the maintenance page."""
    cfg=req['config'];running=[c for c in req.get('running') or [] if isinstance(c,str) and SAFE_NAME.fullmatch(c)]
    if cfg.get('kind')=='static':emit(result={'resumed':True,'static':True});return
    cfg.setdefault('maintenance',{})
    skip_refused_probes(cfg)
    plan=backup_plan(cfg)
    if running:restart_services([cid for cid in plan['restartOrder'] if cid in running],plan['services'])
    cfg['_runningContainers']=running
    until=time.time()+120
    while running and time.time()<until and not health(running,probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):time.sleep(2)
    if running and not health(running,probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):raise ValueError('The old site did not become healthy; its maintenance page stays on.')
    if cfg['maintenance'].get('required') and (pathlib.Path(cfg['maintenance'].get('directory',''))/'enabled').exists():maintenance(cfg,False)
    emit(result={'resumed':True,'running':len(running)})
def move_retire_source(req):
    """After the switch: the old copy stays, stopped, and cannot restart by itself. Original restart policies are kept."""
    mid=move_id(req);cfg=req['config']
    d,_=move_state(mid,create=True);record=d/'retired.json'
    if record.is_file():emit(result=json.loads(record.read_text()));return
    if cfg.get('kind')=='static':result={'containers':[],'static':True}
    else:
        cs=inspect(cfg.get('containers',[]))
        result={'containers':[{'id':c['Id'],'name':c['Name'].lstrip('/'),'restartPolicy':(c['HostConfig'].get('RestartPolicy') or {}).get('Name') or 'no'} for c in cs]}
        atomic_json(record.with_suffix('.pending'),result)
        for c in cs:
            if c['State'].get('Running'):docker('stop','--time',str(int(cfg.get('stopTimeout',60))),c['Id'])
            docker('update','--restart=no',c['Id'])
    atomic_json(record,result);emit(result=result)
def move_finalize_target(req):
    mid=move_id(req);d,_=move_state(mid,create=True)
    atomic_json(d/'finalized',{'at':time.time()});emit(result={'finalized':True})
def move_certificate(req):
    """Issues a certificate only with a certbot account the owner already set up. DockNest never installs certbot."""
    mid=move_id(req);d,state=move_state(mid)
    n=json.loads((d/'nginx.json').read_text()) if (d/'nginx.json').is_file() else None
    if not n:emit(result={'status':'skipped','reason':'no-nginx'});return
    domains=[x for x in n['domains'] if DOMAIN.fullmatch(x)]
    # The one line the owner runs on the new server (after installing certbot themselves, if needed).
    command='certbot --nginx --cert-name docknest-%s %s'%(n['siteId'],' '.join('-d '+x for x in domains))
    if not shutil.which('certbot') or not pathlib.Path('/etc/letsencrypt/accounts').is_dir():emit(result={'status':'needs-owner','reason':'no-certbot' if not shutil.which('certbot') else 'no-account','command':command});return
    try:run(['certbot','certonly','--webroot','-w',str(ACME_ROOT/str(n['siteId'])),'--non-interactive','--keep-until-expiring','--cert-name','docknest-'+str(n['siteId']),*[part for x in domains for part in ['-d',x]]],timeout=300)
    except Exception:emit(result={'status':'needs-owner','reason':'certbot-failed','command':command});return
    live=pathlib.Path('/etc/letsencrypt/live')/('docknest-'+str(n['siteId']))
    write_nginx(d,state,mid,n,{'cert':str(live/'fullchain.pem'),'key':str(live/'privkey.pem')})
    emit(result={'status':'issued','certName':'docknest-'+str(n['siteId'])})
def move_stop_target(req):
    """Switch back: the new copy shows its maintenance page, stops and cannot restart by itself. Nothing is deleted."""
    mid=move_id(req);d,_=move_state(mid);record=d/'stopped.json'
    if record.is_file():emit(result=json.loads(record.read_text()));return
    n=json.loads((d/'nginx.json').read_text()) if (d/'nginx.json').is_file() else None
    if n:
        flag=move_path(n['maintenanceDirectory'],own=True)/'enabled'
        if flag.is_symlink():raise ValueError('Maintenance flag cannot be a symbolic link')
        flag.touch(mode=0o644)
    ids=docker('ps','-aq','--filter','label=docknest.move='+mid,'--filter','label=docknest.move.mode=live').decode().split()
    cs=inspect(ids) if ids else []
    result={'containers':[{'id':c['Id'],'name':c['Name'].lstrip('/'),'restartPolicy':(c['HostConfig'].get('RestartPolicy') or {}).get('Name') or 'no','running':bool(c['State'].get('Running'))} for c in cs],'maintenance':bool(n)}
    atomic_json(d/'stopped.pending',result)
    for c in cs:
        if c['State'].get('Running'):docker('stop','--time','60',c['Id'])
        docker('update','--restart=no',c['Id'])
    atomic_json(record,result);emit(result=result)
def move_unretire_source(req):
    """Switch back: the old copy gets its original restart policies, starts in its recorded order and leaves maintenance."""
    mid=move_id(req);cfg=req['config'];d,_=move_state(mid)
    record=d/'retired.json';done=d/'unretired.json'
    if not record.is_file():
        if done.is_file():emit(result=json.loads(done.read_text()));return
        raise ValueError('DockNest has no record of the stopped old copy for this move')
    retired=json.loads(record.read_text())
    for c in retired.get('containers',[]):
        policy=c.get('restartPolicy') if c.get('restartPolicy') in ['no','always','unless-stopped','on-failure'] else 'no'
        docker('update','--restart='+policy,c['id'])
    running=[c for c in req.get('running') or [] if isinstance(c,str) and SAFE_NAME.fullmatch(c)]
    if cfg.get('kind')!='static' and running:
        cfg.setdefault('maintenance',{});skip_refused_probes(cfg);plan=backup_plan(cfg)
        restart_services([cid for cid in plan['restartOrder'] if cid in running],plan['services'])
        cfg['_runningContainers']=running
        until=time.time()+120
        while time.time()<until and not health(running,probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):time.sleep(2)
        if not health(running,probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):raise ValueError('The old site did not become healthy after starting it again.')
        if cfg['maintenance'].get('required') and (pathlib.Path(cfg['maintenance'].get('directory',''))/'enabled').exists():maintenance(cfg,False)
    result={'started':len(running),'containers':retired.get('containers',[])}
    atomic_json(done,result);record.unlink();emit(result=result)
def move_remove_old(req):
    """Remove the stopped old copy after a move: its containers always; its data only when the owner asked for it.
    Data still mounted by any other container is never removed; system folders are refused."""
    mid=move_id(req);cfg=req['config'];d,_=move_state(mid)
    record=d/'retired.json';done=d/'removed.json'
    if not record.is_file():
        if done.is_file():emit(result=json.loads(done.read_text()));return
        raise ValueError('DockNest has no record of the stopped old copy for this move')
    retired=json.loads(record.read_text());ids=[c['id'] for c in retired.get('containers',[])]
    existing=[cid for cid in ids if docker('ps','-aq','--no-trunc','--filter','id='+cid).decode().split()]
    cs=inspect(existing) if existing else []
    if any(c['State'].get('Running') for c in cs):raise ValueError('The old copy is running again, so DockNest does not remove it.')
    volumes=list(dict.fromkeys(m['Name'] for c in cs for m in c['Mounts'] if m['Type']=='volume'))
    binds=list(dict.fromkeys(m['Source'] for c in cs for m in c['Mounts'] if m['Type']=='bind' and m.get('RW',True)))
    if cfg.get('kind')=='static' and cfg.get('documentRoot'):binds.append(cfg['documentRoot'])
    keep=[lexical(value) for value in req.get('keepPaths') or [] if isinstance(value,str) and value.startswith('/')]
    try:keep+=[lexical(site['documentRoot']) for site in nginx_sites() if site.get('documentRoot')]
    except Exception:pass
    keep=list(dict.fromkeys(keep+[lexical(os.path.realpath(value)) for value in keep]))
    homes={'/home','/root'}
    try:homes|={lexical(entry.pw_dir) for entry in __import__('pwd').getpwall() if entry.pw_dir.startswith('/')}
    except Exception:pass
    for c in cs:docker('rm',c['Id'])
    result={'containers':len(cs),'volumes':[],'paths':[],'dataKept':not req.get('deleteData')}
    if req.get('deleteData'):
        others=docker('ps','-aq').decode().split()
        used=[m for c in (inspect(others) if others else []) for m in c['Mounts']]
        for name in volumes:
            if not any(m['Type']=='volume' and m.get('Name')==name for m in used):docker('volume','rm',name);result['volumes'].append(name)
        result['kept']=[]
        for source in binds:
            path=lexical(source);real=lexical(os.path.realpath(source))
            shared=any(within(real,lexical(os.path.realpath(m['Source']))) or within(lexical(os.path.realpath(m['Source'])),real) for m in used)
            home=any(candidate==h or (candidate.startswith('/home/') and len(pathlib.PurePosixPath(candidate).parts)<=3) for candidate in [path,real] for h in homes)
            if shared or home or any(within(candidate,k) or within(k,candidate) for candidate in [path,real] for k in keep):result['kept'].append(path);continue
            try:p=move_path(source)
            except ValueError:result['kept'].append(path);continue
            if p.is_symlink() or p.is_file():p.unlink()
            elif p.is_dir():shutil.rmtree(p)
            else:continue
            result['paths'].append(str(p))
    atomic_json(done,result);record.unlink();emit(result=result)
# ---- Automatic restore tests (docs/restore-tests.md) ----
# A test restores a verified backup onto a test server with resource limits, checks it, and removes everything it
# created. Rules: every network, container, image, tag change, firewall rule and path is journalled in resources.json
# BEFORE it is created; teardown removes only what the journal lists and Docker still labels docknest.restore-test=<id>;
# it never uses `docker image rm -f`; plaintext staging lives only below the restore root and teardown removes it.
# Results say whether the backup came back ('failed' is the backup's fault) or the test could not finish ('couldnt_run').
RESTORE_TESTS_ROOT=pathlib.Path('/var/lib/docknest/restore-tests')
RESTORE_ROOT=pathlib.Path('/var/lib/docker-backup-manager/restore')
TEST_LABEL='docknest.restore-test'
TEST_MAIL_PORTS='25,465,587,2525'
TEST_MIN_FREE=1024**3
TEST_KINDS=['paths','networks','containers','images','tags','firewall']
REAPER_GRACE=600
TEST_PROBE_LIMIT=64*1024
TEST_PATH=re.compile(r'/[\x21-\x7e]{0,255}')
IMAGE_TAG=re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}')
class TestOutcome(Exception):
    """A verdict, not a crash: 'failed' when the backup did not come back, 'couldnt_run' when the test server or a
    test limit stopped it. `stop` stops the copy's containers at once (watchdogs)."""
    def __init__(self,outcome,reason,checks=None,stop=False):
        super().__init__(reason);self.outcome=outcome;self.reason=reason;self.checks=checks or [];self.stop=stop
def test_id(req):
    value=str(req.get('testId',''))
    if value!=str(uuid.UUID(value)):raise ValueError('Invalid restore test id')
    return value
def test_limits(req):
    limits=req.get('limits') or {}
    memory=limits.get('memoryMb');cpus=limits.get('cpus')
    if not isinstance(memory,int) or isinstance(memory,bool) or not 256<=memory<=16384:raise ValueError('The memory limit must be a whole number from 256 to 16384 MB')
    if not isinstance(cpus,(int,float)) or isinstance(cpus,bool) or not 0.5<=cpus<=16 or cpus*4!=int(cpus*4):raise ValueError('The CPU limit must be 0.5 to 16 in steps of 0.25')
    return memory,float(cpus),limits.get('internet') is True
def limit_args(memory,cpus):
    # Swap equal to memory means no swap on top. Restart 'no' makes a crash loop visible to the stability check.
    return ['--memory','%dm'%memory,'--memory-swap','%dm'%memory,'--cpus','%g'%cpus,'--pids-limit','1024','--restart','no','--log-driver','local','--log-opt','max-size=10m','--log-opt','max-file=3']
def test_dir(tid):return RESTORE_TESTS_ROOT/tid
def test_staging(tid):return RESTORE_ROOT/tid
def test_state(tid,create=False):
    d=test_dir(tid)
    if RESTORE_TESTS_ROOT.is_symlink() or d.is_symlink():raise ValueError('The restore test folder cannot be a symbolic link')
    if create:RESTORE_TESTS_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700);d.mkdir(exist_ok=True,mode=0o700)
    file=d/'resources.json'
    state=json.loads(file.read_text()) if file.is_file() else {}
    state.setdefault('created',{})
    for kind in TEST_KINDS:state['created'].setdefault(kind,[])
    return d,state
def test_journal(d,state,kind,value):
    """Written before the effect: a crash after this line leaves a record teardown can act on."""
    if value not in state['created'][kind]:state['created'][kind].append(value)
    atomic_json(d/'resources.json',state)
def test_check(name,kind,target,status,detail=None):
    return {'name':name,'kind':kind,'target':target,'status':status,'detail':(str(detail)[:200] if detail is not None else None)}
def test_lock(tid,wait_seconds=0):
    import fcntl
    d=test_dir(tid)
    if not d.is_dir():return None
    handle=open(d/'.lock','a');deadline=time.time()+wait_seconds
    while True:
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);return handle
        except BlockingIOError:
            if time.time()>=deadline:handle.close();raise ValueError('Another DockNest step for this restore test is still running on this server.')
            time.sleep(2)
def existing_ancestor(path):
    path=pathlib.Path(path)
    while not path.exists() and path!=path.parent:path=path.parent
    return path
def mem_available(text=None):
    try:
        for line in (text if text is not None else pathlib.Path('/proc/meminfo').read_text()).splitlines():
            if line.startswith('MemAvailable:'):return int(line.split()[1])*1024
    except (OSError,ValueError,IndexError):pass
    return None
def cpu_count():
    try:return len(os.sched_getaffinity(0))
    except (AttributeError,OSError):return os.cpu_count() or 1
def docker_major():
    try:return int(docker('version','--format','{{.Server.Version}}').decode().strip().split('.')[0])
    except (ValueError,IndexError):return 0
TEST_CHAINS=('DOCKER-USER','INPUT')
def test_mail_rules(tid=None):
    """Every firewall rule a restore test added (comment docknest-restore-test-<id>), in both chains and families."""
    marker='docknest-restore-test-'+(tid or '')
    rules=[]
    for tool in ['iptables','ip6tables']:
        if not shutil.which(tool):continue
        for chain in TEST_CHAINS:
            try:lines=run([tool,'-S',chain],timeout=10).decode().splitlines()
            except Exception:continue
            rules+=[(tool,line) for line in lines if line.startswith('-A '+chain+' ') and marker in line]
    return rules
def test_leftovers(tid=None):
    selector='label='+TEST_LABEL+('='+tid if tid else '')
    return {'containers':len(docker('ps','-aq','--filter',selector).decode().split()),'networks':len(docker('network','ls','-q','--filter',selector).decode().split()),'firewall':len(test_mail_rules(tid))}
def restore_test_check(req):
    """Read-only preflight ("Check space"). Each miss is one plain sentence; the manager ends the test couldnt_run."""
    tid=test_id(req);need=req.get('need') or {};problems=[];facts={}
    memory,cpus,internet=test_limits(req)
    facts['uid']=os.geteuid() if hasattr(os,'geteuid') else 0
    if facts['uid']!=0:problems.append('Restore tests need root SSH on the test server.')
    facts['freeBytes']=shutil.disk_usage(existing_ancestor(RESTORE_ROOT)).free
    size=int(need.get('bytes') or 0);required=size*3+1024**3
    if facts['freeBytes']<required:problems.append('The test server needs %.1f GB free for this backup and has %.1f GB.'%(required/1e9,facts['freeBytes']/1e9))
    if need.get('kind')!='static':
        facts['docker']=docker('version','--format','{{.Server.Version}}').decode().strip()[:40]
        facts['architecture']=docker('info','--format','{{.Architecture}}').decode().strip()[:40]
        if need.get('architecture') and need['architecture']!=facts['architecture']:problems.append('The test server has a different CPU architecture (%s) than the backup (%s).'%(facts['architecture'],str(need['architecture'])[:40]))
        if need.get('grouped') and docker_major()<28:problems.append('Sites with more than one container need Docker 28 or newer on the test server.')
        containers=max(1,int(need.get('containers') or 1));factor=2 if need.get('liveServer') else 1
        facts['memAvailableBytes']=mem_available()
        wanted=containers*memory*1024**2*factor
        if facts['memAvailableBytes'] is not None and facts['memAvailableBytes']<wanted:problems.append('The test server has %d MB of memory available; this test needs %d MB (%d container%s at %d MB%s). Lower the memory limit or free memory.'%(facts['memAvailableBytes']//1024**2,wanted//1024**2,containers,'' if containers==1 else 's',memory,', twice on the live server' if factor==2 else ''))
        facts['nproc']=cpu_count()
        if cpus>facts['nproc']:problems.append('The test server has %d CPU%s, so it cannot give each container %g. Lower the CPU limit.'%(facts['nproc'],'' if facts['nproc']==1 else 's',cpus))
        left=test_leftovers()
        if any(left.values()):problems.append('An earlier restore test left containers, networks or firewall rules on the test server. DockNest cleans them up first.')
        facts['firewall']={'iptables':bool(shutil.which('iptables')),'ip6tables':bool(shutil.which('ip6tables')),'nsenter':bool(shutil.which('nsenter'))}
        if internet and not all(facts['firewall'].values()):problems.append('The test server needs nsenter, iptables and ip6tables to block outgoing mail inside the copy, so the test cannot run with internet.')
        facts['probeTools']=bool(shutil.which('nsenter') and shutil.which('setpriv'))
    emit(result={'ok':not problems,'problems':problems,'facts':facts})
def write_private(path,content):
    temporary=path.with_name(path.name+'.new')
    temporary.unlink(missing_ok=True)
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o700)
    with os.fdopen(fd,'wb') as output:output.write(content);output.flush();os.fsync(output.fileno())
    os.replace(temporary,path)
def start_reaper(d,tid,source):
    """The backstop for a manager that is down or rolled back: a detached copy of this reviewed helper, sent by the
    manager, runs teardown once at the deadline plus the clean-up time and exits early when the journal is gone."""
    content=__import__('base64').b64decode(source,validate=True)
    if len(content)>1024*1024:raise ValueError('The reaper exceeds its size limit')
    write_private(d/'reaper.py',content)
    atomic_json(d/'reaper.json',{'operation':'restore-test-reap','testId':tid})
    argv=[sys.executable or 'python3','-I',str(d/'reaper.py')]
    def spawn(command):
        with open(d/'reaper.json','rb') as request:
            return subprocess.Popen(command,stdin=request,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd=str(d),close_fds=True,start_new_session=True)
    # A new session survives the SSH channel closing. Under systemd, logind with KillUserProcesses=yes would still end
    # it with the SSH session, so it runs in its own transient scope; if systemd-run refuses, the plain session is used.
    if systemd_present() and shutil.which('systemd-run'):
        process=spawn([shutil.which('systemd-run'),'--scope','--quiet','--description=DockNest restore test reaper',*argv])
        time.sleep(0.5)
        if process.poll() not in (None,0):process=spawn(argv)
    else:process=spawn(argv)
    return process.pid
def restore_test_prepare(req):
    """Copy backup, first half: the journal, the private staging root and the reaper. The package follows over SFTP."""
    if hasattr(os,'geteuid') and os.geteuid()!=0:raise ValueError('Restore tests need root SSH on the test server.')
    tid=test_id(req);deadline=float(req['deadline']);chain_length(req)
    # The reaper waits the manager's own clean-up time after the deadline (default 10 minutes).
    grace=req.get('grace',REAPER_GRACE)
    if not isinstance(grace,int) or isinstance(grace,bool) or not 60<=grace<=3600:raise ValueError('The clean-up time must be 60 to 3600 seconds')
    d,state=test_state(tid,create=True)
    if state.get('prepared'):raise ValueError('This restore test already ran on this server; DockNest cleans it up first.')
    root=test_staging(tid)
    if RESTORE_ROOT.is_symlink():raise ValueError('The restore root cannot be a symbolic link')
    test_journal(d,state,'paths',str(root))
    if root.exists() or root.is_symlink():raise ValueError('Restore test staging already exists')
    RESTORE_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700);root.mkdir(mode=0o700)
    state['deadline']=deadline;state['grace']=grace;state['prepared']=time.time();save_state(d,state)
    pid=start_reaper(d,tid,req['reaper']) if req.get('reaper') else None
    if isinstance(pid,int) and not isinstance(pid,bool):state['reaperPid']=pid;state['reaperStart']=process_start(pid);save_state(d,state)
    emit(result={'root':str(root),'remotePath':str(root/'payload.tar.gz'),'reaper':pid is not None,**chain_paths(req,root)})
def backup_side(error):
    """Errors from checking and unpacking the package: the backup did not come back, unless the server ran out of room."""
    if STOPPING:return error
    text=str(error)
    if re.search(r'capacity|space',text,re.I):return TestOutcome('couldnt_run','The test server ran low on disk.')
    if 'checksum mismatch' in text:return TestOutcome('couldnt_run','The copy on the test server did not match the backup; the transfer was damaged. Try again.')
    return TestOutcome('failed',text)
def image_archive_tags(archive):
    """repo:tag names a `docker save` archive would set on load (manifest.json, legacy `repositories`)."""
    tags=[]
    with tarfile.open(archive,'r:') as tar:
        for name in ['manifest.json','repositories']:
            try:member=tar.getmember(name)
            except KeyError:continue
            if not member.isfile() or member.size>4*1024*1024:continue
            data=json.loads(tar.extractfile(member).read())
            if name=='manifest.json':tags+=[tag for item in data if isinstance(item,dict) for tag in item.get('RepoTags') or []]
            elif isinstance(data,dict):tags+=[repo+':'+tag for repo,items in data.items() if isinstance(items,dict) for tag in items]
    tags=[tag for tag in dict.fromkeys(tags) if isinstance(tag,str) and IMAGE_TAG.fullmatch(tag)]
    if len(tags)>200:raise ValueError('The image archive names too many tags')
    return tags
def image_archive_names(archive):
    """Every image name an archive would set on load: docker save's manifest.json and repositories, and OCI index.json
    annotations (containerd image store). A DockNest backup saves images by ID, so this is empty for a real package."""
    names=[]
    with tarfile.open(archive,'r:') as tar:
        for name in ['manifest.json','repositories','index.json']:
            try:member=tar.getmember(name)
            except KeyError:continue
            # Raw content counts, before any name filter: a record this check cannot read is refused too.
            if not member.isfile() or member.size>4*1024*1024:raise ValueError('Unreadable image archive record')
            data=json.loads(tar.extractfile(member).read())
            if name=='manifest.json':names+=[str(tag) for item in (data if isinstance(data,list) else [data]) for tag in ((item.get('RepoTags') if isinstance(item,dict) else item) or [])]
            elif name=='repositories':
                if data:names+=[str(repo)+':'+str(tag) for repo,items in (data.items() if isinstance(data,dict) else [('?',data)]) for tag in (items if isinstance(items,dict) and items else [items])]
            else:
                for item in (data.get('manifests') or [] if isinstance(data,dict) else [data]):
                    annotations=item.get('annotations') if isinstance(item,dict) else None
                    if isinstance(annotations,dict):names+=[str(annotations[key]) for key in ['io.containerd.image.name','org.opencontainers.image.ref.name'] if annotations.get(key)]
    return list(dict.fromkeys(names))
def image_id_of(reference):
    try:return docker('image','inspect','--format','{{.Id}}',reference).decode().strip() or None
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired):return None
def image_tags(reference):
    try:return [tag for tag in json.loads(docker('image','inspect','--format','{{json .RepoTags}}',reference)) or [] if isinstance(tag,str)]
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,TypeError):return []
def load_images_keeping_tags(archive):
    """docker load for a restore or move. A DockNest backup saves images by ID, so an archive that names any image is not
    one DockNest made and is refused before loading; the tag restore after the load stays as a second guard."""
    try:names=image_archive_names(archive)
    except (tarfile.TarError,ValueError,OSError,AttributeError,TypeError):raise ValueError('The image archive in the backup cannot be read')
    if names:raise ValueError('The image archive names images (%s); DockNest backups save images by ID only, so it is not loaded.'%', '.join(names[:3]))
    state={'created':{'tags':[]}}
    try:docker('load','-i',str(archive))
    finally:restore_test_tags(state)
def restore_test_tags(state):
    """Point every tag the load moved back at the image it named before, so a later `docker compose up` on this server
    runs exactly what it ran before the test."""
    changed=[]
    for record in state['created']['tags']:
        previous=record.get('previous')
        if previous and image_id_of(record['tag'])!=previous:docker('tag',previous,record['tag']);changed.append(record['tag'])
    return changed
TEST_METADATA={'iptables':'169.254.169.254/32','ip6tables':'fd00:ec2::254/128'}
TEST_EGRESS_REFUSED={'NET_ADMIN','NET_RAW','SYS_ADMIN','ALL'}
SANDBOX_KEY=re.compile(r'/(?:var/)?run/docker/netns/[0-9a-zA-Z]{1,64}')
def internet_problem(containers):
    """Allow internet relies on rules inside each copy's own network namespace, which a copy that can change its
    firewall (NET_ADMIN and friends) or shares another namespace could undo. Such sites are tested without internet."""
    for c in containers:
        hc=c.get('HostConfig',{});mode=hc.get('NetworkMode') or ''
        caps={str(cap).upper().removeprefix('CAP_') for cap in hc.get('CapAdd') or []}&TEST_EGRESS_REFUSED
        name=c.get('Name','').lstrip('/') or 'A container'
        if caps:return 'Allow internet is refused: %s adds %s, which could remove the mail block inside the copy. Test this site without internet.'%(name,', '.join(sorted(caps)))
        if hc.get('Privileged') or mode=='host' or mode.startswith('container:'):return 'Allow internet is refused: %s shares the host or another container\'s network. Test this site without internet.'%name
    return None
def sandbox_key(cid):
    """The network namespace of a running container, by Docker's own sandbox path (never by PID)."""
    info=docker('inspect','--format','{{.State.Running}} {{.NetworkSettings.SandboxKey}}',cid).decode().split()
    if len(info)!=2 or info[0]!='true' or not SANDBOX_KEY.fullmatch(info[1]):return None
    return info[1]
def host_reject_addresses(extra=()):
    """Every address of this server (all interfaces, Docker bridges included, so also the Docker gateway), without
    loopback or link-local, which the copy needs for itself."""
    found=list(extra)
    try:
        for line in run(['ip','-o','addr','show'],timeout=10).decode().splitlines():
            match=re.search(r'\binet6? ([0-9a-fA-F.:]+)/',line)
            if not match:continue
            address=ipaddress.ip_address(match[1])
            if address.is_loopback or address.is_link_local:continue
            found.append(str(address))
    except Exception:raise TestOutcome('couldnt_run','The test server did not list its own addresses, so the copy cannot be kept away from it. The test does not run with internet.',stop=True)
    return list(dict.fromkeys(found))
def egress_rules(addresses):
    """OUTPUT rules for one copy: outbound mail, the cloud metadata service and this server itself, both families."""
    rules=[]
    for tool in ['iptables','ip6tables']:
        family=6 if tool=='ip6tables' else 4
        rules.append((tool,['-p','tcp','-m','multiport','--dports',TEST_MAIL_PORTS,'-j','REJECT']))
        rules.append((tool,['-d',TEST_METADATA[tool],'-j','REJECT']))
        rules+=[(tool,['-d',address,'-j','REJECT']) for address in addresses if ipaddress.ip_address(address).version==family]
    return rules
def isolate_egress(tid,ids,egress):
    """Event, once per container after `docker start`: the copy runs only on its internal isolated networks (no route
    out), its OUTPUT rules go into its own network namespace and are verified, and only then does it join the egress
    network. A host firewall reload or flush cannot remove these rules; any failure stops the test before egress."""
    gateways=[c.get('Gateway') for c in (json.loads(docker('network','inspect',egress))[0].get('IPAM') or {}).get('Config') or [] if c.get('Gateway')]
    rules=egress_rules(host_reject_addresses(gateways))
    nsenter=shutil.which('nsenter')
    for cid in ids:
        key=sandbox_key(cid)
        if not key or not nsenter:raise TestOutcome('couldnt_run','Outgoing mail could not be blocked inside the copy, so the test stopped before it reached the internet.',stop=True)
        for tool,args in rules:
            binary=shutil.which(tool)
            try:
                if not binary:raise ValueError(tool)
                run([nsenter,'--net='+key,binary,'-w','-I','OUTPUT',*args],timeout=20)
                run([nsenter,'--net='+key,binary,'-w','-C','OUTPUT',*args],timeout=20)
            except Exception:raise TestOutcome('couldnt_run','Outgoing mail could not be blocked inside the copy (%s), so the test stopped before it reached the internet.'%tool,stop=True)
        docker('network','connect',egress,cid)
def egress_intact(tid,ids):
    """On demand (restore-test-mail-check): every OUTPUT rule is still in each running copy's namespace."""
    nsenter=shutil.which('nsenter');rules=egress_rules([]);result=bool(ids)
    for cid in ids:
        key=sandbox_key(cid)
        if not key:continue
        for tool,args in rules:
            try:run([nsenter,'--net='+key,shutil.which(tool),'-w','-C','OUTPUT',*args],timeout=20)
            except Exception:result=False
    return result
def test_disk_low(tid):
    roots=[test_staging(tid)]
    try:roots.append(pathlib.Path(docker('info','--format','{{.DockerRootDir}}').decode().strip() or '/var/lib/docker'))
    except Exception:pass
    return min(shutil.disk_usage(existing_ancestor(root)).free for root in roots)<TEST_MIN_FREE
DISK_LOW='The test server ran low on disk.'
def test_unblock_mail(tid):
    """Belt and braces: restore tests add no host rules, but teardown removes any rule carrying their comment."""
    removed=0
    for tool,rule in test_mail_rules(tid):
        try:run([tool,'-D',*shlex.split(rule)[1:]],timeout=10);removed+=1
        except Exception:pass
    return removed
def restore_test_restore(req):
    """Restore copy: verify the package, unpack, load images (tags restored at once), create networks and containers
    with the test's limits, and block mail when internet is allowed. Nothing starts here."""
    tid=test_id(req);memory,cpus,internet=test_limits(req)
    d,state=test_state(tid)
    if not state.get('prepared'):raise ValueError('This restore test was not prepared on this server')
    if state.get('restored') or state['created']['containers'] or state['created']['networks']:raise ValueError('This restore test already restored its copy')
    root=test_staging(tid)
    try:unpacked,manifest,artifacts_verified=unpack_verified(req,root)
    except ValueError as error:raise backup_side(error)
    checks=[test_check('Package complete','package',None,'passed' if artifacts_verified else 'skipped',None if artifacts_verified else 'This older backup has no artifact list.')]
    try:external_restore_plan(manifest,[])
    except ValueError:raise TestOutcome('couldnt_run','This site needs external storage that a restore test cannot attach.',checks)
    if manifest.get('kind')=='static':
        if manifest.get('containers'):raise TestOutcome('failed','Invalid static backup manifest.',checks)
        directory=root/'static-site'
        try:safe_extract(unpacked/'static-files.tar',directory)
        except ValueError as error:raise backup_side(error)
        entries=list(directory.iterdir())
        if len(entries)!=1 or not entries[0].is_dir():raise TestOutcome('failed','The static archive must hold one website folder.',checks)
        if tree_digest(entries[0])!=manifest.get('staticFiles'):
            checks.append(test_check('Static files','static-files',None,'failed','The restored files differ from the captured website.'))
            raise TestOutcome('failed','The restored static files differ from the captured website.',checks)
        checks.append(test_check('Static files','static-files',None,'passed','%s files match'%(manifest.get('staticFiles') or {}).get('files','All')))
        state['restored']={'kind':'static'};save_state(d,state)
        emit(result={'outcome':'ok','kind':'static','checks':checks});return
    if manifest['architecture']!=docker('info','--format','{{.Architecture}}').decode().strip():raise TestOutcome('couldnt_run','The test server has a different CPU architecture than the backup.',checks)
    containers=manifest['containers']
    if internet and internet_problem(containers):raise TestOutcome('couldnt_run',internet_problem(containers),checks)
    if internet and not (shutil.which('nsenter') and shutil.which('iptables') and shutil.which('ip6tables')):raise TestOutcome('couldnt_run','The test server needs nsenter, iptables and ip6tables to block outgoing mail inside the copy, so the test does not run with internet.',checks)
    try:plans=restore_network_plan(containers)
    except ValueError as error:raise TestOutcome('couldnt_run',str(error),checks)
    if len(manifest.get('snapshotImages',[]))!=len(containers):raise TestOutcome('failed','The backup is missing snapshot images.',checks)
    multi=len(containers)>1
    if multi and docker_major()<28:raise TestOutcome('couldnt_run','Sites with more than one container need Docker 28 or newer on the test server.',checks)
    if shutil.disk_usage(root).free<mount_bytes(unpacked)+TEST_MIN_FREE:raise TestOutcome('couldnt_run','The test server ran low on disk.',checks)
    prefix='dbm-test-'+tid[:12]
    labels=['--label',TEST_LABEL+'='+tid,'--label','com.docker.compose.project=docknest-test-'+tid[:12],'--label','com.docker.compose.project.working_dir=','--label','com.docker.compose.project.config_files=']
    definitions=[];sources={}
    for i,c in enumerate(containers):
        name=prefix+('-'+str(i) if multi else '')
        args=['create','--name',name,'--network','none',*labels,*limit_args(memory,cpus)]
        if internet:args+=['--cap-drop','NET_ADMIN']
        if multi and plans[i] and not internet:args+=['--dns','127.0.0.1']
        try:
            for destination,options in temporary_mounts(c):args+=['--tmpfs',tmpfs_argument(destination,options)]
        except ValueError as error:raise TestOutcome('couldnt_run',str(error),checks)
        for j,m in enumerate(c['Mounts']):
            try:source=extract_mount(unpacked,i,j,m,sources,root)
            except MountLayoutError as error:
                if error.kind=='overlap':raise TestOutcome('couldnt_run','Overlapping mount paths need a reviewed offline restore.',checks)
                raise TestOutcome('failed','A mount archive must hold exactly one entry.',checks)
            except ValueError as error:raise backup_side(error)
            if ',' in str(source) or ',' in m['Destination']:raise TestOutcome('couldnt_run','Mount paths with commas need a reviewed offline restore.',checks)
            mount='type=bind,src='+str(source)+',dst='+m['Destination']
            if not m.get('RW',True):mount+=',readonly'
            args+=['--mount',mount]
        definitions.append((name,args+[manifest['snapshotImages'][i]]))
    sqlite_cache={}
    for service in manifest.get('backupPlan',{}).get('services',[]):
        if not service.get('sqliteFiles'):continue
        original=next(c for c in containers if c['Id']==service['container'])
        restored={**original,'Mounts':[{**mount,'Source':str(sources[(mount['Type'],mount['Source'])])} for mount in original['Mounts']]}
        actual=cached_sqlite_file_proof(sqlite_cache,service,restored)
        target=original['Name'].lstrip('/')
        if actual!=service.get('expectedSqliteChecks'):
            checks.append(test_check('Database checks','sqlite',target,'failed','SQLite checks differ from capture.'))
            raise TestOutcome('failed','SQLite checks differ from the values recorded at capture.',checks)
        checks.extend(test_check('Database checks','sqlite',target,'passed',check.get('method')) for check in actual)
    # Images: containers use snapshot image IDs, never tags. Only IDs this server did not have are test-only.
    before=set(docker('images','-aq','--no-trunc').decode().split())
    wanted=list(dict.fromkeys(manifest['snapshotImages']+[item.get('Id') for item in manifest.get('originalImages') or [] if isinstance(item,dict) and isinstance(item.get('Id'),str)]))
    try:tags=[tag for archive in image_archives(unpacked) for tag in image_archive_names(archive)]
    except (tarfile.TarError,ValueError,OSError,AttributeError,TypeError):raise TestOutcome('failed','The image archive in the backup cannot be read.',checks)
    if len(tags)>200 or any(not IMAGE_TAG.fullmatch(tag) for tag in tags):raise TestOutcome('failed','The image archive in the backup names images DockNest cannot put back.',checks)
    for tag in tags:test_journal(d,state,'tags',{'tag':tag,'previous':image_id_of(tag)})
    for image in wanted:
        if image not in before:test_journal(d,state,'images',image)
    try:
        for archive in image_archives(unpacked):docker('load','-i',str(archive))
    finally:restore_test_tags(state)
    networks={};created=[]
    # Every copy starts on fresh internal isolated networks only. With internet, a single container gets one such
    # network too (a `none` container cannot join the egress network later).
    originals=list(dict.fromkeys(name for plan in plans for name in plan))
    if internet and not any(plans):originals=['']
    for index,original in enumerate(originals):
        name=prefix+'-net-'+str(index)
        test_journal(d,state,'networks',name)
        docker('network','create','--internal','--driver','bridge','--opt','com.docker.network.bridge.gateway_mode_ipv4=isolated','--opt','com.docker.network.bridge.gateway_mode_ipv6=isolated','--label',TEST_LABEL+'='+tid,name)
        networks[original]=name
        n=json.loads(docker('network','inspect',name))[0]
        if not n['Internal'] or n.get('EnableIPv6') or n.get('Options',{}).get('com.docker.network.bridge.gateway_mode_ipv4')!='isolated':raise TestOutcome('couldnt_run','The test server did not create an isolated network.',checks)
    egress=None
    if internet:
        egress=prefix+'-egress';test_journal(d,state,'networks',egress)
        docker('network','create','--driver','bridge','--label',TEST_LABEL+'='+tid,egress)
    for i,(name,args) in enumerate(definitions):
        primary=next(iter(plans[i]),None) if plans[i] else ('' if '' in networks else None)
        if primary is not None:
            args[args.index('--network')+1]=networks[primary]
            args[1:1]=[part for alias in (plans[i].get(primary) or []) for part in ['--network-alias',alias]]
        test_journal(d,state,'containers',name)
        cid=docker(*args).decode().strip();created.append(cid)
        for original,aliases in list(plans[i].items())[1:]:
            docker('network','connect',*[part for alias in aliases for part in ['--alias',alias]],networks[original],cid)
    ordered=manifest.get('backupPlan',{}).get('restartOrder',[c['Id'] for c in containers])
    mapping={c['Id']:cid for c,cid in zip(containers,created)}
    running=[mapping[o] for o in ordered if next(c for c in containers if c['Id']==o)['State'].get('Running')]
    state['restored']={'kind':'docker','containers':[{'name':definitions[i][0],'id':cid,'original':c['Name'].lstrip('/')} for i,(c,cid) in enumerate(zip(containers,created))],'running':running,'networks':list(networks.values()),'internet':internet,'egress':egress}
    save_state(d,state)
    emit(result={'outcome':'ok','kind':'docker','containers':len(created),'running':len(running),'networkMode':'internet' if internet else 'isolated-internal' if networks else 'none','mailBlocked':internet,'checks':checks})
def cgroup_counter(cid,filename,key):
    for base in ['/sys/fs/cgroup/system.slice/docker-%s.scope'%cid,'/sys/fs/cgroup/docker/%s'%cid]:
        try:
            for line in pathlib.Path(base,filename).read_text().splitlines():
                parts=line.split()
                if len(parts)==2 and parts[0]==key:return int(parts[1])
        except (OSError,ValueError):continue
    return 0
def limit_problem(states):
    """A container a test limit stopped: the test could not finish, which says nothing about the backup."""
    for c in states:
        if c['State'].get('OOMKilled') or cgroup_counter(c['Id'],'memory.events','oom_kill'):return 'memory'
        if cgroup_counter(c['Id'],'pids.events','max'):return 'process'
    return None
def limit_outcome(kind,checks=None):
    return TestOutcome('couldnt_run','Test couldn\'t finish: %s limit. Raise it in Advanced.'%kind,checks,stop=True)
def test_manifest(tid):
    return json.loads((test_staging(tid)/'unpacked'/'manifest.json').read_text())
def restored_state(tid):
    d,state=test_state(tid);restored=state.get('restored') or {}
    if restored.get('kind')!='docker':raise ValueError('This restore test has no containers to check on this server')
    return d,state,restored
def stop_test_containers(tid):
    try:
        ids=docker('ps','-q','--filter','label='+TEST_LABEL+'='+tid).decode().split()
        if ids:docker('stop','--time','10',*ids)
    except Exception:pass
def test_contracts(manifest,restored):
    mapping={c['Id']:item['id'] for c,item in zip(manifest['containers'],restored['containers'])}
    contracts=[{**s,'container':mapping[s['container']],'dependsOn':[mapping[x] for x in s.get('dependsOn',[]) if x in mapping]} for s in manifest.get('backupPlan',{}).get('services',[]) if s.get('container') in mapping]
    return mapping,contracts
def restore_test_start(req):
    """Start containers in the captured restart order; a level starts once the level before it is healthy."""
    tid=test_id(req);d,state,restored=restored_state(tid)
    if test_disk_low(tid):raise TestOutcome('couldnt_run',DISK_LOW)
    _,contracts=test_contracts(test_manifest(tid),restored)
    running=restored['running']
    started=(lambda ids:isolate_egress(tid,ids,restored['egress'])) if restored.get('internet') else None
    try:restart_services(running,contracts,started=started)
    except ValueError as error:
        if STOPPING:raise
        states=inspect(running) if running else []
        problem=limit_problem(states)
        if problem:raise limit_outcome(problem)
        raise TestOutcome('failed','The containers did not start and become healthy within 120 seconds.',[test_check('Docker health','health',None,'failed',str(error)[:200])])
    emit(result={'outcome':'ok','started':len(running)})
PROBE_SCRIPT=r'''
import http.client,json,sys,time
started=time.monotonic();status=None
try:
    connection=http.client.HTTPConnection('127.0.0.1',int(sys.argv[1]),timeout=10)
    connection.request('GET',sys.argv[2],headers={'User-Agent':'DockNest-restore-test','Connection':'close','Accept':'*/*'})
    response=connection.getresponse();response.read(65536);status=response.status
except Exception:pass
print(json.dumps({'status':status,'ms':round((time.monotonic()-started)*1000)}))
'''
def restore_test_probe(cid,probe,target):
    """GET on loopback inside the container's network namespace, as the nobody user with no new privileges, using the
    host's isolated Python: no tool in the image and no port opened. Only the status code and time are kept."""
    port=probe.get('port');path=probe.get('path') or '/'
    if not isinstance(port,int) or isinstance(port,bool) or not 1<=port<=65535 or not isinstance(path,str) or not TEST_PATH.fullmatch(path):return test_check('Internal web check','http',target,'skipped','The web check settings are not valid.')
    nsenter,setpriv=shutil.which('nsenter'),shutil.which('setpriv')
    if not nsenter or not setpriv:return test_check('Internal web check','http',target,'skipped','nsenter or setpriv (util-linux) is missing on the test server.')
    key=sandbox_key(cid)
    if not key:return test_check('Internal web check','http',target,'failed','The container is not running.')
    try:output=run([nsenter,'--net='+key,setpriv,'--reuid','65534','--regid','65534','--clear-groups','--no-new-privs',shutil.which('python3') or sys.executable,'-I','-c',PROBE_SCRIPT,str(port),path],timeout=20)
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired):return test_check('Internal web check','http',target,'failed','The web check could not run.')
    try:answer=json.loads(output.decode().strip().splitlines()[-1])
    except (ValueError,IndexError):return test_check('Internal web check','http',target,'failed','The web check gave no answer.')
    status=answer.get('status');ms=int(answer.get('ms') or 0)
    if isinstance(status,int) and 200<=status<=399:return test_check('Internal web check','http',target,'passed','HTTP %d in %d ms'%(status,ms))
    return test_check('Internal web check','http',target,'failed','HTTP %d'%status if isinstance(status,int) else 'No answer within 10 seconds')
def restore_test_poll(req):
    """One health poll across ticks: container state. The final poll, 60 seconds after start, is the end of the step:
    it re-checks free space and runs the configured database checks and the internal web check."""
    tid=test_id(req);d,state,restored=restored_state(tid);final=req.get('final') is True
    if final and test_disk_low(tid):raise TestOutcome('couldnt_run',DISK_LOW,stop=True)
    items={item['id']:item for item in restored['containers']}
    states=inspect(list(items)) if items else []
    running=set(restored['running'])
    for c in states:
        target=items.get(c['Id'],{}).get('original')
        if c['Id'] not in running:continue
        if not c['State'].get('Running'):
            problem=limit_problem([c])
            if problem:raise limit_outcome(problem)
            check=test_check('Still running' if final or req.get('stable') else 'Containers running','stable' if final or req.get('stable') else 'running',target,'failed','Stopped with exit code %s'%c['State'].get('ExitCode'))
            raise TestOutcome('failed','%s stopped after it started (exit code %s).'%(target,c['State'].get('ExitCode')),[check])
        if c['State'].get('Health',{}).get('Status')=='unhealthy':raise TestOutcome('failed','%s reports unhealthy.'%target,[test_check('Docker health','health',target,'failed','unhealthy')])
    healthy=all(c['State'].get('Health',{}).get('Status','healthy')=='healthy' for c in states if c['Id'] in running)
    result={'outcome':'ok','healthy':healthy,'running':len(running)}
    if final:
        if not healthy:raise TestOutcome('failed','A service did not stay healthy.',[test_check('Docker health','health',None,'failed','not healthy')])
        checks=[test_check('Containers running','running',None,'passed','%d running'%len(running))]
        if any('Health' in c['State'] for c in states if c['Id'] in running):checks.append(test_check('Docker health','health',None,'passed','healthy'))
        checks.append(test_check('Still running','stable',None,'passed','60 seconds later'))
        manifest=test_manifest(tid);mapping,contracts=test_contracts(manifest,restored)
        names={c['Id']:c['Name'].lstrip('/') for c in manifest['containers']}
        for original,service in zip([s['container'] for s in manifest.get('backupPlan',{}).get('services',[]) if s.get('container') in mapping],contracts):
            if service['engine']=='generic' or not service.get('checks'):continue
            try:actual=data_checks(service['container'],service)
            except (ValueError,subprocess.CalledProcessError,subprocess.TimeoutExpired):actual=None
            if actual!=service.get('expectedChecks',[]):
                checks.append(test_check('Database checks','database',names.get(original),'failed','Differs from capture'))
                raise TestOutcome('failed','Database checks differ from the values recorded at capture.',checks)
            checks.extend(test_check('Database checks','database',names.get(original),'passed',item['name']) for item in actual)
        probe=req.get('probe')
        if isinstance(probe,dict):
            by_name={item['original']:item['id'] for item in restored['containers']}
            target=probe.get('service')
            if target not in by_name:checks.append(test_check('Internal web check','http',str(target)[:80],'skipped','This backup has no service with that name.'))
            else:
                check=restore_test_probe(by_name[target],probe,target);checks.append(check)
                if check['status']=='failed':raise TestOutcome('failed','The internal web check failed: %s.'%check['detail'],checks)
        result['checks']=checks
    emit(result=result)
def restore_test_run(req):
    phase=req.get('phase')
    work={'restore':restore_test_restore,'start':restore_test_start,'poll':restore_test_poll}.get(phase)
    if not work:raise ValueError('Unsupported restore test phase')
    tid=test_id(req)
    try:work(req)
    except TestOutcome as outcome:
        if outcome.stop:stop_test_containers(tid)
        emit(result={'outcome':outcome.outcome,'reason':outcome.reason[:300],'checks':outcome.checks})
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as error:
        if STOPPING:raise
        # Docker's arguments hold data paths, so only the command name and exit code are reported.
        command=error.cmd[:2] if isinstance(error.cmd,list) else ['a command']
        label=' '.join(pathlib.Path(str(part)).name for part in command)
        emit(result={'outcome':'couldnt_run','reason':('The test server timed out running %s.'%label if isinstance(error,subprocess.TimeoutExpired) else 'The test server could not run %s (exit code %s).'%(label,error.returncode))[:300],'checks':[]})
def remove_test_path(value,tid):
    """Only the test's own staging folder directly below the restore root, never through a link."""
    p=pathlib.Path(value)
    if p.name!=tid or p.parent!=RESTORE_ROOT or RESTORE_ROOT.is_symlink():raise ValueError('Restore test clean-up refused a path outside the restore root')
    if os.path.realpath(p.parent)!=os.path.realpath(RESTORE_ROOT):raise ValueError('Restore test clean-up refused a linked restore root')
    if p.is_symlink():p.unlink();return
    if not p.exists():return
    if os.name=='posix' and not getattr(shutil.rmtree,'avoids_symlink_attacks',False):raise ValueError('Safe directory removal is unavailable on this host')
    shutil.rmtree(p)
def process_start(pid):
    """The kernel's start time of a process (field 22 of /proc/<pid>/stat), which a reused PID does not share."""
    try:return int(pathlib.Path('/proc/%d/stat'%pid).read_text().rsplit(')',1)[1].split()[19])
    except (OSError,ValueError,IndexError):return None
def process_cmdline(pid):
    try:return pathlib.Path('/proc/%d/cmdline'%pid).read_bytes()
    except OSError:return b''
def stop_reaper(tid,state):
    """Event, at teardown: the manager finished, so this test's reaper has nothing left to do. Only a process whose
    command line is this test's reaper is signalled, never a reused PID."""
    pid=state.get('reaperPid')
    if not isinstance(pid,int) or isinstance(pid,bool) or pid<=1 or pid==os.getpid():return False
    if ('restore-tests/%s/reaper.py'%tid).encode() not in process_cmdline(pid):return False  # already gone
    if state.get('reaperStart') is not None and process_start(pid)!=state['reaperStart']:return False  # a reused PID
    try:os.kill(pid,signal.SIGTERM);return True
    except OSError:return False  # exited meanwhile; teardown stays idempotent
def restore_test_teardown(req):
    """Idempotent. Containers by label, firewall rules by comment, then journalled networks that still carry the label,
    test-only tags and images (never -f), the staging folder and last the journal, once nothing is left."""
    tid=test_id(req);d=test_dir(tid)
    if d.is_symlink():raise ValueError('The restore test folder cannot be a symbolic link')
    state=test_state(tid)[1] if d.is_dir() else {'created':{kind:[] for kind in TEST_KINDS}}
    ids=docker('ps','-aq','--no-trunc','--filter','label='+TEST_LABEL+'='+tid).decode().split()
    if ids:docker('rm','-f',*ids)
    counts={'containers':len(ids),'firewall':test_unblock_mail(tid),'networks':0,'images':0,'tags':0,'paths':0}
    for name in reversed(state['created']['networks']):
        found=docker('network','ls','-q','--filter','name=^'+re.escape(name)+'$','--filter','label='+TEST_LABEL+'='+tid).decode().split()
        if found:docker('network','rm',*found);counts['networks']+=1
    test_images=set(state['created']['images']);kept=0
    try:restore_test_tags(state)
    except Exception:pass  # the earlier image is gone; nothing to point the tag back at
    for record in state['created']['tags']:
        # A tag the load added is untagged only when its image has other tags too; otherwise removing the image by
        # ID below takes the tag with it, and an image another container uses keeps its only name.
        if record.get('previous') is None and image_id_of(record['tag']) in test_images and len(image_tags(record['tag']))>1:
            try:docker('image','rm',record['tag']);counts['tags']+=1
            except Exception:pass
    for image in state['created']['images']:
        if image_id_of(image) is None:continue
        try:docker('image','rm',image);counts['images']+=1
        except Exception:kept+=1  # a non-test container uses it now; kept and reported
    for value in dict.fromkeys(state['created']['paths']+[str(test_staging(tid))]):
        if pathlib.Path(value).exists() or pathlib.Path(value).is_symlink():remove_test_path(value,tid);counts['paths']+=1
    left=test_leftovers(tid);left['staging']=int(test_staging(tid).exists())
    if any(left.values()):raise ValueError('Clean-up left %s on the test server.'%', '.join('%d %s'%(n,kind) for kind,n in left.items() if n))
    if d.is_dir():
        if os.path.realpath(d.parent)!=os.path.realpath(RESTORE_TESTS_ROOT):raise ValueError('Restore test clean-up refused a linked journal folder')
        stop_reaper(tid,state)
        shutil.rmtree(d)
    emit(result={'removed':True,'counts':counts,'keptImages':kept})
def restore_test_status(req):
    tid=test_id(req);left=test_leftovers(tid)
    result={**left,'staging':test_staging(tid).exists(),'journal':test_dir(tid).exists()}
    result['present']=bool(any(left.values()) or result['staging'] or result['journal'])
    emit(result=result)
def restore_test_reap(req,sleep=time.sleep,clock=time.time):
    """The detached reaper: one timer until the deadline plus the clean-up time, no periodic work. Then, only if the
    manager did not finish (the journal is still there), it runs teardown once and exits."""
    tid=test_id(req);file=test_dir(tid)/'resources.json'
    # The manager's teardown sends SIGTERM when it finished first: exit at once without acting.
    signal.signal(signal.SIGTERM,lambda *_:os._exit(0))
    try:
        state=json.loads(file.read_text());deadline=float(state.get('deadline'))
        grace=state.get('grace') if isinstance(state.get('grace'),int) and 60<=state.get('grace')<=3600 else REAPER_GRACE
    except (OSError,ValueError,TypeError):return
    while (remaining:=deadline+grace-clock())>0:sleep(remaining)  # re-arms only if the sleep ended early
    if not file.is_file():return
    lock=None
    try:
        lock=test_lock(tid,600) if os.name=='posix' else None
        if file.is_file():restore_test_teardown({'testId':tid})
    except Exception:pass
    finally:
        if lock:lock.close()
STOPPING=False;MOVE_ID='';SNAPSHOT_FILTER=''
LOCKED_TEST_OPS={'restore-test-prepare','restore-test-run','restore-test-teardown'}
LOCKED_MOVE_OPS={'deploy-restore','deploy-teardown','move-test','move-resume-source','move-retire-source','move-finalize-target','move-certificate','move-stop-target','move-unretire-source','move-remove-old'}
MOVE_LOCK=None
def move_lock(mid,wait=False):
    import fcntl
    d=MOVES_ROOT/mid;MOVES_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700);d.mkdir(exist_ok=True,mode=0o700)
    handle=open(d/'.lock','a')
    try:fcntl.flock(handle,fcntl.LOCK_EX|(0 if wait else fcntl.LOCK_NB))
    except BlockingIOError:handle.close();return None
    return handle
def docker_snapshot():
    try:return subprocess.run(['docker','ps','-a','--no-trunc','--filter',SNAPSHOT_FILTER or 'label=docknest.move='+MOVE_ID,'--format','{{.ID}} {{.State}}'],capture_output=True,timeout=20).stdout.decode().split('\n')
    except Exception:return None
def stop_after_stdin(read=None,limit=180):
    """DockNest keeps stdin open while it waits. When it gives up (time limit) or its connection drops, stdin ends:
    end every child process, then keep the move lock (this process) until Docker has settled, meaning two snapshots of
    the move's containers 2 s apart are identical and none is restarting or being removed. A Try again never races
    Docker's own work."""
    global STOPPING
    try:(read or sys.stdin.read)()
    except Exception:pass
    STOPPING=True
    try:signal.signal(signal.SIGTERM,signal.SIG_IGN);os.killpg(os.getpgrp(),signal.SIGTERM)
    except Exception:pass
    deadline=time.time()+limit;previous=None
    while time.time()<deadline:
        current=docker_snapshot()
        if current is not None and current==previous and not any(line.endswith((' restarting',' removing')) for line in current):break
        previous=current;time.sleep(2)
    os._exit(1)
def watch_stdin():threading.Thread(target=stop_after_stdin,daemon=True).start()
def main(req):
    global EVENT_STREAM,CAPTURE_DIAGNOSTICS,MOVE_LOCK,MOVE_ID,SNAPSHOT_FILTER
    if req.get('operation')=='move-lock-status':
        handle=move_lock(move_id(req))
        emit(result={'busy':handle is None})
        return
    if req.get('operation') in LOCKED_MOVE_OPS:
        MOVE_LOCK=move_lock(move_id(req));MOVE_ID=move_id(req)
        if MOVE_LOCK is None:raise ValueError('Another DockNest step for this move is still running on this server.')
        if req.get('watchStdin'):watch_stdin()
    if req.get('operation') in LOCKED_TEST_OPS:
        tid=test_id(req)
        if req['operation']=='restore-test-prepare':test_state(tid,create=True)
        # Teardown waits for a step DockNest just stopped to let go of the copy; other steps never queue behind one.
        MOVE_LOCK=test_lock(tid,200 if req['operation']=='restore-test-teardown' else 0)
        SNAPSHOT_FILTER='label='+TEST_LABEL+'='+tid
        if req.get('watchStdin'):watch_stdin()
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
    elif op=='setup-maintenance':setup_maintenance(req)
    elif op=='verify-restore-recovery':verify_restore_recovery(req)
    elif op=='deploy-maintenance':deploy_maintenance(req)
    elif op=='maintenance':
        req['config'].setdefault('maintenance',{})['required']=True
        refused=skip_refused_probes(req['config'])
        if req['enabled'] and 'public' in refused:raise ValueError("Probe URL policy: %s. Update the site's public maintenance URL before enabling maintenance."%refused['public'])
        maintenance(req['config'],req['enabled']);emit(result={'enabled':req['enabled']})
    elif op=='cleanup':cleanup_staging(req);emit(result={'removed':True})
    elif op=='incremental-commit':incremental_commit(req)
    elif op=='incremental-discard':incremental_discard(req)
    elif op=='list-staging':emit(result=list_staging(req['config']))
    elif op=='move-facts':move_facts(req)
    elif op=='install-status':install_status()
    elif op=='install':install_package(req)
    elif op=='deploy-restore':deploy_restore(req)
    elif op=='deploy-teardown':deploy_teardown(req)
    elif op=='deploy-status':deploy_status(req)
    elif op=='move-test':move_test(req)
    elif op=='move-resume-source':move_resume_source(req)
    elif op=='move-retire-source':move_retire_source(req)
    elif op=='move-finalize-target':move_finalize_target(req)
    elif op=='move-certificate':move_certificate(req)
    elif op=='move-stop-target':move_stop_target(req)
    elif op=='move-unretire-source':move_unretire_source(req)
    elif op=='move-remove-old':move_remove_old(req)
    elif op=='restore-test-check':restore_test_check(req)
    elif op=='restore-test-prepare':restore_test_prepare(req)
    elif op=='restore-test-run':restore_test_run(req)
    elif op=='restore-test-teardown':restore_test_teardown(req)
    elif op=='restore-test-status':restore_test_status(req)
    elif op=='restore-test-mail-check':
        tid=test_id(req);_,state=test_state(tid);ids=[item['id'] for item in (state.get('restored') or {}).get('containers',[]) if item['id'] in (state.get('restored') or {}).get('running',[])]
        emit(result={'intact':egress_intact(tid,ids) if (state.get('restored') or {}).get('internet') else None})
    elif op=='restore-test-reap':restore_test_reap(req)
    else:raise ValueError('Unsupported helper operation')
if __name__=='__main__' and sys.argv[1:2]==['restore-chain']:
    # Recovery kit, run by hand as root: python3 helper.py restore-chain <decrypted chain folder> <new empty folder>.
    # DockNest itself runs the helper from stdin (python3 -c), so this never matches its own calls.
    if len(sys.argv)!=4:print('Usage: python3 helper.py restore-chain <folder written by decrypt-backup.js --chain> <new empty folder>',file=sys.stderr);sys.exit(2)
    try:restore_chain_offline(sys.argv[2],sys.argv[3])
    except Exception as e:print('Chain restore failed: %s'%e,file=sys.stderr);sys.exit(1)
elif __name__=='__main__':
    try:main(json.loads(sys.stdin.readline()))
    except Exception as e:
        diagnostic(phase='helper-failure',exceptionType=type(e).__name__)
        emit(error=str(e));sys.exit(1)
