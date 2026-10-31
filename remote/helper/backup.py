# helper/backup.py: Backup plan, artifact streaming and verification, static sites, preflight, readiness, capture.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    atomic_json, complete_recovery, create_staging_root, diagnostic, docker, emit, inspect, run)
from .guides import (
    INCREMENTAL_GUIDE, RESTORE_GUIDE)
from .paths import (
    READINESS_SCAN_ENTRIES, classify_source, excluded_path, guarded_mount, lexical, mount_exclusions, mount_table,
    protected_mount, protected_mount_warning, protected_mounts, protected_path_warning, protected_paths,
    refuse_protected_sources, scoped_classify, source_archive, source_archive_command, within)
from .databases import (
    data_checks, file_sha256, online_sqlite_checks, prepare_database_shutdown, restart_services,
    shutdown_evidence, sqlite_check_mode, sqlite_file_source, validate_database_contracts)
from .incremental import (
    INCREMENTAL_ROOT, annotate_mounts, copy_private, incremental_request, incremental_sources, manifest_snapshots,
    plan_incremental, reset_snapshot, site_lock, snapshot_records)
from .net import (
    ProbePolicyError, health, probe_url, public_probe, skip_refused_probes)
from .maintenance import (
    MAINTENANCE_NOT_SET_UP, MaintenanceOptional, maintenance)
from .discovery import (
    nginx_sites, temporary_mounts)
from .restore import (
    PRIVILEGE_BITS, recover, safe_extract)
# Mutable state lives in common and is never copied by import: CAPTURE_DIAGNOSTICS, PROBE_POLICY_FALLBACKS, TRANSFER
# </build:header>
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
