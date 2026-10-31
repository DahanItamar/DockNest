# helper/move.py: Site moves: source/target facts, deploy, compose override, nginx, cut-over steps.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    NOFOLLOW, VERSION, atomic_json, docker, emit, inspect, run)
from .paths import (
    SYSTEM_TREES, lexical, protected_lexical, protected_mount, resolved, within)
from .databases import (
    restart_services)
from .backup import (
    backup_plan, tree_digest)
from .net import (
    PROBE_LIMIT, health, probe_url, skip_refused_probes)
from .maintenance import (
    maintenance)
from .discovery import (
    nginx_sites, temporary_mounts, tmpfs_argument)
from .restore import (
    extract_archives, image_archives, mount_archive, mount_bytes, owned_job_root, restore_network_plan,
    unpack_verified)
from .install import (
    install_candidates, os_release, package_manager)
from .restore_test import (
    load_images_keeping_tags)
# </build:header>
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
