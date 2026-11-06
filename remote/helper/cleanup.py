# helper/cleanup.py: Server cleanup: scan reclaimable Docker space, then remove exactly the previewed, still-eligible items.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    docker, emit, run)
from .staging import (
    JOB_DIRECTORY, job_folder_finished)
from .move import (
    MOVES_ROOT)
from .restore_test import (
    RESTORE_ROOT, RESTORE_TESTS_ROOT)
# </build:header>
# ---- Server cleanup (docs/server-cleanup.md) ----
# Rules: never a blanket prune (no `docker system prune`, `volume prune`, `image prune -a`); every removal names one
# container, image or volume by ID and never uses -f or -v. Anything a registered site, a backup in progress, a restore
# copy, a restore test, a move or a kept old copy still needs is protected, and so is DockNest itself. When ownership is
# unclear the item is kept: only anonymous volumes are offered, never named ones. The clean re-reads the server and
# re-checks each item right before removing it, so a preview that went stale can only skip items, never widen.
# Build cache is the one exception to item-by-item: `docker builder prune --all` with an age filter, which BuildKit
# applies only to cache no build is using. It never holds site data. Without --all, BuildKit keeps every cache record a
# tagged image was built from, which is most of it, so the scan showed space a clean could never free. The scan counts
# the same records the prune removes: not in use, not shared, last used more than a day ago. On the containerd image
# store build cache is not offered at all (see image_store): there its size is mostly image layers counted twice.
CLEANUP_KINDS=('containers','images','volumes','buildCache')
CLEANUP_STOPPED={'exited','created','dead'}
CLEANUP_OWN_LABEL_PREFIXES=('docknest.','docker-backup-manager.','io.github.dahanitamar.docknest')
CLEANUP_OWN_NAMES=re.compile(r'(docknest|docker-backup-manager)([_.-].*)?')
CLEANUP_ANONYMOUS=re.compile(r'[0-9a-f]{64}')
CLEANUP_REF=re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,254}')
CLEANUP_FRESH_SECONDS=3600
CLEANUP_SIZE_SECONDS=60
CLEANUP_SHARED_WAIT=120
# A clean stops starting new removals after 30 minutes (DockNest's job hold lasts 45) and reports the rest as not removed.
CLEANUP_APPLY_SECONDS=1800
CLEANUP_REMOVE_TIMEOUT=120
CLEANUP_BUILD_CACHE_AGE='24h'
CLEANUP_BUILD_CACHE_SECONDS=86400
CLEANUP_MAX_ITEMS=500
CLEANUP_WALK_LIMIT=200000
CLEANUP_WALK_SECONDS=20
CLEANUP_JOURNAL_BYTES=4*1024*1024
CLEANUP_LOCK=MOVES_ROOT.parent/'cleanup.lock'
CLEANUP_DEFAULT_STAGING='/var/lib/docknest'

def cleanup_time(text):
    """Docker timestamps (RFC 3339, nanoseconds, Z or an offset) as epoch seconds; None when unreadable."""
    import datetime
    value=str(text or '').strip()
    match=re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)?',value)
    if not match:return None
    zone=match.group(3) or 'Z'
    try:return datetime.datetime.fromisoformat(match.group(1)+('+00:00' if zone=='Z' else zone)).timestamp()
    except ValueError:return None
def cleanup_size(text):
    """`docker system df` sizes (decimal units, '1.2GB', '0B', '512kB (40%)') as bytes; None when unreadable."""
    match=re.fullmatch(r'\s*([0-9.]+)\s*([kKMGTP]?B)\s*(\(.*\))?\s*',str(text or ''))
    if not match:return None
    try:return int(float(match.group(1))*{'B':1,'kB':1e3,'KB':1e3,'MB':1e6,'GB':1e9,'TB':1e12,'PB':1e15}[match.group(2)])
    except (ValueError,KeyError):return None
def cleanup_cache_time(text):
    """`docker system df -v` build cache times ('2026-10-22 15:23:21.156936 +0000 UTC') as epoch seconds; None when unreadable."""
    import datetime
    match=re.match(r'(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.\d+)?\s*([+-]\d{4})?',str(text or '').strip())
    if not match:return None
    try:return datetime.datetime.strptime(match.group(1)+' '+match.group(2)+' '+(match.group(3) or '+0000'),'%Y-%m-%d %H:%M:%S %z').timestamp()
    except ValueError:return None
def build_cache_bytes(rows,now):
    """Bytes `docker builder prune --all --filter until=24h` can free: records no build is using, not shared with
    another record, last used (or, never used, created) more than a day ago. A record whose age or size is unreadable
    is not counted, so the figure never promises more than the prune removes."""
    total=0
    for row in rows if isinstance(rows,list) else []:
        if not isinstance(row,dict) or str(row.get('InUse')).lower()=='true' or str(row.get('Shared')).lower()=='true':continue
        used=cleanup_cache_time(row.get('LastUsedAt')) or cleanup_cache_time(row.get('CreatedAt'))
        size=cleanup_size(row.get('Size'))
        if used is None or size is None or now-used<CLEANUP_BUILD_CACHE_SECONDS:continue
        total+=size
    return total
def cleanup_digest(*parts):return hashlib.sha256('\0'.join(str(p) for p in parts).encode()).hexdigest()[:32]
def own_labels(labels):return any(key.startswith(CLEANUP_OWN_LABEL_PREFIXES) for key in (labels or {}))
def cleanup_refs(value,limit=2000):
    """Request references (container names or IDs, volume names): strings of a safe shape only, at most `limit`."""
    if value is None:return set()
    if not isinstance(value,list) or len(value)>limit:raise ValueError('Invalid cleanup protection list')
    refs=set()
    for item in value:
        if not isinstance(item,str) or not CLEANUP_REF.fullmatch(item):raise ValueError('Invalid cleanup protection entry')
        refs.add(item)
    return refs
def cleanup_protect(req):
    protect=req.get('protect') or {}
    if not isinstance(protect,dict):raise ValueError('Invalid cleanup protection')
    roots=protect.get('stagingRoots') or []
    if not isinstance(roots,list) or len(roots)>200 or any(not isinstance(r,str) or not r.startswith('/') or '..' in r.split('/') or len(r)>512 for r in roots):raise ValueError('Invalid staging roots')
    # Only the Linux integration test lowers this (it cannot wait an hour); DockNest itself never sends it.
    age=req.get('minAgeSeconds',CLEANUP_FRESH_SECONDS)
    if not isinstance(age,int) or isinstance(age,bool) or not 0<=age<=86400:raise ValueError('Invalid minimum age')
    return {'containers':cleanup_refs(protect.get('containers')),'volumes':cleanup_refs(protect.get('volumes')),'projects':cleanup_refs(protect.get('projects')),'stagingRoots':list(dict.fromkeys([CLEANUP_DEFAULT_STAGING,*roots])),'minAge':age}

# ---- What the server says ----
def journal_strings(value,into):
    if isinstance(value,str):into.add(value)
    elif isinstance(value,dict):
        for item in value.values():journal_strings(item,into)
    elif isinstance(value,list):
        for item in value:journal_strings(item,into)
def read_journal(path,into):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size>CLEANUP_JOURNAL_BYTES:return
        journal_strings(json.loads(path.read_text()),into)
    except (OSError,ValueError):pass
def cleanup_journals():
    """Every name and ID that a move or a restore test journalled, and the containers of each kept old copy. A journal
    DockNest cannot read protects nothing extra, but Docker labels and the site lists still do."""
    found={'move':set(),'oldCopy':set(),'restoreTest':set()}
    for root,kind in [(MOVES_ROOT,'move'),(RESTORE_TESTS_ROOT,'restoreTest')]:
        try:entries=[e for e in os.scandir(root) if e.is_dir(follow_symlinks=False)] if root.is_dir() and not root.is_symlink() else []
        except OSError:entries=[]
        for entry in entries:
            folder=pathlib.Path(entry.path)
            read_journal(folder/'resources.json',found[kind])
            read_journal(folder/'state.json',found[kind])
            if kind=='move':
                for name in ['retired.json','retired.pending','stopped.json','stopped.pending']:read_journal(folder/name,found['oldCopy'])
    return found
def cleanup_activity(roots,now):
    """Snapshot images of every DockNest job folder (a backup commits them while it runs), and whether a backup or
    restore looks active: any unfinished job folder, or any restore staging folder, however old. A folder left by an
    interrupted job keeps blocking cleanup until DockNest's recovery finishes it (fail closed)."""
    images=set();active=None
    for base in [pathlib.Path(r) for r in roots]+[RESTORE_ROOT]:
        try:
            if base.is_symlink() or not base.is_dir():continue
            entries=list(os.scandir(base))
        except OSError:continue
        for entry in entries:
            if not JOB_DIRECTORY.fullmatch(entry.name) or not entry.is_dir(follow_symlinks=False):continue
            folder=pathlib.Path(entry.path)
            snapshots=set();read_journal(folder/'snapshot-images.json',snapshots);images|=snapshots
            if base!=RESTORE_ROOT and job_folder_finished(folder):continue
            active='restore' if base==RESTORE_ROOT else 'backup'
    return images,active
def volume_bytes(mountpoint,overall=None):
    """Bytes under a volume, without following links; None when it is too large or slow to count, or when the scan's
    overall sizing deadline (`overall`, monotonic seconds) has passed."""
    total=0;count=0;deadline=min(time.monotonic()+CLEANUP_WALK_SECONDS,overall if overall is not None else float('inf'))
    if time.monotonic()>=deadline:return None
    try:
        if not mountpoint or not os.path.isdir(mountpoint) or os.path.islink(mountpoint):return None
        for current,dirs,files in os.walk(mountpoint,followlinks=False):
            for name in dirs+files:
                count+=1
                if count>CLEANUP_WALK_LIMIT or time.monotonic()>deadline:return None
                try:total+=os.lstat(os.path.join(current,name)).st_size
                except OSError:pass
    except OSError:return None
    return total
def docker_json(*args):
    output=docker(*args).decode()
    return json.loads(output) if output.strip() else []
def docker_lines(*args):return docker(*args).decode().split()
def image_store():
    """'containerd' when Docker keeps images in the containerd image store (the default from Docker 29), 'classic' for
    the older graph drivers, None when Docker does not say. In the containerd store, build cache records and image
    layers are the same snapshots: Docker reports their sizes twice, and pruning the cache frees almost nothing while
    an image still holds the layers (9 GB shown, 0.5 GB freed on a real server). So build cache is offered only on the
    classic store, and never when the store is unknown: a scan lists only space a clean really frees."""
    try:status=json.loads(docker('info','--format','{{json .DriverStatus}}').decode() or 'null')
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError):return None
    if not isinstance(status,list):return 'classic' if status is None else None
    pairs=[p for p in status if isinstance(p,list) and len(p)==2]
    return 'containerd' if any(str(k)=='driver-type' and 'containerd' in str(v) for k,v in pairs) else 'classic'
def build_cache_facts(now):
    """Bytes the build cache prune frees on the classic store; None when Docker cannot say."""
    try:
        usage=json.loads(docker('system','df','-v','--format','json').decode() or '{}')
        if isinstance(usage,dict) and isinstance(usage.get('BuildCache'),list):return build_cache_bytes(usage['BuildCache'],now)
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError):pass
    # Older Docker without a JSON per-record listing: its "Reclaimable" total is the upper bound the page shows as "Up to".
    try:
        for line in docker('system','df','--format','{{json .}}').decode().splitlines():
            row=json.loads(line) if line.strip() else {}
            if row.get('Type')=='Build Cache':return cleanup_size(row.get('Reclaimable'))
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError):pass
    return None
def cleanup_facts(protect,now=None):
    now=time.time() if now is None else now
    ids=docker_lines('ps','-aq','--no-trunc')
    containers=docker_json('container','inspect','--size',*ids) if ids else []
    image_ids=list(dict.fromkeys(docker_lines('image','ls','-q','--no-trunc','--filter','dangling=true')))
    images=docker_json('image','inspect',*image_ids) if image_ids else []
    names=docker_lines('volume','ls','-q','--filter','dangling=true')
    volumes=docker_json('volume','inspect',*names) if names else []
    build=build_cache_facts(now) if image_store()=='classic' else None
    snapshots,active=cleanup_activity(protect['stagingRoots'],now)
    return {'containers':containers,'images':images,'volumes':volumes,'buildCacheBytes':build,'snapshotImages':snapshots,'journals':cleanup_journals(),'active':active,'now':now}

# ---- Decisions (pure: tests call these with plain data) ----
def container_refs(c):
    cid=c.get('Id','');name=(c.get('Name') or '').lstrip('/')
    return {cid,cid[:12],name} - {''}
def ref_matches(refs,known):
    if refs & known:return True
    # A short ID in a site list (12+ hex characters) matches the full ID it starts.
    return any(len(k)>=12 and re.fullmatch(r'[0-9a-f]+',k) and any(r.startswith(k) for r in refs) for k in known)
def compose_project(labels):return (labels or {}).get('com.docker.compose.project') or None
def cleanup_classify(facts,protect):
    """Splits what the server holds into items DockNest may remove and protected items with a reason."""
    now=facts['now'];journals=facts['journals'];eligible=[];kept=[]
    def fresh(created):
        at=cleanup_time(created)
        return at is None or now-at<protect.get('minAge',CLEANUP_FRESH_SECONDS)
    containers=facts['containers']
    site_ids=set()
    for c in containers:
        if ref_matches(container_refs(c),protect['containers']):site_ids.add(c.get('Id'))
    # Compose projects of sites: from the site containers still on the server, and from the site backups (DockNest sends
    # those), so a stack that is down keeps its anonymous volumes too.
    site_projects=({compose_project((c.get('Config') or {}).get('Labels')) for c in containers if c.get('Id') in site_ids}|set(protect.get('projects') or ()))-{None}
    running_projects={compose_project((c.get('Config') or {}).get('Labels')) for c in containers if (c.get('State') or {}).get('Status') not in CLEANUP_STOPPED}-{None}
    used_images={c.get('Image') for c in containers}-{None}
    used_volumes={m.get('Name') for c in containers for m in c.get('Mounts') or [] if m.get('Type')=='volume'}-{None}
    def add(kind,item,reason):(kept if reason else eligible).append({**item,'kind':kind,**({'reason':reason} if reason else {})})
    for c in containers:
        state=c.get('State') or {}
        if state.get('Status') not in CLEANUP_STOPPED or state.get('Running') or state.get('Paused') or state.get('Restarting'):continue
        config=c.get('Config') or {};labels=config.get('Labels') or {};refs=container_refs(c);project=compose_project(labels)
        name=(c.get('Name') or '').lstrip('/');image=str(config.get('Image') or '')
        if own_labels(labels) and any(k.startswith('docknest.restore-test') for k in labels):reason='restoreTest'
        elif own_labels(labels) and any(k.startswith('docknest.move') for k in labels):reason='move'
        elif own_labels(labels) and any(k.startswith('docker-backup-manager.restore') for k in labels):reason='restoreCopy'
        elif own_labels(labels) or project in ('docknest','docker-backup-manager') or CLEANUP_OWN_NAMES.fullmatch(name) or CLEANUP_OWN_NAMES.fullmatch(image.split('/')[-1].split(':')[0]):reason='docknest'
        elif c.get('Id') in site_ids or (project and project in site_projects):reason='site'
        elif ref_matches(refs,journals['oldCopy']):reason='oldCopy'
        elif ref_matches(refs,journals['move']):reason='move'
        elif ref_matches(refs,journals['restoreTest']):reason='restoreTest'
        elif project and project in running_projects:reason='runningStack'
        elif fresh(c.get('Created')):reason='tooNew'
        else:reason=None
        add('containers',{'id':c.get('Id'),'name':name,'bytes':c.get('SizeRw') if isinstance(c.get('SizeRw'),int) else None,
            'fingerprint':cleanup_digest(c.get('Id'),c.get('Created'),state.get('Status'),state.get('StartedAt'),state.get('FinishedAt'))},reason)
    for i in facts['images']:
        iid=i.get('Id','');labels=(i.get('Config') or {}).get('Labels') or {};refs={iid,iid.split(':')[-1],iid.split(':')[-1][:12]}
        if i.get('RepoTags'):continue  # tagged meanwhile: not dangling, not listed
        if iid in used_images:reason='inUse'
        elif own_labels(labels):reason='docknest'
        elif refs & facts['snapshotImages']:reason='backup'
        elif ref_matches(refs,journals['oldCopy']) or ref_matches(refs,journals['move']):reason='move'
        elif ref_matches(refs,journals['restoreTest']):reason='restoreTest'
        elif fresh(i.get('Created')):reason='tooNew'
        else:reason=None
        add('images',{'id':iid,'name':iid.split(':')[-1][:12],'bytes':i.get('Size') if isinstance(i.get('Size'),int) else None,'fingerprint':cleanup_digest(iid,i.get('Created'))},reason)
    for v in facts['volumes']:
        name=v.get('Name','');labels=v.get('Labels') or {};project=compose_project(labels)
        if name in used_volumes:reason='inUse'
        elif own_labels(labels) and any(k.startswith('docknest.restore-test') for k in labels):reason='restoreTest'
        elif own_labels(labels) and any(k.startswith('docknest.move') for k in labels):reason='move'
        elif own_labels(labels) or CLEANUP_OWN_NAMES.fullmatch(name) or project in ('docknest','docker-backup-manager'):reason='docknest'
        elif name in protect['volumes'] or (project and project in site_projects):reason='site'
        elif name in journals['oldCopy'] or name in journals['move']:reason='move'
        elif name in journals['restoreTest']:reason='restoreTest'
        # Fail closed: a named volume may be used again by a stack that is down right now. Only anonymous ones go.
        elif not CLEANUP_ANONYMOUS.fullmatch(name):reason='named'
        elif fresh(v.get('CreatedAt')):reason='tooNew'
        else:reason=None
        add('volumes',{'id':name,'name':name[:12] if CLEANUP_ANONYMOUS.fullmatch(name) else name,'bytes':v.get('bytes'),'mountpoint':v.get('Mountpoint'),'fingerprint':cleanup_digest(name,v.get('CreatedAt'))},reason)
    if facts.get('buildCacheBytes'):
        eligible.append({'kind':'buildCache','id':'build-cache','name':'Unused build cache','bytes':facts['buildCacheBytes'],'fingerprint':'build-cache'})
    return eligible,kept

def public_item(item):return {k:item.get(k) for k in ['kind','id','name','bytes','fingerprint','reason'] if k in item}
def cleanup_scan(req,now=None):
    protect=cleanup_protect(req);facts=cleanup_facts(protect,now)
    eligible,kept=cleanup_classify(facts,protect)
    overall=time.monotonic()+CLEANUP_SIZE_SECONDS
    for item in eligible:
        if item['kind']=='volumes':item['bytes']=volume_bytes(item.get('mountpoint'),overall)
    emit(result={'items':[public_item(i) for i in eligible],'protected':[public_item(i) for i in kept][:CLEANUP_MAX_ITEMS],'busy':facts['active']})

# ---- Clean ----
def cleanup_lock():
    """Exclusive: no backup, restore, restore test or move step holds the shared side (cleanup_shared), and none can start
    until the clean ends."""
    import fcntl
    CLEANUP_LOCK.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if CLEANUP_LOCK.is_symlink():raise ValueError('The cleanup lock cannot be a symbolic link')
    handle=open(CLEANUP_LOCK,'a')
    try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:handle.close();raise ValueError('Another cleanup or DockNest step is running on this server. Clean up after it finishes.')
    return handle
def cleanup_shared(wait_seconds=CLEANUP_SHARED_WAIT):
    """Shared side of the cleanup lock, taken (and kept for the whole step) by every step that creates or needs Docker
    resources: backup capture, restore, restore test prepare and run, and move steps. It waits briefly for a running
    clean, then refuses. None where the lock folder cannot exist (not root): then no clean can run either."""
    try:import fcntl
    except ImportError:return None
    try:CLEANUP_LOCK.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    except OSError:return None
    if CLEANUP_LOCK.is_symlink():raise ValueError('The cleanup lock cannot be a symbolic link')
    handle=open(CLEANUP_LOCK,'a');deadline=time.time()+wait_seconds
    while True:
        try:fcntl.flock(handle,fcntl.LOCK_SH|fcntl.LOCK_NB);return handle
        except BlockingIOError:
            if time.time()>=deadline:handle.close();raise ValueError('A server cleanup is running on this server. Try again when it finishes.')
            time.sleep(2)
def step_locks_held():
    """Whether a move or restore test step holds its own lock right now. Probed only while cleanup holds the exclusive
    lock, so no new step can be taking one at the same moment (steps take the shared cleanup lock first)."""
    try:import fcntl
    except ImportError:return False
    for root in [MOVES_ROOT,RESTORE_TESTS_ROOT]:
        try:folders=[pathlib.Path(e.path) for e in os.scandir(root) if e.is_dir(follow_symlinks=False)] if root.is_dir() and not root.is_symlink() else []
        except OSError:folders=[]
        for folder in folders:
            lock=folder/'.lock'
            if lock.is_symlink() or not lock.is_file():continue
            with open(lock,'a') as handle:
                try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(handle,fcntl.LOCK_UN)
                except BlockingIOError:return True
    return False
def cleanup_requested(req):
    items=req.get('items')
    if not isinstance(items,list) or not items or len(items)>CLEANUP_MAX_ITEMS:raise ValueError('Choose up to %d items to clean'%CLEANUP_MAX_ITEMS)
    result=[]
    for item in items:
        if not isinstance(item,dict) or item.get('kind') not in CLEANUP_KINDS or not isinstance(item.get('id'),str) or not CLEANUP_REF.fullmatch(item['id']) or not isinstance(item.get('fingerprint'),str) or len(item['fingerprint'])>64:raise ValueError('Invalid cleanup item')
        result.append({'kind':item['kind'],'id':item['id'],'fingerprint':item['fingerprint']})
    return result
def still_eligible(item):
    """The last look right before removal: one item, read fresh from Docker."""
    kind=item['kind'];ref=item['id']
    try:
        if kind=='containers':
            c=docker_json('container','inspect',ref)[0];state=c.get('State') or {}
            return state.get('Status') in CLEANUP_STOPPED and not state.get('Running') and not own_labels((c.get('Config') or {}).get('Labels')) and cleanup_digest(c.get('Id'),c.get('Created'),state.get('Status'),state.get('StartedAt'),state.get('FinishedAt'))==item['fingerprint']
        if kind=='images':
            i=docker_json('image','inspect',ref)[0]
            return not i.get('RepoTags') and not own_labels((i.get('Config') or {}).get('Labels')) and not docker_lines('ps','-aq','--no-trunc','--filter','ancestor='+ref) and cleanup_digest(i.get('Id'),i.get('Created'))==item['fingerprint']
        if kind=='volumes':
            v=docker_json('volume','inspect',ref)[0]
            return CLEANUP_ANONYMOUS.fullmatch(v.get('Name',''))is not None and not own_labels(v.get('Labels')) and not docker_lines('ps','-aq','--no-trunc','--filter','volume='+ref) and cleanup_digest(v.get('Name'),v.get('CreatedAt'))==item['fingerprint']
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,IndexError,TypeError):return False
    return False
def journal_protects(item,journals):
    """Journals re-read right before each removal. The shared lock already keeps new steps out; this is the second net."""
    ref=item['id'];refs={ref,ref[:12],ref.split(':')[-1],ref.split(':')[-1][:12]}
    return any(ref_matches(refs,journals[kind]) for kind in ['move','oldCopy','restoreTest'])
def remove_item(item,timeout=CLEANUP_REMOVE_TIMEOUT):
    command={'containers':['rm'],'images':['image','rm'],'volumes':['volume','rm']}[item['kind']]
    run(['docker',*command,item['id']],timeout=max(1,int(timeout)))
def prune_build_cache(timeout=600):
    output=run(['docker','builder','prune','--all','--force','--filter','until='+CLEANUP_BUILD_CACHE_AGE],timeout=max(1,int(timeout))).decode(errors='replace')
    match=re.search(r'Total(?: reclaimed space)?:\s*([0-9.]+\s*[kKMGTP]?B)',output)
    return cleanup_size(match.group(1)) if match else None
def active_message(kind):
    """An unfinished folder blocks until recovery finishes it; the message names the folder, not a guess at a job."""
    if kind=='restore':return 'A restore staging folder exists on this server (a restore is running or was interrupted). DockNest recovery removes it when the restore is finished; until then, or until the folder is removed, cleanup waits.'
    return 'An unfinished backup job folder exists on this server (a backup is running or needs recovery). It unblocks when DockNest recovery finishes the job or the folder is removed.'
def cleanup_apply(req,now=None):
    requested=cleanup_requested(req);protect=cleanup_protect(req);started=time.monotonic()
    lock=cleanup_lock()
    try:
        if step_locks_held():raise ValueError('A site move or restore test step is running on this server. Clean up after it finishes.')
        facts=cleanup_facts(protect,now)
        if facts['active']:raise ValueError(active_message(facts['active']))
        eligible,kept=cleanup_classify(facts,protect)
        current={(i['kind'],i['id']):i for i in eligible};reasons={(i['kind'],i['id']):i['reason'] for i in kept}
        results=[];deadline=started+CLEANUP_APPLY_SECONDS
        order={kind:n for n,kind in enumerate(CLEANUP_KINDS)}
        for item in sorted(requested,key=lambda i:order[i['kind']]):
            key=(item['kind'],item['id']);now_item=current.get(key);left=deadline-time.monotonic()
            outcome={'kind':item['kind'],'id':item['id'],'name':(now_item or {}).get('name') or item['id'][:12]}
            if left<=0:outcome.update(status='skipped',reason='timeLimit')
            elif now_item is None:outcome.update(status='skipped',reason=reasons.get(key,'gone'))
            elif now_item['fingerprint']!=item['fingerprint']:outcome.update(status='skipped',reason='changed')
            elif item['kind']=='buildCache':
                try:outcome.update(status='removed',bytes=prune_build_cache(min(600,left)))
                except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError):outcome.update(status='failed',reason='buildCache')
            elif journal_protects(item,cleanup_journals()):outcome.update(status='skipped',reason='move')
            elif not still_eligible(item):outcome.update(status='skipped',reason='changed')
            else:
                try:remove_item(item,min(CLEANUP_REMOVE_TIMEOUT,left));outcome.update(status='removed',bytes=now_item.get('bytes') if item['kind']!='volumes' else None)
                except (subprocess.CalledProcessError,subprocess.TimeoutExpired):outcome.update(status='failed',reason='docker')
            results.append(outcome)
        emit(result={'results':results})
    finally:lock.close()
