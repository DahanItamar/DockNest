#!/usr/bin/env python3
# helper/common.py: Shared core: version, event output (emit/diagnostic), run/docker/inspect, staging base, atomic files,
# and ALL mutable runtime state.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
# </build:header>
"""Versioned Linux helper. No request values are interpolated into shell commands."""
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
VERSION=1

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

SHARED_SYSTEM_FOLDERS={'/','/var','/var/lib','/root','/home','/srv','/opt','/etc','/tmp','/usr','/var/www'}
def private_staging_base(base,traverse=False):
    """The shared staging folder: root-owned, never readable or writable by others.
    Others may only pass through it (0711), so nginx can reach a maintenance page kept under it."""
    base=pathlib.Path(base)
    if str(base) in SHARED_SYSTEM_FOLDERS or not base.is_absolute() or '..' in base.parts:raise ValueError('Dedicated root-owned staging directory required')
    base.mkdir(parents=True,exist_ok=True,mode=0o700)
    info=base.stat()
    # The helper runs as root, so this is the root-ownership check.
    if info.st_uid!=os.geteuid():raise ValueError('Staging directory must be owned by root')
    mode=0o711 if traverse or info.st_mode&0o011 else 0o700
    if stat.S_IMODE(info.st_mode)&0o077!=mode&0o077:os.chmod(base,mode)
    return base
def create_staging_root(root):
    root=pathlib.Path(root)
    if os.name=='posix' and os.geteuid()==0 and str(root.parent) not in SHARED_SYSTEM_FOLDERS:private_staging_base(root.parent)
    root.mkdir(parents=True,mode=0o700)
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

TRANSFER=None
PROBE_POLICY_FALLBACKS=[]

# ---- Chain restore ----
# Every package's transfer checksum and every manifest link are checked before any archive is extracted. Each mount is
# then rebuilt in one fresh directory: the full archive, then each increment in order with --listed-incremental=/dev/null
# (which applies deletions and renames), after the same path checks as safe_extract plus the GNU.dumpdir names.
CHAIN_LINKS={}
STOPPING=False;MOVE_ID='';SNAPSHOT_FILTER=''
MOVE_LOCK=None
