# helper/restore_gaps.py: The restore check: what a restore of an app on a new server would miss (docs/restore-check.md).
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    NOFOLLOW, SHARED_SYSTEM_FOLDERS, docker, inspect)
from .paths import (
    SITE_PATH, classify_source, lexical, protected_content, protected_mount, protected_path, within)
from .net import (
    CERT_NAME, LETSENCRYPT)
from .discovery import (
    nginx_servers, project_roots)
from .cleanup import (
    compose_project)
from .edit import (
    EDIT_PROJECT, EditRefused, edit_config, edit_env_file_paths)
# </build:header>
# Read only, inside the readiness check. A finding names a file, a line number, a schedule and what matched (an app
# folder, container or project), never the command or the line text, which can hold tokens. Nothing read here is
# logged. Reads are bounded, never follow a link out of the scanned folder and skip every protected path.
# Users' crontabs: Debian and Ubuntu, then Red Hat and SUSE, then Alpine (BusyBox).
RESTORE_GAP_ROOTS={'crontab':'/etc/crontab','cron':'/etc/cron.d','spool':('/var/spool/cron/crontabs','/var/spool/cron','/etc/crontabs'),
    'periodic':('/etc/cron.hourly','/etc/cron.daily','/etc/cron.weekly','/etc/cron.monthly'),
    'systemd':'/etc/systemd/system','letsencrypt':str(LETSENCRYPT/'live'),'nginx':None}
GAP_FILES=400;GAP_BYTES=256*1024;GAP_FINDINGS=100;GAP_PROJECTS=5
GAP_ERROR='The restore check could not finish on this server. Backups and the other readiness checks are not affected.'
# Kernel and runtime folders: a path there (such as the Docker socket) says nothing about the app's own files.
GAP_SKIPPED_TREES=('/proc','/sys','/dev','/run','/var/run')
GAP_WORD=re.compile(r'''[^\s'"`;|&()<>]+''')
# An absolute path inside a word (--file=/srv/app, -/usr/bin/x), not a relative one (./x, ~/x, ${DIR}/x).
GAP_PATH=re.compile(r'(?<![\w.~}$])/[A-Za-z0-9_./@+-]*')
CRON_FIELD=r'(?:[0-9*][0-9*/,-]*|[A-Za-z]{3}[A-Za-z,-]*)'
CRON_SCHEDULE=re.compile(r'@(?:reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|%s(?: %s){4}'%(CRON_FIELD,CRON_FIELD))
CRON_VARIABLE=re.compile(r'[A-Za-z_][A-Za-z0-9_]*\s*=')
TIMER_SCHEDULE=re.compile(r'[A-Za-z0-9*:,./~ -]{1,100}')
UNIT_NAME=re.compile(r'[A-Za-z0-9:_.@-]{1,200}\.service')
DOCKER_NAME=re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}')
DOCKER_COMMANDS=('docker','docker-compose','podman')
SERVICE_PATH_KEYS=('WorkingDirectory','ReadWritePaths','EnvironmentFile')

class RestoreGapScan:
    """One bounded restore check: the app's folders and names, files read, findings, and whether all was read."""
    def __init__(self,cfg,containers):
        self.cfg=cfg;self.containers=containers;self.files=0;self.complete=True;self.findings={}
        self.folders=gap_folders(cfg,containers);self.names=gap_names(containers)
        self.included=set(cfg.get('composeFiles',[])+cfg.get('configFiles',[]))
    def entries(self,directory,scanned=()):
        """Files (and links) directly in a scanned folder, sorted. A folder that is a link is not scanned; a link to
        another folder of the same scan (Alpine's /var/spool/cron/crontabs -> /etc/crontabs) is skipped quietly."""
        try:
            if os.path.islink(directory):
                if lexical(os.path.realpath(directory)) not in {lexical(os.path.realpath(f)) for f in scanned if not os.path.islink(f)}:self.complete=False
                return []
            if not os.path.isdir(directory):return []
            with os.scandir(directory) as items:names=sorted(item.name for item in items if not item.name.startswith('.') and not item.is_dir(follow_symlinks=False))
        except OSError:self.complete=False;return []
        return [os.path.join(directory,name) for name in names]
    def read(self,path):
        """Text of one regular file, at most GAP_BYTES. A link is read only when it stays in the file's folder; a
        masked systemd unit (a link to /dev/null) is skipped quietly."""
        try:info=os.lstat(path)
        except OSError:return None
        if stat.S_ISLNK(info.st_mode):
            target=lexical(os.path.realpath(path))
            if gap_masked(path):return None
            if not within(target,lexical(os.path.realpath(os.path.dirname(path)))):self.complete=False;return None
            path=target
        if protected_path(path):return None
        if self.files>=GAP_FILES:self.complete=False;return None
        self.files+=1
        try:
            with open(os.open(path,os.O_RDONLY|NOFOLLOW|getattr(os,'O_NONBLOCK',0)),'rb') as handle:
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):return None
                data=handle.read(GAP_BYTES+1)
        except OSError:self.complete=False;return None
        if len(data)>GAP_BYTES:self.complete=False;data=data[:GAP_BYTES]
        return data.decode('utf-8','replace')
    def add(self,kind,path,matched,message,line=None,schedule=None,include=()):
        key=hashlib.sha256('\0'.join((kind,path,matched)).encode()).hexdigest()
        if key in self.findings:return
        if len(self.findings)>=GAP_FINDINGS:self.complete=False;return
        paths=list(include);includable=bool(paths) and all(gap_includable(p) for p in paths)
        finding={'key':key,'kind':kind,'path':path,'matched':matched,'includable':includable,
            'included':bool(paths) and all(p in self.included for p in paths),'message':message}
        if includable:finding['includePaths']=paths
        if line is not None:finding['line']=line
        if schedule:finding['schedule']=schedule
        self.findings[key]=finding
    def report(self):
        findings=sorted(self.findings.values(),key=lambda f:(f['kind'],f['path'],f.get('line') or 0,f['matched']))
        return {'findings':findings,'complete':self.complete,'limits':{'maxFiles':GAP_FILES,'maxBytesPerFile':GAP_BYTES,'maxFindings':GAP_FINDINGS,'filesRead':self.files}}

def restore_check(cfg,containers=None,roots=None):
    """`restoreGaps` of the readiness result. It never changes `ready`: any failure becomes one plain message."""
    try:return restore_gaps(cfg,containers,roots or RESTORE_GAP_ROOTS)
    except Exception:return {'error':GAP_ERROR}
def restore_gaps(cfg,containers,roots):
    """Every finding kind in turn; `roots` names the host files and folders read (tests pass temporary ones)."""
    if containers is None:containers=gap_containers(cfg)
    scan=RestoreGapScan(cfg,containers)
    cron_gaps(scan,roots);timer_gaps(scan,roots['systemd']);docker_object_gaps(scan);bind_gaps(scan);compose_gaps(scan)
    certificate_gaps(scan,roots['letsencrypt'],roots['nginx'])
    return scan.report()
def gap_masked(path):
    """A masked systemd unit or disabled file: a link to /dev/null."""
    return os.path.islink(path) and lexical(os.path.realpath(path))=='/dev/null'
def gap_containers(cfg):
    ids=(cfg.get('containers') or []) if cfg.get('kind')!='static' else []
    if not all(isinstance(value,str) and DOCKER_NAME.fullmatch(value) for value in ids):raise ValueError('Select valid containers')
    return inspect(ids) if ids else []
def gap_folders(cfg,containers):
    """What a restore brings back, longest first: project folders, Compose file folders, configuration files, mount
    sources and the website folder. A shared folder such as /etc or /srv on its own would match every path."""
    values=[root for c in containers for root in project_roots(c)]+[posixpath.dirname(f) for f in cfg.get('composeFiles',[])]
    values+=list(cfg.get('configFiles',[]))+[m.get('Source') for c in containers for m in c.get('Mounts') or []]
    if cfg.get('kind')=='static':values.append(cfg.get('documentRoot'))
    folders={lexical(v) for v in values if isinstance(v,str) and v.startswith('/')}
    return sorted((f for f in folders if f not in SHARED_SYSTEM_FOLDERS and not any(within(f,t) for t in GAP_SKIPPED_TREES)),key=lambda f:(-len(f),f))
def gap_names(containers):
    """{name: what it is} for the app's containers and Compose projects, the names a docker command can use."""
    names={app_project(c):'Compose project' for c in containers if app_project(c)}
    names.update((container_name(c),'container') for c in containers if container_name(c))
    return names
def container_name(c):return (c.get('Name') or '').lstrip('/')
def app_project(c):return compose_project((c.get('Config') or {}).get('Labels')) or ''
def app_name(c):return app_project(c) or container_name(c)
def gap_includable(path):
    """True when the capture path accepts this file as a configuration file (preflight, refuse_protected_sources): a
    regular, unlinked, unprotected, readable file on a local filesystem, at a path the site form accepts."""
    try:
        if lexical(path)!=path or not SITE_PATH.fullmatch(path) or protected_path(path) or protected_content(path):return False
        if not stat.S_ISREG(os.lstat(path).st_mode) or not os.access(path,os.R_OK):return False
        classify_source(path);return True
    except (OSError,ValueError):return False
def gap_match(text,folders,names):
    """The app folder an absolute path in this command lies in, else the app container or project a docker command
    names, else None. Only what matched leaves this function, never the command."""
    words=GAP_WORD.findall(text)
    for word in words:
        for path in GAP_PATH.findall(word):
            path=lexical(path)
            if '..' in path.split('/'):continue
            folder=next((f for f in folders if within(path,f)),None)
            if folder:return folder
    if any(posixpath.basename(word) in DOCKER_COMMANDS for word in words):
        for word in words:
            for candidate in (word,word.split(':',1)[0],word.rpartition('=')[2]):
                if candidate in names:return candidate
    return None
def what_matched(scan,matched):
    return '%s %s'%(scan.names.get(matched,'folder'),matched)

# ---- host schedules: cron and systemd timers ----
def cron_entry(line,user):
    """(schedule, command) of one crontab line; None for blank lines, comments and variable settings."""
    text=line.strip()
    if not text or text.startswith('#') or CRON_VARIABLE.match(text):return None
    count=1 if text.startswith('@') else 5
    parts=text.split(None,count+int(user))
    if len(parts)<=count+int(user):return None
    schedule=' '.join(parts[:count])
    return (schedule,parts[-1]) if CRON_SCHEDULE.fullmatch(schedule) else None
def periodic_entry(line,schedule):
    text=line.strip()
    return None if not text or text.startswith('#') else (schedule,text)
def cron_sources(scan,roots):
    """(file, line parser) for the system crontab, /etc/cron.d, the users' crontabs and the periodic script folders."""
    sources=[(roots['crontab'],lambda line:cron_entry(line,True))]
    sources+=[(path,lambda line:cron_entry(line,True)) for path in scan.entries(roots['cron'])]
    sources+=[(path,lambda line:cron_entry(line,False)) for folder in roots['spool'] for path in scan.entries(folder,roots['spool'])]
    for folder in roots['periodic']:
        schedule=os.path.basename(folder).rpartition('.')[2]
        sources+=[(path,lambda line,schedule=schedule:periodic_entry(line,schedule)) for path in scan.entries(folder)]
    return sources
def cron_gaps(scan,roots):
    for path,entry in cron_sources(scan,roots):
        for number,line in enumerate((scan.read(path) or '').splitlines(),1):
            parsed=entry(line)
            matched=parsed and gap_match(parsed[1],scan.folders,scan.names)
            if matched:scan.add('host-schedule',path,matched,"A scheduled task in %s uses this app's %s; a new server will not run it unless it is copied there."%(path,what_matched(scan,matched)),line=number,schedule=parsed[0],include=[path])
def unit_settings(text):
    """(key, value, line number) of each setting in a systemd unit file."""
    result=[]
    for number,line in enumerate((text or '').splitlines(),1):
        key,separator,value=line.strip().partition('=')
        if separator and not key.startswith(('#',';','[')):result.append((key.strip(),value.strip(),number))
    return result
def timer_service(directory,unit):
    """The unit file a timer starts, in the same folder (a template unit for an instance name), or None."""
    if not UNIT_NAME.fullmatch(unit):return None
    path=os.path.join(directory,unit)
    if not os.path.lexists(path) and '@' in unit:path=os.path.join(directory,unit.split('@',1)[0]+'@.service')
    return path if os.path.lexists(path) else None
def timer_gaps(scan,directory):
    """Timers in /etc/systemd/system whose service runs, works in, writes to or reads its environment from the app."""
    for timer in scan.entries(directory):
        if not timer.endswith('.timer') or gap_masked(timer):continue
        settings=unit_settings(scan.read(timer))
        schedule='; '.join(value for key,value,_ in settings if key=='OnCalendar')
        unit=next((value for key,value,_ in settings if key=='Unit'),os.path.basename(timer)[:-len('.timer')]+'.service')
        service=timer_service(directory,unit)
        # A service only in /lib/systemd/system (a package's own) is not read: the check cannot say it is clean.
        if service is None:scan.complete=False;continue
        for key,value,number in unit_settings(scan.read(service)):
            matched=(key.startswith('ExecStart') or key in SERVICE_PATH_KEYS) and gap_match(value,scan.folders,scan.names)
            if matched:scan.add('host-schedule',service,matched,"The timer %s runs a command that uses this app's %s; a new server will not run it unless it is copied there."%(os.path.basename(timer),what_matched(scan,matched)),line=number,schedule=schedule if TIMER_SCHEDULE.fullmatch(schedule) else None,include=[timer,service])

# ---- Docker objects and files outside the app's folder ----
def docker_object_project(scan,kind,name):
    """The Compose project that created a Docker network or volume ('' for none), or None when it cannot be read."""
    try:return (json.loads(docker(kind,'inspect',name))[0].get('Labels') or {}).get('com.docker.compose.project') or ''
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,IndexError,AttributeError):scan.complete=False;return None
def docker_object_gaps(scan):
    """Networks and named volumes the app uses that its own Compose project did not create. `docker run` never creates
    a network, so a user network of a plain container always counts; it does create a named volume."""
    for c in scan.containers:
        project=app_project(c);app=app_name(c)
        for network in ((c.get('NetworkSettings') or {}).get('Networks') or {}):
            if network in ('bridge','host','none'):continue
            if not DOCKER_NAME.fullmatch(network):scan.complete=False;continue
            owner=docker_object_project(scan,'network',network)
            if owner is not None and (not project or owner!=project):scan.add('external-network',network,app,'The app uses the Docker network %s, which it does not create itself; create it on the new server before the app starts.'%network)
        for m in c.get('Mounts') or []:
            volume=m.get('Name') or ''
            if m.get('Type')!='volume' or re.fullmatch(r'[0-9a-f]{64}',volume):continue
            if not DOCKER_NAME.fullmatch(volume):scan.complete=False;continue
            owner=docker_object_project(scan,'volume',volume)
            if owner is not None and owner!=project:scan.add('external-volume',volume,app,'The app uses the Docker volume %s, which it does not create itself; backups copy its data, but the new server needs the volume created before the app starts.'%volume)
def bind_gaps(scan):
    """Bind mounts outside the app's Compose project folder. Informational: they are copied and restored in place."""
    for c in scan.containers:
        roots=[lexical(root) for root in project_roots(c)]
        if not roots:continue
        for m in c.get('Mounts') or []:
            source=lexical(m.get('Source') or '')
            if m.get('Type')!='bind' or not source.startswith('/') or protected_mount(source):continue
            if any(within(source,folder) for folder in GAP_SKIPPED_TREES+tuple(roots)):continue
            scan.add('bind-outside',source,app_name(c),"The app's folder %s is outside its project folder; backups copy it and a restore puts it back at the same path."%source)
def compose_invocation(labels):
    """How the app's Compose project was started, from its container labels, or None when the labels are unusable."""
    project=labels.get('com.docker.compose.project') or ''
    files=[f.strip() for f in labels.get('com.docker.compose.project.config_files','').split(',') if f.strip()]
    directory=labels.get('com.docker.compose.project.working_dir') or ''
    def usable(path):return path.startswith('/') and lexical(path)==path and not protected_path(path)
    if not EDIT_PROJECT.fullmatch(project) or not 1<=len(files)<=10 or not usable(directory) or not all(usable(f) and os.path.isfile(f) for f in files):return None
    return {'project':project,'files':files,'projectDirectory':directory,'envFiles':[]}
def compose_path(value,folder):
    if not isinstance(value,str) or '$' in value:return None
    return lexical(value if value.startswith('/') else posixpath.join(folder,value))
def compose_model_gaps(scan,inv,model):
    project=inv['project'];folder=inv['projectDirectory']
    for service in (model.get('services') or {}).values():
        for value,_ in edit_env_file_paths(service) if isinstance(service,dict) else ():
            path=compose_path(value,folder)
            if path and not within(path,folder):scan.add('env-file',path,project,'The app reads the environment file %s from outside its project folder; include it in the backup or copy it to the new server.'%path,include=[path])
    for kind,label in (('secrets','secret'),('configs','config')):
        for name,item in (model.get(kind) or {}).items():
            if not isinstance(item,dict):continue
            if item.get('external'):
                name=str(item.get('name') or name)[:200]
                scan.add('secret-or-config',name,project,'The app uses the external Compose %s %s, which Docker keeps outside any file; create it again on the new server.'%(label,name))
                continue
            path=compose_path(item.get('file'),folder)
            if path and not within(path,folder):scan.add('secret-or-config',path,project,'The app reads the Compose %s file %s from outside its project folder; include it in the backup or copy it to the new server.'%(label,path),include=[path])
def compose_gaps(scan):
    """env_file, secrets and configs of each of the app's Compose projects, read through `docker compose config` as
    Safe Edit reads them: no interpolation, no environment or path resolution, no remote includes."""
    projects={app_project(c):(c.get('Config') or {}).get('Labels') or {} for c in scan.containers if app_project(c)}
    if len(projects)>GAP_PROJECTS:scan.complete=False
    for labels in list(projects.values())[:GAP_PROJECTS]:
        inv=compose_invocation(labels)
        if inv is None:scan.complete=False;continue
        try:compose_model_gaps(scan,inv,edit_config(inv,inv['files'],[],True))
        except (EditRefused,ValueError):scan.complete=False

# ---- certificates ----
def lineage_gap(scan,folder,domain):
    scan.add('certificate',folder,domain,"The HTTPS certificate for %s is in %s, outside the app's backup; a move issues a new one with certbot."%(domain,folder))
def certificate_gaps(scan,live,nginx_folders):
    """certbot's folder for each of the app's domains, and the certificate files its nginx site names."""
    live=lexical(live);wanted=[d.lower() for d in scan.cfg.get('domains') or [] if isinstance(d,str) and CERT_NAME.fullmatch(d.lower())]
    for domain in wanted:
        folder=posixpath.join(live,domain)
        if os.path.isdir(folder) and not os.path.islink(folder):lineage_gap(scan,folder,domain)
    if not wanted:return
    for _,names,children in nginx_servers(nginx_folders):
        domain=next((name.lower() for name in names if name.lower() in wanted),None)
        if domain is None:continue
        for key,values,_ in children:
            if key not in ('ssl_certificate','ssl_certificate_key') or not values or '$' in values[0] or not values[0].startswith('/'):continue
            path=lexical(values[0])
            if within(path,live) and path!=live:lineage_gap(scan,posixpath.join(live,path[len(live)+1:].split('/')[0]),domain)
            else:scan.add('certificate',path,domain,"The app's nginx site uses the certificate file %s; include it in the backup or issue a new certificate on the new server."%path,include=[path])
