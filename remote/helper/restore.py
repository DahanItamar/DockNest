# helper/restore.py: Recovery verification, safe extraction, chains (incl. offline restore-chain), isolated restore.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    atomic_json, complete_recovery, docker, emit, inspect, run)
from .paths import (
    excluded_path, mount_table)
from .databases import (
    cached_sqlite_file_proof, data_checks, file_sha256, restart_services)
from .backup import (
    archive_renames_safely, tree_digest, verify_artifacts)
from .incremental import (
    CHAIN_ID, FORMAT_VERSIONS, HEX64, MAX_CHAIN, manifest_snapshots)
from .net import (
    health, probe_url, public_probe, skip_refused_probes)
from .maintenance import (
    maintenance)
from .discovery import (
    temporary_mounts, tmpfs_argument)
from .staging import (
    is_regular)
from .restore_test import (
    load_images_keeping_tags)
# Mutable state lives in common and is never copied by import: CHAIN_LINKS, PROBE_POLICY_FALLBACKS
# </build:header>
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
