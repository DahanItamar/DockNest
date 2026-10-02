#!/usr/bin/env python3
"""Versioned Linux helper. No request values are interpolated into shell commands."""
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,ssl,socket,shlex,hashlib,stat
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

def emit(**kw): print(json.dumps(kw),flush=True)
def run(args,timeout=3600):
    return subprocess.check_output(args,stderr=subprocess.DEVNULL,timeout=timeout)
def docker(*args): return run(['docker',*args])
def inspect(ids): return json.loads(docker('inspect',*ids))
class OriginHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        sock=socket.create_connection(('127.0.0.1',self.port),self.timeout)
        try:self.sock=self._context.wrap_socket(sock,server_hostname=self.host)
        except Exception:sock.close();raise

def public_probe(m):
    url=m.get('publicUrl','')
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password:raise ValueError('A valid HTTP or HTTPS public probe URL is required')
    if not m.get('probeOrigin'):
        try:
            with urllib.request.urlopen(url,timeout=10) as response:return response.status,response.read(256*1024)
        except urllib.error.HTTPError as error:return error.code,error.read(256*1024)
    # Same hostname and verified TLS identity; only the connection address changes to loopback.
    if parsed.scheme=='https':connection=OriginHTTPSConnection(parsed.hostname,parsed.port or 443,timeout=10,context=ssl.create_default_context())
    else:connection=http.client.HTTPConnection('127.0.0.1',parsed.port or 80,timeout=10)
    try:
        path=urllib.parse.urlunsplit(('','',parsed.path or '/',parsed.query,''))
        connection.request('GET',path,headers={'Host':parsed.netloc,'Cache-Control':'no-cache'})
        response=connection.getresponse()
        return response.status,response.read(256*1024)
    finally:connection.close()

def health(containers,url=None):
    for c in inspect(containers) if containers else []:
        if not c['State']['Running']: return False
        if c['State'].get('Health',{}).get('Status','healthy')!='healthy': return False
    if url:
        try:
            with urllib.request.urlopen(url,timeout=5) as r:
                if r.status!=200 or b'dbm-maintenance-v1' in r.read(256*1024):return False
        except Exception:return False
    return True
def maintenance(cfg,enabled):
    m=cfg.get('maintenance',{})
    if not m.get('required'):return
    directory=pathlib.Path(m['directory'])
    if not directory.is_absolute() or '..' in directory.parts:raise ValueError('Invalid maintenance directory')
    if not (directory/'ready').is_file():raise ValueError('Maintenance proxy integration is not ready')
    if enabled:
        was_enabled=(directory/'enabled').exists()
        (directory/'enabled').touch(mode=0o600)
        try:
            if not m.get('publicUrl'):raise ValueError('Public maintenance probe URL required')
            status,body=public_probe(m)
            if status!=503 or b'dbm-maintenance-v1' not in body:raise ValueError('Maintenance probe is not the deployed HTTP 503 page')
        except Exception:
            if not was_enabled:(directory/'enabled').unlink(missing_ok=True)
            raise
    else:
        if not health(cfg.get('_runningContainers',cfg['containers']),m.get('healthUrl')):raise ValueError('Health probe failed; maintenance retained')
        (directory/'enabled').unlink(missing_ok=True)
        if m.get('publicUrl'):
            try:
                status,body=public_probe(m)
                if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('Public access did not recover')
            except Exception:
                (directory/'enabled').touch(mode=0o600)
                raise ValueError('Public probe failed; maintenance retained')
def recover(root,ids,cfg,deadline,parent):
    while not (root/'disarmed').exists() and time.time()<deadline:time.sleep(2)
    if (root/'disarmed').exists():
        (root/'watchdog.done').touch(mode=0o600)
        return
    try:
        if os.getpgid(parent)==parent:os.killpg(parent,signal.SIGTERM)
    except ProcessLookupError:pass
    try:
        if ids:docker('start',*ids)
        until=time.time()+120
        while time.time()<until and not health(ids,cfg.get('maintenance',{}).get('healthUrl')):time.sleep(2)
        if ids and not health(ids,cfg.get('maintenance',{}).get('healthUrl')):raise ValueError('Recovery health failed')
        maintenance(cfg,False)
        (root/'recovery.json').write_text(json.dumps({'recovered':True,'at':time.time()}))
    except Exception:
        (root/'recovery.json').write_text(json.dumps({'recovered':False,'at':time.time()}))
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
    root=pathlib.Path(cfg.get('documentRoot',''))
    if not root.is_absolute() or '..' in root.parts or not root.is_dir() or root.resolve()!=root:raise ValueError('Choose a regular static website directory from discovery')
    if not any(site.get('documentRoot')==str(root) for site in nginx_sites() if site['kind']=='static'):raise ValueError('The directory must belong to a discovered static nginx website')
    if cfg.get('containers') or cfg.get('composeFiles'):raise ValueError('Static sites cannot contain Docker services or Compose files')
    if not cfg.get('exclusiveSourcesConfirmed') or not cfg.get('externalReferencesConfirmed'):raise ValueError('Review the static website files and confirm that no deployment will change them during capture')
    if os.geteuid()!=0:raise ValueError('Root SSH required to preserve ownership')
    for filename in cfg.get('configFiles',[]):
        p=pathlib.Path(filename)
        if not p.is_absolute() or '..' in p.parts or not p.is_file() or p.is_symlink():raise ValueError('Static configuration file is unreadable or invalid')
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
    base=pathlib.Path(cfg.get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts or base.resolve()!=base:raise ValueError('Use a regular absolute staging directory')
    if os.path.commonpath([str(base),str(source)]) in [str(base),str(source)]:raise ValueError('Staging and static website paths cannot overlap')
    root=base/req['job']
    if root.exists():raise ValueError('Staging already exists; inspect retained job before retry')
    root.mkdir(parents=True,mode=0o700)
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
    (root/'manifest.json').write_text(json.dumps(manifest));os.chmod(root/'manifest.json',0o600)
    (root/'restore-guide.md').write_text('Static website backup. static-files.tar preserves numeric owners, permissions, ACLs and xattrs. Restore into a new private directory and verify staticFiles.sha256 before an explicit nginx cutover. Original website and nginx/TLS configuration must never be overwritten automatically. Configuration archives are for review; TLS keys and external services are not included.\n')
    (root/'disarmed').touch(mode=0o600);(root/'watchdog.done').touch(mode=0o600)
    emit(stage='packing')
    run(['tar','-czf',str(root/'payload.tar.gz'),'-C',str(root),'static-files.tar','manifest.json','restore-guide.md',*[p.name for p in root.glob('config-*.tar')]])
    emit(result={'remotePath':str(root/'payload.tar.gz'),'root':str(root),'manifest':manifest})

def preflight(cfg):
    if cfg.get('kind')=='static':static_preflight(cfg);return []
    ids=cfg.get('containers',[])
    if not ids or not all(isinstance(x,str) and x and not x.startswith('-') for x in ids):raise ValueError('Select valid containers')
    if not cfg.get('exclusiveSourcesConfirmed'):raise ValueError('Confirm no external processes write the selected data')
    profile=cfg.get('shutdownProfile','generic')
    if profile not in ['generic','postgres','mysql']:raise ValueError('Unsupported shutdown profile')
    if profile=='generic' and not cfg.get('cleanShutdownConfirmed'):raise ValueError('Generic shutdown requires explicit application clean-shutdown confirmation')
    cs=inspect(ids); selected={c['Id'] for c in cs}
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
            if os.path.islink(src):raise ValueError('Mount source symlink requires a capture adapter')
            if os.path.isdir(src):
                for current,dirs,files in os.walk(src,followlinks=False):
                    for filename in dirs+files:
                        p=os.path.join(current,filename)
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
    def direct_health():
        if not health(cfg['containers'],cfg.get('healthUrl') or cfg.get('maintenance',{}).get('healthUrl')):raise ValueError('Application health URL must return HTTP 200 from the source server. Check the URL and that all selected services are running.')
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
        status,body=public_probe(m)
        if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('Website probe must return HTTP 200. If a CDN blocks server probes, choose the local origin probe after verifying the source proxy.')
    if cfg.get('kind')!='static':check('Maintenance proxy and website',proxy)
    return {'ready':all(item['ok'] or item.get('required') is False for item in checks),'checks':checks,'readOnly':True,'maintenanceActivationTested':False}
def capture(req):
    if req['config'].get('kind')=='static':return capture_static(req)
    cfg=req['config'];cs=preflight(cfg)
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
    root.mkdir(parents=True,mode=0o700)
    # Capacity is estimated before stopping; additional free space remains mandatory.
    needed=sum(int(run(['du','-sb',m['Source']]).split()[0]) for c in cs for m in c['Mounts'])
    needed+=sum(c.get('SizeRw',0) or 0 for c in cs)
    if shutil.disk_usage(root).free<needed*2+1024**3:raise ValueError('Insufficient staging capacity')
    original_ids=list({c['Image'] for c in cs})
    original_images=json.loads(docker('image','inspect',*original_ids))
    running=[c['Id'] for c in cs if c['State']['Running']]
    cfg['_runningContainers']=running
    (root/'recovery-plan.json').write_text(json.dumps({'running':running,'containers':[c['Id'] for c in cs]}))
    os.chmod(root/'recovery-plan.json',0o600)
    stop_timeout=int(cfg.get('stopTimeout',60))
    if stop_timeout<5 or stop_timeout>600:raise ValueError('Stop timeout must be 5..600 seconds')
    deadline=time.time()+int(cfg.get('captureTimeout',1800))+stop_timeout*len(running)+120
    # Forked watchdog survives SSH loss, cannot remove maintenance until health succeeds.
    parent=os.getpid()
    if os.getpgrp()!=parent:os.setsid()
    pid=os.fork()
    if pid==0:
        os.setsid()
        for fd in [0,1,2]:
            try:os.close(fd)
            except OSError:pass
        try:recover(root,running,cfg,deadline,parent)
        finally:
            try:(root/'watchdog.done').touch(mode=0o600)
            except Exception:pass
        os._exit(0)
    stopped_at=None;visitor_start=None;captured=None;images=[];shutdown_evidence=[]
    try:
        emit(stage='stopping')
        visitor_start=time.time()
        maintenance(cfg,True)
        stopped_at=time.time()
        for cid in running:docker('stop','--time',str(stop_timeout),cid)
        for c in inspect([c['Id'] for c in cs]):
            if c['State']['Running'] or c['State']['ExitCode']!=0 or c['State'].get('OOMKilled'):raise ValueError('Graceful clean shutdown was not proven')
        profile=cfg.get('shutdownProfile','generic')
        if profile in ['postgres','mysql']:
            pattern='postgres' if profile=='postgres' else ('mysql','mariadb')
            databases=[c for c in cs if (any(v in c['Config']['Image'].lower() for v in pattern) if isinstance(pattern,tuple) else pattern in c['Config']['Image'].lower())]
            if not databases:raise ValueError('Selected database shutdown profile does not match a database image')
            marker='database system is shut down' if profile=='postgres' else 'shutdown complete'
            for c in databases:
                log_args=['docker','logs','--since',str(stopped_at),c['Id']] if c['Id'] in running else ['docker','logs','--tail','100',c['Id']]
                result=subprocess.run(log_args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
                logs=(result.stdout+result.stderr).decode(errors='replace').lower()
                if marker not in logs:raise ValueError('Database shutdown evidence not found in logs; full capture blocked')
                shutdown_evidence.append({'container':c['Id'],'profile':profile,'cleanShutdownLogVerified':True})
        else:shutdown_evidence=[{'profile':'generic','applicationShutdownConfirmed':True,'zeroExitCodeVerified':True}]
        emit(stage='copying')
        for i,c in enumerate(cs):
            # commit captures the writable layer; mounted data is archived separately.
            image=docker('commit',c['Id']).decode().strip();images.append(image)
            for j,m in enumerate(c['Mounts']):
                source=pathlib.Path(m['Source'])
                run(['tar','--xattrs','--acls','--numeric-owner','-cpf',str(root/('mount-%d-%d.tar'%(i,j))),'-C',str(source.parent),'--',source.name])
        for i,filename in enumerate(cfg.get('composeFiles',[])+cfg.get('configFiles',[])):
            source=pathlib.Path(filename)
            run(['tar','--xattrs','--acls','--numeric-owner','-cpf',str(root/('config-%d.tar'%i)),'-C',str(source.parent),'--',source.name])
        captured=time.time()
    finally:
        emit(stage='restarting')
        try:
            if running:docker('start',*running)
            until=time.time()+120
            while running and time.time()<until and not health(running,cfg.get('maintenance',{}).get('healthUrl')):time.sleep(2)
            if running and not health(running,cfg.get('maintenance',{}).get('healthUrl')):raise ValueError('RESTART_FAILED: watchdog remains armed, maintenance retained')
            maintenance(cfg,False)
            (root/'disarmed').touch(mode=0o600)
            emit(stage='source_ready')
        except Exception:raise ValueError('RESTART_FAILED: inspect remote watchdog and recovery.json')
    restarted=time.time()
    emit(stage='packing')
    docker('save','-o',str(root/'images.tar'),*original_ids,*images)
    manifest={'formatVersion':1,'capturedAt':captured,'downtimeSeconds':restarted-stopped_at,'containerDowntimeSeconds':restarted-stopped_at,'visitorDowntimeSeconds':restarted-visitor_start,'architecture':docker('info','--format','{{.Architecture}}').decode().strip(),'containers':cs,'snapshotImages':images,'originalImages':original_images,'shutdownEvidence':shutdown_evidence,'configurationFiles':cfg.get('composeFiles',[])+cfg.get('configFiles',[]),'complete':True,'restoreTested':False}
    manifest['temporaryMemoryFolders']=cfg.get('temporaryMemoryFolders',[])
    (root/'manifest.json').write_text(json.dumps(manifest));os.chmod(root/'manifest.json',0o600)
    (root/'restore-guide.md').write_text(RESTORE_GUIDE)
    run(['tar','-czf',str(root/'payload.tar.gz'),'-C',str(root),'images.tar','manifest.json','restore-guide.md',*[p.name for p in root.glob('mount-*.tar')],*[p.name for p in root.glob('config-*.tar')]])
    for image in images:
        try:docker('image','rm',image)
        except Exception:pass
    emit(result={'remotePath':str(root/'payload.tar.gz'),'root':str(root),'manifest':manifest})

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
    if not health(plan['running'],cfg.get('maintenance',{}).get('healthUrl')):raise ValueError('Application health has not recovered')
    m=cfg.get('maintenance',{})
    if m.get('required'):
        if (pathlib.Path(m['directory'])/'enabled').exists():raise ValueError('Maintenance remains enabled')
        if not m.get('publicUrl'):raise ValueError('Public health probe required')
        status,body=public_probe(m)
        if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('Public access has not recovered')
    emit(result={'recoveryReviewed':True,'healthVerified':True,'originalStatesPreserved':True})

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
    if manifest.get('kind')=='static':
        if manifest.get('containers'):raise ValueError('Invalid static backup manifest')
        directory=root/'static-site';safe_extract(unpacked/'static-files.tar',directory)
        entries=list(directory.iterdir())
        if len(entries)!=1 or not entries[0].is_dir():raise ValueError('Static archive must have one website directory')
        if tree_digest(entries[0])!=manifest.get('staticFiles'):raise ValueError('Restored static files differ from the captured website')
        for i,_ in enumerate(manifest.get('configurationFiles',[])):safe_extract(unpacked/('config-%d.tar'%i),root/('configuration-%d'%i))
        emit(result={'kind':'static','root':str(root),'documentRoot':str(entries[0]),'filesVerified':True,'fileCount':manifest['staticFiles']['files'],'hostingUnchanged':True,'externallyAccessible':False,'restoreTested':False,'access':'Review files at '+str(entries[0])+'; configure nginx only after validation.'});return
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
        definitions.append((name,args+[manifest['snapshotImages'][i]]))
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
        for c,cid in zip(containers,created):
            if c['State'].get('Running'):
                docker('start',cid);running.append(cid)
        until=time.time()+120
        while time.time()<until and not health(running):time.sleep(2)
        if not health(running):raise ValueError('Restored container health check failed')
    except Exception:
        try:
            if created:docker('stop','--time','30',*created)
        except Exception:pass
        raise
    emit(result={'containerId':created[0],'containerIds':created,'name':definitions[0][0],'networkMode':'isolated-internal' if networks else 'none','networks':list(networks.values()),'root':str(root),'access':'docker exec '+definitions[0][0]+' sh','externallyAccessible':False,'restoreTested':False,'containerHealthVerified':True,'originalStatesPreserved':True})
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

def main(req):
    op=req['operation']
    if op=='readiness':emit(result=readiness(req['config']))
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
    elif op=='prepare-restore':prepare_restore(req)
    elif op=='restore':restore(req)
    elif op=='verify-recovery':verify_recovery(req)
    elif op=='verify-restore-recovery':verify_restore_recovery(req)
    elif op=='deploy-maintenance':deploy_maintenance(req)
    elif op=='maintenance':
        req['config'].setdefault('maintenance',{})['required']=True
        maintenance(req['config'],req['enabled']);emit(result={'enabled':req['enabled']})
    elif op=='cleanup':
        root=pathlib.Path(req['root']);uuid.UUID(root.name)
        if not (root/'disarmed').exists() or not (root/'watchdog.done').exists():raise ValueError('Recovery watchdog has not acknowledged disarm')
        shutil.rmtree(root);emit(result={'removed':True})
    else:raise ValueError('Unsupported helper operation')
if __name__=='__main__':
    try:main(json.loads(sys.stdin.readline()))
    except Exception as e:emit(error=str(e));sys.exit(1)
