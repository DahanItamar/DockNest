# helper/incremental.py: Incremental snapshot state, chain records, commit/discard.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    NOFOLLOW, atomic_json, emit, sync_directory)
from .paths import (
    protected_mount, warn)
from .databases import (
    file_sha256)
from .staging import (
    JOB_DIRECTORY, is_regular, staging_base)
# </build:header>
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
