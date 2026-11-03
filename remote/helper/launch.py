# helper/launch.py: Launch a new site (docs/launch-site.md): facts, Git fetch, build, start, poll, nginx, certificate,
# teardown and status.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    LAUNCH_CHILDREN, NOFOLLOW, STOPPING, atomic_json, emit, inspect)
from .paths import (
    lexical, within)
from .net import (
    LETSENCRYPT)
from .restore import (
    strip_privileges)
from .move import (
    ACME_ROOT, host_addresses, listening_ports, loopback_probe, nginx_conf_dir, process_running, tool_version)
from .install import (
    install_supported, os_release, package_manager)
# </build:header>
# ---- Launch a new site (docs/launch-site.md, "Security review changes" items 1-18) ----
# Rules: every request value is validated here again; secrets (the deploy key, environment values, pasted Compose text)
# arrive only on stdin and never enter argv, results, diagnostics or exception text. Every created thing is written to
# the launch journal BEFORE it is created, so launch-teardown removes exactly what this launch made (journal plus the
# docknest.launch label), never anything else. Refusals answer {ok: false, code, reason} with a stable code.
LAUNCH_ROOT=pathlib.Path('/var/lib/docknest/launches')
LAUNCH_SITES=pathlib.Path('/srv/docknest')
LAUNCH_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
LAUNCH_LOCK_PATH='/run/docknest-launch.lock'
LAUNCH_UUID=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
LAUNCH_SLUG=re.compile(r'[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?')
LAUNCH_DOMAIN=re.compile(r'(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+')
LAUNCH_HOST=re.compile(r'(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*')
LAUNCH_SSH_USER=re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}')
LAUNCH_GIT_PATH=re.compile(r'[A-Za-z0-9._~/+-]{1,400}')
LAUNCH_REF=re.compile(r'[A-Za-z0-9._/+-]{1,200}')
LAUNCH_COMPOSE_PATH=re.compile(r'[A-Za-z0-9._/-]{1,300}')
LAUNCH_ENV_KEY=re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,255}')
LAUNCH_ENV_REFUSED=('COMPOSE_','DOCKER_','BUILDKIT_')
LAUNCH_IMAGE=re.compile(r'[a-z0-9][a-z0-9._/:@-]{0,254}')
LAUNCH_EMAIL=re.compile(r'[A-Za-z0-9._%+][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}')
# Items 9 and 16 (owner decision 2026-11-02): git 2.37 or newer (http.curloptResolve). The CVE classes of the 2024-2025
# fixes are closed by how every git call runs (LAUNCH_GIT_CONFIG and launch_git_env), whatever the distribution's
# version number: no submodules (and .gitmodules refused), no file/ext transports, no bundle URIs, no hooks, no
# symlinks in the checkout, no system or global configuration, an empty HOME, and never a local path.
LAUNCH_GIT_MIN=(2,37,0)
LAUNCH_GIT_CONFIG=('-c','protocol.allow=never','-c','protocol.https.allow=always','-c','protocol.ssh.allow=always','-c','protocol.file.allow=never',
    '-c','protocol.ext.allow=never','-c','http.followRedirects=false','-c','submodule.recurse=false','-c','transfer.bundleURI=false',
    '-c','core.hooksPath=/dev/null','-c','core.symlinks=false')
LAUNCH_CLONE_LIMIT=2*1024**3
LAUNCH_CLONE_SECONDS=600
LAUNCH_BUILD_SECONDS=1800
LAUNCH_UP_SECONDS=1800
LAUNCH_WATCH_SECONDS=2
LAUNCH_SPACE_MARGIN=2*1024**3
LAUNCH_STABLE_SECONDS=30
LAUNCH_COMPOSE_LIMIT=256*1024
LAUNCH_DOCKERFILE_LIMIT=1024*1024
LAUNCH_ENV_KEYS=200
LAUNCH_VALUE_LIMIT=8*1024
LAUNCH_MIN_COMPOSE=(2,24)
# Item 14: the BuildKit image of the launch's own builder, pinned by digest (v0.34.1, multi-arch index).
LAUNCH_BUILDKIT_IMAGE='moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c'
LAUNCH_BUILD_KEYS={'context','dockerfile','args','target','labels','platforms'}
LAUNCH_SYNTAX=re.compile(r'(?:docker\.io/)?docker/dockerfile(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?')
LAUNCH_RUN_FLAGS={'network':{'default','none'},'security':{'sandbox'}}
LAUNCH_HOST_KEY_TYPES=('ssh-ed25519','ecdsa-sha2-nistp256','ecdsa-sha2-nistp384','ecdsa-sha2-nistp521','ssh-rsa')
# Never fetched from, even with "Allow private address": the alert outbound policy's refused list (src/alerts/addresses.js):
# unspecified, loopback, link-local and cloud metadata, special-use, documentation and benchmark, 6to4 relay, the Alibaba
# metadata, Tailscale resolver and Azure host endpoints, multicast and reserved, AWS's IPv6 block, Teredo, ORCHID.
LAUNCH_REFUSED_NETS=tuple(ipaddress.ip_network(n) for n in ('0.0.0.0/8','127.0.0.0/8','169.254.0.0/16','192.0.0.0/24','192.0.2.0/24','198.51.100.0/24','203.0.113.0/24','198.18.0.0/15','192.88.99.0/24',
    '100.100.100.200/32','100.100.100.100/32','168.63.129.16/32','224.0.0.0/4','240.0.0.0/4','fd00:ec2::/32','2001::/32','2001:2::/48','2001:10::/28','2001:20::/28','2001:db8::/32','3fff::/20','::/128','::1/128','fe80::/10','ff00::/8'))
LAUNCH_PRIVATE_NETS=tuple(ipaddress.ip_network(n) for n in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10','fc00::/7','fec0::/10'))
LAUNCH_KINDS=('paths','keys','images','builders','containers','volumes','networks','nginx','certificates')
LAUNCH_HEADER='# Managed by DockNest launch %s;'
LAUNCH_REASONS={
    'INVALID_REQUEST':'DockNest sent a request the server did not accept.',
    'NOT_ROOT':'DockNest must sign in as root to launch a site.',
    'LAUNCH_BUSY':'Another launch step is running on this server. Try again in a minute.',
    'URL_REFUSED':'Use an https:// address or an SSH address (git@host:path or ssh://).',
    'URL_USERINFO':'Remove the user name or password from the https:// address.',
    'URL_PRIVATE':'This Git address points to a private network. Tick "Allow private address" for a self-hosted Git server.',
    'URL_METADATA':'This Git address points to a local or cloud metadata address, which DockNest never fetches from.',
    'DNS_FAILED':'The server could not find the Git host. Check the address.',
    'GIT_MISSING':'The server needs git. Install it, then try again.',
    'GIT_TOO_OLD':'Git 2.37 or newer is needed. Update git, then try again.',
    'SSH_MISSING':'The server needs the OpenSSH client (ssh and ssh-keyscan) for SSH Git addresses.',
    'KEY_REQUIRED':'An SSH Git address needs a deploy key.',
    'KEY_INVALID':'The deploy key could not be read.',
    'HOST_KEY_INVALID':'The pinned Git host key could not be read. Pin it again.',
    'HOST_KEY_MISMATCH':'The Git host answered with a different host key than the one you confirmed. Check the host, then pin it again.',
    'HOST_KEY_UNAVAILABLE':'The server could not read the Git host key.',
    'AUTH_FAILED':'The Git host refused the deploy key. Add it to the repository as a read-only deploy key.',
    'REPO_NOT_FOUND':'The Git host has no such repository, or it is private.',
    'REF_NOT_FOUND':'The repository has no such branch or tag.',
    'REF_INVALID':'Use a branch or tag name.',
    'REDIRECT_REFUSED':'The Git host redirected to another address, which DockNest does not follow. Use the final address.',
    'FETCH_FAILED':'The repository could not be fetched.',
    'FETCH_TIMEOUT':'Fetching the repository took longer than 10 minutes.',
    'REPO_TOO_LARGE':'The repository is larger than 2 GB.',
    'SUBMODULES_REFUSED':'The repository uses Git submodules, which DockNest does not fetch.',
    'LFS_REFUSED':'The repository uses Git LFS, which DockNest does not fetch.',
    'SYMLINK_ESCAPE':'The repository has a symbolic link that points outside it.',
    'COMPOSE_PATH_INVALID':'Use a path to the Compose file inside the repository.',
    'COMPOSE_MISSING':'The Compose file was not found.',
    'COMPOSE_TOO_LARGE':'The Compose file is larger than 256 KB.',
    'COMPOSE_INVALID':'Docker Compose could not read the Compose file.',
    'COMPOSE_INCLUDE_REFUSED':'The Compose file includes other Compose files, which DockNest cannot check.',
    'COMPOSE_EXTENDS_REFUSED':'The Compose file uses extends, which DockNest cannot check. Write the settings out.',
    'COMPOSE_SYNTAX_REFUSED':'The Compose file uses YAML that DockNest cannot check safely (a directive, an explicit, tagged or aliased key, or an escaped or multi-line quoted key).',
    'SANDBOX_UNAVAILABLE':'DockNest could not read the Compose file in an isolated view of the server (it needs unshare and mount namespaces).',
    'COMPOSE_FLOW_REFUSED':'Write the Compose file as YAML blocks, not as one JSON or flow mapping.',
    'BUILD_IMAGE_REFUSED':'A service that is built must use an image name of its own (starting with the site name, no registry).',
    'BIND_COVERS_SECRETS':'A service mounts the site folder, its .env or its Compose file with write access. Mount it read-only.',
    'COMPOSE_TOO_OLD':'Update Docker Compose to 2.24 or newer.',
    'COMPOSE_TOOL_MISSING':'The server needs Docker Compose 2.24 or newer. Install it, then try again.',
    'PATH_REFUSED':'The folder /srv/docknest on the server goes through a symbolic link.',
    'DOCKER_MISSING':'The server needs Docker. Install it, then try again.',
    'ENV_REFUSED':'An environment value is not allowed (COMPOSE_, DOCKER_ and BUILDKIT_ names, line breaks and NUL).',
    'SITE_EXISTS':'A folder for this site already exists on the server.',
    'PROJECT_EXISTS':'A Compose project with this name already exists on the server.',
    'NAME_COLLISION':'A container, volume or network with this name already exists on the server.',
    'DISK_FULL':'The server is too low on disk space.',
    'GATE_UNAVAILABLE':'This DockNest version cannot check Compose files for host access yet.',
    'GATE_REFUSED':'The Compose file gives the site access to the server.',
    'PORT_NOT_LOOPBACK':'A service publishes a port on all addresses. Publish it on 127.0.0.1, or pick it as the web service.',
    'PORT_IN_USE':'The local port is already in use on the server.',
    'ENV_FILE_REFUSED':'A service reads an environment file outside the site folder.',
    'WEB_SERVICE_INVALID':'Pick a service and port from the Compose file.',
    'BUILDX_MISSING':'The server needs Docker Buildx to build images.',
    'BUILD_SETTING_REFUSED':'A build setting is not allowed (only context, dockerfile, args, target, labels and platforms).',
    'DOCKERFILE_MISSING':'A Dockerfile named in the Compose file was not found in the repository.',
    'DOCKERFILE_REFUSED':'A Dockerfile asks for host network or insecure builds (--network=host, --security=insecure).',
    'SYNTAX_REFUSED':'A Dockerfile names a build frontend other than docker/dockerfile.',
    'IMAGE_EXISTS':'An image with the same name already exists on the server.',
    'BUILD_FAILED':'The image build failed.',
    'BUILD_TIMEOUT':'The image build took longer than 30 minutes.',
    'IMAGE_NO_ARCH':'An image has no build for this server\'s processor.',
    'START_FAILED':'Docker could not start the site.',
    'NOT_FETCHED':'The site files are not on the server yet.',
    'NGINX_MISSING':'The server needs nginx. Install it, then try again.',
    'NGINX_NO_CONF_DIR':'nginx on this server does not include a folder DockNest can add its file to.',
    'NGINX_UNREADABLE':'DockNest could not read the nginx configuration (nginx -T failed).',
    'NGINX_DOMAIN_SERVED':'nginx on this server already serves this domain.',
    'NGINX_FILE_EXISTS':'An nginx file with DockNest\'s name already exists and was not written by this launch.',
    'NGINX_TEST_FAILED':'nginx refused the new site file, so DockNest removed it again.',
    'CERTBOT_MISSING':'The server needs certbot. Install it, then try again.',
    'CERT_LINEAGE_EXISTS':'A certificate for this domain already exists on the server.',
    'NO_ACCOUNT_EMAIL':'certbot has no account on this server. Enter an email address for Let\'s Encrypt.',
    'DNS_WAITING':'The domain does not point at this server yet.',
    'RATE_LIMITED':'Let\'s Encrypt rate limit reached. Try again later.',
    'CAA_REFUSED':'A CAA record on the domain does not allow Let\'s Encrypt.',
    'CERT_FAILED':'The certificate could not be issued. The site stays on HTTP.',
    'NO_WEB':'The nginx site file is not set up yet.',
    'FAILED':'The launch step could not be completed on the server.',
    'PRIVATE_ADDRESS':'This Git host is on a private network. Tick "Allow private address" for a self-hosted Git server.',
    'REFUSED_ADDRESS':'DockNest does not connect to this Git host address.',
    'CONNECT_FAILED':'The server could not connect to the Git host to read its key.',
}
class LaunchRefused(Exception):
    """The message is the code only, so a stray str(error) never carries anything else."""
    def __init__(self,code):
        super().__init__(code);self.code=code
def launch_refuse(code):raise LaunchRefused(code)
def launch_answer(result):emit(result={'ok':True,**result})
LAUNCH_CHECK_STALE=15*60
def launch_clean_checks():
    """Check folders (they may hold a deploy key file for ls-remote) left by a helper that was killed before its finally
    ran are removed by the next launch operation. A check takes at most a few minutes, so older ones are never in use."""
    try:entries=list(os.scandir(LAUNCH_ROOT))
    except OSError:return
    for entry in entries:
        try:
            if entry.name.startswith('check-') and entry.is_dir(follow_symlinks=False) and time.time()-entry.stat(follow_symlinks=False).st_mtime>LAUNCH_CHECK_STALE:shutil.rmtree(entry.path,ignore_errors=True)
        except OSError:pass
def launch_entry(req,body):
    """Every launch operation runs through here: refusals and unexpected errors become {ok: false, code, reason}."""
    try:
        launch_clean_checks()
        body(req)
    except LaunchRefused as error:emit(result={'ok':False,'code':error.code,'reason':LAUNCH_REASONS.get(error.code,LAUNCH_REASONS['FAILED'])})
    except Exception as error:
        # Only the exception type leaves the helper: exception text may hold paths or command output.
        emit(result={'ok':False,'code':'FAILED','reason':LAUNCH_REASONS['FAILED'],'errorType':type(error).__name__})

# ---- request validation ----
def launch_ids(req):
    lid=req.get('launchId');slug=req.get('slug')
    if not isinstance(lid,str) or not LAUNCH_UUID.fullmatch(lid) or not isinstance(slug,str) or not LAUNCH_SLUG.fullmatch(slug):launch_refuse('INVALID_REQUEST')
    return lid,slug
def launch_domain(req):
    domain=req.get('domain')
    if not isinstance(domain,str) or not LAUNCH_DOMAIN.fullmatch(domain):launch_refuse('INVALID_REQUEST')
    return domain
def launch_names(req,domain):
    """The domain and, when asked for, its www. alias (derived here, never typed)."""
    return [domain]+(['www.'+domain] if req.get('www') is True and not domain.startswith('www.') and len(domain)<=249 else [])
def launch_port(value,low=1):
    if not isinstance(value,int) or isinstance(value,bool) or not low<=value<=65535:launch_refuse('INVALID_REQUEST')
    return value
def launch_root_user():
    if getattr(os,'geteuid',lambda:0)()!=0:launch_refuse('NOT_ROOT')

# ---- processes: fixed argv, no shell, own process group, output kept inside the helper ----
def launch_env(home='/root'):
    return {'PATH':LAUNCH_PATH,'HOME':str(home),'LC_ALL':'C','COMPOSE_EXPERIMENTAL_GIT_REMOTE':'0','COMPOSE_EXPERIMENTAL_OCI_REMOTE':'0'}
def launch_tree_size(folder):
    total=0
    for current,dirs,files in os.walk(folder,followlinks=False):
        for name in files+dirs:
            try:total+=os.lstat(os.path.join(current,name)).st_size
            except OSError:pass
    return total
def launch_wait(process,timeout):
    """Wait for the child to exit for at most `timeout` seconds without polling: on Linux a pidfd becomes readable when
    the process exits (select wakes on that event); elsewhere Popen.wait. Raises subprocess.TimeoutExpired."""
    try:fd=os.pidfd_open(process.pid)
    except (AttributeError,OSError):return process.wait(timeout=timeout)
    try:
        ready,_,_=__import__('select').select([fd],[],[],max(0,timeout))
        if not ready:raise subprocess.TimeoutExpired(process.args,timeout)
        return process.wait()
    finally:os.close(fd)
def launch_kill_group(process):
    for sig in (signal.SIGTERM,getattr(signal,'SIGKILL',signal.SIGTERM)):
        try:os.killpg(process.pid,sig)
        except (OSError,AttributeError):
            try:process.kill()
            except OSError:pass
        try:launch_wait(process,20);return
        except subprocess.TimeoutExpired:pass
def launch_proc_start(pid):
    """The kernel start time of a process (field 22 of /proc/<pid>/stat), so a recorded group is never confused with a
    later process that reused the number. None where /proc is missing."""
    try:return int(pathlib.Path('/proc/%d/stat'%pid).read_text().rsplit(')',1)[1].split()[19])
    except (OSError,ValueError,IndexError):return None
def launch_kill_recorded(journal):
    """End process groups a step recorded and did not clear (worker restart, killed helper). Only a group whose leader
    still has the recorded start time is signalled."""
    killed=[]
    for item in list(journal.get('children') or []):
        pgid=item.get('pgid') if isinstance(item,dict) else None
        if isinstance(pgid,int) and pgid>1 and item.get('start') is not None and launch_proc_start(pgid)==item.get('start'):
            try:os.killpg(pgid,getattr(signal,'SIGKILL',signal.SIGTERM));killed.append(pgid)
            except (OSError,AttributeError):pass
    journal['children']=[]
    return killed
def launch_watch(argv,env,timeout,folder=None,limit=None,cwd=None,journal=None):
    """Run one argv in its own process group. The group is killed when the time limit passes, when DockNest stops the
    step, or when `folder` grows beyond `limit` bytes (item 9), and always in finally (leftover ssh or build children).
    Waits on the process itself (no sleeping); only a size watch wakes up every LAUNCH_WATCH_SECONDS. With `journal`
    (d, journal) the group id is recorded while it runs, so teardown and launch-status can end it after a crash.
    Returns (exit code, stdout bytes, lower-case output tail, why stopped)."""
    exe=argv[0] if os.path.isabs(argv[0]) else shutil.which(argv[0],path=LAUNCH_PATH)
    if exe is None:return 127,b'','',None
    with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
        process=subprocess.Popen([exe]+list(argv[1:]),stdin=subprocess.DEVNULL,stdout=out,stderr=err,env=env,cwd=cwd,close_fds=True,start_new_session=True)
        LAUNCH_CHILDREN.add(process.pid);deadline=time.monotonic()+timeout;why=None
        record={'pgid':process.pid,'start':launch_proc_start(process.pid)}
        try:
            if journal is not None:journal[1].setdefault('children',[]).append(record);launch_save(*journal)
            while True:
                wait=LAUNCH_WATCH_SECONDS if folder and limit else max(0.1,deadline-time.monotonic())
                try:code=launch_wait(process,wait);break
                except subprocess.TimeoutExpired:
                    if STOPPING:why='stopped'
                    elif time.monotonic()>deadline:why='timeout'
                    elif folder and limit and launch_tree_size(folder)>limit:why='size'
                    if why:launch_kill_group(process);code=-1;break
        finally:
            LAUNCH_CHILDREN.discard(process.pid)
            if process.poll() is None:launch_kill_group(process)
            try:os.killpg(process.pid,getattr(signal,'SIGKILL',signal.SIGTERM))
            except (OSError,AttributeError):pass
            if journal is not None and record in journal[1].get('children',[]):journal[1]['children'].remove(record);launch_save(*journal)
        out.seek(0);stdout=out.read(64*1024*1024)
        size=err.seek(0,2);err.seek(max(0,size-4000));tail=err.read().decode('utf-8','replace').lower()
    return code,stdout,tail,why
def launch_exec(argv,timeout=120,env=None,cwd=None,journal=None):
    code,stdout,tail,why=launch_watch(argv,env if env is not None else launch_env(),timeout,cwd=cwd,journal=journal)
    return code,stdout,tail
def launch_docker_lines(*args):
    code,stdout,_=launch_exec(['docker',*args],60)
    if code!=0:raise ValueError('docker')
    return stdout.decode('utf-8','replace').split()

# ---- journal: /var/lib/docknest/launches/<id>/ (0700) ----
def launch_dir(lid):return LAUNCH_ROOT/lid
def launch_journal(lid,slug=None,create=False):
    d=launch_dir(lid)
    if create:
        LAUNCH_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
        if LAUNCH_ROOT.is_symlink() or d.is_symlink():launch_refuse('INVALID_REQUEST')
        d.mkdir(exist_ok=True,mode=0o700)
        if os.name=='posix':os.chmod(d,0o700,follow_symlinks=False) if os.chmod in os.supports_follow_symlinks else os.chmod(d,0o700)
    if d.is_symlink():launch_refuse('INVALID_REQUEST')
    file=d/'journal.json'
    journal=json.loads(file.read_text()) if file.is_file() else {}
    journal.setdefault('version',1);journal.setdefault('created',{});journal.setdefault('phase','new')
    for kind in LAUNCH_KINDS:journal['created'].setdefault(kind,[])
    if slug is not None:
        if journal.get('slug') not in (None,slug):launch_refuse('INVALID_REQUEST')
        journal['slug']=slug
    return d,journal
def launch_record(d,journal,kind,value):
    """Written before the effect: a crash after this line leaves a record teardown can act on."""
    if value not in journal['created'][kind]:journal['created'][kind].append(value)
    atomic_json(d/'journal.json',journal)
def launch_save(d,journal):atomic_json(d/'journal.json',journal)
def launch_existing(lid,slug):
    """The journal of a launch that already fetched (every step after fetch acts only on a journalled launch)."""
    if not (launch_dir(lid)/'journal.json').is_file():launch_refuse('NOT_FETCHED')
    return launch_journal(lid,slug)
def launch_lock():
    """One mutating launch step per server at a time; never waits (the worker ticks again)."""
    try:import fcntl
    except ImportError:return None
    handle=open(LAUNCH_LOCK_PATH,'a')
    try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:handle.close();launch_refuse('LAUNCH_BUSY')
    return handle
def launch_site(slug):return LAUNCH_SITES/slug
def launch_inside(path,root):
    p=os.path.realpath(path);r=os.path.realpath(root)
    return p==r or p.startswith(r.rstrip(os.sep)+os.sep)

# ---- Git address rules (threat model "Git URL tricks", items 2, 3, 16) ----
def launch_ip_problem(ip,allow_private):
    inner=ip.ipv4_mapped if ip.version==6 and ip.ipv4_mapped else ip
    # NAT64 (an IPv6-only server behind DNS64) is judged by the IPv4 address it carries.
    if inner.version==6 and inner in ipaddress.ip_network('64:ff9b::/96'):inner=ipaddress.ip_address(int(inner)&0xffffffff)
    # 6to4 is judged by the IPv4 address it carries; Teredo (2001::/32) is refused outright below.
    embedded=[inner.sixtofour] if inner.version==6 and inner.sixtofour else [inner]
    private=False
    for value in embedded:
        if any(value in net for net in LAUNCH_REFUSED_NETS if net.version==value.version):return 'URL_METADATA'
        if any(value in net for net in LAUNCH_PRIVATE_NETS if net.version==value.version):private=True;continue
        # Anything else that is not global unicast (2000::/3 for IPv6) is refused too.
        if value.is_loopback or value.is_link_local or value.is_multicast or value.is_unspecified or value.is_reserved or not value.is_global:return 'URL_METADATA'
        if value.version==6 and value not in ipaddress.ip_network('2000::/3'):return 'URL_METADATA'
    if private:return None if allow_private else 'URL_PRIVATE'
    return None
def launch_host_text(host):
    """A DNS name (lower-case LDH) or an IP literal; numeric spellings that are not plain IPs are refused."""
    if not isinstance(host,str) or not host or host.startswith('-') or '%' in host:launch_refuse('URL_REFUSED')
    try:return ipaddress.ip_address(host.strip('[]')).compressed,True
    except ValueError:pass
    if host.startswith('[') or not LAUNCH_HOST.fullmatch(host) or re.fullmatch(r'[0-9.]+|0x[0-9a-f.x]+',host) or any(label.startswith('-') for label in host.split('.')):launch_refuse('URL_REFUSED')
    return host,False
def launch_git_path(path):
    if not isinstance(path,str) or not LAUNCH_GIT_PATH.fullmatch(path):launch_refuse('URL_REFUSED')
    parts=[p for p in path.split('/') if p]
    if not parts or any(p.startswith('-') or p in ('.','..') for p in parts):launch_refuse('URL_REFUSED')
    return path
def launch_git_url(value):
    """{kind, host, ipLiteral, port, user, path, form} for https://, ssh:// and user@host:path addresses only."""
    if not isinstance(value,str) or not 8<=len(value)<=512 or value.startswith('-') or any(ord(c)<33 or ord(c)==127 or c in '\\"\'`' for c in value):launch_refuse('URL_REFUSED')
    lower=value.lower()
    if lower.startswith(('https://','ssh://')):
        try:parts=urllib.parse.urlsplit(value);port=parts.port
        except ValueError:launch_refuse('URL_REFUSED')
        if '@' in parts.netloc and (lower.startswith('https://') or parts.password is not None):launch_refuse('URL_USERINFO')
        if port is not None and not 1<=port<=65535:launch_refuse('URL_REFUSED')
        if parts.query or parts.fragment or '#' in value or '?' in value or not parts.path.startswith('/'):launch_refuse('URL_REFUSED')
        netloc=parts.netloc.rpartition('@')[2]
        host_part=netloc[:netloc.index(']')+1] if netloc.startswith('[') and ']' in netloc else netloc.split(':')[0]
        host,literal=launch_host_text(host_part.lower())
        kind='https' if lower.startswith('https://') else 'ssh'
        user=parts.username if kind=='ssh' else None
        if kind=='ssh' and (not user or not LAUNCH_SSH_USER.fullmatch(user)):launch_refuse('URL_REFUSED')
        return {'kind':kind,'form':'url','host':host,'ipLiteral':literal,'port':port or (443 if kind=='https' else 22),'user':user,'path':launch_git_path(parts.path)}
    if '://' in value or '::' in value.split('@',1)[0]:launch_refuse('URL_REFUSED')
    match=re.fullmatch(r'([A-Za-z0-9_][A-Za-z0-9_.-]{0,31})@(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(.+)',value)
    if not match:launch_refuse('URL_REFUSED')
    host,literal=launch_host_text(match[2].lower())
    return {'kind':'ssh','form':'scp','host':host,'ipLiteral':literal,'port':22,'user':match[1],'path':launch_git_path(match[3])}
def launch_resolve(host,port,allow_private):
    """Resolve on the server, check every answer, pin the first (DNS rebinding between check and fetch is caught at
    fetch, because fetch resolves and checks again and git connects only to the pinned address)."""
    try:literal=ipaddress.ip_address(host)
    except ValueError:literal=None
    if literal is not None:addresses=[literal]
    else:
        try:answers=socket.getaddrinfo(host,port,0,socket.SOCK_STREAM)
        except (OSError,UnicodeError):launch_refuse('DNS_FAILED')
        addresses=list(dict.fromkeys(ipaddress.ip_address(a[4][0].split('%')[0]) for a in answers))
    if not addresses:launch_refuse('DNS_FAILED')
    for address in addresses:
        problem=launch_ip_problem(address,allow_private)
        if problem:launch_refuse(problem)
    return addresses[0]
def launch_bracket(ip):return '[%s]'%ip.compressed if ip.version==6 else ip.compressed
def launch_known_name(host,port):
    """The known_hosts name (and HostKeyAlias): the bare host or address on port 22, else [host]:port (as #171 stores it)."""
    return host if port==22 else '[%s]:%d'%(host,port)
def launch_git_target(repo,allow_private):
    """What git actually connects to: the checked IP, with TLS and host keys still verified against the name."""
    ip=launch_resolve(repo['host'],repo['port'],allow_private)
    if repo['kind']=='https':
        resolve=None if repo['ipLiteral'] else '%s:%d:%s'%(repo['host'],repo['port'],launch_bracket(ip))
        host=launch_bracket(ipaddress.ip_address(repo['host'])) if repo['ipLiteral'] else repo['host']
        return {'kind':'https','url':'https://%s%s%s'%(host,'' if repo['port']==443 else ':%d'%repo['port'],repo['path']),'resolve':resolve,'alias':None,'ip':ip.compressed}
    alias=launch_known_name(repo['host'],repo['port'])
    if repo['form']=='scp':url='%s@%s:%s'%(repo['user'],launch_bracket(ip),repo['path'])
    else:url='ssh://%s@%s%s%s'%(repo['user'],launch_bracket(ip),'' if repo['port']==22 else ':%d'%repo['port'],repo['path'])
    return {'kind':'ssh','url':url,'resolve':None,'alias':alias,'ip':ip.compressed}
def launch_ref(value):
    if value in (None,''):return None
    if not isinstance(value,str) or not LAUNCH_REF.fullmatch(value) or value.startswith(('-','/')) or value.endswith(('/','.lock','.')) or '..' in value or '//' in value or any(p.startswith('.') for p in value.split('/')):launch_refuse('REF_INVALID')
    return value
def launch_repo(req):
    repo=req.get('repo')
    if not isinstance(repo,dict):launch_refuse('INVALID_REQUEST')
    parsed=launch_git_url(repo.get('url'))
    return parsed,launch_ref(repo.get('ref')),repo.get('allowPrivate') is True

# ---- git version, argv and environment (items 2, 3, 9, 16) ----
def launch_git_version():
    code,stdout,_=launch_exec(['env','-i','PATH='+LAUNCH_PATH,'LC_ALL=C','git','--version'],30,env={})
    if code==127:return None,False
    match=re.search(r'git version (\d+)\.(\d+)(?:\.(\d+))?',stdout.decode('utf-8','replace')) if code==0 else None
    if not match:return None,False
    version=(int(match[1]),int(match[2]),int(match[3] or 0))
    ok=version>=LAUNCH_GIT_MIN
    return '%d.%d.%d'%version,ok
def launch_git_home(folder):
    """An empty, private HOME for git inside the journal (or check) folder: git finds no .gitconfig, credentials or hooks."""
    home=pathlib.Path(folder)/'git-home'
    if home.is_symlink():launch_refuse('INVALID_REQUEST')
    home.mkdir(mode=0o700,exist_ok=True)
    if any(home.iterdir()):launch_refuse('INVALID_REQUEST')
    return home
def launch_git_env(home,ssh=None):
    # clone and ls-remote create or need no repository, so GIT_DIR stays unset for them (it would redirect clone's own
    # .git); git runs in its private folder and never looks above it for one.
    pairs=['PATH='+LAUNCH_PATH,'HOME='+str(home),'GIT_TERMINAL_PROMPT=0','GIT_CONFIG_NOSYSTEM=1','GIT_CONFIG_GLOBAL=/dev/null','GIT_CEILING_DIRECTORIES=/','LC_ALL=C']
    if ssh:pairs+=['GIT_SSH_COMMAND='+ssh,'GIT_SSH_VARIANT=ssh']
    return pairs
def launch_git_argv(home,target,ssh,tail):
    url=target.get('url') if isinstance(target,dict) else None
    # Never a local path or another transport: only the https:// and SSH forms launch_git_target builds.
    if url is not None and not (url.startswith(('https://','ssh://')) or re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}@(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):[^-].*',url)):launch_refuse('URL_REFUSED')
    config=list(LAUNCH_GIT_CONFIG)
    if isinstance(target,dict) and target.get('resolve'):config+=['-c','http.curloptResolve='+target['resolve']]
    return ['env','-i',*launch_git_env(home,ssh),'git',*config,*tail]
def launch_ssh_command(known_hosts,key,alias):
    """Item 3. git runs GIT_SSH_COMMAND through sh, so every value is quoted."""
    return ' '.join(['ssh','-F','/dev/null','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ProxyCommand=none','-o','ProxyJump=none','-o','StrictHostKeyChecking=yes',
        '-o','UserKnownHostsFile='+shlex.quote(str(known_hosts)),'-o','GlobalKnownHostsFile=/dev/null','-o','HostKeyAlias='+shlex.quote(alias),'-o','CheckHostIP=no','-o','UpdateHostKeys=no','-i',shlex.quote(str(key))])
# The PEM wrapper of an OpenSSH private key, built from parts so no file ever holds a key header (repository rule).
LAUNCH_KEY_KIND='OPENSSH '+'PRIVATE'+' KEY'
LAUNCH_KEY_PEM='-----BEGIN %s-----\n[A-Za-z0-9+/=\n]+-----END %s-----\n'%(LAUNCH_KEY_KIND,LAUNCH_KEY_KIND)
def launch_private_key(value):
    if not isinstance(value,str) or len(value)>16384:launch_refuse('KEY_INVALID')
    text=value.replace('\r\n','\n').strip()+'\n'
    if not re.fullmatch(LAUNCH_KEY_PEM,text):launch_refuse('KEY_INVALID')
    return text
def launch_host_key(value,name=None):
    """(type, base64) from a pinned known_hosts line or a bare 'type base64' pair; the blob must name its own type.
    With `name`, a line that names a host must name exactly that known_hosts name (a key pinned for another port or
    host is never used)."""
    if not isinstance(value,str) or len(value)>16384 or any(c in value for c in '\r\n\0'):launch_refuse('HOST_KEY_INVALID')
    words=value.split()
    for i,word in enumerate(words[:-1]):
        if word in LAUNCH_HOST_KEY_TYPES:
            blob=words[i+1]
            try:raw=__import__('base64').b64decode(blob,validate=True)
            except ValueError:launch_refuse('HOST_KEY_INVALID')
            size=int.from_bytes(raw[:4],'big') if len(raw)>4 else 0
            if raw[4:4+size]!=word.encode():launch_refuse('HOST_KEY_INVALID')
            if name is not None and i>0 and words[i-1]!=name:launch_refuse('HOST_KEY_MISMATCH')
            return word,blob
    launch_refuse('HOST_KEY_INVALID')
def launch_with_key(folder,repo,target,key,action,journal=None):
    """Item 10: the one key-file helper. The private key is written to a 0600 file in the 0700 journal (or check)
    folder, outside the site folder and any build context, used through GIT_SSH_COMMAND only, and removed in finally
    on every path. The key never enters argv, results or logs."""
    files=[]
    try:
        ssh=None
        if repo['kind']=='ssh':
            if not isinstance(key,dict):launch_refuse('KEY_REQUIRED')
            private=launch_private_key(key.get('privateKey'));kind,blob=launch_host_key(key.get('hostKeyLine'),target['alias'])
            if shutil.which('ssh',path=LAUNCH_PATH) is None:launch_refuse('SSH_MISSING')
            tag=uuid.uuid4().hex[:12];key_file=pathlib.Path(folder)/('key-'+tag);known=pathlib.Path(folder)/('known-hosts-'+tag)
            for path in (key_file,known):
                if journal is not None:launch_record(journal[0],journal[1],'keys',str(path))
                files.append(path)
            for path,data in ((key_file,private),(known,'%s %s %s\n'%(target['alias'],kind,blob))):
                fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600)
                with os.fdopen(fd,'w') as output:output.write(data)
            ssh=launch_ssh_command(known,key_file,target['alias'])
        return action(ssh)
    finally:
        for path in files:
            try:path.unlink()
            except FileNotFoundError:pass
def launch_git_failure(tail,why):
    if why=='timeout':return 'FETCH_TIMEOUT'
    if why=='size':return 'REPO_TOO_LARGE'
    if 'host key verification failed' in tail or 'remote host identification has changed' in tail:return 'HOST_KEY_MISMATCH'
    if 'permission denied' in tail or 'authentication failed' in tail or 'could not read username' in tail:return 'AUTH_FAILED'
    if 'remote branch' in tail and 'not found' in tail:return 'REF_NOT_FOUND'
    if 'redirect' in tail or ' 301' in tail or ' 302' in tail:return 'REDIRECT_REFUSED'
    if 'repository not found' in tail or 'does not appear to be a git repository' in tail or 'not found' in tail:return 'REPO_NOT_FOUND'
    if 'could not resolve' in tail:return 'DNS_FAILED'
    return 'FETCH_FAILED'
def launch_ls_remote(folder,repo,ref,target,key,journal=None):
    patterns=['refs/heads/'+ref,'refs/tags/'+ref,'refs/tags/'+ref+'^{}'] if ref else ['HEAD']
    def action(ssh):
        code,stdout,tail,why=launch_watch(launch_git_argv(launch_git_home(folder),target,ssh,['ls-remote','--',target['url'],*patterns]),{},120,cwd=str(folder),journal=journal)
        if code!=0:launch_refuse(launch_git_failure(tail,why))
        found={}
        for line in stdout.decode('utf-8','replace').splitlines():
            sha,_,name=line.partition('\t')
            if re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}',sha):found[name.strip()]=sha
        for name in (['refs/heads/'+ref,'refs/tags/'+ref+'^{}','refs/tags/'+ref] if ref else ['HEAD']):
            if name in found:return found[name]
        launch_refuse('REF_NOT_FOUND')
    return launch_with_key(folder,repo,target,key,action,journal)

# ---- repository content (item 4, non-goals) ----
def launch_symlink_escape(root):
    """True when any symbolic link in the tree resolves outside it (dangling links are judged by their target)."""
    real=os.path.realpath(root)
    for current,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            path=os.path.join(current,name)
            if os.path.islink(path) and not launch_inside(path,real):return True
    return False
def launch_lfs(root):
    for current,dirs,files in os.walk(root,followlinks=False):
        if '.git' in dirs:dirs.remove('.git')
        if '.gitattributes' in files:
            try:
                with open(os.path.join(current,'.gitattributes'),'rb') as handle:
                    if b'filter=lfs' in handle.read(1024*1024):return True
            except OSError:return True
    return False

# ---- environment values (item 6) ----
def launch_env_values(value):
    if value is None:return {}
    if not isinstance(value,dict) or len(value)>LAUNCH_ENV_KEYS:launch_refuse('ENV_REFUSED')
    for key,item in value.items():
        if not isinstance(key,str) or not LAUNCH_ENV_KEY.fullmatch(key) or key.upper().startswith(LAUNCH_ENV_REFUSED):launch_refuse('ENV_REFUSED')
        if not isinstance(item,str) or len(item.encode())>LAUNCH_VALUE_LIMIT or any(c in item for c in '\r\n\0'):launch_refuse('ENV_REFUSED')
    return value
def launch_env_quote(value):
    """Literal in Compose's env file: plain, single-quoted, or double-quoted with \\, " and $ escaped (as Safe Edit)."""
    if re.fullmatch(r'[A-Za-z0-9_./:@+,%^~=-]*',value):return value
    if "'" not in value:return "'%s'"%value
    return '"%s"'%value.replace('\\','\\\\').replace('"','\\"').replace('$','\\$')
def launch_private_write(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as output:output.write(data);output.flush();os.fsync(output.fileno())

# ---- Compose resolution and checks ----
def launch_compose_version():
    code,stdout,_=launch_exec(['docker','compose','version','--short'],30)
    match=re.match(r'v?(\d+)\.(\d+)',stdout.decode('utf-8','replace').strip()) if code==0 else None
    return (stdout.decode('utf-8','replace').strip()[:32] if match else None),bool(match) and (int(match[1]),int(match[2]))>=LAUNCH_MIN_COMPOSE
def launch_compose_base(slug,files,project_dir,env_file):
    """Item 6: explicit project name, files and env file; a repository .env is never read by Compose."""
    args=['docker','compose','-p',slug]
    for f in files:args+=['-f',str(f)]
    return args+['--project-directory',str(project_dir),'--env-file',str(env_file)]
# Compose config sandbox (defence in depth behind the text checks): every `docker compose config` on the user's file runs
# in a private mount namespace where the other sites' folders, DockNest's own state and home folders are empty tmpfs
# mounts. Only the folder of this launch (its site folder, or a check folder) is bound back, read-only. An include or
# extends the text checks missed can then only reach files of this launch. The mounts are done by this fixed Python
# program (no shell); its arguments are a JSON list of folders to keep and the compose argv.
LAUNCH_SANDBOX_HIDE=('/srv/docknest','/var/lib/docknest','/var/lib/docker-backup-manager','/etc/docknest','/root','/home','/var/lib/docker/volumes')
LAUNCH_SANDBOX_CODE=r'''
import json,os,subprocess,sys
spec=json.loads(sys.argv[1]);argv=sys.argv[2:]
def mount(*args,fds=()):
    if subprocess.run(['mount',*args],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,pass_fds=fds).returncode:os._exit(97)
try:
    mount('--make-rprivate','/')
    keep=[(path,os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)) for path in spec['keep']]
    hidden=[]
    for path in spec['hide']:
        if os.path.isdir(path) and not os.path.islink(path) and not any(path==h or path.startswith(h+'/') for h in hidden):
            mount('-t','tmpfs','-o','size=1m,mode=0755,nosuid,nodev,noexec','docknest-sandbox',path);hidden.append(path)
    for path,fd in keep:
        os.makedirs(path,mode=0o755,exist_ok=True)
        mount('--bind','/proc/self/fd/%d'%fd,path,fds=(fd,));mount('-o','remount,bind,ro,nosuid,nodev',path)
        os.close(fd)
except OSError:os._exit(97)
os.execvp(argv[0],argv)
'''
def launch_plugin_dirs():
    """Docker CLI plugin folders (where the compose plugin may live) under the hidden home folders: /root/.docker,
    the helper user's ~/.docker and $DOCKER_CONFIG. Each existing, real folder is bound back read-only in the sandbox;
    the rest of .docker (config.json can hold registry credentials) stays hidden."""
    found=[]
    for base in ('/root/.docker',os.path.expanduser('~/.docker'),os.environ.get('DOCKER_CONFIG') or ''):
        if not base or not os.path.isabs(base):continue
        path=os.path.join(base,'cli-plugins')
        if os.path.isdir(path) and not os.path.islink(path) and path not in found:found.append(path)
    return found
def launch_sandboxed(argv,keep):
    """argv wrapped in the compose config sandbox. Refuses SANDBOX_UNAVAILABLE without unshare (fail closed)."""
    if shutil.which('unshare',path=LAUNCH_PATH) is None or shutil.which('mount',path=LAUNCH_PATH) is None:launch_refuse('SANDBOX_UNAVAILABLE')
    hide=list(dict.fromkeys([str(LAUNCH_SITES),str(LAUNCH_ROOT),*LAUNCH_SANDBOX_HIDE]))
    keep=[str(k) for k in keep]+launch_plugin_dirs()
    python=sys.executable if sys.executable and os.path.isabs(sys.executable) else 'python3'
    return ['unshare','--mount','--propagation','private','--',python,'-I','-c',LAUNCH_SANDBOX_CODE,json.dumps({'keep':keep,'hide':hide}),*argv]
def launch_model(slug,files,project_dir,env_file):
    # Every file Compose may read for this launch lives in the env file's folder (the site folder or a check folder).
    argv=launch_sandboxed(launch_compose_base(slug,files,project_dir,env_file)+['config','--format','json'],[os.path.dirname(str(env_file))])
    code,stdout,_=launch_exec(argv,120)
    if code==97:launch_refuse('SANDBOX_UNAVAILABLE')
    if code!=0:launch_refuse('COMPOSE_INVALID')
    try:model=json.loads(stdout)
    except ValueError:launch_refuse('COMPOSE_INVALID')
    if not isinstance(model,dict) or not isinstance(model.get('services'),dict) or not model['services']:launch_refuse('COMPOSE_INVALID')
    return model
def launch_compose_text_problem(data):
    """Compose text DockNest can judge from the resolved model alone: no include, no extends (both pull in other files
    or services the model hides) and no JSON or flow-style document. Keys are matched in block and flow position."""
    if len(data)>LAUNCH_COMPOSE_LIMIT:return 'COMPOSE_TOO_LARGE'
    try:text=data.decode('utf-8').lstrip('\ufeff')
    except UnicodeDecodeError:return 'COMPOSE_SYNTAX_REFUSED'
    # Every YAML spelling that could hide a key from the plain-text checks below is refused first: directives (%YAML,
    # %TAG), explicit keys (?), tagged or aliased keys (!!binary, *anchor), and quoted keys with an escape or a line break.
    if re.search(r'(?m)^%',text):return 'COMPOSE_SYNTAX_REFUSED'
    if re.search(r'(?m)(?:^[ \t]*(?:-[ \t]+)?|[{\[,][ \t]*)\?(?:[ \t]|$)',text):return 'COMPOSE_SYNTAX_REFUSED'
    if re.search(r'(?m)(?:^[ \t]*(?:-[ \t]+)?|[{,][ \t]*)\*[^\s,:\]}]+[ \t]*:',text):return 'COMPOSE_SYNTAX_REFUSED'
    if re.search(r'(?m)(?:^[ \t]*(?:-[ \t]+)?|[{,][ \t]*)![^\s]*[ \t]+(?:"[^"\n]*"|\'[^\'\n]*\'|[^\s:\[\]{},#]+)[ \t]*:(?:[ \t]|$)',text):return 'COMPOSE_SYNTAX_REFUSED'
    if re.search(r'"(?:[^"\\]|\\.)*(?:\\|\n)(?:[^"\\]|\\.)*"[ \t]*:(?:[ \t]|$)',text) or re.search(r"'(?:[^'\n]|'')*\n(?:[^']|'')*'[ \t]*:(?:[ \t]|$)",text):return 'COMPOSE_SYNTAX_REFUSED'
    # The words themselves as a key anywhere (block or flow, quoted or plain, the colon even on the next line). A value
    # that happens to read "include:" is refused too; DockNest prefers that to a missed key.
    # No condition on what follows the colon: a quoted (JSON-style) key may have its value right after it.
    if re.search(r'(?<![\w-])(["\']?)include\1\s*:',text):return 'COMPOSE_INCLUDE_REFUSED'
    if re.search(r'(?<![\w-])(["\']?)extends\1\s*:',text):return 'COMPOSE_EXTENDS_REFUSED'
    # A flow document may start on the --- line, after a tag or an anchor.
    first=next((line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith('#') and line.strip()!='---'),'')
    first=re.sub(r'^(?:---[ \t]*)?(?:[!&][^\s]*[ \t]+)*','',first)
    if first.startswith(('{','[')):return 'COMPOSE_FLOW_REFUSED'
    return None
def launch_build_problems(model,repo_root,slug):
    """Build allow-list (threat model "Build escape") and the Dockerfile scan (item 1)."""
    refusals=[]
    for name,service in model['services'].items():
        build=service.get('build')
        if build is None:continue
        def refuse(code,field):refusals.append({'code':code,'service':name,'field':'services.%s.build%s'%(name,'.'+field if field else '')})
        if not isinstance(build,dict):refuse('BUILD_SETTING_REFUSED',None);continue
        extra=sorted(set(build)-LAUNCH_BUILD_KEYS)
        if extra:refuse('BUILD_SETTING_REFUSED',extra[0]);continue
        args=build.get('args') or {}
        keys=list(args) if isinstance(args,dict) else [str(a).partition('=')[0] for a in args]
        if any(str(k).upper().startswith('BUILDKIT_') for k in keys):refuse('BUILD_SETTING_REFUSED','args');continue
        context=build.get('context')
        if not isinstance(context,str) or '://' in context or context.startswith(('git@','github.com/')) or not os.path.isabs(context) or not launch_inside(context,repo_root) or not os.path.isdir(context):refuse('BUILD_SETTING_REFUSED','context');continue
        dockerfile=os.path.join(context,build.get('dockerfile') or 'Dockerfile')
        if not os.path.lexists(dockerfile):refuse('DOCKERFILE_MISSING','dockerfile');continue
        if not launch_inside(dockerfile,repo_root) or not os.path.isfile(dockerfile):refuse('BUILD_SETTING_REFUSED','dockerfile');continue
        problem=launch_dockerfile_problem(dockerfile)
        if problem:refuse(problem,'dockerfile');continue
        if service.get('image') is not None and not launch_image_ours(service.get('image'),slug):refuse('BUILD_IMAGE_REFUSED','image')
    return refusals
def launch_image_ours(image,slug):
    """A built image may only carry a name in the launch's own namespace (<slug>-x, <slug>_x or <slug>/x, an optional tag,
    no registry host, no digest), so a build can never replace a shared tag such as postgres:16 used by other sites."""
    if not isinstance(image,str) or '@' in image or not LAUNCH_IMAGE.fullmatch(image):return False
    name,tag=image,''
    if ':' in image.rsplit('/',1)[-1]:name,_,tag=image.rpartition(':')
    if tag and not re.fullmatch(r'[a-z0-9_][a-z0-9_.-]{0,127}',tag):return False
    if ':' in name or ('/' in name and ('.' in name.split('/')[0] or name.split('/')[0]=='localhost')):return False
    return re.fullmatch(re.escape(slug)+r'[-_/][a-z0-9][a-z0-9._/-]*',name) is not None
def launch_dockerfile_problem(path):
    try:
        with open(path,'rb') as handle:data=handle.read(LAUNCH_DOCKERFILE_LIMIT+1)
    except OSError:return 'DOCKERFILE_MISSING'
    if len(data)>LAUNCH_DOCKERFILE_LIMIT:return 'DOCKERFILE_REFUSED'
    text=data.decode('utf-8','replace').lstrip('\ufeff')
    # Every way BuildKit picks a frontend: '#' and '//' syntax directives and a JSON {"syntax": ...} document. Any syntax
    # value anywhere in the file must name docker/dockerfile; a JSON or array document is never built.
    if text.lstrip().startswith(('{','[')):return 'SYNTAX_REFUSED'
    for match in re.finditer(r'(?im)^[ \t]*(?:#|//)[ \t]*syntax[ \t]*=[ \t]*(\S*)',text):
        if not LAUNCH_SYNTAX.fullmatch(match[1]):return 'SYNTAX_REFUSED'
    for match in re.finditer(r'(?i)["\']syntax["\'][ \t]*:[ \t]*["\']([^"\']*)',text):
        if not LAUNCH_SYNTAX.fullmatch(match[1]):return 'SYNTAX_REFUSED'
    # RUN --network and --security: only the values that grant nothing (allow-list), never a variable.
    joined=re.sub(r'[\\`][ \t]*\r?\n',' ',text)
    for match in re.finditer(r'(?i)--(network|security)(?:[ \t]*=[ \t]*|[ \t]+)(["\']?)([^\s"\']*)\2',joined):
        value=match[3]
        if '$' in value or value.lower() not in LAUNCH_RUN_FLAGS[match[1].lower()]:return 'DOCKERFILE_REFUSED'
    return None
def launch_runtime_gate(model,site):
    """The Safe Edit privilege gate (remote/helper/edit.py, 2.15) with no "before": nothing the site gets may add host
    access. The gate compares against a current model; here every service's "current" is only a bind of the site
    folder, so new binds must lie inside it and nothing privileged is allowed. `build` is checked by the build
    allow-list above, so it is taken out first. Fails closed when this helper has no gate."""
    gate=globals().get('edit_gate')
    if not callable(gate):launch_refuse('GATE_UNAVAILABLE')
    candidate=json.loads(json.dumps(model))
    for service in candidate['services'].values():
        if isinstance(service,dict):service.pop('build',None)
    root=str(site)
    current={'services':{name:{'volumes':[{'type':'bind','source':root,'target':'/docknest-launch-site'}]} for name in candidate['services']}}
    try:gate(current,candidate,[root],{},{})
    except Exception as error:
        code=getattr(error,'code',None)
        if not isinstance(code,str):raise
        field=getattr(error,'field',None)
        service=field.split('.')[1] if isinstance(field,str) and field.startswith('services.') and field.count('.')>=1 else None
        # Only the service and the setting name leave the helper (never a path or value the gate may have named).
        field='.'.join(field.split('.')[:3])[:120] if isinstance(field,str) else None
        return [{'code':code[:40],'service':service[:64] if service else None,'field':field}]
    return []
def launch_secret_bind_problems(model,protected):
    """Read-write binds that cover the site's .env or Compose file (a bind of the site root or the repository root
    included) are refused; read-only binds stay allowed."""
    refusals=[]
    for name,service in model['services'].items():
        for mount in service.get('volumes') or []:
            if not isinstance(mount,dict) or mount.get('type')!='bind' or mount.get('read_only') or not isinstance(mount.get('source'),str):continue
            if any(launch_inside(path,mount['source']) for path in protected):
                refusals.append({'code':'BIND_COVERS_SECRETS','service':name,'field':'services.%s.volumes'%name});break
    return refusals
def launch_port_problems(model,web_service=None):
    refusals=[]
    for name,service in model['services'].items():
        if name==web_service:continue
        for port in service.get('ports') or []:
            if isinstance(port,dict) and port.get('published') not in (None,'') and port.get('host_ip') not in ('127.0.0.1','::1'):
                refusals.append({'code':'PORT_NOT_LOOPBACK','service':name,'field':'services.%s.ports'%name});break
    return refusals
def launch_env_file_problems(model,site):
    refusals=[]
    for name,service in model['services'].items():
        items=service.get('env_file') or []
        for item in items if isinstance(items,list) else [items]:
            path=item.get('path') if isinstance(item,dict) else item
            if not isinstance(path,str) or not os.path.isabs(path) or not launch_inside(path,site):refusals.append({'code':'ENV_FILE_REFUSED','service':name,'field':'services.%s.env_file'%name});break
    return refusals
def launch_resolved_names(model,slug):
    """Item 5: the names Compose will use for every container, volume and network."""
    containers=[]
    for name,service in model['services'].items():
        if service.get('container_name'):containers.append(str(service['container_name']));continue
        count=(service.get('deploy') or {}).get('replicas') or service.get('scale') or 1
        containers+=['%s-%s-%d'%(slug,name,i) for i in range(1,min(int(count),50)+1)]
    volumes=[str((item or {}).get('name') or '%s_%s'%(slug,key)) for key,item in (model.get('volumes') or {}).items()]
    networks=[str((item or {}).get('name') or '%s_%s'%(slug,key)) for key,item in (model.get('networks') or {}).items()]
    return {'containers':containers,'volumes':volumes,'networks':networks}
def launch_collisions(model,slug,lid):
    names=launch_resolved_names(model,slug);label='label=docknest.launch='+lid
    own={'containers':set(launch_docker_lines('ps','-a','--filter',label,'--format','{{.Names}}')),'volumes':set(launch_docker_lines('volume','ls','-q','--filter',label)),'networks':set(launch_docker_lines('network','ls','--filter',label,'--format','{{.Name}}'))}
    existing={'containers':set(launch_docker_lines('ps','-a','--format','{{.Names}}')),'volumes':set(launch_docker_lines('volume','ls','-q')),'networks':set(launch_docker_lines('network','ls','--format','{{.Name}}'))}
    refusals=[]
    project=set(launch_docker_lines('ps','-aq','--filter','label=com.docker.compose.project='+slug))-set(launch_docker_lines('ps','-aq','--filter',label))
    if project:refusals.append({'code':'PROJECT_EXISTS','service':None,'field':'name'})
    for kind,values in names.items():
        for value in values:
            if value in existing[kind] and value not in own[kind]:refusals.append({'code':'NAME_COLLISION','service':None,'field':'%s.%s'%(kind,value)})
    return refusals
def launch_checks(model,lid,slug,site,repo_root,web_service=None,protected=()):
    # The port rule needs the web service (its ports are replaced by the loopback port): always at start, at fetch when given.
    refusals=launch_build_problems(model,repo_root,slug)+(launch_port_problems(model,web_service) if web_service else [])+launch_env_file_problems(model,site)
    refusals+=launch_secret_bind_problems(model,protected)
    refusals+=launch_runtime_gate(model,site)
    refusals+=launch_collisions(model,slug,lid)
    return refusals
def launch_services(model):
    out=[]
    for name,service in model['services'].items():
        ports=[]
        for port in service.get('ports') or []:
            target=port.get('target') if isinstance(port,dict) else None
            if isinstance(target,int) and target not in ports:ports.append(target)
        for value in service.get('expose') or []:
            match=re.match(r'(\d+)',str(value))
            if match and int(match[1]) not in ports:ports.append(int(match[1]))
        out.append({'name':name,'ports':ports[:20],'build':service.get('build') is not None})
    return out[:50]
def launch_layout(journal):
    """The fetched files: compose file, project folder, repository root, env file (all inside the site folder)."""
    files=journal.get('files')
    if not isinstance(files,dict):launch_refuse('NOT_FETCHED')
    site=launch_site(journal['slug'])
    for key in ('compose','projectDir','repoRoot','envFile'):
        if not isinstance(files.get(key),str) or not launch_inside(files[key],site):launch_refuse('NOT_FETCHED')
    return site,files

# ---- nginx: "already served" from nginx -T (item 7) ----
def launch_nginx_dump():
    code,stdout,_=launch_exec(['nginx','-T'],60)
    if code!=0:launch_refuse('NGINX_UNREADABLE')
    return stdout.decode('utf-8','replace')
def launch_server_blocks(text,skip=None):
    """[{names, default}] for every server block. File sections DockNest wrote for this launch (`skip`) are left out."""
    sections=re.split(r'(?m)^# configuration file (.+?):\s*$',text)
    blocks=[]
    for index in range(0,len(sections),2):
        name=sections[index-1] if index else ''
        body=sections[index]
        if skip and posixpath.basename(name.strip())==skip[0] and body.lstrip().startswith(skip[1]):continue
        try:
            lexer=shlex.shlex(body,posix=True,punctuation_chars='{};');lexer.whitespace_split=True;lexer.commenters='#'
            tokens=list(lexer)
        except ValueError:launch_refuse('NGINX_UNREADABLE')
        stack=[];words=[];current=None
        for token in tokens:
            if token=='{':
                head=words[0] if words else ''
                stack.append(head)
                # An http server block (nginx -T prints each included file at its own top level); stream and mail
                # servers have no names.
                if head=='server' and not set(stack[:-1])&{'server','stream','mail','upstream'}:current={'names':[],'default':False,'listens':[]};blocks.append(current)
                words=[]
            elif token=='}':
                if stack and stack.pop()=='server':current=None
                words=[]
            elif token==';':
                if current is not None and words and stack and stack[-1]=='server':
                    if words[0]=='server_name':current['names']+=words[1:]
                    elif words[0]=='listen':
                        current['listens'].append(words[1] if len(words)>1 else '')
                        if 'default_server' in words[1:]:current['default']=True
                words=[]
            else:words.append(token)
    return blocks
def launch_name_matches(name,host):
    n=name.lower().rstrip('.')
    if n.startswith('~'):
        pattern=name[1:].replace('(?<','(?P<').replace('(?P<=','(?<=').replace('(?P<!','(?<!')
        try:return re.search(pattern,host,re.I) is not None
        except re.error:return True  # a regular expression DockNest cannot evaluate counts as a conflict
    if n.startswith('*.'):return host.endswith(n[1:])
    if n.startswith('.'):return host==n[1:] or host.endswith(n)
    if n.endswith('.*'):return host.startswith(n[:-1])
    return n==host
def launch_ip_listens(blocks):
    """Server blocks that listen on one address for port 80 or 443: nginx picks the address before the name, so such a
    block may answer for this domain on that address. Reported as a warning in Check."""
    found=[]
    for block in blocks:
        for value in block.get('listens') or []:
            match=re.fullmatch(r'(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\]):(80|443)',value)
            if match and match[1] not in ('0.0.0.0','[::]') and value not in found:found.append(value)
    return found[:20]
def launch_nginx_conflicts(names,skip=None,blocks=None):
    found=[]
    for block in blocks if blocks is not None else launch_server_blocks(launch_nginx_dump(),skip):
        for name in block['names']:
            if any(launch_name_matches(name,host) for host in names):
                kind='regex' if name.startswith('~') else 'wildcard' if '*' in name or name.startswith('.') else 'exact'
                item={'name':name[:253],'kind':'default' if block['default'] and kind=='exact' else kind}
                if item not in found:found.append(item)
    return found[:20]
def launch_nginx_conf(lid,names,port,acme,tls=None):
    proxy='proxy_pass http://127.0.0.1:%d; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $http_connection;'%port
    acme_location='  location /.well-known/acme-challenge/ { root %s; }\n'%acme
    if tls:
        plain='server {\n  listen 80;\n  listen [::]:80;\n  server_name %s;\n%s  location / { return 301 https://$host$request_uri; }\n}\n'%(' '.join(names),acme_location)
        secure='server {\n  listen 443 ssl;\n  listen [::]:443 ssl;\n  server_name %s;\n  ssl_certificate %s;\n  ssl_certificate_key %s;\n  location / { %s }\n}\n'%(' '.join(names),tls['cert'],tls['key'],proxy)
        servers=plain+secure
    else:servers='server {\n  listen 80;\n  listen [::]:80;\n  server_name %s;\n%s  location / { %s }\n}\n'%(' '.join(names),acme_location,proxy)
    return (LAUNCH_HEADER%lid)+' removed by Remove launch.\n'+servers
def launch_nginx_reload():
    code,_,_=launch_exec(['nginx','-t'],60)
    if code!=0:return False
    code,_,_=launch_exec(['nginx','-s','reload'],60)
    if code!=0:
        code,_,_=launch_exec(['systemctl','reload','nginx'],60)
    return code==0
def launch_nginx_path(slug):
    conf=nginx_conf_dir()
    if not conf:launch_refuse('NGINX_NO_CONF_DIR')
    return pathlib.Path(conf)/('docknest-%s.conf'%slug)
def launch_write_nginx(d,journal,lid,slug,names,port,tls=None):
    path=launch_nginx_path(slug)
    if path.is_symlink() or (path.exists() and not path.read_text(errors='replace').startswith(LAUNCH_HEADER%lid)):launch_refuse('NGINX_FILE_EXISTS')
    launch_record(d,journal,'nginx',str(path))
    acme=ACME_ROOT/('launch-'+lid)
    if not acme.exists():launch_record(d,journal,'paths',str(acme));acme.mkdir(parents=True,mode=0o755)
    previous=path.read_text() if path.exists() else None
    temporary=path.with_name('.'+path.name+'.docknest-tmp')
    if temporary.is_symlink() or temporary.exists():temporary.unlink()
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o644)
    with os.fdopen(fd,'w') as output:output.write(launch_nginx_conf(lid,names,port,str(acme),tls))
    os.replace(temporary,path)
    if not launch_nginx_reload():
        if previous is None:path.unlink(missing_ok=True)
        else:path.write_text(previous)
        launch_nginx_reload()
        launch_refuse('NGINX_TEST_FAILED')
    return path

# ---- certificates (items 8 and 13) ----
def launch_lineages(root=None):
    """[{name, domains}] for every certbot lineage, read from the public certificate files only."""
    live=pathlib.Path(root or LETSENCRYPT)/'live'
    decode=getattr(getattr(ssl,'_ssl',None),'_test_decode_cert',None)
    found=[]
    try:names=sorted(e.name for e in os.scandir(live) if e.is_dir() and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',e.name))[:500]
    except OSError:return found
    for name in names:
        # Without a certificate decoder (or an unreadable certificate) the lineage's names are unknown: None, which
        # counts as covering the domain (fail closed).
        domains=None
        try:
            if decode:domains=[str(v).lower() for kind,v in decode(str(live/name/'cert.pem')).get('subjectAltName',()) if kind=='DNS'][:100]
        except Exception:domains=None
        found.append({'name':name,'domains':domains})
    return found
def launch_covers(domain,host):
    domain=domain.lower().rstrip('.')
    if domain.startswith('*.'):return host.endswith(domain[1:]) and '.' not in host[:-len(domain)+1]
    return domain==host
def launch_lineage_conflicts(names,cert_name,own=()):
    hosts=list(dict.fromkeys(names+['www.'+names[0]]))
    return [{'name':item['name'],'domains':(item['domains'] or [])[:10]} for item in launch_lineages() if item['name'] not in own and (item['name']==cert_name or item['domains'] is None or any(launch_covers(d,h) for d in item['domains'] for h in hosts))][:20]
def launch_dns(host):
    answers={'A':[],'AAAA':[]}
    try:
        for item in socket.getaddrinfo(host,None,0,socket.SOCK_STREAM):
            address=item[4][0].split('%')[0];kind='AAAA' if ':' in address else 'A'
            if address not in answers[kind]:answers[kind].append(address)
    except (OSError,UnicodeError):pass
    return answers
def launch_certbot_failure(tail):
    if 'too many certificates' in tail or 'ratelimited' in tail or 'rate limit' in tail:return 'RATE_LIMITED'
    if 'caa record' in tail or ':caa' in tail:return 'CAA_REFUSED'
    if 'nxdomain' in tail or 'dns problem' in tail or 'no valid ip addresses' in tail:return 'DNS_WAITING'
    return 'CERT_FAILED'

# ---- operations ----
def launch_host_key_op(req):
    """Reads the Git host's public key from this server's network view. Nothing is trusted here: the administrator
    confirms the SHA-256 fingerprint before it is pinned."""
    host=req.get('gitHost')
    if not isinstance(host,str) or len(host)>260:launch_refuse('INVALID_REQUEST')
    match=re.fullmatch(r'(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?',host)
    if not match:launch_refuse('URL_REFUSED')
    name,literal=launch_host_text(match[1].lower());port=launch_port(int(match[2]) if match[2] else 22)
    ip=launch_resolve(name,port,req.get('allowPrivate') is True)
    code,stdout,_=launch_exec(['env','-i','PATH='+LAUNCH_PATH,'LC_ALL=C','ssh-keyscan','-T','10','-p',str(port),'-t','ed25519,ecdsa,rsa',ip.compressed],60,env={})
    if code==127:launch_refuse('SSH_MISSING')
    keys={}
    for line in stdout.decode('utf-8','replace').splitlines():
        words=line.split()
        if len(words)==3 and words[1] in LAUNCH_HOST_KEY_TYPES:
            try:launch_host_key(' '.join(words[1:]));keys.setdefault(words[1],words[2])
            except LaunchRefused:continue
    kind=next((k for k in LAUNCH_HOST_KEY_TYPES if k in keys),None)
    if kind is None:launch_refuse('HOST_KEY_UNAVAILABLE')
    alias=launch_known_name(name,port)
    digest=__import__('base64').b64encode(hashlib.sha256(__import__('base64').b64decode(keys[kind])).digest()).decode().rstrip('=')
    launch_answer({'hostKeyLine':'%s %s %s'%(alias,kind,keys[kind]),'sha256':'SHA256:'+digest,'keyType':kind})
LAUNCH_PROCESS_NAME=re.compile(r'[A-Za-z0-9][A-Za-z0-9._:+-]{0,31}')
def launch_port_users_ss(port):
    """Process names holding a listening TCP socket on `port`, from `ss -ltnpH` (iproute2). None when ss is missing or fails."""
    if not shutil.which('ss',path=LAUNCH_PATH):return None
    try:
        code,stdout,_=launch_exec(['ss','-ltnpH','sport = :%d'%port],15)
    except Exception:return None
    if code!=0:return None
    names=[];listening=False
    for line in stdout.decode('utf-8','replace').splitlines()[:200]:
        fields=line.split()
        if len(fields)<4:continue
        local=fields[3] if fields[0]=='LISTEN' else fields[2]
        if not local.endswith(':%d'%port):continue
        listening=True
        found=re.findall(r'\(\("([^"]{1,64})",pid=\d+',line)
        names+=found or ['']  # a listener whose process ss cannot show counts as another program
    return names if listening else []
def launch_port_users_proc(port):
    """Fallback without ss: listening sockets on `port` from /proc/net/tcp{,6}, mapped to processes through /proc/*/fd."""
    inodes=set()
    for name in ('/proc/net/tcp','/proc/net/tcp6'):
        try:lines=pathlib.Path(name).read_text().splitlines()[1:]
        except OSError:continue
        for line in lines:
            parts=line.split()
            if len(parts)>9 and parts[3]=='0A':
                try:
                    if int(parts[1].rsplit(':',1)[1],16)==port:inodes.add(parts[9])
                except ValueError:pass
    if not inodes:return []
    names=[]
    try:pids=[entry for entry in os.listdir('/proc') if entry.isdigit()]
    except OSError:return ['']
    for pid in pids[:65536]:
        try:fds=os.listdir('/proc/%s/fd'%pid)
        except OSError:continue
        for fd in fds:
            try:link=os.readlink('/proc/%s/fd/%s'%(pid,fd))
            except OSError:continue
            if link.startswith('socket:[') and link[8:-1] in inodes:
                try:names.append(pathlib.Path('/proc/%s/comm'%pid).read_text().strip())
                except OSError:names.append('')
                break
    return names or ['']  # a listener whose process cannot be read counts as another program
def launch_port_holder(port,ports):
    """Who holds `port`: {port, holder: 'none'|'nginx'|'other', process?}. Only the process name (never a command line,
    which can hold secrets). Ports Docker publishes are 'other': named docker-proxy when that process was seen, unnamed
    when only a NAT rule publishes them."""
    names=launch_port_users_ss(port)
    if names is None:names=launch_port_users_proc(port)
    if not names:
        return {'port':port,'holder':'other'} if port in ports else {'port':port,'holder':'none'}  # published by Docker without a socket: no name
    clean=[n for n in names if LAUNCH_PROCESS_NAME.fullmatch(n or '')]
    other=[n for n in clean if n!='nginx']
    if clean and not other and len(clean)==len(names):return {'port':port,'holder':'nginx','process':'nginx'}
    return {'port':port,'holder':'other',**({'process':other[0]} if other else {})}
def launch_facts_op(req):
    """Read-only facts for Check. Never returns environment values, Compose text or key material."""
    lid,slug=launch_ids(req);domain=launch_domain(req);names=launch_names(req,domain)
    docker_version=tool_version(['docker','version','--format','{{.Server.Version}}'])
    compose_text,compose_ok=launch_compose_version() if docker_version else (None,False)
    git_text,git_ok=launch_git_version()
    buildx=tool_version(['docker','buildx','version']) if docker_version else None
    nginx=bool(shutil.which('nginx',path=LAUNCH_PATH));certbot=bool(shutil.which('certbot',path=LAUNCH_PATH))
    osr=os_release();manager=package_manager(osr['id'])
    existing=next((p for p in [LAUNCH_SITES,*LAUNCH_SITES.parents] if p.exists()),pathlib.Path('/'))
    free=shutil.disk_usage(existing).free
    ports=listening_ports()
    checks=[]
    def check(cid,ok,code=None,install=None):
        item={'id':cid,'ok':bool(ok)}
        if not ok:
            item['code']=code;item['reason']=LAUNCH_REASONS[code]
            if install and install_supported(manager,osr['id'],osr['versionId'],install):item['install']=install
        checks.append(item)
    check('docker',docker_version,'DOCKER_MISSING','docker')
    check('compose',compose_ok,'COMPOSE_TOO_OLD' if compose_text else 'COMPOSE_TOOL_MISSING',None if compose_text else 'compose')
    check('nginx',nginx,'NGINX_MISSING','nginx')
    check('certbot',certbot,'CERTBOT_MISSING','certbot')
    check('disk',free>=2*LAUNCH_SPACE_MARGIN,'DISK_FULL')
    check('siteFolder',not (launch_site(slug).exists() or launch_site(slug).is_symlink()),'SITE_EXISTS')
    project=[]
    if docker_version:
        try:project=launch_docker_lines('ps','-aq','--filter','label=com.docker.compose.project='+slug)
        except ValueError:project=[]
    check('project',not project,'PROJECT_EXISTS')
    conflicts=[];lineages=[];warnings=[]
    if nginx:
        try:
            blocks=launch_server_blocks(launch_nginx_dump())
            conflicts=launch_nginx_conflicts(list(dict.fromkeys(names+['www.'+domain])),blocks=blocks);check('nginxDomain',not conflicts,'NGINX_DOMAIN_SERVED')
            warnings+=[{'code':'NGINX_IP_LISTEN','listen':value} for value in launch_ip_listens(blocks)]
        except LaunchRefused as error:check('nginxDomain',False,error.code)
    lineages=launch_lineage_conflicts(names,'docknest-'+slug)
    check('certLineage',not lineages,'CERT_LINEAGE_EXISTS')
    facts={'tools':{'docker':bool(docker_version),'compose':bool(compose_text),'git':bool(git_text),'nginx':nginx,'certbot':certbot,'buildx':bool(buildx)},
        'versions':{'docker':docker_version,'compose':compose_text,'git':git_text,'gitMinimum':'%d.%d.%d'%LAUNCH_GIT_MIN,'buildx':buildx},
        'os':osr,'packageManager':manager,'freeBytes':free,'usedPorts':sorted(int(p) for p in ports),
        'ports':{str(p):launch_port_holder(p,ports) for p in (80,443)},
        'nginxDomains':conflicts,'certLineages':lineages,'dnsAnswers':launch_dns(domain),'serverIps':host_addresses(),'checks':checks,'warnings':warnings}
    if req.get('source')=='git':
        check('git',git_text,'GIT_MISSING','git')
        if git_text:check('gitVersion',git_ok,'GIT_TOO_OLD')
        if git_ok:
            folder=None
            try:
                repo,ref,allow=launch_repo(req)
                target=launch_git_target(repo,allow)
                LAUNCH_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
                folder=LAUNCH_ROOT/('check-'+uuid.uuid4().hex);folder.mkdir(mode=0o700)
                facts['refHead']=launch_ls_remote(folder,repo,ref,target,req.get('deployKey'))
                check('repo',True)
            except LaunchRefused as error:check('repo',False,error.code)
            finally:
                if folder is not None:shutil.rmtree(folder,ignore_errors=True)
    elif req.get('source')=='compose' and isinstance(req.get('composeText'),str) and compose_ok:
        web=req.get('webService') if isinstance(req.get('webService'),str) else None
        services,code,gate,name=launch_paste_services(lid,slug,req['composeText'],web)
        facts['services']=services
        if gate is not None:facts['gate']=gate;facts['composeName']=name
        check('compose-file',code is None,code)
    launch_answer(facts)
def launch_paste_services(lid,slug,text,web=None):
    """Services, ports, the gate verdict and the top-level name of a pasted Compose file, read in a private folder that
    is removed right after (the folder stands in for the site folder). (services, refusal code, gate, composeName)."""
    data=text.encode('utf-8')
    problem=launch_compose_text_problem(data)
    if problem:return [],problem,None,None
    LAUNCH_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
    folder=LAUNCH_ROOT/('check-'+uuid.uuid4().hex);folder.mkdir(mode=0o700)
    try:
        compose=folder/'compose.yaml';env=folder/'.env'
        launch_private_write(compose,data);launch_private_write(env,b'')
        try:model=launch_model(slug,[compose],folder,env)
        except LaunchRefused as error:return [],error.code,None,None
        try:refusals=launch_checks(model,lid,slug,str(folder),str(folder),web,(str(compose),str(env)))
        except LaunchRefused as error:refusals=[{'code':error.code,'service':None,'field':None}]
        name=model.get('name') if isinstance(model.get('name'),str) and model.get('name')!=slug else None
        return launch_services(model),None,{'ok':not refusals,'refusals':refusals[:50]},name
    finally:shutil.rmtree(folder,ignore_errors=True)
def launch_fetch_op(req):
    lid,slug=launch_ids(req);launch_root_user()
    source=req.get('source')
    if source not in ('compose','git'):launch_refuse('INVALID_REQUEST')
    env=launch_env_values(req.get('env'))
    lock=launch_lock()
    try:
        site=launch_site(slug)
        if LAUNCH_SITES.is_symlink() or (LAUNCH_SITES.exists() and os.path.realpath(LAUNCH_SITES)!=os.path.abspath(LAUNCH_SITES)):launch_refuse('PATH_REFUSED')
        if site.exists() or site.is_symlink():launch_refuse('SITE_EXISTS')
        version,compose_ok=launch_compose_version()
        if not version:launch_refuse('COMPOSE_TOOL_MISSING')
        if not compose_ok:launch_refuse('COMPOSE_TOO_OLD')
        if source=='git':
            repo,ref,allow=launch_repo(req)
            raw=req.get('repo') or {};compose_rel=raw.get('composePath') or 'compose.yaml'
            if not isinstance(compose_rel,str) or not LAUNCH_COMPOSE_PATH.fullmatch(compose_rel) or compose_rel.startswith(('/','-')) or any(p in ('','.','..') or p.startswith('-') for p in compose_rel.split('/')):launch_refuse('COMPOSE_PATH_INVALID')
            git_text,git_ok=launch_git_version()
            if not git_text:launch_refuse('GIT_MISSING')
            if not git_ok:launch_refuse('GIT_TOO_OLD')
            target=launch_git_target(repo,allow)  # resolved and checked again here: DNS rebinding since Check is caught
        LAUNCH_SITES.mkdir(parents=True,exist_ok=True,mode=0o755)
        if shutil.disk_usage(LAUNCH_SITES).free<2*LAUNCH_SPACE_MARGIN:launch_refuse('DISK_FULL')
        d,journal=launch_journal(lid,slug,create=True)
        if journal.get('files'):launch_refuse('SITE_EXISTS')
        repo_root=site/'app';commit=None
        if source=='git':
            journal['phase']='fetching';launch_record(d,journal,'paths',str(site))
            site.mkdir(mode=0o755)
            argv_tail=['clone','--depth','1','--single-branch','--no-recurse-submodules']+(['--branch',ref] if ref else [])+['--',target['url'],str(repo_root)]
            def clone(ssh):
                code,_,tail,why=launch_watch(launch_git_argv(launch_git_home(d),target,ssh,argv_tail),{},LAUNCH_CLONE_SECONDS,folder=str(site),limit=LAUNCH_CLONE_LIMIT,cwd=str(d),journal=(d,journal))
                if code!=0:launch_refuse(launch_git_failure(tail,why))
            launch_with_key(d,repo,target,req.get('deployKey'),clone,(d,journal))
            code,stdout,_=launch_exec(['env','-i',*launch_git_env(launch_git_home(d)),'GIT_DIR='+str(repo_root/'.git'),'git',*LAUNCH_GIT_CONFIG,'-C',str(repo_root),'rev-parse','HEAD'],30,env={},cwd=str(repo_root))
            commit=stdout.decode('utf-8','replace').strip()
            if code!=0 or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}',commit):launch_refuse('FETCH_FAILED')
            journal['commit']=commit;launch_save(d,journal)
            if (repo_root/'.gitmodules').exists():launch_refuse('SUBMODULES_REFUSED')
            if launch_symlink_escape(str(repo_root)):launch_refuse('SYMLINK_ESCAPE')
            if launch_lfs(str(repo_root)):launch_refuse('LFS_REFUSED')
            shutil.rmtree(repo_root/'.git')  # after the commit is recorded
            compose=repo_root/compose_rel
            if not os.path.lexists(compose):launch_refuse('COMPOSE_MISSING')
            if not launch_inside(compose,repo_root) or not os.path.isfile(compose):launch_refuse('COMPOSE_PATH_INVALID')
            with open(compose,'rb') as handle:data=handle.read(LAUNCH_COMPOSE_LIMIT+1)
        else:
            text=req.get('composeText')
            if not isinstance(text,str) or not text.strip():launch_refuse('COMPOSE_MISSING')
            data=text.encode('utf-8')
            problem=launch_compose_text_problem(data)
            if problem:launch_refuse(problem)
            journal['phase']='fetching';launch_record(d,journal,'paths',str(site))
            site.mkdir(mode=0o755);repo_root.mkdir(mode=0o755)
            compose=repo_root/'compose.yaml';launch_private_write(compose,data)
        problem=launch_compose_text_problem(data)
        if problem:launch_refuse(problem)
        strip_privileges(str(site))
        env_file=site/'.env'
        launch_private_write(env_file,''.join('%s=%s\n'%(k,launch_env_quote(v)) for k,v in env.items()).encode('utf-8'))
        project_dir=pathlib.Path(compose).parent
        model=launch_model(slug,[compose],project_dir,env_file)
        refusals=launch_checks(model,lid,slug,str(site),str(repo_root),req.get('webService') if isinstance(req.get('webService'),str) else None,(str(compose),str(env_file)))
        journal['files']={'compose':str(compose),'projectDir':str(project_dir),'repoRoot':str(repo_root),'envFile':str(env_file)}
        journal['phase']='fetched';launch_save(d,journal)
        result={'commit':commit,'services':launch_services(model),'composeName':model.get('name') if isinstance(model.get('name'),str) and model.get('name')!=slug else None,'gate':{'ok':not refusals,'refusals':refusals[:50]}}
        if refusals:emit(result={'ok':False,'code':'GATE_REFUSED','reason':LAUNCH_REASONS['GATE_REFUSED'],**result});return
        launch_answer(result)
    finally:
        if lock:lock.close()
def launch_build_override(lid,slug,model):
    lines=['# Written by DockNest launch %s.'%lid,'services:'];images=[]
    for name,service in model['services'].items():
        if service.get('build') is None:continue
        image=service.get('image') or '%s-%s'%(slug,name);images.append(image)
        lines+=['  %s:'%json.dumps(name),'    image: %s'%json.dumps(image),'    build:','      labels:','        docknest.launch: %s'%json.dumps(lid)]
    return '\n'.join(lines)+'\n',images
def launch_image_label(image):
    code,stdout,_=launch_exec(['docker','image','inspect','--format','{{json .Config.Labels}}',image],60)
    if code!=0:return None,False
    try:labels=json.loads(stdout) or {}
    except ValueError:labels={}
    return labels.get('docknest.launch'),True
def launch_build_op(req):
    lid,slug=launch_ids(req);launch_root_user()
    lock=launch_lock()
    try:
        d,journal=launch_existing(lid,slug)
        site,files=launch_layout(journal)
        model=launch_model(slug,[files['compose']],files['projectDir'],files['envFile'])
        refusals=launch_build_problems(model,files['repoRoot'],slug)
        if refusals:emit(result={'ok':False,'code':refusals[0]['code'],'reason':LAUNCH_REASONS[refusals[0]['code']],'gate':{'ok':False,'refusals':refusals}});return
        text,images=launch_build_override(lid,slug,model)
        if not images:launch_answer({'images':[]});return
        if not tool_version(['docker','buildx','version']):launch_refuse('BUILDX_MISSING')
        if shutil.disk_usage(site).free<2*LAUNCH_SPACE_MARGIN:launch_refuse('DISK_FULL')
        for image in images:
            owner,present=launch_image_label(image)
            if present and owner!=lid:launch_refuse('IMAGE_EXISTS')
        override=site/'compose.docknest-build.yaml'
        override.unlink(missing_ok=True);launch_private_write(override,text.encode())
        builder='docknest-launch-'+lid.replace('-','')[:12]
        journal['phase']='building';launch_record(d,journal,'builders',builder)
        for image in images:launch_record(d,journal,'images',image)
        try:
            # buildx may still allow the network.host entitlement on this builder (0.13 and later do by default). The controls
            # are that no build can ask for it: the Dockerfile allow-list (RUN --network=default|none, --security=sandbox, no
            # variables) and the build allow-list (no network or entitlements keys); nothing passes --allow to the build.
            code,_,_=launch_exec(['docker','buildx','create','--name',builder,'--driver','docker-container','--driver-opt','image='+LAUNCH_BUILDKIT_IMAGE,'--bootstrap'],600,journal=(d,journal))
            if code!=0:launch_refuse('BUILD_FAILED')
            argv=launch_compose_base(slug,[files['compose'],override],files['projectDir'],files['envFile'])+['build','--builder',builder]
            code,_,tail,why=launch_watch(argv,launch_env(),LAUNCH_BUILD_SECONDS,journal=(d,journal))
            if why=='timeout':launch_refuse('BUILD_TIMEOUT')
            if code!=0:launch_refuse('IMAGE_NO_ARCH' if 'no match for platform' in tail or 'exec format error' in tail else 'BUILD_FAILED')
        finally:launch_exec(['docker','buildx','rm',builder],120)
        for image in images:
            owner,present=launch_image_label(image)
            if not present or owner!=lid:launch_refuse('BUILD_FAILED')  # built images must be loaded into the engine
        journal['phase']='built';launch_save(d,journal)
        launch_answer({'images':images})
    finally:
        if lock:lock.close()
def launch_start_override(lid,model,web_service,web_port,loopback):
    lines=['# Written by DockNest launch %s.'%lid,'services:']
    for name in model['services']:
        lines+=['  %s:'%json.dumps(name),'    labels:','      docknest.launch: %s'%json.dumps(lid)]
        if name==web_service:lines+=['    ports: !override','      - %s'%json.dumps('127.0.0.1:%d:%d'%(loopback,web_port))]
    for kind in ('volumes','networks'):
        keys=list(model.get(kind) or {})
        if keys:lines.append('%s:'%kind)
        for key in keys:lines+=['  %s:'%json.dumps(key),'    labels:','      docknest.launch: %s'%json.dumps(lid)]
    return '\n'.join(lines)+'\n'
def launch_start_op(req):
    lid,slug=launch_ids(req);launch_root_user()
    web=req.get('webService');web_port=launch_port(req.get('webPort'));loopback=launch_port(req.get('loopbackPort'),1024)
    lock=launch_lock()
    try:
        d,journal=launch_existing(lid,slug)
        site,files=launch_layout(journal)
        model=launch_model(slug,[files['compose']],files['projectDir'],files['envFile'])
        if not isinstance(web,str) or web not in model['services']:launch_refuse('WEB_SERVICE_INVALID')
        # Binds are resolved again at start (item 4): the checks run on the files as they are now.
        refusals=launch_checks(model,lid,slug,str(site),files['repoRoot'],web,(files['compose'],files['envFile']))
        if refusals:emit(result={'ok':False,'code':'GATE_REFUSED','reason':LAUNCH_REASONS['GATE_REFUSED'],'gate':{'ok':False,'refusals':refusals[:50]}});return
        own=launch_docker_lines('ps','-aq','--filter','label=docknest.launch='+lid)
        if loopback in listening_ports() and not own:launch_refuse('PORT_IN_USE')
        override=site/'compose.docknest.yaml'
        override.unlink(missing_ok=True);launch_private_write(override,launch_start_override(lid,model,web,web_port,loopback).encode())
        names=launch_resolved_names(model,slug)
        journal['phase']='starting'
        for kind in ('containers','volumes','networks'):
            for name in names[kind]:launch_record(d,journal,kind,name)
        journal['web']={'service':web,'port':web_port,'loopbackPort':loopback};launch_save(d,journal)
        argv=launch_compose_base(slug,[files['compose'],override],files['projectDir'],files['envFile'])+['up','-d','--no-build']
        code,_,tail,why=launch_watch(argv,launch_env(),LAUNCH_UP_SECONDS,journal=(d,journal))
        if code!=0:
            if 'no matching manifest' in tail or 'no match for platform' in tail:launch_refuse('IMAGE_NO_ARCH')
            if 'port is already allocated' in tail or 'address already in use' in tail:launch_refuse('PORT_IN_USE')
            launch_refuse('START_FAILED')
        journal['phase']='started';launch_save(d,journal)
        launch_answer({'containers':launch_docker_lines('ps','-aq','--no-trunc','--filter','label=docknest.launch='+lid),'containerNames':names['containers'],'composeFiles':[files['compose'],str(override)]})
    finally:
        if lock:lock.close()
def launch_started_at(text):
    match=re.match(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)',str(text or ''))
    if not match or match[1].startswith('0001'):return None
    return __import__('calendar').timegm(time.strptime(match[1],'%Y-%m-%dT%H:%M:%S'))
def launch_poll_op(req):
    """One look, no loop: the worker ticks again. The restore test "passed" rules, then HTTP on the loopback port."""
    lid,slug=launch_ids(req);loopback=launch_port(req.get('loopbackPort'),1024);domain=req.get('domain')
    host=domain if isinstance(domain,str) and LAUNCH_DOMAIN.fullmatch(domain) else '127.0.0.1'
    def answer(state,reason=None,**extra):launch_answer({'state':state,**({'reason':reason} if reason else {}),**extra})
    ids=launch_docker_lines('ps','-aq','--no-trunc','--filter','label=docknest.launch='+lid)
    if not ids:return answer('failed','NO_CONTAINERS')
    web=(launch_journal(lid,slug)[1].get('web') or {}).get('service')
    now=time.time();youngest=None
    for c in inspect(ids):
        state=c.get('State') or {};labels=(c.get('Config') or {}).get('Labels') or {}
        service=labels.get('com.docker.compose.service')
        if state.get('Restarting'):return answer('waiting','RESTARTING',service=service)
        if int(c.get('RestartCount') or 0)>=3:return answer('failed','CRASH_LOOP',service=service)
        if not state.get('Running'):
            if state.get('ExitCode')==0 and service!=web:continue  # a one-shot service that finished
            return answer('failed','SERVICE_STOPPED',service=service,exitCode=state.get('ExitCode'))
        health=(state.get('Health') or {}).get('Status')
        if health=='unhealthy':return answer('failed','UNHEALTHY',service=service)
        if health=='starting':return answer('waiting','HEALTH_STARTING',service=service)
        started=launch_started_at(state.get('StartedAt'))
        if started is not None:youngest=max(youngest or 0,started)
    try:status,_=loopback_probe(loopback,host,'/',10)
    except Exception:return answer('waiting','NO_ANSWER')
    if status>=500:return answer('waiting','HTTP_ERROR',httpStatus=status)
    if youngest is not None and now-youngest<LAUNCH_STABLE_SECONDS:return answer('waiting','SETTLING',httpStatus=status)
    answer('passed',httpStatus=status)
def launch_web_op(req):
    lid,slug=launch_ids(req);launch_root_user();domain=launch_domain(req);names=launch_names(req,domain)
    loopback=launch_port(req.get('loopbackPort'),1024)
    if not shutil.which('nginx',path=LAUNCH_PATH):launch_refuse('NGINX_MISSING')
    lock=launch_lock()
    try:
        d,journal=launch_existing(lid,slug)
        path=launch_nginx_path(slug)
        if launch_nginx_conflicts(names,(path.name,LAUNCH_HEADER%lid)):launch_refuse('NGINX_DOMAIN_SERVED')
        journal['phase']='web';journal['domain']={'names':names,'loopbackPort':loopback};launch_save(d,journal)
        path=launch_write_nginx(d,journal,lid,slug,names,loopback)
        launch_answer({'file':str(path)})
    finally:
        if lock:lock.close()
LAUNCH_MAINTENANCE_ROOT=pathlib.Path('/var/lib/docknest/maintenance')
def launch_maintenance_dir(value):
    """None, or exactly <LAUNCH_MAINTENANCE_ROOT>/<site id> with no symbolic link anywhere on the path."""
    if value is None:return None
    if not isinstance(value,str):launch_refuse('INVALID_REQUEST')
    name=value[len(str(LAUNCH_MAINTENANCE_ROOT))+1:] if value.startswith(str(LAUNCH_MAINTENANCE_ROOT)+'/') else ''
    if not LAUNCH_UUID.fullmatch(name):launch_refuse('INVALID_REQUEST')
    path=LAUNCH_MAINTENANCE_ROOT/name;current=pathlib.Path(path.anchor)
    for part in path.parts[1:]:
        current=current/part
        if os.path.islink(current):launch_refuse('INVALID_REQUEST')
    return path
def launch_certificate_op(req):
    lid,slug=launch_ids(req);launch_root_user();domain=launch_domain(req);names=launch_names(req,domain)
    maintenance=launch_maintenance_dir(req.get('maintenanceDirectory'))
    cert_name='docknest-'+slug
    email=req.get('email')
    if email is not None and (not isinstance(email,str) or not LAUNCH_EMAIL.fullmatch(email)):launch_refuse('INVALID_REQUEST')
    lock=launch_lock()
    try:
        d,journal=launch_existing(lid,slug)
        web=journal.get('domain') or {}
        if not journal['created']['nginx'] or not isinstance(web.get('loopbackPort'),int):launch_refuse('NO_WEB')
        # The names nginx serves (journalled by launch-web) are the names certbot asks for.
        if isinstance(web.get('names'),list) and web['names'] and all(isinstance(n,str) and LAUNCH_DOMAIN.fullmatch(n) for n in web['names']):names=web['names']
        def state(value,code=None):launch_answer({'state':value,'certName':cert_name,**({'code':code,'reason':LAUNCH_REASONS[code]} if code else {})})
        if not shutil.which('certbot',path=LAUNCH_PATH):return state('failed','CERTBOT_MISSING')
        own=[c['name'] for c in journal['created']['certificates']]
        if launch_lineage_conflicts(names,cert_name,own):launch_refuse('CERT_LINEAGE_EXISTS')
        ips=set(host_addresses())|{a for a in req.get('serverIps') or [] if isinstance(a,str) and len(a)<=45}
        for host in names:
            answers=launch_dns(host)
            if not set(answers['A']+answers['AAAA'])&ips:return state('dns_waiting','DNS_WAITING')
        account=(LETSENCRYPT/'accounts').is_dir()
        if not account and not email:return state('failed','NO_ACCOUNT_EMAIL')
        if cert_name not in own:launch_record(d,journal,'certificates',{'name':cert_name})
        acme=ACME_ROOT/('launch-'+lid)
        argv=['certbot','certonly','--webroot','-w',str(acme),'--non-interactive','--keep-until-expiring','--cert-name',cert_name]+[p for h in names for p in ['-d',h]]
        if not account:argv+=['--agree-tos','--no-eff-email','--email',email]
        code,_,tail=launch_exec(argv,300)
        if code!=0:
            failure=launch_certbot_failure(tail)
            return state('dns_waiting' if failure=='DNS_WAITING' else 'failed',failure)
        live=LETSENCRYPT/'live'/cert_name
        launch_write_nginx(d,journal,lid,slug,names,web['loopbackPort'],{'cert':str(live/'fullchain.pem'),'key':str(live/'privkey.pem')})
        journal['phase']='certificate';launch_save(d,journal)
        # The rewritten file has no maintenance include yet: removing `ready` makes the engine run the maintenance setup
        # (2.13) again, which adds it back. Only a regular file is removed, never through a link.
        reset=False
        if maintenance is not None:
            ready=maintenance/'ready'
            if os.path.islink(ready):launch_refuse('INVALID_REQUEST')
            if ready.is_file():ready.unlink();reset=True
        launch_answer({'state':'issued','certName':cert_name,'maintenanceReset':reset})
    finally:
        if lock:lock.close()
def launch_present(lid,journal):
    """What the journal lists that still exists on this server (label-confirmed for Docker objects)."""
    created=journal['created'];label='label=docknest.launch='+lid;present=[]
    for path in created['paths']+created['keys']:
        if os.path.lexists(path):present.append({'kind':'path','name':path})
    try:
        present+=[{'kind':'container','name':n} for n in launch_docker_lines('ps','-a','--filter',label,'--format','{{.Names}}')]
        for kind,listing in (('volume',['volume','ls','-q','--filter',label]),('network',['network','ls','--filter',label,'--format','{{.Name}}'])):
            owned=set(launch_docker_lines(*listing))
            present+=[{'kind':kind,'name':n} for n in created[kind+'s'] if n in owned]
        for image in created['images']:
            owner,there=launch_image_label(image)
            if there and owner==lid:present.append({'kind':'image','name':image})
        for builder in created['builders']:
            if launch_exec(['docker','buildx','inspect',builder],60)[0]==0:present.append({'kind':'builder','name':builder})
    except ValueError:present.append({'kind':'docker','name':'unreadable'})
    for path in created['nginx']:
        if os.path.isfile(path):present.append({'kind':'nginx','name':path})
    for item in created['certificates']:
        if (LETSENCRYPT/'live'/item['name']).exists():present.append({'kind':'certificate','name':item['name']})
    return present
def launch_remove_path(path,slug,lid):
    """Only the launch's own folders: the site folder, its ACME folder and key files in its journal folder."""
    allowed=[str(launch_site(slug)),str(ACME_ROOT/('launch-'+lid))]
    in_journal=os.path.dirname(path)==str(launch_dir(lid)) and os.path.basename(path).startswith(('key-','known-hosts-'))
    if path not in allowed and not in_journal:return False
    if os.path.islink(path) or os.path.isfile(path):os.unlink(path)
    elif os.path.isdir(path):
        if os.name=='posix' and not getattr(shutil.rmtree,'avoids_symlink_attacks',False):return False
        shutil.rmtree(path)
    return True
def launch_teardown_op(req):
    """Removes only what the journal lists and the docknest.launch label confirms. Idempotent: a second run finds
    nothing left and says so. Backups are never touched (they live in DockNest's storage, not on this server)."""
    lid,slug=launch_ids(req);launch_root_user()
    d=launch_dir(lid)
    if not (d/'journal.json').is_file():
        if d.is_dir() and not d.is_symlink():shutil.rmtree(d,ignore_errors=True)
        return launch_answer({'removed':[],'left':[],'nothingToDo':True,'keepBackup':True})
    lock=launch_lock()
    try:
        d,journal=launch_journal(lid,slug);created=journal['created'];label='label=docknest.launch='+lid
        removed=[];left=[]
        for pgid in launch_kill_recorded(journal):removed.append({'kind':'process-group','name':str(pgid)})
        launch_save(d,journal)
        def attempt(kind,name,argv):
            code=launch_exec(argv,300)[0]
            (removed if code==0 else left).append({'kind':kind,'name':name})
        ids=launch_docker_lines('ps','-aq','--filter',label)
        if ids:attempt('containers',str(len(ids)),['docker','rm','-f','-v',*ids])
        for builder in created['builders']:
            if launch_exec(['docker','buildx','inspect',builder],60)[0]==0:attempt('builder',builder,['docker','buildx','rm',builder])
        for path in created['nginx']:
            p=pathlib.Path(path)
            if p.is_file() and not p.is_symlink() and p.read_text(errors='replace').startswith(LAUNCH_HEADER%lid):
                p.unlink();removed.append({'kind':'nginx','name':path})
                if not launch_nginx_reload():left.append({'kind':'nginx-reload','name':path})
        for item in created['certificates']:
            name=item['name']
            if name=='docknest-'+slug and (LETSENCRYPT/'live'/name).exists():
                attempt('certificate',name,['certbot','delete','--cert-name',name,'--non-interactive'])
                if launch_exec(['nginx','-t'],60)[0]!=0:left.append({'kind':'nginx-test','name':name})
        for kind,listing,remove in (('networks',['network','ls','--filter',label,'--format','{{.Name}}'],'network'),('volumes',['volume','ls','-q','--filter',label],'volume')):
            owned=set(launch_docker_lines(*listing))
            for name in reversed(created[kind]):
                if name in owned:attempt(kind[:-1],name,['docker',remove,'rm',name])
        for image in created['images']:
            owner,present=launch_image_label(image)
            if present and owner==lid:attempt('image',image,['docker','image','rm',image])  # never -f
            elif present:left.append({'kind':'image-not-ours','name':image})
        for path in list(reversed(created['paths']))+created['keys']:
            if not os.path.lexists(path):continue
            try:ok=launch_remove_path(path,slug,lid)
            except OSError:ok=False
            (removed if ok else left).append({'kind':'path','name':path})
        if not left:
            shutil.rmtree(d,ignore_errors=True)
        else:
            journal['phase']='teardown_incomplete';launch_save(d,journal)
        launch_answer({'removed':removed,'left':left,'keepBackup':True})
    finally:
        if lock:lock.close()
def launch_status_op(req):
    lid,slug=launch_ids(req)
    d=launch_dir(lid)
    if not (d/'journal.json').is_file():return launch_answer({'journal':False,'present':[],'phase':None})
    d,journal=launch_journal(lid,slug)
    # While no step holds the launch lock, process groups a killed step recorded are ended (recovery after a restart).
    busy=False;killed=[]
    try:lock=launch_lock()
    except LaunchRefused:lock=None;busy=True
    try:
        if not busy and journal.get('children'):killed=launch_kill_recorded(journal);launch_save(d,journal)
    finally:
        if lock:lock.close()
    summary={kind:len(values) for kind,values in journal['created'].items()}
    phase=journal.get('phase')
    launch_answer({'journal':True,'phase':phase,'commit':journal.get('commit'),'counts':summary,'present':launch_present(lid,journal),'busy':busy,'killed':len(killed),
        'resumable':launch_resumable(journal,phase,busy)})
LAUNCH_RESUME={'fetched':['build','start'],'built':['start'],'started':['check_health','web'],'web':['certificate'],'certificate':[]}
def launch_resumable(journal,phase,busy):
    """The steps that can safely run next after a restart, or False (a step was cut off mid-way, so teardown decides)."""
    if busy or journal.get('children') or not isinstance(journal.get('files'),dict) or phase not in LAUNCH_RESUME:return False
    return list(LAUNCH_RESUME[phase])
LAUNCH_HOST_KEY_CODES={'URL_PRIVATE':'PRIVATE_ADDRESS','URL_METADATA':'REFUSED_ADDRESS','URL_REFUSED':'REFUSED_ADDRESS','HOST_KEY_UNAVAILABLE':'CONNECT_FAILED','SSH_MISSING':'CONNECT_FAILED'}
def launch_host_key_mapped(req):
    """launch-host-key answers with the backend's codes: PRIVATE_ADDRESS, REFUSED_ADDRESS, DNS_FAILED, CONNECT_FAILED."""
    try:launch_host_key_op(req)
    except LaunchRefused as error:raise LaunchRefused(LAUNCH_HOST_KEY_CODES.get(error.code,error.code))
def launch_host_key_entry(req):launch_entry(req,launch_host_key_mapped)
def launch_facts(req):launch_entry(req,launch_facts_op)
def launch_fetch(req):launch_entry(req,launch_fetch_op)
def launch_build(req):launch_entry(req,launch_build_op)
def launch_start(req):launch_entry(req,launch_start_op)
def launch_poll(req):launch_entry(req,launch_poll_op)
def launch_web(req):launch_entry(req,launch_web_op)
def launch_certificate(req):launch_entry(req,launch_certificate_op)
def launch_teardown(req):launch_entry(req,launch_teardown_op)
def launch_status(req):launch_entry(req,launch_status_op)
