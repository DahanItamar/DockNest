# helper/install.py: Fixed-argv package installation (nginx, Docker, Compose, certbot).
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    emit)
from .move import (
    listening_ports, tool_version)
# </build:header>
# ---- Install on server (src/installs.js asks, this table decides). Distro packages only: no repositories are added, no
# scripts are downloaded, no config files are edited and nothing is removed (apt runs with --no-remove). DockNest sends
# only a package NAME; the argv below is fixed here and runs without a shell. Failures raise InstallError with a short
# CODE; src/install-plan.js turns each known code into a fixed sentence. Raw exception text and tool output never leave.
INSTALL_PLAN_JSON=r'''{"apt":{"nginx":["nginx"],"certbot":["certbot","python3-certbot-nginx"],"docker":["docker.io"],"compose":["docker-compose-v2"]},"dnf":{"nginx":["nginx"],"certbot":["certbot","python3-certbot-nginx"],"docker":["moby-engine"],"compose":[]}}'''
INSTALL_PLAN=json.loads(INSTALL_PLAN_JSON)
INSTALL_NAMES={'nginx':'nginx','docker':'Docker','compose':'Docker Compose','certbot':'certbot'}
# Packages from any source that mean the tool is already on the server. Never install over them.
INSTALL_PRESENT={'nginx':['nginx','nginx-core','nginx-full','nginx-light','nginx-extras'],'docker':['docker.io','docker-ce','docker-ce-cli','containerd.io','moby-engine','docker-engine','podman-docker'],'compose':['docker-compose-v2','docker-compose-plugin','docker-compose'],'certbot':['certbot']}
INSTALL_VERIFY={'nginx':[['nginx','-v'],['nginx','-t']],'docker':[['docker','version','--format','{{.Server.Version}}']],'compose':[['docker','compose','version']],'certbot':[['certbot','--version']]}
INSTALL_SERVICES={'nginx':'nginx','docker':'docker'}
INSTALL_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
INSTALL_UPDATE_TIMEOUT=300
INSTALL_TIMEOUT=900
INSTALL_KILL_WAIT=60
INSTALL_LOCK_PATH='/run/docknest-install.lock'
class InstallError(ValueError):
    """The message is a short code (see INSTALL_ERRORS in src/install-plan.js), never free text."""
def systemd_present():return pathlib.Path('/run/systemd/system').is_dir()
def os_release():
    values={'id':'','versionId':''}
    try:text=pathlib.Path('/etc/os-release').read_text(errors='replace')
    except OSError:return values
    for line in text.splitlines()[:100]:
        key,separator,value=line.partition('=')
        value=value.strip().strip('"').strip("'").lower()
        if not separator:continue
        if key=='ID' and re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,39}',value):values['id']=value
        elif key=='VERSION_ID' and re.fullmatch(r'[0-9][0-9.]{0,19}',value):values['versionId']=value
    return values
def package_manager(os_id):
    if os_id in ('debian','ubuntu'):return 'apt' if shutil.which('apt-get') else None
    if os_id in ('fedora','rhel','rocky','almalinux'):return 'dnf' if shutil.which('dnf') else None
    return None
def version_at_least(text,major,minor):
    match=re.match(r'(\d+)(?:\.(\d+))?',text or '')
    if not match:return False
    return (int(match.group(1)),int(match.group(2) or 0))>=(major,minor)
def install_supported(manager,os_id,version_id,name):
    """Keep in step with installSupported() in src/install-plan.js."""
    if manager not in INSTALL_PLAN or not INSTALL_PLAN[manager].get(name):return False
    if manager=='apt':
        if os_id not in ('debian','ubuntu'):return False
        if name=='compose':return os_id=='ubuntu' and version_at_least(version_id,22,4)
        return True
    if manager=='dnf':
        if os_id not in ('fedora','rhel','rocky','almalinux'):return False
        return name=='nginx' or (os_id=='fedora' and name in ('certbot','docker'))
    return False
def package_known(manager,package):
    """True when the package manager says this package is installed (any source)."""
    if manager=='apt':
        code,tail=run_fixed(['dpkg-query','-W','-f=${Status}',package],30)
        return code==0 and 'install ok installed' in tail
    if manager=='dnf':
        code,_=run_fixed(['rpm','-q',package],30)
        return code==0
    return False
def package_installed(name,manager=None):
    # The binary on the PATH, or any package from any source (docker-ce, containerd.io ...): either means "already there".
    if name=='compose':
        if tool_version(['docker','compose','version','--short']) is not None:return True
    elif shutil.which(name) is not None:return True
    return bool(manager) and any(package_known(manager,package) for package in INSTALL_PRESENT[name])
def version_head(text):
    """'5:27.5.1-1' or '26.1.3+dfsg' -> '27.5' (major.minor), else None. Only digits are ever kept."""
    match=re.match(r'(?:\d+:)?(\d{1,3})\.(\d{1,3})',text or '')
    return '%s.%s'%(match.group(1),match.group(2)) if match else None
def install_candidates(manager):
    """The Docker version this system's own package sources offer (read only, no update, may be stale)."""
    result={}
    if manager=='apt':
        code,tail=run_fixed(['apt-cache','policy','docker.io'],30)
        match=re.search(r'candidate:\s*(\S+)',tail) if code==0 else None
        if match:result['docker']=version_head(match.group(1))
    elif manager=='dnf':
        code,tail=run_fixed(['dnf','-q','info','moby-engine'],60)
        match=re.search(r'^version\s*:\s*(\S+)',tail,re.M) if code==0 else None
        if match:result['docker']=version_head(match.group(1))
    return {key:value for key,value in result.items() if value}
def install_status():
    osr=os_release();manager=package_manager(osr['id'])
    emit(result={'os':osr,'packageManager':manager,'installed':{name:package_installed(name,manager) for name in INSTALL_NAMES},'candidates':install_candidates(manager)})
def stop_group(process):
    """SIGTERM to the process group, up to INSTALL_KILL_WAIT seconds to finish, then SIGKILL."""
    try:os.killpg(process.pid,signal.SIGTERM)
    except OSError:pass
    try:process.wait(timeout=INSTALL_KILL_WAIT)
    except subprocess.TimeoutExpired:
        try:os.killpg(process.pid,signal.SIGKILL)
        except OSError:pass
        process.wait()
def run_fixed(argv,timeout):
    """One fixed argv, no shell, its own process group. Output is kept as a short lower-case tail that only picks a plain message; it is never returned."""
    exe=shutil.which(argv[0],path=INSTALL_PATH)
    if exe is None:return 127,''
    env={'PATH':INSTALL_PATH,'DEBIAN_FRONTEND':'noninteractive','NEEDRESTART_SUSPEND':'1','LC_ALL':'C','HOME':'/root'}
    with tempfile.TemporaryFile() as output:
        process=subprocess.Popen([exe]+list(argv[1:]),stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,env=env,shell=False,close_fds=True,start_new_session=True)
        try:code=process.wait(timeout=max(30,timeout))
        except subprocess.TimeoutExpired:
            stop_group(process);return -1,''
        size=output.seek(0,2);output.seek(max(0,size-4000))
        return code,output.read().decode('utf-8','replace').lower()
def install_failure(code,tail,manager,step):
    """step is 'update' or 'install'. Returns a code from INSTALL_ERRORS."""
    if code==-1:return ('TIMEOUT_APT_' if manager=='apt' else 'TIMEOUT_')+step.upper()
    if 'could not get lock' in tail or 'unable to acquire the dpkg' in tail or 'waiting for cache lock' in tail or 'another instance' in tail:return 'PACKAGE_TOOL_BUSY'
    if 'unable to locate package' in tail or 'no match for argument' in tail or 'has no installation candidate' in tail:return 'NOT_OFFERED'
    if 'temporary failure resolving' in tail or 'could not resolve' in tail or 'failed to fetch' in tail or 'cannot download' in tail or 'failed to download' in tail:return 'NO_NETWORK'
    if 'no space left' in tail:return 'NO_SPACE'
    # apt --no-remove ends with "Packages need to be removed but remove is disabled"; the plan above it may be cut off.
    if 'packages will be removed' in tail or 'remove is disabled' in tail or 'unmet dependencies' in tail:return 'CONFLICT'
    return 'UPDATE_FAILED' if step=='update' else 'INSTALL_FAILED'
def verify_install(name):
    unit=INSTALL_SERVICES.get(name)
    if unit and systemd_present():
        code,_=run_fixed(['systemctl','enable','--now',unit],120)
        if code!=0:raise InstallError('SERVICE_NOT_STARTED')
    attempts=6 if name=='docker' else 1
    for command in INSTALL_VERIFY[name]:
        for attempt in range(attempts):
            code,_=run_fixed(command,60)
            if code==0:break
            if attempt==attempts-1:raise InstallError('VERIFY_FAILED')
            time.sleep(3)
def install_package(req):
    try:install_guarded(req)
    except InstallError:raise
    except Exception:raise InstallError('GENERIC')
def install_guarded(req):
    import fcntl
    name=req.get('package')
    if not isinstance(name,str) or name not in INSTALL_NAMES:raise InstallError('UNKNOWN_PACKAGE')
    emit(stage='connected')
    if os.geteuid()!=0:raise InstallError('NOT_ROOT')
    lock=open(INSTALL_LOCK_PATH,'a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise InstallError('LOCKED')
    try:install_locked(name)
    finally:lock.close()
def install_locked(name):
    osr=os_release();manager=package_manager(osr['id'])
    if not install_supported(manager,osr['id'],osr['versionId'],name):raise InstallError('UNSUPPORTED')
    if package_installed(name,manager):raise InstallError('DOCKER_NOT_RUNNING' if name=='docker' else 'ALREADY_INSTALLED')
    if name=='nginx' and 80 in listening_ports():raise InstallError('PORT_80')
    names=list(INSTALL_PLAN[manager][name])
    emit(stage='update')
    if manager=='apt':
        code,tail=run_fixed(['apt-get','-o','DPkg::Lock::Timeout=120','update'],INSTALL_UPDATE_TIMEOUT)
        if code!=0:raise InstallError(install_failure(code,tail,manager,'update'))
        command=['apt-get','-o','DPkg::Lock::Timeout=120','install','-y','--no-install-recommends','--no-remove']+names
    else:command=['dnf','install','-y']+names
    emit(stage='install')
    code,tail=run_fixed(command,INSTALL_TIMEOUT)
    if code!=0:raise InstallError(install_failure(code,tail,manager,'install'))
    emit(stage='verify')
    verify_install(name)
    emit(result={'package':name,'installed':True})
