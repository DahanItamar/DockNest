# helper/routing.py: Read-only proxy routes for the domain path (docs/domains.md): nginx, Nginx Proxy Manager, Caddy, Traefik.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    docker, inspect)
from .discovery import (
    nginx_sites)
from .move import (
    host_addresses, listening_ports, process_running)
# </build:header>
# Only hosts, ports, upstreams (scheme, host and port) and certificate file names leave the server: never a configuration
# file, a path, a label other than a parsed Traefik rule, a credential, Nginx Proxy Manager's database or Traefik's
# dashboard. Nothing here changes the server, and nothing here can fail the operation it rides on.
ROUTING_FORMAT=1
ROUTE_LIMIT=200
CONFIG_LIMIT=1024*1024
CADDY_ADMIN=('127.0.0.1',2019,'/config/')
ROUTE_DOMAIN=re.compile(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+')
UPSTREAM_HOST=re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,252})|\[[0-9A-Fa-f:.]{2,45}\]')
LOCAL_HOSTS={'127.0.0.1','localhost','::1','0.0.0.0','::'}
ALL_INTERFACES={'','0.0.0.0','::'}
CONTAINER_NAME=re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}')

def route_domains(values):
    found=[]
    for value in values:
        value=str(value).lower().rstrip('.')
        if ROUTE_DOMAIN.fullmatch(value) and len(value)<=253 and value not in found:found.append(value)
    return found
def upstream_address(value,scheme='http'):
    """scheme://host[:port] of a proxy target, or None. Login details, paths and queries are dropped; a target that
    still holds a variable or a placeholder is not understood."""
    value=str(value).strip()
    if '://' in value:scheme,value=value.split('://',1)
    elif '/' in value:return None  # a Unix socket (unix//run/app.sock) or a path, never a network target
    value=value.split('/',1)[0].rsplit('@',1)[-1]
    if not re.fullmatch(r'[a-z][a-z0-9+.-]{0,15}',scheme.lower()):return None
    host,port=value,None
    match=re.fullmatch(r'(.*?):([0-9]{1,5})',value)
    if match and not value.endswith(']'):host,port=match.group(1),int(match.group(2))
    if not UPSTREAM_HOST.fullmatch(host) or (port is not None and not 0<port<65536):return None
    return scheme.lower()+'://'+host.lower()+(':%d'%port if port else '')
def split_upstream(value):
    scheme,rest=value.split('://',1)
    match=re.fullmatch(r'(.*?):([0-9]{1,5})',rest)
    host,port=(match.group(1),int(match.group(2))) if match and not rest.endswith(']') else (rest,None)
    return scheme,host.strip('[]'),port

def container_name(c):return (c.get('Name') or '').lstrip('/')
def container_aliases(c):
    """Names other containers reach this one by on a Docker network: its name, Compose service and network aliases."""
    names={container_name(c),(c.get('Config',{}).get('Labels') or {}).get('com.docker.compose.service','')}
    for network in ((c.get('NetworkSettings') or {}).get('Networks') or {}).values():
        names.update((network or {}).get('Aliases') or []);names.update((network or {}).get('DNSNames') or [])
    return {name.lower() for name in names if name}
def published_ports(c):
    """(host address, host port, container port) of every published TCP port."""
    found=[]
    for internal,bindings in ((c.get('NetworkSettings') or {}).get('Ports') or {}).items():
        if not str(internal).endswith('/tcp'):continue
        for binding in bindings or []:
            port=str((binding or {}).get('HostPort') or '')
            if port.isdigit():found.append(((binding.get('HostIp') or '').split('%',1)[0],int(port),int(str(internal).split('/')[0])))
    return found
def container_ports(c):
    exposed=set((c.get('Config') or {}).get('ExposedPorts') or {})|set(((c.get('NetworkSettings') or {}).get('Ports') or {}))
    return {int(value.split('/')[0]) for value in exposed if value.split('/')[0].isdigit()}
def match_upstream(upstream,containers,addresses=()):
    """Names of the containers a proxy target reaches: a host port a container publishes, reached through loopback or
    an address of this server, or a container's network name and port (http://shop-web:8080). A container that declares
    no port at all matches by name."""
    scheme,host,port=split_upstream(upstream)
    if port is None:port=443 if scheme=='https' else 80
    local=host in LOCAL_HOSTS;own=host in set(addresses)
    matched=[]
    for c in containers:
        name=container_name(c)
        if local or own:
            hit=any(published==port and (bound in ALL_INTERFACES or bound==host or (local and bound in LOCAL_HOSTS)) for bound,published,_ in published_ports(c))
        else:
            ports=container_ports(c)
            hit=host.lower() in container_aliases(c) and (not ports or port in ports)
        if hit and name not in matched:matched.append(name)
    return matched

def nginx_routes(proxy,folders=None,container=None):
    routes=[]
    for site in nginx_sites(folders):
        upstreams=[value for value in (upstream_address(raw) for raw in site.get('upstreams',[])) if value]
        routes.append({'proxy':proxy,'domains':route_domains(site['domains']),'upstreams':upstreams,'static':site['kind']=='static',
            'understood':len(upstreams)==len(site.get('upstreams',[])),'listen':site.get('listen',[]),'certificates':site.get('certificates',[]),
            **({'container':container} if container else {})})
    return routes

def image_of(c):return str((c.get('Config') or {}).get('Image') or '').lower()
def mount_source(c,destination):
    """The host folder or file mounted at `destination`, only when it is a plain absolute path."""
    for m in c.get('Mounts') or []:
        source=str(m.get('Source') or '')
        if m.get('Destination')==destination and os.path.isabs(source) and '..' not in pathlib.Path(source).parts and os.path.realpath(source)==os.path.abspath(source):return pathlib.Path(source)
    return None
def npm_routes(c):
    """Nginx Proxy Manager: the nginx files it generates under its /data mount, read with the nginx parser."""
    data=mount_source(c,'/data')
    return nginx_routes('npm',[str(data/'nginx'/'proxy_host')],container_name(c)) if data else []

def caddy_admin_config():
    """GET the Caddy admin API's configuration on loopback only, with a fixed path and a 1 MB limit."""
    host,port,path=CADDY_ADMIN
    connection=http.client.HTTPConnection(host,port,timeout=3)
    try:
        connection.request('GET',path,headers={'Accept':'application/json'})
        response=connection.getresponse()
        if response.status!=200:return None
        body=response.read(CONFIG_LIMIT+1)
        if len(body)>CONFIG_LIMIT:return None
        return json.loads(body)
    finally:connection.close()
def caddy_json_routes(config,container=None):
    """Reduces Caddy's JSON to hosts and reverse_proxy upstreams. Handlers, headers and matchers stay on the server."""
    routes=[]
    def upstreams_of(handlers,hosts,listen):
        found=[]
        for handler in handlers or []:
            if not isinstance(handler,dict):continue
            if handler.get('handler')=='reverse_proxy':
                found.extend(value for value in (upstream_address((u or {}).get('dial','')) for u in handler.get('upstreams') or [] if isinstance(u,dict)) if value)
            elif handler.get('handler')=='subroute':walk(handler.get('routes'),hosts,listen)
        return found
    def walk(items,inherited,listen):
        for route in items or []:
            if not isinstance(route,dict):continue
            hosts=route_domains(h for m in route.get('match') or [] if isinstance(m,dict) for h in m.get('host') or [])
            hosts=hosts or inherited
            upstreams=upstreams_of(route.get('handle'),hosts,listen)
            if hosts and upstreams:routes.append({'proxy':'caddy','domains':hosts,'upstreams':upstreams,'static':False,'understood':True,'listen':listen,'certificates':[],**({'container':container} if container else {})})
    servers=(((config or {}).get('apps') or {}).get('http') or {}).get('servers') or {}
    for server in servers.values() if isinstance(servers,dict) else []:
        if not isinstance(server,dict):continue
        listen=sorted({int(value.rsplit(':',1)[1]) for value in server.get('listen') or [] if isinstance(value,str) and re.fullmatch(r'.*:[0-9]{1,5}',value) and 0<int(value.rsplit(':',1)[1])<65536})
        walk(server.get('routes'),[],listen)
    return routes
def caddyfile_routes(text,container=None):
    """Site addresses and reverse_proxy targets of a Caddyfile. Global options, snippets and every other directive
    (basic auth hashes, headers, environment placeholders) are skipped, never returned."""
    routes=[];depth=0;site=None;understood=True
    for raw in text.splitlines():
        line=raw.split(' #',1)[0].strip()
        if not line or line.startswith('#'):continue
        words=line.split()
        if depth==0 and words[-1]=='{':
            addresses=[w.rstrip(',') for w in words[:-1] for w in w.split(',') if w]
            if not addresses or addresses[0].startswith('('):site=None
            else:
                hosts=[];listen=set()
                for address in addresses:
                    match=re.fullmatch(r'(?:(https?)://)?([^:/]*)(?::([0-9]{1,5}))?(?:/.*)?',address)
                    if not match:continue
                    if match.group(3):listen.add(int(match.group(3)))
                    elif match.group(1)!='http':listen.update((80,443))
                    else:listen.add(80)
                    hosts.extend(route_domains([match.group(2)]))
                site={'proxy':'caddy','domains':hosts,'upstreams':[],'static':False,'understood':True,'listen':sorted(listen),'certificates':[],**({'container':container} if container else {})}
        elif depth==0 and words[0]=='import':understood=False
        elif site is not None and words[0]=='reverse_proxy':
            targets=[w for w in words[1:] if w!='{' and not w.startswith(('@','/','*'))]
            values=[upstream_address(w) for w in targets]
            site['upstreams'].extend(value for value in values if value)
            if not all(values):site['understood']=False
        depth+=line.count('{')-line.count('}')
        if depth<=0:
            depth=0
            if site is not None and site['domains'] and site['upstreams']:routes.append(site)
            if site is not None and words[-1]!='{':site=None
    return routes,understood
def caddy_routes(c):
    """The admin API first (loopback, GET only); then the Caddyfile mounted into the Caddy container."""
    try:config=caddy_admin_config()
    except (OSError,ValueError,http.client.HTTPException):config=None
    if config is not None:return caddy_json_routes(config,container_name(c) if c else None),True
    if c is None:return [],False
    for destination,name in (('/etc/caddy/Caddyfile',''),('/etc/caddy','Caddyfile')):
        source=mount_source(c,destination)
        path=source/name if source and name else source
        try:
            if path and path.is_file() and path.stat().st_size<=CONFIG_LIMIT:return caddyfile_routes(path.read_text(errors='replace'),container_name(c))
        except OSError:continue
    return [],False

TRAEFIK_ROUTER=re.compile(r'traefik\.(http|tcp)\.routers\.([A-Za-z0-9_-]{1,64})\.rule')
TRAEFIK_HOST=re.compile(r'\s*(Host|HostSNI)\(\s*((?:`[^`]*`|"[^"]*")(?:\s*,\s*(?:`[^`]*`|"[^"]*"))*)\s*\)\s*')
def traefik_rule_hosts(rule):
    """Hosts of a rule made only of Host() or HostSNI() joined by ||, else None ("route not understood")."""
    hosts=[]
    for part in str(rule).split('||'):
        match=TRAEFIK_HOST.fullmatch(part)
        if not match:return None
        values=[value[1:-1] for value in re.findall(r'`[^`]*`|"[^"]*"',match.group(2))]
        domains=route_domains(values)
        if len(domains)!=len(values):return None
        hosts.extend(domains)
    return hosts or None
def traefik_routes(containers):
    """Routers from Docker labels, parsed as text and never evaluated. Each route reaches the container it is defined on."""
    routes=[];unparsed=[]
    for c in containers:
        labels=(c.get('Config') or {}).get('Labels') or {};name=container_name(c)
        if str(labels.get('traefik.enable','')).lower()=='false' or not CONTAINER_NAME.fullmatch(name):continue
        for key,rule in labels.items():
            match=TRAEFIK_ROUTER.fullmatch(key)
            if not match:continue
            kind,router=match.groups()
            hosts=traefik_rule_hosts(rule)
            if hosts is None:unparsed.append({'proxy':'traefik','container':name,'router':router});continue
            services=sorted({k.split('.')[3] for k in labels if re.fullmatch(r'traefik\.'+kind+r'\.services\.[A-Za-z0-9_-]{1,64}\.loadbalancer\.server\.port',k)})
            service=labels.get('traefik.%s.routers.%s.service'%(kind,router)) or (services[0] if len(services)==1 else None)
            port=str(labels.get('traefik.%s.services.%s.loadbalancer.server.port'%(kind,service),'')) if service else ''
            upstream=('http' if kind=='http' else 'tcp')+'://'+name.lower()+(':'+port if port.isdigit() and 0<int(port)<65536 else '')
            routes.append({'proxy':'traefik','domains':hosts,'upstreams':[upstream],'containers':[name],'static':False,'understood':True,'listen':[],'certificates':[]})
    return routes,unparsed

def container_state(c):
    state=c.get('State') or {}
    return {'name':container_name(c),'running':bool(state.get('Running')),'health':(state.get('Health') or {}).get('Status') or None,
        'published':sorted({port for bound,port,_ in published_ports(c) if bound in ALL_INTERFACES})[:64]}
def proxy_routes(containers=None):
    """Routing facts of this server, or None when they cannot be read at all. `incomplete` says the list may miss
    routes (a container that could not be inspected, an adapter that failed, a Caddyfile import)."""
    try:
        incomplete=False
        if containers is None:
            try:
                ids=docker('ps','-aq').decode().split()
                containers=inspect(ids) if ids else []
            except Exception:containers=[];incomplete=True
        addresses=host_addresses();routes=[];unparsed=[];proxies=[]
        def adapter(kind,c,read):
            nonlocal incomplete
            try:found=read()
            except Exception:incomplete=True;return
            if isinstance(found,tuple):found,complete=found;incomplete=incomplete or not complete
            routes.extend(found);proxies.append({'proxy':kind,'container':container_name(c) if c else None,'running':bool((c.get('State') or {}).get('Running')) if c else process_running(kind)})
        if shutil.which('nginx') or pathlib.Path('/etc/nginx').is_dir():adapter('nginx',None,lambda:nginx_routes('nginx'))
        for c in containers:
            image=image_of(c)
            if 'nginx-proxy-manager' in image:adapter('npm',c,lambda c=c:npm_routes(c))
            elif re.search(r'(^|/)caddy(:|@|$)',image):adapter('caddy',c,lambda c=c:caddy_routes(c))
        # Traefik reads the labels of every container, so its routes are read once however many Traefik containers run.
        traefik=[c for c in containers if re.search(r'(^|/)traefik(:|@|$)',image_of(c))]
        if traefik:
            found,skipped=traefik_routes(containers);routes.extend(found);unparsed.extend(skipped)
            proxies.extend({'proxy':'traefik','container':container_name(c),'running':bool((c.get('State') or {}).get('Running'))} for c in traefik)
        if shutil.which('caddy') and not any(p['proxy']=='caddy' for p in proxies):adapter('caddy',None,lambda:caddy_routes(None))
        for route in routes:
            route.setdefault('containers',sorted({name for upstream in route['upstreams'] for name in match_upstream(upstream,containers,addresses)}))
        try:port80=80 in listening_ports()
        except Exception:port80=None
        return {'format':ROUTING_FORMAT,'routes':routes[:ROUTE_LIMIT],'notUnderstood':unparsed[:ROUTE_LIMIT],'proxies':proxies[:20],
            'containers':[container_state(c) for c in containers][:ROUTE_LIMIT],'addresses':addresses,'port80':port80,
            'incomplete':incomplete or len(routes)>ROUTE_LIMIT}
    except Exception:return None
