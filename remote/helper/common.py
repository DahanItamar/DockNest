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

# ---- Container hardening: a copy (restore, restore test, move) keeps the original's protections ----
# Docker's default capabilities: every container already has them, so adding one changes nothing. NET_RAW is left out
# on purpose: a site that adds it is refused like any other extra capability. The one definition for restores, restore
# tests, moves and the Compose allow-list.
DEFAULT_CAPABILITIES=frozenset({'AUDIT_WRITE','CHOWN','DAC_OVERRIDE','FOWNER','FSETID','KILL','MKNOD','NET_BIND_SERVICE','SETFCAP','SETGID','SETPCAP','SETUID','SYS_CHROOT'})
DOCKER_BASE_CAPABILITIES=DEFAULT_CAPABILITIES|{'NET_RAW'}  # what a container without CapAdd/CapDrop starts with
CAPABILITY_NAME=re.compile(r'[A-Z][A-Z0-9_]{1,31}')
APPARMOR_PROFILE=re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}')
SELINUX_LABEL=re.compile(r'[A-Za-z0-9_.:,=-]{1,255}')
SECCOMP_LIMIT=1024*1024
APPARMOR_PROFILES='/sys/kernel/security/apparmor/profiles'
RELAXING_OPTIONS={'systempaths=unconfined':'systempaths=unconfined','systempaths:unconfined':'systempaths=unconfined','writable-cgroups=true':'writable-cgroups=true','writable-cgroups:true':'writable-cgroups=true','writable-cgroups=false':None,'writable-cgroups:false':None}  # None: Docker's default anyway
def capability_name(value):
    name=value.strip().upper().removeprefix('CAP_') if isinstance(value,str) else ''
    return name if CAPABILITY_NAME.fullmatch(name) else None
def extra_capabilities(added):
    """True when anything is added beyond Docker's defaults (ALL, NET_RAW, SYS_ADMIN, ... or a value that is no name)."""
    return any(capability_name(cap) not in DEFAULT_CAPABILITIES for cap in added or [])
def container_label(c):return str(c.get('Name') or '').lstrip('/') or str(c.get('Id') or '')[:12] or 'A container'
def seccomp_profile(value,name):
    """'default', 'unconfined' or the profile as canonical JSON. Docker stores a custom profile's contents; an absolute
    path (Compose files, other tools) must name a readable profile file on this server."""
    if value=='builtin':return 'default'
    if value=='unconfined':return value
    text=value
    if not value.lstrip().startswith('{'):
        path=pathlib.Path(value)
        if not value.startswith('/') or '..' in path.parts:raise ValueError('Container %s uses the seccomp profile %s. Use an absolute path to the profile file.'%(name,value[:256]))
        try:
            fd=os.open(path,os.O_RDONLY|NOFOLLOW|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_CLOEXEC',0))  # a FIFO never blocks
            with os.fdopen(fd,'rb') as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):raise OSError('not a file')
                text=source.read(SECCOMP_LIMIT+1).decode()
        except (OSError,UnicodeDecodeError):raise ValueError('Container %s uses the seccomp profile %s, which is not on this server. Copy the file to the same path, then try again.'%(name,value[:256]))
    try:profile=json.loads(text) if len(text)<=SECCOMP_LIMIT else None
    except ValueError:profile=None
    if not isinstance(profile,dict):raise ValueError('Container %s has a seccomp profile DockNest cannot read.'%name)
    return json.dumps(profile,sort_keys=True,separators=(',',':'))
def hardening(c):
    """The protections a copy must keep, read from the container's HostConfig. Refuses what DockNest cannot reproduce."""
    hc=c.get('HostConfig') or {};name=container_label(c)
    drop,add=[],[]
    for kind,values,result in [('drops',hc.get('CapDrop'),drop),('adds',hc.get('CapAdd'),add)]:
        for value in values or []:
            cap=capability_name(value)
            if cap is None:raise ValueError('Container %s %s a capability DockNest does not recognize (%s).'%(name,kind,str(value)[:64]))
            if cap not in result:result.append(cap)
    found={'noNewPrivileges':False,'seccomp':'default','apparmor':None,'labels':[],'relaxed':[]}
    for item in hc.get('SecurityOpt') or []:
        if not isinstance(item,str):raise ValueError('Container %s has a security option DockNest cannot read.'%name)
        # The Docker CLI's own parsing: key=value, or the older key:value.
        key,separator,value=item.partition('=')
        if not separator and key!='no-new-privileges':key,separator,value=item.partition(':')
        if key=='no-new-privileges' and value in ['','true','false']:found['noNewPrivileges']=value!='false'
        elif key=='seccomp' and value:found['seccomp']=seccomp_profile(value,name)
        elif key=='apparmor' and APPARMOR_PROFILE.fullmatch(value):found['apparmor']=value
        elif key=='label' and SELINUX_LABEL.fullmatch(value):found['labels'].append(value)
        # Options that only turn a protection off: a copy without them is stricter, so they are left out (as before
        # 2.14.0) and recorded, so a Compose copy that adds one the original lacks is caught as weaker.
        elif item in RELAXING_OPTIONS:found['relaxed']+=[RELAXING_OPTIONS[item]] if RELAXING_OPTIONS[item] else []
        else:raise ValueError('Container %s uses the security option %s, which DockNest cannot copy safely. Remove it, or restore this site by hand.'%(name,key[:64]))
    base=set() if 'ALL' in drop else DOCKER_BASE_CAPABILITIES-set(drop)
    return {'readonly':bool(hc.get('ReadonlyRootfs')),'privileged':bool(hc.get('Privileged')),'drop':drop,'add':add,'capabilities':frozenset(base|set(add)),**found,'labels':sorted(found['labels']),'relaxed':sorted(set(found['relaxed']))}
def hardened(c):
    hc=c.get('HostConfig') or {}
    return bool(hc.get('ReadonlyRootfs') or hc.get('CapDrop') or hc.get('CapAdd') or hc.get('SecurityOpt'))
def apparmor_loaded(profile):
    try:
        with open(APPARMOR_PROFILES) as source:return any(line.rsplit(' (',1)[0]==profile for line in source.read().splitlines())
    except OSError:return False
def target_hardening_problem(h,name):
    """What this server lacks to give a copy the same protections; None when it can."""
    if h['apparmor'] not in [None,'unconfined'] and not apparmor_loaded(h['apparmor']):return 'Container %s uses the AppArmor profile %s, which is not loaded on this server. Load it, then try again.'%(name,h['apparmor'])
    return None
def hardening_args(c,directory):
    """`docker create` flags that give a copy the original's read-only root, capabilities and security options. A
    custom seccomp profile is written to a private file in `directory` (Docker reads it at create)."""
    h=hardening(c);name=container_label(c)
    if extra_capabilities(h['add']):raise ValueError('Host privileges or shared namespace networking cannot be restored automatically')
    problem=target_hardening_problem(h,name)
    if problem:raise ValueError(problem)
    args=['--read-only'] if h['readonly'] else []
    for cap in h['drop']:args+=['--cap-drop',cap]
    for cap in h['add']:args+=['--cap-add',cap]
    if h['noNewPrivileges']:args+=['--security-opt','no-new-privileges=true']
    if h['seccomp']=='unconfined':args+=['--security-opt','seccomp=unconfined']
    elif h['seccomp']!='default':
        path=pathlib.Path(directory)/('seccomp-%s.json'%hashlib.sha256(h['seccomp'].encode()).hexdigest()[:16])
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as output:output.write(h['seccomp'])
        args+=['--security-opt','seccomp='+str(path)]
    if h['apparmor']:args+=['--security-opt','apparmor='+h['apparmor']]
    for label in h['labels']:args+=['--security-opt','label='+label]
    return args
def hardening_shortfall(original,copy):
    """None when the copy keeps every protection of the original, else the user-facing reason."""
    o,k=hardening(original),hardening(copy);missing=[]
    if o['readonly'] and not k['readonly']:missing.append('a read-only root filesystem')
    if k['privileged'] or not k['capabilities']<=o['capabilities']:missing.append('its dropped capabilities')
    if o['noNewPrivileges'] and not k['noNewPrivileges']:missing.append('no-new-privileges')
    if o['seccomp']!='unconfined' and k['seccomp']!=o['seccomp']:missing.append('its seccomp profile')
    if o['apparmor']!='unconfined' and k['apparmor']!=o['apparmor']:missing.append('its AppArmor profile')
    if 'disable' not in o['labels'] and k['labels']!=o['labels']:missing.append('its SELinux labels')
    if set(k['relaxed'])-set(o['relaxed']):missing.append('its masked system paths and read-only cgroups')
    if not missing:return None
    return 'The copy of %s would run without %s, which the original has. DockNest stopped so a copy is never less protected.'%(container_label(original),', '.join(missing))
def verify_hardening(originals,created,every=False):
    """Inspect each new copy before it starts; raise when it is less protected than its original. Plain copies skip
    unhardened originals (DockNest adds nothing to them); a Compose copy (every=True) is always checked, because the
    site's Compose files may add settings the original lacks."""
    if len(originals)!=len(created):raise ValueError('DockNest could not match each copy to its original, so it stopped.')
    pairs=[(o,cid) for o,cid in zip(originals,created) if every or hardened(o)]
    if not pairs:return
    copies=inspect([cid for _,cid in pairs])
    if len(copies)!=len(pairs):raise ValueError('DockNest could not inspect every copy, so it stopped.')
    for (original,_),copy in zip(pairs,copies):
        problem=hardening_shortfall(original,copy)
        if problem:raise ValueError(problem)

TRANSFER=None
PROBE_POLICY_FALLBACKS=[]
# Certificate facts the HTTPS probes of this run saw, by hostname (net.py, note_peer_certificate). One run, one process.
PEER_CERTIFICATES={}

# ---- Chain restore ----
# Every package's transfer checksum and every manifest link are checked before any archive is extracted. Each mount is
# then rebuilt in one fresh directory: the full archive, then each increment in order with --listed-incremental=/dev/null
# (which applies deletions and renames), after the same path checks as safe_extract plus the GNU.dumpdir names.
CHAIN_LINKS={}
STOPPING=False;MOVE_ID='';SNAPSHOT_FILTER=''
MOVE_LOCK=None
