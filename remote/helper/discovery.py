# helper/discovery.py: Docker project and nginx site discovery, configuration files, tmpfs mounts.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    inspect)
# </build:header>
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
