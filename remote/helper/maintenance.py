# helper/maintenance.py: Maintenance page on/off, deployment and automatic nginx setup.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    NOFOLLOW, VERSION, emit, private_staging_base, run, sync_maintenance_flag)
from .paths import (
    lexical, maintenance_directory_problem, maintenance_link_escape, warn, within)
from .net import (
    ProbePolicyError, health, policy_fallback, probe_url, public_probe)
from .move import (
    DOMAIN, nginx_reload, process_running)
# </build:header>
class MaintenanceOptional(ValueError):pass
MAINTENANCE_NOT_SET_UP='The maintenance page is not set up for this site, so visitors may see an error for the few seconds its containers are stopped.'
def maintenance(cfg,enabled):
    m=cfg.get('maintenance',{})
    if not m.get('required'):return
    directory=pathlib.Path(m['directory'])
    if not directory.is_absolute() or '..' in directory.parts:raise ValueError('Invalid maintenance directory')
    # The maintenance page is optional: without the proxy integration a backup still runs, visitors just see the
    # origin's own error while containers are stopped. There is then nothing to switch on or off.
    if not (directory/'ready').is_file():
        if enabled:warn(MAINTENANCE_NOT_SET_UP)
        return
    problem=maintenance_directory_problem(cfg,directory)
    # Leaving maintenance is never blocked, so a site can always return to service.
    if enabled and maintenance_link_escape(directory):raise ValueError(problem+'. The maintenance directory links into a system folder.')
    if problem:warn(problem+'; kept because the maintenance proxy is already integrated there')
    def enable_flag():
        # The proxy may share this directory; never follow a planted link as root.
        flag=directory/'enabled'
        if flag.is_symlink():raise ValueError('Maintenance flag cannot be a symbolic link')
        # O_NONBLOCK: a planted FIFO must fail at once instead of blocking the helper.
        try:fd=os.open(flag,os.O_WRONLY|os.O_CREAT|NOFOLLOW|getattr(os,'O_NONBLOCK',0),0o600)
        except OSError:raise ValueError('Maintenance flag must be a regular file')
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('Maintenance flag must be a regular file')
            if m.get('readableFlag'):
                if hasattr(os,'fchmod'):os.fchmod(fd,0o644)
                else:os.chmod(flag,0o644)
        finally:os.close(fd)
    if enabled:
        was_enabled=(directory/'enabled').exists()
        enable_flag()
        try:
            if 'public' not in cfg.get('_skippedProbes',()):
                if not m.get('publicUrl'):raise ValueError('Public maintenance probe URL required')
                status,body=public_probe(m,cfg.get('domains',()))
                if status!=503 or b'dbm-maintenance-v1' not in body:raise ValueError('Maintenance probe is not the deployed HTTP 503 page')
            sync_maintenance_flag(directory)
        except Exception:
            if not was_enabled:
                (directory/'enabled').unlink(missing_ok=True)
                sync_maintenance_flag(directory)
            raise
    else:
        if not health(cfg.get('_runningContainers',cfg['containers']),probe_url(cfg,'health'),cfg.get('domains',()),fallback=True):raise ValueError('Health probe failed; maintenance retained')
        (directory/'enabled').unlink(missing_ok=True)
        if probe_url(cfg,'public'):
            try:
                try:status,body=public_probe(m,cfg.get('domains',()))
                except ProbePolicyError:policy_fallback('public');status,body=200,b''
                if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('Public access did not recover')
                sync_maintenance_flag(directory)
            except Exception:
                enable_flag()
                sync_maintenance_flag(directory)
                raise ValueError('Public probe failed; maintenance retained')
        else:sync_maintenance_flag(directory)
def deploy_maintenance(req):
    cfg=req['config'];m=cfg.get('maintenance',{})
    p=pathlib.Path(m.get('directory',''))
    if not p.is_absolute() or '..' in p.parts:raise ValueError('Absolute maintenance directory required')
    if p.exists() and not p.is_dir():raise ValueError('Maintenance directory is not a directory')
    problem=maintenance_directory_problem(cfg,p)
    if problem:
        # A page deployed there by an earlier release keeps working; a new location or a link into a system folder is refused.
        if maintenance_link_escape(p) or not (p/'maintenance.html').is_file():raise ValueError(problem+'. Choose a directory under the staging root or a web root.')
        warn(problem+'; kept because a maintenance page is already deployed there')
    staging=cfg.get('stagingRoot')
    if staging and within(lexical(p),lexical(staging)) and os.name=='posix' and os.geteuid()==0:private_staging_base(staging,traverse=True)
    p.mkdir(parents=True,exist_ok=True,mode=0o755)
    content=__import__('base64').b64decode(req['html'])
    if len(content)>256*1024:raise ValueError('Maintenance asset exceeds size limit')
    temp=p/('maintenance.html.tmp-'+str(uuid.uuid4()))
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o644)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(content)
            if hasattr(os,'fchmod'):os.fchmod(f.fileno(),0o644)
        os.replace(temp,p/'maintenance.html')
    finally:temp.unlink(missing_ok=True)
    emit(result={'distributed':True,'helperVersion':VERSION,'ready':False,'proxyIntegrationRequired':True,'directory':str(p)})

# Automatic maintenance page for host nginx. DockNest writes its own snippet file and adds one include line after
# server_name in each server block that serves the site's domains. Nothing else in the site's config changes.
MAINTENANCE_SNIPPETS=pathlib.Path('/etc/nginx/docknest')
NGINX_SITE_FOLDERS=('/etc/nginx/sites-enabled','/etc/nginx/conf.d','/etc/nginx/http.d')
def nginx_server_blocks(text):
    """Server blocks in an nginx file: names, offset just after server_name's semicolon, whether it returns, body."""
    blocks=[];stack=[];i=0;n=len(text);words=[];word_start=None
    def flush_word(end):
        nonlocal word_start
        if word_start is not None:words.append(text[word_start:end]);word_start=None
    while i<n:
        ch=text[i]
        if ch=='#' and word_start is None:
            while i<n and text[i]!='\n':i+=1
            continue
        if ch in '"\'':
            quote=ch;start=i;i+=1
            while i<n and text[i]!=quote:i+=2 if text[i]=='\\' else 1
            if word_start is None:word_start=start
            i+=1;continue
        if ch.isspace():flush_word(i);i+=1;continue
        if ch in '{};':
            flush_word(i)
            if ch=='{':stack.append({'name':words[0] if words else '','start':i+1,'names':set(),'insert':None,'returns':False})
            elif ch==';' and words and stack and stack[-1]['name']=='server':
                frame=stack[-1]
                if words[0]=='server_name':
                    frame['names'].update(w.strip('"\'').lower() for w in words[1:])
                    if frame['insert'] is None:frame['insert']=i+1
                if words[0]=='return':frame['returns']=True
            elif ch=='}' and stack:
                frame=stack.pop()
                if frame['name']=='server':blocks.append({'names':frame['names'],'insert':frame['insert'],'returns':frame['returns'],'body':text[frame['start']:i]})
            words=[];i+=1;continue
        if word_start is None:word_start=i
        i+=1
    return blocks
def maintenance_snippet(site,directory):
    suffix=site.replace('-','')[:12]
    return ('# Managed by DockNest: maintenance page for site %s. DockNest switches it on only during a backup.\n'
        'set $dn_maint_%s 0;\nif (-f %s/enabled) { set $dn_maint_%s 1; }\n'
        'if ($uri = /__docknest_maintenance.html) { set $dn_maint_%s 0; }\nif ($dn_maint_%s) { return 503; }\n'
        'error_page 503 /__docknest_maintenance.html;\n'
        'location = /__docknest_maintenance.html { internal; alias %s/maintenance.html; default_type text/html; add_header Retry-After 30 always; add_header Cache-Control no-store always; }\n')%(site,suffix,directory,suffix,suffix,suffix,directory)
def maintenance_nginx_edits(domains,include_line,folders=NGINX_SITE_FOLDERS,root='/etc/nginx'):
    """Planned edits {path: new text}. Only files under /etc/nginx; redirect-only blocks are left alone."""
    wanted={d.lower() for d in domains};edits={};found=False
    for folder in folders:
        directory=pathlib.Path(folder)
        if not directory.is_dir():continue
        for entry in sorted(directory.iterdir()):
            if entry.name.startswith(('docknest-','.')):continue
            real=pathlib.Path(os.path.realpath(entry))
            if not real.is_file() or not real.is_relative_to(os.path.realpath(root)) or real.stat().st_size>1024*1024:continue
            text=edits.get(str(real)) or real.read_text()
            blocks=[b for b in nginx_server_blocks(text) if b['names']&wanted]
            if not blocks:continue
            found=True
            for block in sorted((b for b in blocks if not b['returns'] and b['insert']),key=lambda b:b['insert'],reverse=True):
                if include_line in block['body'] or 'docknest/maintenance' in block['body']:continue
                text=text[:block['insert']]+'\n    '+include_line+text[block['insert']:]
            if text!=real.read_text():edits[str(real)]=text
    if not found:raise ValueError('The site\'s domains were not found in this server\'s nginx configuration.')
    return edits
def setup_maintenance(req):
    cfg=req['config'];m=cfg.get('maintenance',{});site=str(req['siteId']);uuid.UUID(site)
    if os.geteuid()!=0:raise ValueError('Setting up the maintenance page requires root on the server')
    directory=pathlib.Path(m.get('directory',''))
    if not directory.is_absolute() or '..' in directory.parts or re.search(r'[\s;{}"\'$\\]',str(directory)):raise ValueError('Unsupported maintenance directory')
    if (directory/'ready').is_file():emit(result={'configured':True,'alreadySetUp':True});return
    if not (directory/'maintenance.html').is_file():raise ValueError('Deploy the maintenance page before setting it up')
    domains=[d for d in cfg.get('domains',[]) if isinstance(d,str) and DOMAIN.fullmatch(d)]
    if not domains:raise ValueError('Add the site\'s domain in Edit configuration first')
    if not m.get('publicUrl'):raise ValueError('Public maintenance probe URL required')
    if not shutil.which('nginx') or not process_running('nginx'):raise ValueError('nginx is not running on this server. Set up the maintenance page by hand under Advanced options.')
    try:run(['nginx','-t'],timeout=60)
    except Exception:raise ValueError('nginx reports a configuration error already, so DockNest did not change it. Fix nginx first.')
    snippet=MAINTENANCE_SNIPPETS/(site+'.conf');include_line='include %s;'%snippet
    edits=maintenance_nginx_edits(domains,include_line)
    originals={path:pathlib.Path(path).read_text() for path in edits}
    snippet_existed=snippet.exists();flag=directory/'enabled'
    def write(path,text):
        target=pathlib.Path(path);info=target.stat() if target.exists() else None
        temporary=target.with_name('.'+target.name+'.docknest-tmp');temporary.write_text(text)
        if info:os.chmod(temporary,stat.S_IMODE(info.st_mode));os.chown(temporary,info.st_uid,info.st_gid)
        else:os.chmod(temporary,0o644)
        os.replace(temporary,target)
    try:
        MAINTENANCE_SNIPPETS.mkdir(mode=0o755,exist_ok=True)
        write(snippet,maintenance_snippet(site,directory))
        for path,text in edits.items():write(path,text)
        try:nginx_reload()
        except Exception:raise ValueError('nginx rejected the maintenance page settings, so DockNest put the configuration back.')
        flag.touch(mode=0o644)
        status,body=public_probe(m,domains)
        if status!=503 or b'dbm-maintenance-v1' not in body:raise ValueError('Visitors did not get the maintenance page during the test (HTTP %d), so DockNest put the configuration back. A CDN or another proxy in front of nginx can cause this.'%status)
        flag.unlink()
        status,body=public_probe(m,domains)
        if status!=200 or b'dbm-maintenance-v1' in body:raise ValueError('The site did not come back normally after the test (HTTP %d), so DockNest put the configuration back.'%status)
    except BaseException:
        flag.unlink(missing_ok=True)
        for path,text in originals.items():
            try:write(path,text)
            except Exception:pass
        if not snippet_existed:snippet.unlink(missing_ok=True)
        try:nginx_reload()
        except Exception:pass
        raise
    (directory/'ready').touch(mode=0o644)
    emit(result={'configured':True,'files':sorted(edits),'snippet':str(snippet)})
