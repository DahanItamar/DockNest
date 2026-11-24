# helper/discovery.py: Docker project and nginx site discovery, configuration files, tmpfs mounts.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    DEFAULT_CAPABILITIES, docker, inspect, run)
from .runtime import (
    RUNTIME_USER, MIN_RUNTIME_UID, Runtime, RuntimeRefused, parse_subid, using_runtime)
from .paths import (
    SITE_PATH, lexical, within)
from .routing import (
    match_upstream, upstream_address)
# </build:header>
# Stack managers (since 3.0.0, docs/site-setup.md): Portainer and Dockge run `docker compose` inside their own container,
# so a stack's Compose labels name its folder as that container sees it (Portainer: /data/compose/<id>). Through the
# manager's mounts that folder maps to the host. Read only: DockNest reads the manager's image, mounts and stacks setting.
STACK_MANAGER_IMAGES=(('portainer',re.compile(r'(?:[a-zA-Z0-9.:-]+/)?portainer/portainer(?:-ce|-ee)?')),('dockge',re.compile(r'(?:[a-zA-Z0-9.:-]+/)?louislam/dockge')))
def image_repository(image):
    name=str(image or '').split('@')[0];head,_,tail=name.rpartition('/')
    return (head+'/' if head else '')+tail.split(':')[0]
def stack_manager_kind(image):
    repository=image_repository(image)
    return next((kind for kind,pattern in STACK_MANAGER_IMAGES if pattern.fullmatch(repository)),None)
def stack_managers(containers):
    """The Portainer and Dockge containers among `containers`: kind, the stacks folder as the manager sees it, and its
    mounts (destination, host source), longest destination first."""
    managers=[]
    for c in containers:
        config=c.get('Config') or {};kind=stack_manager_kind(config.get('Image'))
        if not kind:continue
        if kind=='portainer':
            args=[str(value) for value in config.get('Cmd') or []]
            data=next((value.partition('=')[2] for value in args if value.startswith('--data=')),None) or next((args[i+1] for i,value in enumerate(args[:-1]) if value in ('--data','-d')),None) or '/data'
            stacks=posixpath.join(data,'compose')
        else:
            # Only this one setting is read from the environment; no other value leaves the container record.
            stacks=next((str(value).partition('=')[2] for value in config.get('Env') or [] if str(value).startswith('DOCKGE_STACKS_DIR=')),'') or '/opt/stacks'
        # A stacks folder of '/' would map every path a container names; such a manager is skipped.
        if not stacks.startswith('/') or '..' in stacks.split('/') or lexical(stacks)=='/':continue
        mounts=[(lexical(m['Destination']),m['Source']) for m in c.get('Mounts') or [] if m.get('Type') in ('bind','volume')
            and isinstance(m.get('Destination'),str) and m['Destination'].startswith('/') and isinstance(m.get('Source'),str) and m['Source']]
        managers.append({'kind':kind,'stacks':lexical(stacks),'mounts':sorted(mounts,key=lambda m:-len(m[0]))})
    return managers
def managed_path(value,managers):
    """(host path, manager kind) for a path inside a stack manager's stacks folder, or None when no manager holds it.
    The path comes from container labels: an unusual one ('..', relative, the stacks folder itself) maps to nothing."""
    value=str(value or '')
    if not value.startswith('/') or '..' in value.split('/'):return None
    path=lexical(value)
    for manager in managers:
        if path==manager['stacks'] or not within(path,manager['stacks']):continue
        for destination,source in manager['mounts']:
            if not within(path,destination):continue
            rest=[part for part in path[len(destination):].split('/') if part]
            return str(pathlib.Path(source).joinpath(*rest)),manager['kind']
    return None
def host_path(value,managers):
    mapped=managed_path(value,managers)
    return mapped[0] if mapped else value
def project_root(value):
    p=pathlib.Path(value)
    if not value or not p.is_absolute() or '..' in p.parts:return False
    if str(p) in ['/', '/etc','/home','/root','/var','/srv','/opt','/tmp']:return False
    if str(p).startswith(('/proc','/sys','/dev','/run')):return False
    return p.is_dir() and os.path.realpath(p)==os.path.abspath(p)
def project_folders(container):
    labels=container.get('Config',{}).get('Labels',{}) or {}
    if not labels.get('com.docker.compose.project'):return []
    paths=[labels.get('com.docker.compose.project.working_dir','')]
    # A label path is a Linux path; PurePosixPath keeps its parent the same when the unit tests run on Windows.
    paths.extend(str((pathlib.PurePosixPath if value.strip().startswith('/') else pathlib.Path)(value.strip()).parent) for value in labels.get('com.docker.compose.project.config_files','').split(',') if value.strip())
    return paths
def project_roots(container,managers=()):
    """The container's Compose project folders on this host. A folder a stack manager names maps to the host first; the
    label path as written stays the fallback, exactly as before stack managers were read."""
    roots=[]
    for value in project_folders(container):
        mapped=managed_path(value,managers)
        root=next((str(pathlib.Path(candidate)) for candidate in ([mapped[0]] if mapped else [])+[value] if project_root(candidate)),None)
        if root and root not in roots:roots.append(root)
    return roots
def container_stack_manager(container,managers,roots):
    """'portainer' or 'dockge' when the container's project folder is a manager's stack found on this host."""
    for value in project_folders(container):
        mapped=managed_path(value,managers)
        if mapped and str(pathlib.Path(mapped[0])) in roots:return mapped[1]
    return None

def nginx_parse(tokens):
    nodes=[];words=[]
    for token in tokens:
        if token==';':
            if words:nodes.append((words[0],words[1:],[]))
            words=[]
        elif token=='{':
            nested=nginx_parse(tokens)
            if words:nodes.append((words[0],words[1:],nested))
            words=[]
        elif token=='}':break
        else:words.append(token)
    return nodes
def nginx_walk(nodes):
    for name,args,children in nodes:
        yield name,args,children
        yield from nginx_walk(children)
CONFIG_LIMIT=1024*1024
def read_config(path,follow_links=True,limit=CONFIG_LIMIT):
    """The text of one regular configuration file of at most `limit` bytes, or None. Opened without blocking and checked
    on the open descriptor, so a FIFO or device swapped in never hangs the helper; with follow_links False a symbolic
    link is refused too (files a container controls, such as Nginx Proxy Manager's and Caddy's)."""
    flags=os.O_RDONLY|getattr(os,'O_NONBLOCK',0)|(0 if follow_links else getattr(os,'O_NOFOLLOW',0))
    if not follow_links and os.path.islink(path):return None
    try:descriptor=os.open(str(path),flags)
    except OSError:return None
    with os.fdopen(descriptor,'rb') as handle:
        info=os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>limit:return None
        data=handle.read(limit+1)
    return data.decode('utf-8','replace') if len(data)<=limit else None
def nginx_file_nodes(file,follow_links=True):
    """The parsed directives of one nginx file of at most 1 MB, or None."""
    text=read_config(file,follow_links)
    if text is None:return None
    try:
        lexer=shlex.shlex(text,posix=True,punctuation_chars='{};');lexer.whitespace_split=True
        return nginx_parse(iter(lexer))
    except ValueError:return None
def nginx_servers(folders=None,follow_links=True):
    """(file, domains, directives) of every nginx server block with a domain name. Contents never leave the helper."""
    for folder in folders or ['/etc/nginx/sites-enabled','/etc/nginx/conf.d']:
        directory=pathlib.Path(folder)
        if not directory.is_dir():continue
        for file in sorted(directory.iterdir()):
            nodes=nginx_file_nodes(file,follow_links)
            for name,args,children in nginx_walk(nodes or []):
                if name!='server':continue
                domains=[v for key,values,_ in children if key=='server_name' for v in values if re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]+',v) and '.' in v]
                if domains:yield file,domains,children

NGINX_CERTIFICATE=re.compile(r'/live/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/[A-Za-z0-9._-]+')
CERTIFICATE_FILE=re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')
def nginx_listen_port(args):
    """The port of one `listen` directive (80, 443 ssl, [::]:443, 127.0.0.1:8080), or None for a Unix socket."""
    value=(args or ['80'])[0]
    if value.startswith('unix:'):return None
    port=value.rsplit(']',1)[-1]
    port=port.rsplit(':',1)[1] if ':' in port else port if port.isdigit() else '80'
    return int(port) if port.isdigit() and 0<int(port)<65536 else None
def nginx_certificate_name(path):
    """A certbot certificate's name (/etc/letsencrypt/live/NAME/fullchain.pem), else the file name. Never a path."""
    if '$' in path:return None
    match=NGINX_CERTIFICATE.search(path)
    if match:return match.group(1)
    name=path.rsplit('/',1)[-1]
    return name if CERTIFICATE_FILE.fullmatch(name) else None
def nginx_pools(file,follow_links=True):
    """Named upstream blocks of one file: proxy_pass http://shop reaches their servers."""
    return {args[0]:[v[0] for k,v,_ in children if k=='server' and v] for name,args,children in nginx_walk(nginx_file_nodes(file,follow_links) or []) if name=='upstream' and args}
def nginx_targets(flattened,pools):
    """proxy_pass targets of one server block. Nginx Proxy Manager writes `set $server "app"; set $port 8080;` and proxies
    to $forward_scheme://$server:$port through an include, so those variables are filled in."""
    variables={values[0][1:]:values[1] for key,values,_ in flattened if key=='set' and len(values)==2 and values[0] in ('$forward_scheme','$server','$port')}
    substitute=lambda value,known:re.sub(r'\$(forward_scheme|server|port)\b',lambda match:known.get(match.group(1),match.group(0)),value).replace('$request_uri','')
    proxies=[substitute(values[0],variables) for key,values,_ in flattened if key=='proxy_pass' and values]
    if not proxies and {'server','port'}<=set(variables):proxies=[substitute('$forward_scheme://$server:$port',{'forward_scheme':'http',**variables})]
    names=[value.split('://',1)[-1].rstrip('/') for value in proxies]
    return [target for value,name in zip(proxies,names) for target in (['http://'+server for server in pools[name]] if name in pools else [value])]
def nginx_sites(folders=None,follow_links=True):
    """Return routing metadata only, never nginx configuration contents or TLS keys."""
    sites=[];pools={}
    for file,domains,children in nginx_servers(folders,follow_links):
        if file not in pools:pools[file]=nginx_pools(file,follow_links)
        flattened=list(nginx_walk(children))
        proxies=nginx_targets(flattened,pools[file])
        dynamic=any(key in ['proxy_pass','fastcgi_pass','uwsgi_pass','scgi_pass'] for key,_,_ in flattened)
        facts={'listen':sorted({port for key,values,_ in children if key=='listen' for port in [nginx_listen_port(values)] if port}) or [80],
            'certificates':sorted({name for key,values,_ in children if key=='ssl_certificate' and values for name in [nginx_certificate_name(values[0])] if name})}
        roots=[values[0] for key,values,_ in children if key=='root' and values]
        if not roots:
            roots=[v[0] for key,values,nested in children if key=='location' and values==['/'] for k,v,_ in nested if k=='root' and v]
        for root in roots[:1] if not dynamic else []:
            p=pathlib.Path(root)
            if p.is_absolute() and '..' not in p.parts and str(p) not in ['/','/etc','/root','/home','/var','/var/www','/srv','/opt','/tmp'] and p.is_dir() and p.resolve()==p and (p/'index.html').is_file():
                sites.append({'kind':'static','name':domains[0],'domains':domains,'documentRoot':str(p),'configFiles':[str(file.resolve())],'healthUrl':'https://'+domains[0],**facts})
        if proxies:sites.append({'kind':'proxy','domains':domains,'upstreams':proxies,**facts})
    unique={}
    for site in sites:unique[(site['kind'],tuple(site['domains']),site.get('documentRoot',''))]=site
    return list(unique.values())

def web_hints(container,routes):
    """Health URL candidates (loopback ports of common web ports) and the domains whose nginx upstream reaches this
    container, by the matcher every proxy adapter shares (remote/helper/routing.py)."""
    ports=container.get('NetworkSettings',{}).get('Ports',{}) or {}
    candidates=[]
    for internal,bindings in ports.items():
        if not internal.endswith('/tcp'):continue
        for binding in bindings or []:
            port=binding.get('HostPort','');host=binding.get('HostIp','')
            if not port.isdigit() or host not in ['127.0.0.1','0.0.0.0','::','::1']:continue
            if internal.split('/')[0] not in ['80','8080','3000','5173','8000','5000','5678']:continue
            candidates.append('http://127.0.0.1:'+port+'/')
    domains=[domain for route in routes for value in route.get('upstreams',[]) for upstream in [upstream_address(value)]
        if upstream and match_upstream(upstream,[container]) for domain in route['domains']]
    return {'healthUrls':list(dict.fromkeys(candidates)),'domains':list(dict.fromkeys(domains))}

def inspect_each(ids):
    """Inspect records of the listed containers and how many could not be read (one removed meanwhile, say): a scan
    never fails on one container, and the count tells the coverage view the scan is incomplete."""
    if not ids:return [],0
    try:return inspect(ids),0
    except subprocess.CalledProcessError:
        records=[]
        for cid in ids:
            try:records+=inspect([cid])
            except subprocess.CalledProcessError:pass
        return records,len(ids)-len(records)
DOCKER_NETWORKS={'bridge','host','none','default'}
def user_networks(container):
    """The user-defined networks a container is on: the hint that plain containers belong to one app."""
    return sorted(name for name in (container.get('NetworkSettings') or {}).get('Networks') or {} if name not in DOCKER_NETWORKS)
def volume_labels(text):
    # `docker volume ls` prints labels as one "key=value,key=value" string; a comma inside a value cannot be told apart.
    return dict(item.partition('=')[::2] for item in str(text or '').split(',') if item)
def discovered_volumes():
    """Every volume on the server: name, driver and labels only (never its contents or mount point). None when they
    cannot be listed: a scan never fails on them, and None is never read as "no volumes"."""
    try:return [{'name':v.get('Name'),'driver':v.get('Driver'),'labels':volume_labels(v.get('Labels'))} for v in map(json.loads,filter(str.strip,docker('volume','ls','--format','{{json .}}').decode().splitlines()))]
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError,ValueError,AttributeError):return None
def configuration_paths(container,managers=()):
    labels=container.get('Config',{}).get('Labels',{}) or {}
    roots=project_roots(container,managers)
    def valid_file(value):
        p=pathlib.Path(value)
        return p.is_absolute() and '..' not in p.parts and any(p.is_relative_to(root) for root in roots) and p.is_file() and os.path.realpath(p)==os.path.abspath(p) and os.access(p,os.R_OK)
    compose=[host_path(value.strip(),managers) for value in labels.get('com.docker.compose.project.config_files','').split(',') if value.strip()]
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
    manager=container_stack_manager(container,managers,roots)
    return {'composeFiles':[value for value in compose if valid_file(value)],'configFiles':configs,'directory':roots[0] if roots else '',**({'manager':manager} if manager else {})}

def manager_containers():
    """Inspect records of the server's Portainer and Dockge containers only, picked by image; [] when none can be read."""
    try:
        lines=docker('ps','-a','--no-trunc','--format','{{.ID}} {{.Image}}').decode().splitlines()
        ids=[cid for cid,_,image in (line.partition(' ') for line in lines) if re.fullmatch(r'[0-9a-f]{12,64}',cid) and stack_manager_kind(image)]
        return inspect_each(ids)[0]
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError,ValueError):return []
def list_project_files(ids,directory=None):
    if not ids or len(ids)>30 or not all(isinstance(value,str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}',value) for value in ids):raise ValueError('Choose valid site containers')
    selected=inspect(ids);managers=stack_managers(manager_containers()) if any(project_folders(c) for c in selected) else []
    roots=list(dict.fromkeys(root for container in selected for root in project_roots(container,managers)))
    if not roots:raise ValueError('No project configuration folder was detected. Enter the file paths manually.')
    p=pathlib.Path(directory or roots[0])
    if not p.is_absolute() or '..' in p.parts or not any(p.is_relative_to(root) for root in roots):raise ValueError('Choose a folder inside this site\'s detected project directory')
    if os.path.realpath(p)!=os.path.abspath(p) or not p.is_dir():raise ValueError('Choose a regular project folder, not a symbolic link')
    entries=[]
    with os.scandir(p) as items:
        for item in items:
            kind='link' if item.is_symlink() else 'directory' if item.is_dir(follow_symlinks=False) else 'file' if item.is_file(follow_symlinks=False) else 'other'
            entry_path=str(p/item.name)
            entries.append({'name':item.name,'path':entry_path,'kind':kind,'selectable':kind=='file' and bool(SITE_PATH.fullmatch(entry_path))})
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

# ---- Hardening facts (docs/hardening-score.md) ----
# Read-only facts about how each container is configured, gathered from the `docker inspect` output that discovery and
# backups already read. Only booleans, port bindings, the image reference and capability names leave the server: never
# environment values, labels, commands or mount sources other than the Docker socket flag.
HARDENING_FORMAT=1
# A bind of the socket itself, of a folder that holds it, or onto the path clients use, gives the container the engine.
SOCKET_FOLDERS=('/','/var','/run','/var/run','/run/podman')
USER_RUN=re.compile(r'/run/user/[0-9]+(?:/(?:docker|podman)\.sock)?')
def engine_socket(source,destination):
    source=str(source or '').rstrip('/') or '/';destination=str(destination or '').rstrip('/')
    return source.endswith(('/docker.sock','/podman.sock')) or source in SOCKET_FOLDERS or bool(USER_RUN.fullmatch(source)) or destination=='/var/run/docker.sock'
def engine_rootless():
    """rootless, userns or none for the Docker engine; None when it cannot be read."""
    try:options=json.loads(run(['docker','info','--format','{{json .SecurityOptions}}'],timeout=15) or b'null') or []
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError,ValueError):return None
    names=[o for o in options if isinstance(o,str)]
    return 'rootless' if any('name=rootless' in o for o in names) else 'userns' if any('name=userns' in o for o in names) else 'none'
def image_pin(image):
    """digest, tag, latest or untagged for an image reference such as nginx:1.27 or app@sha256:..."""
    if not isinstance(image,str) or not image or re.fullmatch(r'(?:sha256:)?[0-9a-f]{12,64}',image):return 'untagged'
    if '@sha256:' in image:return 'digest'
    last=image.rsplit('/',1)[-1]
    if ':' not in last:return 'untagged'
    return 'latest' if last.rsplit(':',1)[1]=='latest' else 'tag'
def root_user(user):
    name=(user or '').split(':',1)[0].strip()
    return name in ('','root','0')
def loopback(address):
    address=address.strip('[]').split('%',1)[0]
    if address=='localhost':return True
    try:return ipaddress.ip_address(address).is_loopback
    except ValueError:return False
DATABASE_PORTS={'3306','5432','6379','27017','1433'}
def container_hardening_facts(c,engine=None):
    config=c.get('Config') or {};host=c.get('HostConfig') or {}
    bindings={}
    for source in (host.get('PortBindings') or {},(c.get('NetworkSettings') or {}).get('Ports') or {}):
        for internal,values in source.items():
            for binding in values or []:
                if not isinstance(binding,dict):continue
                address=(binding.get('HostIp') or '').split('%',1)[0];port=str(binding.get('HostPort') or '')
                if not loopback(address):bindings[(address or '0.0.0.0')+':'+(port or '?')+'->'+str(internal)]=True
    # Database ports first, so a long list never drops the finding that matters most.
    ports=sorted(bindings,key=lambda value:(not bool(DATABASE_PORTS & set(re.findall(r'[0-9]+',value.split(':')[-1]))),value))[:64]
    sockets=any(m.get('Type')=='bind' and engine_socket(m.get('Source'),m.get('Destination')) for m in c.get('Mounts') or [])
    sockets=sockets or any(m.get('Destination')=='/var/run/docker.sock' for m in c.get('Mounts') or [])
    sockets=sockets or any(isinstance(b,str) and engine_socket(*(b.split(':')+[''])[:2]) for b in host.get('Binds') or [])
    check=(config.get('Healthcheck') or {}).get('Test') or []
    security=[str(o).replace('=',':') for o in host.get('SecurityOpt') or []]
    added=[str(cap).upper().removeprefix('CAP_') for cap in host.get('CapAdd') or [] if isinstance(cap,str)]
    # With userns-remap, a container started with --userns=host still runs as real root.
    rootless=None if engine is None else engine=='rootless' or (engine=='userns' and host.get('UsernsMode')!='host')
    return {'format':HARDENING_FORMAT,'name':(c.get('Name') or '').lstrip('/') or (c.get('Id') or '')[:12],
        'privileged':bool(host.get('Privileged')),'dockerSocket':sockets,'rootUser':root_user(config.get('User')),
        'rootless':rootless,'hostNetwork':host.get('NetworkMode')=='host','publicPorts':ports,'publishAll':bool(host.get('PublishAllPorts')),
        'memoryLimit':bool(host.get('Memory')),'image':str(config.get('Image') or '')[:255],'imagePin':image_pin(config.get('Image')),
        'healthcheck':bool(check) and check[0]!='NONE','noNewPrivileges':any(o in ('no-new-privileges','no-new-privileges:true') for o in security),
        'extraCapabilities':sorted({cap for cap in added if cap not in DEFAULT_CAPABILITIES})[:40]}
def hardening_report(containers):
    """Facts for every container, or None. A fact we cannot read never fails the scan or the backup around it."""
    try:
        engine=engine_rootless() if containers else None
        return [container_hardening_facts(c,engine) for c in containers]
    except Exception:return None

# ---- Linked apps facts (docs/linked-apps.md) ----
# Read-only facts that show how containers depend on each other, from the same `docker inspect` output: the Compose
# project, service and depends_on service names, user-defined network names, named volumes, bind sources
# and legacy links. Never environment values, commands, other labels or file contents. DockNest validates them again.
LINKS_FORMAT=1
DEFAULT_NETWORKS=('bridge','host','none')
def depends_on_services(label):
    """Service names from a Compose depends_on label such as db:service_healthy:false,cache:service_started:true."""
    return sorted({part.split(':',1)[0].strip() for part in (label or '').split(',') if part.split(':',1)[0].strip()})
def link_target(value):
    """The linked container of a HostConfig.Links entry such as /db:/web/db."""
    return value.split(':',1)[0].lstrip('/')
def container_link_facts(c):
    labels=(c.get('Config') or {}).get('Labels') or {};mounts=c.get('Mounts') or []
    networks=(c.get('NetworkSettings') or {}).get('Networks') or {}
    def mounted(kind,field):return sorted({m[field] for m in mounts if m.get('Type')==kind and isinstance(m.get(field),str) and m[field]})
    return {'format':LINKS_FORMAT,'project':labels.get('com.docker.compose.project') or None,'service':labels.get('com.docker.compose.service') or None,
        'networks':sorted(name for name in networks if name not in DEFAULT_NETWORKS),
        'volumes':mounted('volume','Name'),'binds':mounted('bind','Source'),
        'links':sorted({link_target(v) for v in (c.get('HostConfig') or {}).get('Links') or [] if isinstance(v,str) and link_target(v)}),
        'dependsOn':depends_on_services(labels.get('com.docker.compose.depends_on'))}
def link_report(containers):
    """Facts per container; None for one that cannot be read, so a scan never fails because of them."""
    def facts(c):
        try:return container_link_facts(c)
        except Exception:return None
    return [facts(c) for c in containers]

# ---- Container engines (docs/podman-rootless.md, ADR decision 2) ----
# Read-only probe of the engines root can reach: rootful Docker, Podman as root, and for each user with a subordinate ID
# range whose home already holds rootless storage, that user's running rootless Docker and rootless Podman. Nothing is
# started or created, a home folder is only lstat'd (never followed through a link), and any engine that cannot be read
# is left out: the probe never fails a scan. Users, uids, homes and versions of rootless engines come from files and
# sockets those users control, so they are validated here and again by DockNest before they are shown.
ENGINE_LIST_LIMIT=32
SUBORDINATE_FILE='/etc/subuid'
ENGINE_VERSION=re.compile(r'[0-9][0-9A-Za-z.+~_-]{0,31}')
def rootless_users(subuid_text=None,lookup=None):
    """(user, uid, home) for each name in /etc/subuid with exactly one valid range, a normal uid and an absolute home."""
    if subuid_text is None:
        try:subuid_text=pathlib.Path(SUBORDINATE_FILE).read_text()
        except OSError:return []
    if lookup is None:
        def lookup(key):
            import pwd
            try:entry=pwd.getpwuid(int(key)) if str(key).isdigit() else pwd.getpwnam(key)
            except (KeyError,ValueError,OverflowError):return None
            return entry.pw_name,entry.pw_uid,entry.pw_dir
    found,seen=[],set()
    for line in str(subuid_text).splitlines():
        line=line.strip()
        if not line or line.startswith('#') or line.count(':')!=2:continue
        entry=lookup(line.split(':',1)[0])
        if not entry or entry[0] in seen:continue
        user,uid,home=entry
        seen.add(user)
        if not isinstance(user,str) or not RUNTIME_USER.fullmatch(user) or type(uid) is not int or uid<MIN_RUNTIME_UID:continue
        if not isinstance(home,str) or not home.startswith('/') or home=='/' or posixpath.normpath(home)!=home or '\0' in home:continue
        own='\n'.join(l for l in str(subuid_text).splitlines() if l.strip().split(':',1)[0] in (user,str(uid)))
        try:parse_subid(own,user,uid)
        except RuntimeRefused:continue
        found.append((user,uid,home))
        if len(found)>=ENGINE_LIST_LIMIT:break
    return found
def storage_folder(home,*parts,lstat=os.lstat):
    """True when home/<parts> is a real folder (a link, a file or nothing is False). Never reads inside it."""
    path=home
    for part in parts:
        path=posixpath.join(path,part)
        try:info=lstat(path)
        except OSError:return False
        if not stat.S_ISDIR(info.st_mode):return False
    return True
def socket_owned_by(path,uid,lstat=os.lstat):
    try:info=lstat(path)
    except OSError:return False
    return stat.S_ISSOCK(info.st_mode) and info.st_uid==uid
def cgroup_delegated(uid,read=None):
    """True when the user's systemd slice has memory and cpu delegated (cgroup v2), so a limit can be set for its containers."""
    path='/sys/fs/cgroup/user.slice/user-%d.slice/user@%d.service/cgroup.controllers'%(uid,uid)
    try:text=(read or (lambda p:pathlib.Path(p).read_text()))(path)
    except OSError:return False
    return {'memory','cpu'}<=set(str(text).split())
def engine_version(runtime,format):
    try:answer=runtime.cli('version','--format',format,timeout=20).decode('utf-8','replace').strip()
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError):return None
    return answer if ENGINE_VERSION.fullmatch(answer) else None
def engine_probe(subuid_text=None,lookup=None,lstat=os.lstat,which=shutil.which,delegated=cgroup_delegated,version=engine_version):
    """Engines found on this server: [{engine, rootless, user?, uid?, version, cgroupDelegated}]. Never raises."""
    engines=[]
    def add(runtime,format,delegation):
        number=version(runtime,format)
        if number is None:return
        engines.append({**runtime.describe(),'version':number,'cgroupDelegated':delegation})
    try:
        add(Runtime(),'{{.Server.Version}}',True)
        if which('podman'):add(Runtime('podman'),'{{.Version}}',True)
        for user,uid,home in rootless_users(subuid_text,lookup):
            if storage_folder(home,'.local','share','docker',lstat=lstat) and socket_owned_by('/run/user/%d/docker.sock'%uid,uid,lstat):
                add(Runtime('docker',True,user,uid,home),'{{.Server.Version}}',bool(delegated(uid)))
            if which('podman') and storage_folder(home,'.local','share','containers','storage',lstat=lstat):
                add(Runtime('podman',True,user,uid,home),'{{.Version}}',bool(delegated(uid)))
    except Exception:pass
    return engines[:ENGINE_LIST_LIMIT]
def engine_homes(subuid_text=None,lookup=None):
    return {user:home for user,uid,home in rootless_users(subuid_text,lookup)}
def engine_runtime(engine,homes):
    """The Runtime for one probed engine record (its home taken from the passwd lookup, never from the record), or None."""
    try:
        home=homes.get(engine.get('user')) if engine.get('rootless') else None
        return Runtime(engine['engine'],engine['rootless'],engine.get('user'),engine.get('uid'),home)
    except (RuntimeRefused,KeyError,TypeError,AttributeError):return None
ENGINE_CONTAINER_LIMIT=200
ENGINE_OUTPUT_LIMIT=8*1024*1024
def other_engine_containers(engines,homes):
    """(runtime, inspect record) for every container of every non-default engine. A broken, slow or oversized engine
    adds nothing: a rootless user controls its engine's answers, so time, size and count are all capped."""
    tagged=[]
    for engine in engines[:ENGINE_LIST_LIMIT]:
        runtime=engine_runtime(engine,homes)
        if runtime is None or (runtime.engine=='docker' and not runtime.rootless):continue
        try:
            listing=runtime.cli('ps','-aq',timeout=30)
            if len(listing)>ENGINE_OUTPUT_LIMIT:continue
            ids=listing.decode('utf-8','replace').split()[:ENGINE_CONTAINER_LIMIT]
            if not ids or not all(re.fullmatch(r'[0-9a-f]{12,64}',i) for i in ids):continue
            answer=runtime.cli('inspect',*ids,timeout=60)
            if len(answer)>ENGINE_OUTPUT_LIMIT:continue
            records=json.loads(answer)
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError,ValueError):continue
        if not isinstance(records,list):continue
        tagged+=[(runtime,c) for c in records[:ENGINE_CONTAINER_LIMIT] if isinstance(c,dict) and isinstance(c.get('Id'),str)]
    return tagged[:ENGINE_CONTAINER_LIMIT]
def foreign_container(runtime,c):
    """The discover entry of a container from a Podman or rootless engine: only fields the engine really answered.
    No hardening facts, links, web hints or configuration files yet: those read the rootful Docker engine only."""
    config,state,network=c.get('Config') or {},c.get('State') or {},c.get('NetworkSettings') or {}
    return {'hardening':None,'links':None,'runtime':runtime.describe(),'id':c['Id'],'name':str(c.get('Name') or '').lstrip('/'),'image':config.get('Image'),
        'state':state.get('Status'),'running':bool(state.get('Running')),'health':(state.get('Health') or {}).get('Status'),'labels':config.get('Labels') or {},
        'mounts':c.get('Mounts') or [],'temporaryMemoryFolders':list((c.get('HostConfig') or {}).get('Tmpfs') or {}),'ports':network.get('Ports') or {},
        'webHints':[],'backupConfiguration':{'composeFiles':[],'configFiles':[],'directory':''}}
# Until backup and restore understand other engines, an app that names one is refused by every operation that would
# otherwise run its containers through rootful Docker.
# KNOWN GAP for the backup/restore PR: operations that carry no config (restore and prepare-restore take a manifest;
# self-heal-*, describe-containers and list-project-files take names) are blocked in Node (src/runtime.js hasForeignRuntime),
# but the helper cannot see their engine yet. The restore PR must refuse a manifest whose runtime is not rootful Docker.
RUNTIME_FREE_OPERATIONS=('discover','test','domain-routes','install-status')
def refuse_foreign_runtime(request):
    config=request.get('config') if isinstance(request,dict) else None
    runtime=config.get('runtime') if isinstance(config,dict) else None
    if runtime is None or request.get('operation') in RUNTIME_FREE_OPERATIONS:return
    if isinstance(runtime,dict) and runtime.get('engine')=='docker' and runtime.get('rootless') is False and not runtime.get('user') and runtime.get('uid') is None:return
    raise RuntimeRefused('Backups and restores of Podman and rootless apps are not available yet in this release.')
