# helper/edit.py: Safe Edit (docs/safe-edit.md): load, check, prepare, apply, poll, rollback, finish, status.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    NOFOLLOW, atomic_json, diagnostic, emit, private_staging_base, sync_directory)
from .paths import (
    SYSTEM_TREES, lexical, protected_lexical, within)
from .net import (
    ProbePolicyError, fetch, skip_refused_probes)
from .maintenance import (
    maintenance)
from .incremental import (
    INCREMENTAL_ROOT, SITE_KEY)
from .restore import (
    DEFAULT_CAPABILITIES)
from .move import (
    COMPOSE_MOUNT_KEYS, COMPOSE_SERVICE_KEYS, COMPOSE_SERVICE_NETWORK_KEYS, COMPOSE_TOP_KEYS, PROTECTED_PATHS, SAFE_NAME,
    compose_network_problem, compose_volume_problem, listening_ports)
from .restore_test import (
    IMAGE_TAG)
from .discovery import (
    temporary_mounts, tmpfs_argument)
# Mutable state used here lives in common: SNAPSHOT_FILTER, STOPPING
# </build:header>
"""Safe Edit operations. Final contract (shared with src/site-edits/engine.js):

Every op reads one JSON request and answers with ONE `result` line that always carries `ok`. A refusal or failure is
`{ok: false, code, reason, field?}`: `code` is fixed, `reason` a fixed sentence, `field` a Compose field path or an
environment KEY name (never a value, a resolved path or Docker output). The `{error}` line is not used by these ops.

Common request fields
  operation, editId (UUID v4), siteId ([A-Za-z0-9-]{1,64}), allowedRoots: [absolute site application folders],
  invocation: {project, files: [abs], projectDirectory: abs, envFiles: [abs], dockerConfig?: abs}
              or {container: "<exact name>"} for a single-container site,
  config: the site's backup config (maintenance settings; used by edit-apply, edit-finish and edit-status),
  sshPort?: int (refused as a new host port, like 22), watchStdin?: bool (stop when stdin closes).
  Every op holds the per-site lock INCREMENTAL_ROOT/.lock-<siteId> (the backup lock family); busy for 60 s -> SITE_BUSY.

edit-load    -> {ok, files: [{path, inode, sha256, text|null}], env: [{file, keys}], services: [{name, image, ports:
                [{host, container, protocol, hostIp}], frozen, healthcheck}], composeVersion, usable: {compose, env,
                ports, image}, reasons: {tab: code}}. Env values never leave the helper. A file over 256 KB has
                text null and reasons.compose FILE_TOO_LARGE. Single container: env file is "container".
edit-check   request adds files: [{path, sha256, text}] (Compose files only, sha256 = the hash edit-load returned),
                env: [{file, key, value} | {file, key, remove: true}],
                containerChanges?: {image?, ports?: [{host, container, protocol?, hostIp?}]} (single container only).
             -> {ok: true, verdict: {changed, envChanged: {added, replaced, removed}, imageChanged, newPorts: [{host,
                allAddresses}], hashes: [{path, before, after, keyed?}], frozen: [service], reviewedModelSha256}}.
                Env-file hashes are keyed (HMAC with a server-local key) so no guessable value hash leaves.
                reviewedModelSha256 is an HMAC over the candidate's resolved model, the env-file contents and the
                hashes of every original file it replaces, so a hand edit between review and apply changes it.
edit-prepare same payload + reviewedModelSha256 -> {ok, pulled: [service]} | PULL_FAILED | DISK_FULL | FILE_CHANGED.
                Re-runs the check, journals originals, current image IDs and docknest-edit/<editId>:<service> tags.
edit-apply   {reviewedModelSha256} (candidates come from the journal) -> {ok, startedAt (epoch seconds)}.
edit-poll    {services, healthUrl?, windowStartedAt (epoch seconds), timeLimitSeconds, final}
             -> {ok, state: waiting|healthy|unhealthy, reason?, healthSeconds}.
edit-rollback {restoreData} -> {ok, journal, leftovers} | ROLLBACK_FAILED. Maintenance stays on.
edit-finish  -> {ok, journal}. Maintenance off unless it was on before the edit; tags and journal removed.
edit-status  -> {ok, journal, files: original|candidate|mixed|none, maintenance, state}.
"""
EDITS_ROOT=pathlib.Path('/var/lib/docknest/edits')
EDIT_UUID=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
EDIT_PROJECT=re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')
EDIT_ENV_KEY=re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
EDIT_ENV_REFUSED_PREFIXES=('COMPOSE_','DOCKER_','BUILDKIT_')
EDIT_FILE_LIMIT=256*1024
EDIT_ENV_KEYS=200
EDIT_VALUE_LIMIT=8*1024
EDIT_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
EDIT_PULL_SECONDS=15*60
EDIT_MIN_COMPOSE=(2,24)
EDIT_BINARY=getattr(os,'O_BINARY',0)
EDIT_OPS=('edit-load','edit-check','edit-prepare','edit-apply','edit-poll','edit-rollback','edit-finish','edit-status')
# Item 1: the move allow-list, plus the settings that are compared with the current model ("already had it").
# Any other key is refused, even when the site already has it.
EDIT_DIFF_KEYS={'privileged','cap_add','cap_drop','devices','pid','ipc','uts','userns_mode','network_mode','security_opt',
    'sysctls','cgroup_parent','cgroup','volumes_from','use_api_socket','gpus','runtime','group_add','device_cgroup_rules',
    'storage_opt','build','isolation'}
EDIT_SERVICE_KEYS=COMPOSE_SERVICE_KEYS|EDIT_DIFF_KEYS
EDIT_LOGGING_SAFE={'json-file','local','none'}
EDIT_SOCKETS={'docker.sock','containerd.sock','podman.sock','dockershim.sock','cri-dockerd.sock','buildkitd.sock'}
EDIT_SAFE_PROPAGATION={None,'','private','rprivate'}
EDIT_REASONS={
    'INVALID_REQUEST':'DockNest sent a request the server did not accept.',
    'SITE_BUSY':'Another DockNest task is working on this site. Try again in a minute.',
    'PRIVILEGE_ADDED':'This change gives the site more access to the server. Change it by hand.',
    'UNKNOWN_SETTING':'This change uses a Compose setting DockNest cannot check. Change it by hand.',
    'PATH_REFUSED':'This change uses a file or folder outside the site\'s folders.',
    'SYMLINK_REFUSED':'A folder this change mounts goes through a symbolic link.',
    'FILE_CHANGED':'This file changed on the server. Reload it.',
    'FILE_CHANGED_APPLY':'The files changed during the backup.',
    'COMPOSE_INVALID':'Docker Compose could not read the changed files.',
    'SERVICE_REMOVED':'This change removes a service. Remove it by hand.',
    'PORT_IN_USE':'A new port is already in use on the server.',
    'SERVICE_FROZEN':'This service has host access. Change it by hand.',
    'ENV_REFUSED':'This environment change is not allowed.',
    'COMPOSE_TOO_OLD':'Update Docker Compose to 2.24 or newer.',
    'FILE_TOO_LARGE':'A file is larger than 256 KB.',
    'NO_ENV_FILE':'This site has no environment file.',
    'NOT_COMPOSE':'This site is a single container, so it has no Compose file.',
    'UNSUPPORTED_CONTAINER':'This container uses settings DockNest cannot recreate. Change it by hand.',
    'PULL_FAILED':'The new image could not be downloaded.',
    'DISK_FULL':'The server is too low on disk space.',
    'DATA_COPY_SPACE':'Not enough free disk space for the safety copy.',
    'DATA_NOT_LOCAL':'This site keeps data on a volume DockNest cannot copy, so an image change cannot be undone safely. Change the image by hand.',
    'OWN_SITE':'This is DockNest itself. Change it with the DockNest upgrade, not Safe Edit.',
    'NO_JOURNAL':'This change was not prepared on the server.',
    'MAINTENANCE_FAILED':'The maintenance page could not be switched.',
    'APPLY_FAILED':'Docker could not start the changed site.',
    'ROLLBACK_FAILED':'The previous version could not be put back.',
    'FAILED':'Safe Edit could not run on the server.',
}
class EditRefused(Exception):
    def __init__(self,code,field=None,reason=None):
        super().__init__(code);self.code=code;self.field=field;self.reason=reason or EDIT_REASONS[code]
def edit_refuse(code,field=None,reason=None):raise EditRefused(code,field,reason)

# ---- request validation ----
def edit_abs(value,code='INVALID_REQUEST'):
    if not isinstance(value,str) or not value.startswith('/') or '\0' in value or len(value)>1024 or '..' in value.split('/'):edit_refuse(code)
    return lexical(value)
def edit_real(path):
    # The helper runs on Linux; unit tests on Windows keep the written path.
    return lexical(os.path.realpath(path)) if os.name=='posix' else lexical(path)
def edit_system(path):
    return path=='/' or protected_lexical(path) or any(within(path,root) for root in SYSTEM_TREES) or posixpath.basename(path) in EDIT_SOCKETS
def edit_path_refused(path):
    return any(edit_system(p) for p in {lexical(path),edit_real(path)})
def edit_inside(path,roots):
    return any(within(p,root) for root in roots for p in [lexical(path)]) and any(within(edit_real(path),root) for root in roots)
def edit_symlink_component(path):
    """True when any existing component of the absolute path is a symbolic link (item 6)."""
    current=''
    for part in [p for p in lexical(path).split('/') if p]:
        current+='/'+part
        try:info=os.lstat(current)
        except FileNotFoundError:return False
        except OSError:return True
        if stat.S_ISLNK(info.st_mode):return True
    return False
def edit_request(req):
    edit_id=req.get('editId');site=req.get('siteId')
    if not isinstance(edit_id,str) or not EDIT_UUID.fullmatch(edit_id) or not isinstance(site,str) or not SITE_KEY.fullmatch(site):edit_refuse('INVALID_REQUEST')
    roots=req.get('allowedRoots')
    if not isinstance(roots,list) or not 1<=len(roots)<=20:edit_refuse('INVALID_REQUEST')
    roots=[edit_abs(r) for r in roots]
    if any(r in PROTECTED_PATHS or edit_path_refused(r) for r in roots):edit_refuse('PATH_REFUSED')
    inv=req.get('invocation')
    if not isinstance(inv,dict):edit_refuse('INVALID_REQUEST')
    if 'container' in inv:
        name=inv.get('container')
        if not isinstance(name,str) or not SAFE_NAME.fullmatch(name) or set(inv)-{'container'}:edit_refuse('INVALID_REQUEST')
        return edit_id,site,roots,{'container':name}
    project=inv.get('project');files=inv.get('files');envs=inv.get('envFiles') or []
    if not isinstance(project,str) or not EDIT_PROJECT.fullmatch(project) or not isinstance(files,list) or not 1<=len(files)<=10 or not isinstance(envs,list) or len(envs)>10:edit_refuse('INVALID_REQUEST')
    clean={'project':project,'files':[edit_abs(f) for f in files],'projectDirectory':edit_abs(inv.get('projectDirectory')),'envFiles':[edit_abs(e) for e in envs]}
    if inv.get('dockerConfig') is not None:
        clean['dockerConfig']=edit_abs(inv['dockerConfig'])
        if protected_lexical(clean['dockerConfig']):edit_refuse('PATH_REFUSED')
    for path in clean['files']+clean['envFiles']+[clean['projectDirectory']]:
        if edit_path_refused(path) or not edit_inside(path,roots):edit_refuse('PATH_REFUSED')
    if len(set(clean['files']))!=len(clean['files']):edit_refuse('INVALID_REQUEST')
    return edit_id,site,roots,clean

# ---- process execution (items 2, 3, 11): fixed argv, no shell, env -i with a fixed PATH ----
def edit_env(inv=None):
    env={'PATH':EDIT_PATH,'HOME':'/root','COMPOSE_EXPERIMENTAL_GIT_REMOTE':'0','COMPOSE_EXPERIMENTAL_OCI_REMOTE':'0'}
    if inv and inv.get('dockerConfig'):env['DOCKER_CONFIG']=inv['dockerConfig']
    return env
def edit_exec(args,timeout=120,env=None):
    """The only place Safe Edit starts a process. stderr is discarded: Docker's messages never leave the helper."""
    if STOPPING:raise ValueError('DockNest stopped this step.')
    started=time.monotonic();label=' '.join(args[:3]) if args[:2]==['docker','compose'] else ' '.join(args[:2])
    diagnostic(command=label,phase='start')
    result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout,env=env if env is not None else edit_env())
    diagnostic(command=label,phase='finish',elapsedMs=round((time.monotonic()-started)*1000),exitCode=result.returncode)
    if result.returncode:raise subprocess.CalledProcessError(result.returncode,args[:2])
    return result.stdout
def edit_docker(*args,timeout=120,inv=None):return edit_exec(['docker',*args],timeout,edit_env(inv))
def edit_compose_base(inv,files=None,envs=None):
    args=['docker','compose','-p',inv['project']]
    for f in (files or inv['files']):args+=['-f',f]
    args+=['--project-directory',inv['projectDirectory']]
    for e in (inv['envFiles'] if envs is None else envs):args+=['--env-file',e]
    return args
def edit_compose(inv,tail,files=None,envs=None,timeout=180):
    return edit_exec(edit_compose_base(inv,files,envs)+tail,timeout,edit_env(inv))
def edit_compose_version(inv=None):
    try:text=edit_docker('compose','version','--short',inv=inv).decode().strip().lstrip('v')
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError):return None,False
    match=re.match(r'(\d+)\.(\d+)',text)
    return text[:32],bool(match) and (int(match[1]),int(match[2]))>=EDIT_MIN_COMPOSE

# ---- per-site lock and journal ----
def edit_lock(site,wait=60):
    try:import fcntl
    except ImportError:return None
    INCREMENTAL_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
    handle=open(INCREMENTAL_ROOT/('.lock-'+site),'a');deadline=time.time()+wait
    while True:
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);return handle
        except BlockingIOError:
            if time.time()>=deadline:handle.close();edit_refuse('SITE_BUSY')
            time.sleep(1)
def edit_root():
    EDITS_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
    if os.name=='posix':private_staging_base(EDITS_ROOT)
    return EDITS_ROOT
def edit_model_key():
    """A server-local secret: model and env-file hashes are keyed, so a hash never helps guess a secret value."""
    path=edit_root()/'.model-key'
    try:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW|EDIT_BINARY,0o600)
        with os.fdopen(fd,'wb') as output:output.write(os.urandom(32));output.flush();os.fsync(output.fileno())
    except FileExistsError:pass
    fd=os.open(path,os.O_RDONLY|NOFOLLOW|EDIT_BINARY)
    with os.fdopen(fd,'rb') as source:key=source.read()
    if len(key)!=32:edit_refuse('FAILED')
    return key
def edit_keyed(key,data):
    import hmac
    return hmac.new(key,data,hashlib.sha256).hexdigest()
def edit_dir(edit_id):return EDITS_ROOT/edit_id
def edit_journal(edit_id):
    d=edit_dir(edit_id);path=d/'journal.json'
    if d.is_symlink() or not path.is_file() or path.is_symlink():return None
    return json.loads(path.read_text())
def edit_save(edit_id,journal):
    atomic_json(edit_dir(edit_id)/'journal.json',journal)
    if os.name=='posix':sync_directory(edit_dir(edit_id))
def edit_private_write(path,data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|NOFOLLOW|EDIT_BINARY,0o600)
    with os.fdopen(fd,'wb') as output:output.write(data);output.flush();os.fsync(output.fileno())

# ---- files ----
def edit_sha(data):return hashlib.sha256(data).hexdigest()
def edit_read(path,limit=EDIT_FILE_LIMIT):
    """Bytes and identity of a regular file, opened without following a final symbolic link."""
    try:fd=os.open(path,os.O_RDONLY|NOFOLLOW|EDIT_BINARY|getattr(os,'O_NONBLOCK',0))
    except OSError as error:
        if error.errno==errno.ELOOP:edit_refuse('PATH_REFUSED')  # the file itself is a symbolic link
        raise
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):edit_refuse('PATH_REFUSED')
        if info.st_size>limit:edit_refuse('FILE_TOO_LARGE')
        with os.fdopen(fd,'rb',closefd=False) as source:data=source.read(limit+1)
    finally:os.close(fd)
    if len(data)>limit:edit_refuse('FILE_TOO_LARGE')
    return data,{'inode':info.st_ino,'dev':info.st_dev,'uid':getattr(info,'st_uid',0),'gid':getattr(info,'st_gid',0),'mode':stat.S_IMODE(info.st_mode),'sha256':edit_sha(data)}
def edit_atomic_write(path,data,uid,gid,mode,tag):
    """Item: O_NOFOLLOW temp file in the same folder, original owner and mode, fsync, rename, fsync of the folder.
    The target itself must be a regular file or absent, never a symbolic link."""
    path=lexical(path);folder,name=posixpath.split(path)
    if os.path.islink(path) or (os.path.lexists(path) and not os.path.isfile(path)):edit_refuse('PATH_REFUSED')
    temporary=posixpath.join(folder,'.%s.docknest-%s.tmp'%(name,tag))
    try:os.unlink(temporary)
    except FileNotFoundError:pass
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW|EDIT_BINARY,0o600)
    try:
        with os.fdopen(fd,'wb') as output:
            output.write(data);output.flush()
            if hasattr(os,'fchown'):os.fchown(output.fileno(),uid,gid)
            if hasattr(os,'fchmod'):os.fchmod(output.fileno(),mode)
            os.fsync(output.fileno())
        if not hasattr(os,'fchmod'):os.chmod(temporary,mode)
        os.replace(temporary,path)
        if os.name=='posix':sync_directory(folder)
    finally:
        try:os.unlink(temporary)
        except FileNotFoundError:pass

# ---- .env editor: keeps comments, order, quoting, `export`, CRLF and a missing final newline ----
EDIT_ENV_LINE=re.compile(r'([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)',re.S)
EDIT_PLAIN=re.compile(r'[A-Za-z0-9_./:@+,%^~=-]*')
def edit_env_entries(text):
    """Entries {lines, key, head, quote, eol}. A quoted value may continue over several lines, as in Compose."""
    lines=re.findall(r'[^\n]*\n|[^\n]+$',text);entries=[];i=0
    while i<len(lines):
        line=lines[i];body=line[:-1] if line.endswith('\n') else line
        eol='\n' if line.endswith('\n') else ''
        if body.endswith('\r'):body=body[:-1];eol='\r'+eol
        match=EDIT_ENV_LINE.fullmatch(body);group=[line]
        if not match:entries.append({'lines':group,'key':None});i+=1;continue
        value=match[5];quote=value[:1] if value[:1] in ('"',"'") else ''
        if quote:
            def closed(v):
                j=1
                while j<len(v):
                    if quote=='"' and v[j]=='\\':j+=2;continue
                    if v[j]==quote:return True
                    j+=1
                return False
            joined=value
            while not closed(joined) and i+1<len(lines):
                i+=1;group.append(lines[i]);joined+='\n'+lines[i].rstrip('\n')
                last=lines[i];eol=('\r\n' if last.endswith('\r\n') else '\n') if last.endswith('\n') else ''
        entries.append({'lines':group,'key':match[3],'head':match[1]+(match[2] or '')+match[3]+match[4],'quote':quote,'eol':eol})
        i+=1
    return entries
def edit_env_keys(text):return list(dict.fromkeys(e['key'] for e in edit_env_entries(text) if e['key']))
def edit_env_quote(value,quote):
    if quote=='' and EDIT_PLAIN.fullmatch(value):return value
    if quote in ('',"'") and "'" not in value:return "'%s'"%value
    return '"%s"'%value.replace('\\','\\\\').replace('"','\\"').replace('$','\\$')
def edit_env_apply(text,edits):
    """edits: [{key, value} | {key, remove: True}] already validated. Returns the new text."""
    entries=edit_env_entries(text)
    newline='\r\n' if text.count('\r\n')*2>text.count('\n') else '\n'
    for item in edits:
        key=item['key'];hits=[e for e in entries if e['key']==key]
        if item.get('remove'):
            last=entries[-1] if entries else None
            entries=[e for e in entries if e['key']!=key]
            if last is not None and last['key']==key and not (last.get('eol') or last['lines'][-1].endswith('\n')) and entries:
                tail=entries[-1];tail['lines'][-1]=tail['lines'][-1].rstrip('\n').rstrip('\r')
                if tail.get('key'):tail['eol']=''
            continue
        if hits:
            for e in hits:e['lines']=[e['head']+edit_env_quote(item['value'],e['quote'])+e['eol']]
        else:
            line=key+'='+edit_env_quote(item['value'],'')
            if entries and not entries[-1]['lines'][-1].endswith('\n'):
                entries[-1]['lines'][-1]+=newline
                if entries[-1].get('key'):entries[-1]['eol']=newline
                entries.append({'lines':[line],'key':key,'head':key+'=','quote':'','eol':''})
            else:entries.append({'lines':[line+newline],'key':key,'head':key+'=','quote':'','eol':newline})
    return ''.join(''.join(e['lines']) for e in entries)
def edit_env_value_problem(value):
    return not isinstance(value,str) or len(value.encode())>EDIT_VALUE_LIMIT or any(c in value for c in '\r\n\0')
def edit_env_edits(req,files):
    """Validated env edits grouped by file (item 2). files: the editable env files."""
    items=req.get('env') or []
    if not isinstance(items,list) or len(items)>EDIT_ENV_KEYS:edit_refuse('ENV_REFUSED')
    grouped={};seen=set()
    for item in items:
        if not isinstance(item,dict):edit_refuse('ENV_REFUSED')
        key=item.get('key');target=item.get('file')
        if not isinstance(key,str) or not EDIT_ENV_KEY.fullmatch(key) or len(key)>256:edit_refuse('ENV_REFUSED')
        if key.upper().startswith(EDIT_ENV_REFUSED_PREFIXES):edit_refuse('ENV_REFUSED',key)
        if target not in files or (target,key) in seen:edit_refuse('ENV_REFUSED',key)
        seen.add((target,key))
        if item.get('remove') is True:grouped.setdefault(target,[]).append({'key':key,'remove':True});continue
        if edit_env_value_problem(item.get('value')):edit_refuse('ENV_REFUSED',key)
        grouped.setdefault(target,[]).append({'key':key,'value':item['value']})
    return grouped

# ---- Compose resolution (item 3) ----
def edit_text_includes(text):
    match=re.search(r'(?m)^["\']?include["\']?[ \t]*:.*(?:\n(?:[ \t#].*|)$)*',text)
    return match[0].strip() if match else None
EDIT_FILE_VALUE=re.compile(r'(?m)(?:^|[\s{,\-])["\']?file["\']?[ \t]*:[ \t]*([^\n,}#]*)')
def edit_text_problems(original,candidate,inv,roots):
    """Before any Compose call: a candidate may not add an include block, nor a new `file:` reference (extends,
    secrets, configs) that leaves the site's folders or is interpolated, anchored or protected."""
    if edit_text_includes(candidate) and edit_text_includes(candidate)!=edit_text_includes(original or ''):edit_refuse('PATH_REFUSED','include')
    before={v.strip() for v in EDIT_FILE_VALUE.findall(original or '')}
    for raw in EDIT_FILE_VALUE.findall(candidate):
        value=raw.strip()
        if not value or value in before:continue
        value=value.strip('"\'')
        if not value or value[0] in '*&!|>' or '$' in value or '{' in value or '\0' in value:edit_refuse('PATH_REFUSED','file')
        edit_check_reference(value,inv,roots,'file')
def edit_check_reference(value,inv,roots,field):
    path=lexical(value if value.startswith('/') else posixpath.join(inv['projectDirectory'],value))
    if edit_path_refused(path) or not edit_inside(path,roots) or edit_symlink_escape(path,roots):edit_refuse('PATH_REFUSED',field)
    return path
def edit_symlink_escape(path,roots):return not edit_inside(edit_real(path),roots)
def edit_env_file_paths(service):
    for item in service.get('env_file') or []:
        if isinstance(item,str):yield item,True
        elif isinstance(item,dict) and isinstance(item.get('path'),str):yield item['path'],item.get('required',True) is not False
        else:edit_refuse('COMPOSE_INVALID')
def edit_config(inv,files,envs,first):
    flags=['--no-interpolate','--no-env-resolution','--no-path-resolution'] if first else ['--no-env-resolution']
    try:model=json.loads(edit_compose(inv,['config','--format','json',*flags],files,envs))
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,OSError):edit_refuse('COMPOSE_INVALID')
    if not isinstance(model,dict) or not isinstance(model.get('services'),dict):edit_refuse('COMPOSE_INVALID')
    return model
def edit_first_pass_checks(first,current_first,inv,roots):
    """env_file and file-based secrets/configs are validated before the full (interpolating) pass."""
    existing={p for s in ((current_first or {}).get('services') or {}).values() if isinstance(s,dict) for p,_ in edit_env_file_paths(s)}
    for name,service in first['services'].items():
        if not isinstance(service,dict):edit_refuse('COMPOSE_INVALID')
        for value,_ in edit_env_file_paths(service):
            field='services.%s.env_file'%name
            if '$' in value and value not in existing:edit_refuse('PATH_REFUSED',field)
            if '$' in value:continue
            path=lexical(value if value.startswith('/') else posixpath.join(inv['projectDirectory'],value))
            if edit_path_refused(path):edit_refuse('PATH_REFUSED',field)
            if value not in existing and (not edit_inside(path,roots) or edit_symlink_escape(path,roots)):edit_refuse('PATH_REFUSED',field)
    for kind in ('secrets','configs'):
        for key,item in (first.get(kind) or {}).items():
            if isinstance(item,dict) and isinstance(item.get('file'),str):
                current=((current_first or {}).get(kind) or {}).get(key)
                if current!=item:edit_check_reference(item['file'],inv,roots,'%s.%s'%(kind,key))
def edit_env_digests(model,key,overrides):
    """Keyed digest of every service env_file (the full pass runs with --no-env-resolution), using candidate bytes
    for files this edit rewrites."""
    result={}
    for service in model['services'].values():
        for value,required in edit_env_file_paths(service):
            path=lexical(value)
            if path in result:continue
            if edit_path_refused(path):edit_refuse('PATH_REFUSED')
            if path in overrides:result[path]=edit_keyed(key,overrides[path]);continue
            try:data,_=edit_read(path)
            except FileNotFoundError:
                if required:edit_refuse('COMPOSE_INVALID')
                result[path]='missing';continue
            result[path]=edit_keyed(key,data)
    return result

# ---- the gate (items 1, 4, 6, 12) ----
def edit_caps(values):return {str(c).upper().removeprefix('CAP_') for c in values or []}
def edit_mounts(service):return [m for m in service.get('volumes') or [] if isinstance(m,dict)]
def edit_frozen(service):
    """Item 4: a service that already has host access."""
    if service.get('privileged') or service.get('devices'):return True
    if any(service.get(k)=='host' for k in ('pid','ipc','uts','userns_mode','network_mode')):return True
    if str(service.get('network_mode') or '').startswith('container:'):return True
    added=edit_caps(service.get('cap_add'))
    if added and (service.get('cap_drop') or added-DEFAULT_CAPABILITIES):return True
    return any(m.get('type')=='bind' and isinstance(m.get('source'),str) and edit_path_refused(m['source']) for m in edit_mounts(service))
def edit_ports(service):
    result=[]
    for p in service.get('ports') or []:
        if not isinstance(p,dict):continue
        result.append({'host':str(p.get('published') or ''),'container':p.get('target'),'protocol':p.get('protocol') or 'tcp','hostIp':p.get('host_ip') or ''})
    return result
def edit_port_numbers(value):
    if not value:return []
    match=re.fullmatch(r'(\d{1,5})(?:-(\d{1,5}))?',value)
    if not match:edit_refuse('COMPOSE_INVALID')
    low=int(match[1]);high=int(match[2] or low)
    if not 1<=low<=high<=65535 or high-low>1000:edit_refuse('COMPOSE_INVALID')
    return list(range(low,high+1))
def edit_published(model):
    return {(p['hostIp'],n,p['protocol']) for s in model['services'].values() for p in edit_ports(s) for n in edit_port_numbers(p['host'])}
def edit_new_ports(current_ports,candidate_ports,ssh_port):
    fresh=sorted(candidate_ports-current_ports,key=lambda x:(x[1],x[0],x[2]))
    if not fresh:return []
    used={n for _,n,_ in current_ports}
    busy=set(listening_ports())
    for ip,port,_ in fresh:
        if port in (22,ssh_port) or (port in busy and port not in used):edit_refuse('PORT_IN_USE',str(port))
    seen={};
    for ip,port,_ in fresh:seen[port]=seen.get(port,False) or ip in ('','0.0.0.0','::')
    return [{'host':port,'allAddresses':wide} for port,wide in seen.items()]
def edit_empty(value):return value is None or value is False or value==[] or value=={} or value==''
def edit_gate(current,candidate,roots,current_env,candidate_env):
    """Allow-list first, then the per-service comparison with the current resolved model. Raises EditRefused."""
    cur=current['services'];cand=candidate['services']
    unknown=[k for k in candidate if k not in COMPOSE_TOP_KEYS and not k.startswith('x-')]
    if unknown:edit_refuse('UNKNOWN_SETTING',sorted(unknown)[0])
    removed=sorted(set(cur)-set(cand))
    if removed:edit_refuse('SERVICE_REMOVED','services.'+removed[0])
    for kind,problem in (('networks',compose_network_problem),('volumes',compose_volume_problem)):
        for key,item in (candidate.get(kind) or {}).items():
            if (item or {})!=((current.get(kind) or {}).get(key) or {}) and problem(item or {}):edit_refuse('PRIVILEGE_ADDED','%s.%s'%(kind,key))
    for kind in ('secrets','configs'):
        for key,item in (candidate.get(kind) or {}).items():
            if item==((current.get(kind) or {}).get(key)):continue
            if not isinstance(item,dict) or item.get('external') or set(item)-{'name','file','environment','content'}:edit_refuse('PRIVILEGE_ADDED','%s.%s'%(kind,key))
            if item.get('file'):
                path=lexical(item['file'])
                if edit_path_refused(path) or not edit_inside(path,roots) or edit_symlink_component(path):edit_refuse('PATH_REFUSED','%s.%s'%(kind,key))
    existing_binds=[lexical(m['source']) for s in cur.values() for m in edit_mounts(s) if m.get('type')=='bind' and isinstance(m.get('source'),str)]
    frozen=[]
    for name,service in cand.items():
        if not isinstance(service,dict):edit_refuse('COMPOSE_INVALID')
        before=cur.get(name) or {};field='services.%s.'%name
        extra=[k for k in service if k not in EDIT_SERVICE_KEYS and not k.startswith('x-')]
        if extra:edit_refuse('UNKNOWN_SETTING',field+sorted(extra)[0])
        for key in sorted(EDIT_DIFF_KEYS-{'cap_add','cap_drop','security_opt'}):
            if not edit_empty(service.get(key)) and service.get(key)!=before.get(key):edit_refuse('PRIVILEGE_ADDED',field+key)
        added=edit_caps(service.get('cap_add'))-edit_caps(before.get('cap_add'))
        if added and (service.get('cap_drop') or added-DEFAULT_CAPABILITIES):edit_refuse('PRIVILEGE_ADDED',field+'cap_add')
        if edit_caps(before.get('cap_drop'))-edit_caps(service.get('cap_drop')):edit_refuse('PRIVILEGE_ADDED',field+'cap_drop')
        old_opts=set(map(str,before.get('security_opt') or []));new_opts=set(map(str,service.get('security_opt') or []))
        if not old_opts<=new_opts or any(not o.startswith('no-new-privileges') for o in new_opts-old_opts):edit_refuse('PRIVILEGE_ADDED',field+'security_opt')
        labels=service.get('labels') or {};old_labels=before.get('labels') or {}
        if isinstance(labels,list):labels=dict(str(x).partition('=')[::2] for x in labels)
        if isinstance(old_labels,list):old_labels=dict(str(x).partition('=')[::2] for x in old_labels)
        for label,value in labels.items():
            if str(label).startswith(('docknest.','com.docker.compose.')) and old_labels.get(label)!=value:edit_refuse('PRIVILEGE_ADDED',field+'labels')
        driver=(service.get('logging') or {}).get('driver');old_driver=(before.get('logging') or {}).get('driver')
        if driver!=old_driver and driver not in EDIT_LOGGING_SAFE|{None}:edit_refuse('PRIVILEGE_ADDED',field+'logging')
        if (service.get('logging') or {}).get('options')!=(before.get('logging') or {}).get('options') and driver not in EDIT_LOGGING_SAFE|{None}:edit_refuse('PRIVILEGE_ADDED',field+'logging')
        devices=(((service.get('deploy') or {}).get('resources') or {}).get('reservations') or {}).get('devices')
        if not edit_empty(devices) and devices!=(((before.get('deploy') or {}).get('resources') or {}).get('reservations') or {}).get('devices'):edit_refuse('PRIVILEGE_ADDED',field+'deploy')
        for network,options in (service.get('networks') or {}).items():
            if set(options or {})-COMPOSE_SERVICE_NETWORK_KEYS and options!=((before.get('networks') or {}).get(network)):edit_refuse('PRIVILEGE_ADDED',field+'networks')
        old_mounts=edit_mounts(before)
        for mount in edit_mounts(service):
            if mount in old_mounts:continue
            if set(mount)-COMPOSE_MOUNT_KEYS:edit_refuse('UNKNOWN_SETTING',field+'volumes')
            kind=mount.get('type')
            if kind=='bind':
                source=mount.get('source')
                if not isinstance(source,str) or not source.startswith('/'):edit_refuse('PATH_REFUSED',field+'volumes')
                if edit_path_refused(source) or not edit_inside(source,roots):edit_refuse('PATH_REFUSED',field+'volumes')
                if not any(within(lexical(source),b) for b in existing_binds) or not any(within(edit_real(source),edit_real(b)) for b in existing_binds):edit_refuse('PATH_REFUSED',field+'volumes')
                if edit_symlink_component(source):edit_refuse('SYMLINK_REFUSED',field+'volumes')
                if (mount.get('bind') or {}).get('propagation') not in EDIT_SAFE_PROPAGATION:edit_refuse('PRIVILEGE_ADDED',field+'volumes')
            elif kind not in ('volume','tmpfs'):edit_refuse('UNKNOWN_SETTING',field+'volumes')
        if name in cur and edit_frozen(cur[name]):
            frozen.append(name)
            for key in ('image','command','entrypoint','environment','env_file'):
                if service.get(key)!=before.get(key):edit_refuse('SERVICE_FROZEN',field+key)
            for value,_ in edit_env_file_paths(service):
                if candidate_env.get(lexical(value))!=current_env.get(lexical(value)):edit_refuse('SERVICE_FROZEN',field+'env_file')
    # Item 6: nested read-write binds across services, unless the same pair already existed.
    def rw_binds(services):
        return [(n,edit_real(m['source'])) for n,s in services.items() for m in edit_mounts(s) if m.get('type')=='bind' and isinstance(m.get('source'),str) and not m.get('read_only')]
    old_pairs=set();binds=rw_binds(cur)
    for a in binds:
        for b in binds:
            if a[0]!=b[0] and a[1]!=b[1] and within(a[1],b[1]):old_pairs.add((a,b))
    binds=rw_binds(cand)
    for a in binds:
        for b in binds:
            if a[0]!=b[0] and a[1]!=b[1] and within(a[1],b[1]) and (a,b) not in old_pairs:edit_refuse('PATH_REFUSED','services.%s.volumes'%a[0])
    return frozen
def edit_changes(current,candidate):
    changed=[]
    for name in sorted(set(current['services'])|set(candidate['services'])):
        a=current['services'].get(name) or {};b=candidate['services'].get(name) or {}
        if name not in current['services']:changed.append('services.%s'%name);continue
        changed+=['services.%s.%s'%(name,k) for k in sorted(set(a)|set(b)) if a.get(k)!=b.get(k)]
    for kind in ('networks','volumes','secrets','configs'):
        a=current.get(kind) or {};b=candidate.get(kind) or {}
        changed+=['%s.%s'%(kind,k) for k in sorted(set(a)|set(b)) if a.get(k)!=b.get(k)]
    return changed[:200]
def edit_image_services(current,candidate):
    return sorted(n for n,s in candidate['services'].items() if s.get('image') and s.get('image')!=(current['services'].get(n) or {}).get('image'))
def edit_digest(key,kind,model,env_digests,before):
    canonical=json.dumps({'kind':kind,'model':model,'envFiles':env_digests,'before':before},sort_keys=True,separators=(',',':'))
    return edit_keyed(key,canonical.encode())

# ---- Compose sites: load and candidate check ----
def edit_env_targets(inv):
    """The interpolation env files Safe Edit may change: the recorded --env-file list, else the project's .env."""
    if inv['envFiles']:return list(inv['envFiles'])
    default=posixpath.join(inv['projectDirectory'],'.env')
    return [default] if os.path.isfile(default) and not os.path.islink(default) else []
def edit_resolve(inv,roots,key,files=None,envs=None,overrides=None,current_first=None,existing=False):
    """Two passes: references checked on the uninterpolated model, then the full model. existing=True for the
    site's current files (what it already reads stays allowed, protected paths never are)."""
    first=edit_config(inv,files,envs,True)
    edit_first_pass_checks(first,first if existing else current_first,inv,roots)
    model=edit_config(inv,files,envs,False)
    return first,model,edit_env_digests(model,key,overrides or {})
# ---- guided tabs (Ports, Image): where the one line to change is, or why the change belongs in Compose ----
EDIT_VAR=re.compile(r'\$\{?([A-Za-z_][A-Za-z0-9_]*)')
def edit_locate(texts,patterns):
    """{file, line} (1-based) when exactly one line of all the Compose files matches, else None."""
    hits=[]
    for path,text in texts.items():
        if text is None:continue
        for number,line in enumerate(text.splitlines(),1):
            if any(pattern.search(line) for pattern in patterns):hits.append({'file':path,'line':number})
    return hits[0] if len(hits)==1 else None
def edit_guided(first,texts):
    """Per service: imageAt or imageReason (IMAGE_FROM_ENV with imageVariable, or EDIT_IN_COMPOSE), and per port
    at or reason. Anchors, extends and several files that set the same value are never guessed."""
    raw=first.get('services') or {};result={}
    images=[str((svc or {}).get('image') or '') for svc in raw.values()]
    for name,svc in raw.items():
        svc=svc or {};info={'imageAt':None,'imageReason':None,'imageVariable':None,'ports':[]}
        image=str(svc.get('image') or '');shared=svc.get('extends') is not None
        variable=EDIT_VAR.search(image)
        if variable:info['imageReason']='IMAGE_FROM_ENV';info['imageVariable']=variable[1]
        elif image:
            at=None if shared or images.count(image)>1 else edit_locate(texts,[re.compile(r"^\s*-?\s*[\"']?image[\"']?\s*:\s*[\"']?"+re.escape(image)+r"[\"']?\s*,?\s*(#.*)?$")])
            info['imageAt']=at
            if not at:info['imageReason']='EDIT_IN_COMPOSE'
        for port in svc.get('ports') or []:
            if not isinstance(port,dict):continue
            published=str(port.get('published') or '');target=str(port.get('target') or '')
            at=None
            if published and target and '$' not in published+target and not shared:
                at=edit_locate(texts,[re.compile(r"(^|[\s\"'\[:,-])"+re.escape(published)+r':'+re.escape(target)+r"(/(tcp|udp))?($|[\s\"'\],#])"),re.compile(r"^\s*-?\s*[\"']?published[\"']?\s*:\s*[\"']?"+re.escape(published)+r"[\"']?\s*,?\s*(#.*)?$")])
            info['ports'].append({'host':published,'container':target,'at':at,**({} if at else {'reason':'EDIT_IN_COMPOSE'})})
        result[name]=info
    return result
def edit_compose_load(req,inv,roots):
    version,recent=edit_compose_version(inv)
    files=[];reasons={};usable={'compose':True,'env':True,'ports':True,'image':True}
    def unusable(tabs,code):
        for tab in tabs:
            if usable[tab]:usable[tab]=False;reasons[tab]=code
    if not recent:unusable(['compose','env','ports','image'],'COMPOSE_TOO_OLD')
    for path in inv['files']:
        try:
            data,info=edit_read(path)
            try:text=data.decode('utf-8')
            except UnicodeDecodeError:text=None;unusable(['compose','ports','image'],'COMPOSE_INVALID')
            files.append({'path':path,'inode':info['inode'],'sha256':info['sha256'],'text':text})
        except EditRefused as refused:
            files.append({'path':path,'inode':None,'sha256':None,'text':None});unusable(['compose','ports','image'],refused.code)
        except FileNotFoundError:
            files.append({'path':path,'inode':None,'sha256':None,'text':None});unusable(['compose','ports','image'],'COMPOSE_INVALID')
    env=[]
    for path in edit_env_targets(inv):
        try:
            data,_=edit_read(path);keys=edit_env_keys(data.decode('utf-8'))
            env.append({'file':path,'keys':keys})
            if len(keys)>EDIT_ENV_KEYS:unusable(['env'],'ENV_REFUSED')
        except (EditRefused,FileNotFoundError,UnicodeDecodeError) as problem:
            unusable(['env'],problem.code if isinstance(problem,EditRefused) else 'NO_ENV_FILE')
    if not env:unusable(['env'],'NO_ENV_FILE')
    services=[]
    if recent:
        try:
            key=edit_model_key()
            first,model,_=edit_resolve(inv,roots,key,existing=True)
            running=edit_project_containers(inv)
            guided=edit_guided(first,{f['path']:f['text'] for f in files})
            for name,service in sorted(model['services'].items()):
                health=service.get('healthcheck') or {}
                where=guided.get(name) or {'imageAt':None,'imageReason':'EDIT_IN_COMPOSE','imageVariable':None,'ports':[]}
                ports=[]
                for p in edit_ports(service):
                    located=next((g for g in where['ports'] if g['container']==str(p['container']) and (g['host']==p['host'] or '$' in g['host'])),None)
                    ports.append({**p,'host':p['host'] or None,'at':located['at'] if located else None,**({} if located and located['at'] else {'reason':'EDIT_IN_COMPOSE'})})
                services.append({'name':name,'image':service.get('image'),'ports':ports,'frozen':edit_frozen(service),
                    'healthcheck':bool(health and not health.get('disable')) or any('Health' in (c.get('State') or {}) for c in running if c.get('service')==name),
                    'imageAt':where['imageAt'],'imageReason':where['imageReason'],'imageVariable':where['imageVariable']})
        except EditRefused as refused:unusable(['compose','ports','image'],refused.code)
    # A guided tab is usable when it can make at least one text edit; otherwise it says why (and which variable).
    variables={}
    if services and usable['image'] and not any(s['imageAt'] for s in services):
        variable=next((s['imageVariable'] for s in services if s['imageVariable']),None)
        unusable(['image'],'IMAGE_FROM_ENV' if variable else 'EDIT_IN_COMPOSE')
        if variable:variables['image']=variable
    if services and usable['ports'] and any(s['ports'] for s in services) and not any(p.get('at') for s in services for p in s['ports']):unusable(['ports'],'EDIT_IN_COMPOSE')
    emit(result={'ok':True,'files':files,'env':env,'services':services,'composeVersion':version,'usable':usable,'reasons':reasons,'variables':variables})
def edit_candidates(req,inv,roots):
    """Validated candidate Compose texts and env edits: {path: bytes} for files that differ, plus the originals."""
    items=req.get('files') or []
    if not isinstance(items,list) or len(items)>len(inv['files']):edit_refuse('INVALID_REQUEST')
    compose={};originals={};seen=set()
    for item in items:
        if not isinstance(item,dict):edit_refuse('INVALID_REQUEST')
        path=item.get('path');text=item.get('text')
        if path not in inv['files'] or path in seen or not isinstance(text,str) or not isinstance(item.get('sha256'),str):edit_refuse('INVALID_REQUEST')
        seen.add(path);data=text.encode('utf-8')
        if len(data)>EDIT_FILE_LIMIT:edit_refuse('FILE_TOO_LARGE')
        if '\0' in text:edit_refuse('COMPOSE_INVALID')
        try:original,info=edit_read(path)
        except FileNotFoundError:edit_refuse('FILE_CHANGED')
        if info['sha256']!=item['sha256']:edit_refuse('FILE_CHANGED')
        if data!=original:
            edit_text_problems(original.decode('utf-8','replace'),text,inv,roots)
            compose[path]=data;originals[path]=(original,info)
    targets=edit_env_targets(inv);grouped=edit_env_edits(req,targets);env={};changes={'added':[],'replaced':[],'removed':[]}
    for path,edits in grouped.items():
        try:original,info=edit_read(path)
        except FileNotFoundError:edit_refuse('NO_ENV_FILE')
        try:text=original.decode('utf-8')
        except UnicodeDecodeError:edit_refuse('ENV_REFUSED')
        keys=set(edit_env_keys(text))
        for item in edits:
            if item.get('remove'):
                if item['key'] not in keys:edit_refuse('ENV_REFUSED',item['key'])
                changes['removed'].append(item['key'])
            else:changes['replaced' if item['key'] in keys else 'added'].append(item['key'])
        new=edit_env_apply(text,edits).encode('utf-8')
        if len(new)>EDIT_FILE_LIMIT:edit_refuse('FILE_TOO_LARGE')
        if len(edit_env_keys(new.decode('utf-8')))>EDIT_ENV_KEYS:edit_refuse('ENV_REFUSED')
        if new!=original:env[path]=new;originals[path]=(original,info)
    return compose,env,originals,changes
def edit_compose_check(req,inv,roots,key,keep=False):
    """Candidate check in a private 0700 folder. Returns the verdict and the context prepare needs."""
    version,recent=edit_compose_version(inv)
    if not recent:edit_refuse('COMPOSE_TOO_OLD')
    compose,env,originals,changes=edit_candidates(req,inv,roots)
    current_first,current,current_env=edit_resolve(inv,roots,key,existing=True)
    folder=pathlib.Path(tempfile.mkdtemp(prefix='.check-',dir=str(edit_root())))
    try:
        files=[];envs=[];written={}
        for i,path in enumerate(inv['files']):
            if path in compose:
                target=folder/('c%d'%i);target.mkdir(mode=0o700);target=target/posixpath.basename(path)
                edit_private_write(target,compose[path]);files.append(str(target));written[path]=compose[path]
            else:files.append(path)
        targets=inv['envFiles'] or edit_env_targets(inv)
        for i,path in enumerate(targets):
            if path in env:
                target=folder/('e%d'%i);target.mkdir(mode=0o700);target=target/posixpath.basename(path)
                edit_private_write(target,env[path]);envs.append(str(target));written[path]=env[path]
            else:envs.append(path)
        if not inv['envFiles'] and not any(p in env for p in targets):envs=[]
        _,candidate,candidate_env=edit_resolve(inv,roots,key,files,envs,written,current_first)
        frozen=edit_gate(current,candidate,roots,current_env,candidate_env)
        new_ports=edit_new_ports(edit_published(current),edit_published(candidate),req.get('sshPort'))
        before={path:info['sha256'] for path,(_,info) in originals.items()}
        digest=edit_digest(key,'compose',candidate,candidate_env,before)
        hashes=[{'path':p,'before':originals[p][1]['sha256'],'after':edit_sha(compose[p])} for p in compose]
        hashes+=[{'path':p,'before':edit_keyed(key,originals[p][0]),'after':edit_keyed(key,env[p]),'keyed':True} for p in env]
        verdict={'changed':edit_changes(current,candidate),'envChanged':changes,'imageChanged':bool(edit_image_services(current,candidate)),
            'newPorts':new_ports,'hashes':hashes,'frozen':frozen,'reviewedModelSha256':digest}
        context={'currentFirst':current_first,'folder':folder,'files':files,'envs':envs,'compose':compose,'env':env,'originals':originals,'current':current,'candidate':candidate,'currentEnv':current_env}
        return verdict,context
    finally:
        if not keep:shutil.rmtree(folder,ignore_errors=True)

# ---- Docker facts ----
def edit_project_containers(inv):
    try:ids=edit_docker('ps','-aq','--no-trunc','--filter','label=com.docker.compose.project='+inv['project'],inv=inv).decode().split()
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError):return []
    if not ids:return []
    try:items=json.loads(edit_docker('inspect',*ids,inv=inv))
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,OSError):return []
    return [{'id':c.get('Id'),'service':((c.get('Config') or {}).get('Labels') or {}).get('com.docker.compose.service'),'image':c.get('Image'),'ref':(c.get('Config') or {}).get('Image'),'State':c.get('State') or {}} for c in items]
def edit_project_resources(inv):
    found={}
    for kind in ('volume','network'):
        try:found[kind]=sorted(edit_docker(kind,'ls','-q','--filter','label=com.docker.compose.project='+inv['project'],inv=inv).decode().split())
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError):found[kind]=None
    return found
def edit_tag(edit_id,service):
    name=service if re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',service or '') else 's'+edit_sha(str(service).encode())[:12]
    return 'docknest-edit/%s:%s'%(edit_id,name)
def edit_disk_low():
    try:return shutil.disk_usage('/var/lib/docker' if os.path.isdir('/var/lib/docker') else '/').free<1024**3
    except OSError:return False

# ---- data safety copy (owner decision: data rolls back in place, only when an image changes) ----
# The site's writable data sets are copied into the journal folder after its services stop and before the candidate is
# written. A rollback with data stops the services, replaces each data set's contents from the copy exactly (extras
# removed), then starts the pinned previous version. Finish removes the copy; a failed rollback keeps it.
# Data sets: every mount of the site's containers that a backup copies and a container can write: named volumes of the
# local driver (by their Mountpoint) and bind folders. Not: files (Compose and configuration files come back through the
# file journal), read-only mounts, tmpfs, protected paths, and the paths the site excludes from its backups.
EDIT_DATA_SCAN_LIMIT=200000
def edit_inspect_containers(ids,inv):
    if not ids:return []
    try:return json.loads(edit_docker('inspect',*ids,inv=inv))
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,OSError):edit_refuse('FAILED')
def edit_site_containers(inv):
    if 'container' in inv:return [edit_container(inv['container'],inv)]
    return edit_inspect_containers([c['id'] for c in edit_project_containers(inv) if c.get('id')],inv)
def edit_exclusions(cfg):
    return sorted({lexical(item['path']) for item in (cfg or {}).get('mountExclusions') or [] if isinstance(item,dict) and isinstance(item.get('path'),str) and item['path'].startswith('/')})
def edit_data_sets(cfg,containers):
    """[{kind, name, path, exclude}]: the copy plan. A volume of another driver refuses the edit (DATA_NOT_LOCAL)."""
    found={}
    for c in containers:
        for m in c.get('Mounts') or []:
            kind=m.get('Type');source=m.get('Source')
            if kind not in ('volume','bind') or not isinstance(source,str) or not source.startswith('/'):continue
            if kind=='volume' and (m.get('Driver') or 'local')!='local':edit_refuse('DATA_NOT_LOCAL')
            entry=found.setdefault(lexical(source),{'kind':kind,'name':m.get('Name') if kind=='volume' else None,'path':lexical(source),'rw':False})
            entry['rw']=entry['rw'] or m.get('RW',True) is not False
    excluded=edit_exclusions(cfg);sets=[]
    for path,entry in sorted(found.items()):
        if not entry['rw'] or path in PROTECTED_PATHS:continue
        if entry['kind']=='bind' and (os.path.islink(path) or not os.path.isdir(path) or edit_path_refused(path) or protected_lexical(path)):continue
        if any(within(path,item) for item in excluded):continue
        sets.append({'kind':entry['kind'],'name':entry['name'],'path':path,'exclude':[item for item in excluded if within(item,path) and item!=path]})
    # A data set inside another one is part of the outer copy.
    return [s for s in sets if not any(o is not s and within(s['path'],o['path']) for o in sets)]
def edit_skip(path,exclude):return any(within(path,item) for item in exclude)
def edit_data_size(sets,limit=EDIT_DATA_SCAN_LIMIT):
    """Bytes the copy needs (lstat sizes, links never followed), or None past `limit` entries."""
    total=0;count=0
    for s in sets:
        stack=[s['path']]
        while stack:
            current=stack.pop()
            try:entries=list(os.scandir(current))
            except OSError:continue
            for entry in entries:
                count+=1
                if count>limit:return None
                path=posixpath.join(current,entry.name)
                if edit_skip(path,s['exclude']):continue
                try:st=entry.stat(follow_symlinks=False)
                except OSError:continue
                total+=st.st_size
                if stat.S_ISDIR(st.st_mode):stack.append(path)
    return total
def edit_copy_meta(st,target):
    """Owner, mode, times and extended attributes (POSIX ACLs live there) of one entry; a link's own owner only."""
    link=stat.S_ISLNK(st.st_mode)
    if os.name=='posix' and os.geteuid()==0:
        try:os.chown(target,st.st_uid,st.st_gid,follow_symlinks=False)
        except (OSError,NotImplementedError):pass
    if not link:os.chmod(target,stat.S_IMODE(st.st_mode))
    try:
        if not link:os.utime(target,ns=(st.st_atime_ns,st.st_mtime_ns))
        elif os.utime in os.supports_follow_symlinks:os.utime(target,ns=(st.st_atime_ns,st.st_mtime_ns),follow_symlinks=False)
    except (OSError,NotImplementedError):pass
def edit_copy_xattrs(source,target,link):
    if not hasattr(os,'listxattr'):return
    try:names=os.listxattr(source,follow_symlinks=not link)
    except OSError:return
    for name in names:
        try:os.setxattr(target,name,os.getxattr(source,name,follow_symlinks=not link),follow_symlinks=not link)
        except OSError:pass
def edit_copy_entry(source,target,st):
    if stat.S_ISLNK(st.st_mode):os.symlink(os.readlink(source),target)
    elif stat.S_ISDIR(st.st_mode):os.mkdir(target,0o700)
    elif stat.S_ISREG(st.st_mode):
        fd=os.open(source,os.O_RDONLY|NOFOLLOW|EDIT_BINARY)
        try:
            out=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW|EDIT_BINARY,0o600)
            try:
                while True:
                    chunk=os.read(fd,1024*1024)
                    if not chunk:break
                    view=memoryview(chunk)
                    while view:view=view[os.write(out,view):]
            finally:os.close(out)
        finally:os.close(fd)
    elif stat.S_ISFIFO(st.st_mode) and hasattr(os,'mkfifo'):os.mkfifo(target,0o600)
    else:return False  # sockets and device nodes are runtime state: not copied
    return True
def edit_copy_tree(source,target,exclude=()):
    """Copies the contents of `source` into the existing folder `target`; symbolic links stay links (never followed)."""
    for entry in sorted(os.scandir(source),key=lambda e:e.name):
        path=posixpath.join(source,entry.name)
        if edit_skip(path,exclude):continue
        st=entry.stat(follow_symlinks=False);dest=posixpath.join(target,entry.name)
        if not edit_copy_entry(path,dest,st):continue
        if stat.S_ISDIR(st.st_mode):edit_copy_tree(path,dest,exclude)
        edit_copy_xattrs(path,dest,stat.S_ISLNK(st.st_mode));edit_copy_meta(st,dest)
def edit_clear(path,exclude=()):
    """Removes everything inside `path` except the excluded paths (and the folders that lead to them)."""
    for entry in list(os.scandir(path)):
        child=posixpath.join(path,entry.name)
        if edit_skip(child,exclude):continue
        if entry.is_dir(follow_symlinks=False):
            if any(within(item,child) for item in exclude):edit_clear(child,exclude);continue
            shutil.rmtree(child)
        else:os.unlink(child)
def edit_snapshot(edit_id,journal,sets):
    """Copies each data set into the journal folder; a marker per set makes a re-run continue where it stopped."""
    base=edit_dir(edit_id)/'data';base.mkdir(mode=0o700,exist_ok=True)
    for index,s in enumerate(sets):
        record=journal['data'][index]
        if record.get('state') in ('saved','restored'):continue
        target=base/str(index)
        if target.exists():shutil.rmtree(target)
        target.mkdir(mode=0o700)
        try:
            edit_copy_tree(s['path'],target.as_posix(),s['exclude'])
            root=os.stat(s['path'],follow_symlinks=False);record['root']={'uid':root.st_uid,'gid':root.st_gid,'mode':stat.S_IMODE(root.st_mode)}
        except OSError as error:
            if error.errno==errno.ENOSPC:edit_refuse('DISK_FULL',reason=EDIT_REASONS['DATA_COPY_SPACE'])
            raise
        record['state']='saved';edit_save(edit_id,journal)
def edit_restore_data(edit_id,journal):
    """Replaces each data set's contents with the copy, exactly. Idempotent: a restored set is skipped."""
    base=edit_dir(edit_id)/'data'
    for index,record in enumerate(journal.get('data') or []):
        if record.get('state')=='restored':continue
        if record.get('state')!='saved' or not (base/str(index)).is_dir():edit_refuse('ROLLBACK_FAILED')
        path=record['path']
        if os.path.islink(path) or not os.path.isdir(path):edit_refuse('ROLLBACK_FAILED')
        edit_clear(path,record['exclude']);edit_copy_tree((base/str(index)).as_posix(),path)
        root=record.get('root') or {}
        if os.name=='posix' and os.geteuid()==0 and 'uid' in root:os.chown(path,root['uid'],root['gid'])
        if 'mode' in root:os.chmod(path,root['mode'])
        record['state']='restored';edit_save(edit_id,journal)
def edit_take_data_copy(edit_id,journal,cfg,containers,stop):
    """Measure, check space (1.2x), stop the services, copy. Fails before any write with DISK_FULL."""
    sets=edit_data_sets(cfg,containers)
    if 'data' not in journal:
        size=edit_data_size(sets,limit=10**9) or 0
        try:free=shutil.disk_usage(str(edit_dir(edit_id))).free
        except OSError:free=0
        if free<size*1.2:edit_refuse('DISK_FULL',reason=EDIT_REASONS['DATA_COPY_SPACE'])
        journal['data']=[{'kind':s['kind'],'name':s['name'],'path':s['path'],'exclude':s['exclude'],'state':'pending'} for s in sets];journal['dataBytes']=size
    journal['servicesStopped']=True;edit_save(edit_id,journal)
    stop()
    edit_snapshot(edit_id,journal,[{'path':r['path'],'exclude':r['exclude']} for r in journal['data']])

# ---- maintenance ----
def edit_maintenance_config(req):
    cfg=req.get('config')
    if not isinstance(cfg,dict):edit_refuse('INVALID_REQUEST')
    cfg.setdefault('maintenance',{})['required']=True
    return cfg
def edit_maintenance_on_now(cfg):
    directory=(cfg.get('maintenance') or {}).get('directory')
    return bool(directory) and pathlib.Path(directory,'enabled').exists()
def edit_maintenance(cfg,enabled,running=None):
    try:
        if running is not None:cfg['_runningContainers']=running
        refused=skip_refused_probes(cfg)
        if enabled and 'public' in refused:edit_refuse('MAINTENANCE_FAILED')
        maintenance(cfg,enabled)
    except EditRefused:raise
    except Exception:edit_refuse('MAINTENANCE_FAILED')

# ---- single-container sites ----
EDIT_HOST_DEFAULTS={'Privileged':(False,None),'CapAdd':(None,[]),'CapDrop':(None,[]),'Devices':(None,[]),'DeviceRequests':(None,[]),
    'DeviceCgroupRules':(None,[]),'SecurityOpt':(None,[]),'Sysctls':(None,{}),'GroupAdd':(None,[]),'VolumesFrom':(None,[]),'Links':(None,[]),
    'Dns':(None,[]),'DnsSearch':(None,[]),'DnsOptions':(None,[]),'CgroupParent':('',None),'Runtime':('runc','',None),'PidMode':('',None),
    'UTSMode':('',None),'UsernsMode':('',None),'IpcMode':('','private','shareable',None),'Cgroup':('',None),'Memory':(0,None),
    'MemoryReservation':(0,None),'MemorySwap':(0,None),'NanoCpus':(0,None),'CpuShares':(0,None),'CpuQuota':(0,None),'CpuPeriod':(0,None),
    'CpusetCpus':('',None),'CpusetMems':('',None),'PidsLimit':(None,0,-1),'BlkioWeight':(0,None),'OomScoreAdj':(0,None),'OomKillDisable':(False,None),
    'ReadonlyRootfs':(False,None),'Ulimits':(None,[]),'StorageOpt':(None,{}),'ShmSize':(0,67108864,None),'Isolation':('','default',None),
    'AutoRemove':(False,None),'PublishAllPorts':(False,None),'Annotations':(None,{}),'VolumeDriver':('',None)}
def edit_image_config(image_id,inv):
    try:return (json.loads(edit_docker('image','inspect',image_id,inv=inv))[0].get('Config') or {})
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,OSError,IndexError):edit_refuse('UNSUPPORTED_CONTAINER')
def edit_container(name,inv):
    try:items=json.loads(edit_docker('inspect','--type','container',name,inv=inv))
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,OSError):edit_refuse('INVALID_REQUEST')
    if len(items)!=1 or items[0].get('Name','').lstrip('/')!=name:edit_refuse('INVALID_REQUEST')
    return items[0]
def edit_container_plan(c,inv):
    """Everything the recreate keeps, read from inspect. Settings the recreate cannot reproduce refuse the edit."""
    hc=c.get('HostConfig') or {};config=c.get('Config') or {}
    for key,allowed in EDIT_HOST_DEFAULTS.items():
        if key in hc and hc[key] not in allowed:edit_refuse('UNSUPPORTED_CONTAINER')
    log=hc.get('LogConfig') or {}
    if (log.get('Type') or 'json-file') not in ('json-file',) or log.get('Config'):edit_refuse('UNSUPPORTED_CONTAINER')
    mode=hc.get('NetworkMode') or 'default'
    if mode=='host' or mode.startswith('container:') or mode=='none':edit_refuse('UNSUPPORTED_CONTAINER')
    if config.get('Tty') or config.get('OpenStdin') or config.get('Domainname') or config.get('StopTimeout') is not None:edit_refuse('UNSUPPORTED_CONTAINER')
    image=edit_image_config(c.get('Image'),inv)
    if config.get('Healthcheck')!=image.get('Healthcheck'):edit_refuse('UNSUPPORTED_CONTAINER')
    image_env=set(image.get('Env') or [])
    env=[e for e in config.get('Env') or [] if e not in image_env]
    if any(edit_env_value_problem(e.partition('=')[2]) or not EDIT_ENV_KEY.fullmatch(e.partition('=')[0]) for e in env):edit_refuse('UNSUPPORTED_CONTAINER')
    image_labels=image.get('Labels') or {}
    labels={k:v for k,v in (config.get('Labels') or {}).items() if image_labels.get(k)!=v}
    if any(str(k).startswith(('docknest.','com.docker.compose.')) for k in labels):edit_refuse('UNSUPPORTED_CONTAINER')
    mounts=[]
    for m in c.get('Mounts') or []:
        if m.get('Type') not in ('bind','volume') or ',' in str(m.get('Source')) or ',' in str(m.get('Destination')) or '=' in str(m.get('Destination')):edit_refuse('UNSUPPORTED_CONTAINER')
        if m.get('Type')=='volume' and (m.get('Driver') or 'local')!='local':edit_refuse('UNSUPPORTED_CONTAINER')
        if m.get('Type')=='bind' and (edit_path_refused(m.get('Source') or '/') or (m.get('Propagation') or '') not in ('','rprivate','private')):edit_refuse('UNSUPPORTED_CONTAINER')
        mounts.append({'type':m['Type'],'source':m.get('Name') if m['Type']=='volume' else m.get('Source'),'target':m.get('Destination'),'readonly':not m.get('RW',True)})
    networks=[n for n in ((c.get('NetworkSettings') or {}).get('Networks') or {}) if n!='none']
    primary=mode if mode in networks else (networks[0] if networks else 'bridge')
    def aliases(network):
        values=[a for a in (((c.get('NetworkSettings') or {}).get('Networks') or {}).get(network) or {}).get('Aliases') or [] if a and a!=c.get('Id','')[:12] and SAFE_NAME.fullmatch(a)]
        return list(dict.fromkeys(values))
    policy=hc.get('RestartPolicy') or {}
    restart=policy.get('Name') or 'no'
    if restart not in ('no','always','unless-stopped','on-failure'):edit_refuse('UNSUPPORTED_CONTAINER')
    if restart=='on-failure' and policy.get('MaximumRetryCount'):restart+=':%d'%int(policy['MaximumRetryCount'])
    entrypoint=config.get('Entrypoint') or [];command=config.get('Cmd') or []
    custom_entry=entrypoint!=(image.get('Entrypoint') or [])
    plan={'name':c['Name'].lstrip('/'),'imageRef':config.get('Image'),'imageId':c.get('Image'),'restart':restart,'network':'bridge' if primary=='default' else primary,
        'aliases':aliases(primary) if primary not in ('bridge','default') else [],'extraNetworks':[{'name':n,'aliases':aliases(n)} for n in networks if n!=primary],
        'ports':[{'host':int(b.get('HostPort')),'container':int(k.split('/')[0]),'protocol':k.split('/')[1] if '/' in k else 'tcp','hostIp':b.get('HostIp') or ''} for k,v in sorted((hc.get('PortBindings') or {}).items()) for b in v or [] if str(b.get('HostPort') or '').isdigit()],
        'mounts':mounts,'tmpfs':[[d,o] for d,o in temporary_mounts(c)],'extraHosts':[h for h in hc.get('ExtraHosts') or [] if re.fullmatch(r'[A-Za-z0-9.-]+:[0-9a-fA-F.:]+|[A-Za-z0-9.-]+:host-gateway',h)],
        'init':bool(hc.get('Init')),'labels':labels,'user':config.get('User') if config.get('User')!=image.get('User') else None,
        'workdir':config.get('WorkingDir') if config.get('WorkingDir')!=image.get('WorkingDir') else None,
        'entrypoint':entrypoint if custom_entry else None,'command':command if custom_entry or command!=(image.get('Cmd') or []) else None,
        'hostname':config.get('Hostname') if config.get('Hostname') and config.get('Hostname')!=c.get('Id','')[:12] else None,
        'stopSignal':config.get('StopSignal') if config.get('StopSignal')!=image.get('StopSignal') else None,
        'envKeys':[e.partition('=')[0] for e in env],'running':bool((c.get('State') or {}).get('Running'))}
    if len(plan['extraHosts'])!=len(hc.get('ExtraHosts') or []):edit_refuse('UNSUPPORTED_CONTAINER')
    return plan,env
def edit_container_changes(req,plan):
    changes=req.get('containerChanges') or {}
    if not isinstance(changes,dict) or set(changes)-{'image','ports'}:edit_refuse('INVALID_REQUEST')
    new=json.loads(json.dumps(plan))
    if 'image' in changes:
        if not isinstance(changes['image'],str) or not IMAGE_TAG.fullmatch(changes['image']):edit_refuse('INVALID_REQUEST','image')
        if changes['image']!=plan['imageRef']:new['imageRef']=changes['image'];new['imageId']=None
    if 'ports' in changes:
        ports=changes['ports']
        if not isinstance(ports,list) or len(ports)>50:edit_refuse('INVALID_REQUEST','ports')
        clean=[]
        for p in ports:
            if not isinstance(p,dict):edit_refuse('INVALID_REQUEST','ports')
            host,target,protocol,ip=p.get('host'),p.get('container'),p.get('protocol') or 'tcp',p.get('hostIp') or ''
            if any(not isinstance(v,int) or isinstance(v,bool) or not 1<=v<=65535 for v in (host,target)) or protocol not in ('tcp','udp') or not isinstance(ip,str):edit_refuse('INVALID_REQUEST','ports')
            if ip:
                try:ipaddress.ip_address(ip)
                except ValueError:edit_refuse('INVALID_REQUEST','ports')
            clean.append({'host':host,'container':target,'protocol':protocol,'hostIp':ip})
        new['ports']=clean
    return new
def edit_container_env(env,edits):
    values=dict(e.partition('=')[::2] for e in env);keys=list(values)
    changes={'added':[],'replaced':[],'removed':[]}
    for item in edits:
        if item.get('remove'):
            if item['key'] not in values:edit_refuse('ENV_REFUSED',item['key'])
            values.pop(item['key']);changes['removed'].append(item['key'])
        else:
            changes['replaced' if item['key'] in values else 'added'].append(item['key'])
            if item['key'] not in values:keys.append(item['key'])
            values[item['key']]=item['value']
    if len(values)>EDIT_ENV_KEYS:edit_refuse('ENV_REFUSED')
    return ['%s=%s'%(k,values[k]) for k in keys if k in values],changes
def edit_container_check(req,inv,key):
    c=edit_container(inv['container'],inv);plan,env=edit_container_plan(c,inv)
    grouped=edit_env_edits(req,['container']);new_env,changes=edit_container_env(env,grouped.get('container',[]))
    candidate=edit_container_changes(req,plan)
    def published(p):return {(x['hostIp'],x['host'],x['protocol']) for x in p['ports']}
    new_ports=edit_new_ports(published(plan),published(candidate),req.get('sshPort'))
    changed=(['container.image'] if candidate['imageRef']!=plan['imageRef'] else [])+(['container.ports'] if candidate['ports']!=plan['ports'] else [])+(['container.environment'] if new_env!=env else [])
    before={'container':c.get('Id'),'env':edit_keyed(key,'\n'.join(env).encode())}
    digest=edit_digest(key,'container',candidate,{'container':edit_keyed(key,'\n'.join(new_env).encode())},before)
    verdict={'changed':changed,'envChanged':changes,'imageChanged':candidate['imageRef']!=plan['imageRef'],'newPorts':new_ports,
        'hashes':[{'path':'container','before':before['env'],'after':edit_keyed(key,'\n'.join(new_env).encode()),'keyed':True}],'frozen':[],'reviewedModelSha256':digest}
    return verdict,{'container':c,'plan':plan,'candidate':candidate,'env':new_env,'envBefore':before['env']}
def edit_create_args(plan,env_file,name):
    args=['create','--name',name,'--restart',plan['restart'],'--network',plan['network']]
    for a in plan['aliases']:args+=['--network-alias',a]
    for p in plan['ports']:args+=['-p','%s%d:%d/%s'%(('[%s]:'%p['hostIp'] if ':' in p['hostIp'] else p['hostIp']+':') if p['hostIp'] else '',p['host'],p['container'],p['protocol'])]
    for m in plan['mounts']:args+=['--mount','type=%s,src=%s,dst=%s%s'%(m['type'],m['source'],m['target'],',readonly' if m['readonly'] else '')]
    for d,o in plan['tmpfs']:args+=['--tmpfs',tmpfs_argument(d,o)]
    for h in plan['extraHosts']:args+=['--add-host',h]
    if plan['init']:args.append('--init')
    for k,v in sorted(plan['labels'].items()):args+=['--label','%s=%s'%(k,v)]
    if plan['user'] is not None:args+=['--user',plan['user']]
    if plan['workdir'] is not None:args+=['--workdir',plan['workdir']]
    if plan['hostname']:args+=['--hostname',plan['hostname']]
    if plan['stopSignal']:args+=['--stop-signal',plan['stopSignal']]
    command=list(plan['command'] or [])
    if plan['entrypoint'] is not None:
        entry=list(plan['entrypoint']);args+=['--entrypoint',entry[0] if entry else '']
        command=entry[1:]+command
    args+=['--env-file',str(env_file),plan['imageRef']]
    return args+command

# ---- operations ----
def edit_load(req,edit_id,site,roots,inv):
    if 'container' not in inv:return edit_compose_load(req,inv,roots)
    c=edit_container(inv['container'],inv)
    usable={'compose':False,'env':True,'ports':True,'image':True};reasons={'compose':'NOT_COMPOSE'}
    try:plan,env=edit_container_plan(c,inv)
    except EditRefused as refused:
        for tab in ('env','ports','image'):usable[tab]=False;reasons[tab]=refused.code
        plan,env={'imageRef':(c.get('Config') or {}).get('Image'),'ports':[]},[]
    health=bool((c.get('State') or {}).get('Health'))
    emit(result={'ok':True,'files':[],'env':[{'file':'container','keys':[e.partition('=')[0] for e in env]}],'services':[{'name':inv['container'],'image':plan['imageRef'],
        'ports':[{**p,'host':str(p['host'])} for p in plan['ports']],'frozen':not usable['env'],'healthcheck':health}],'composeVersion':None,'usable':usable,'reasons':reasons})
EDIT_OWN_LABEL='io.github.dahanitamar.docknest'
def edit_refuse_own_site(containers):
    """DockNest's own containers carry its image label: changing them would stop the dashboard mid-edit."""
    if any(EDIT_OWN_LABEL in (((c.get('Config') or {}).get('Labels')) or {}) for c in containers):edit_refuse('OWN_SITE')
def edit_check(req,edit_id,site,roots,inv):
    key=edit_model_key();containers=edit_site_containers(inv)
    edit_refuse_own_site(containers)
    verdict,_=edit_container_check(req,inv,key) if 'container' in inv else edit_compose_check(req,inv,roots,key)
    # An image change rolls data back in place: every data set must be copyable (local volumes), and Review shows the size.
    if verdict.get('imageChanged'):verdict['dataBytes']=edit_data_size(edit_data_sets(req.get('config') if isinstance(req.get('config'),dict) else {},containers))
    emit(result={'ok':True,'verdict':verdict})
def edit_store_file(d,index,kind,data):
    folder=d/kind;folder.mkdir(mode=0o700,exist_ok=True)
    edit_private_write(folder/str(index),data)
def edit_prepare(req,edit_id,site,roots,inv):
    key=edit_model_key();reviewed=req.get('reviewedModelSha256')
    if not isinstance(reviewed,str) or not re.fullmatch(r'[0-9a-f]{64}',reviewed):edit_refuse('INVALID_REQUEST')
    existing=edit_journal(edit_id)
    if existing and existing.get('state')!='prepared':edit_refuse('INVALID_REQUEST')
    container='container' in inv
    verdict,context=edit_container_check(req,inv,key) if container else edit_compose_check(req,inv,roots,key,keep=True)
    try:
        if verdict['reviewedModelSha256']!=reviewed:edit_refuse('FILE_CHANGED')
        d=edit_dir(edit_id)
        if not (existing and existing.get('reviewedModelSha256')==reviewed):
            if d.exists() and not d.is_symlink():shutil.rmtree(d)
            try:
                edit_root();d.mkdir(mode=0o700,exist_ok=True)
                journal={'version':1,'editId':edit_id,'siteId':site,'kind':'container' if container else 'compose','state':'prepared','reviewedModelSha256':reviewed,
                    'invocation':inv,'restoreData':False,'createdAt':time.time(),'dataCopy':bool(verdict.get('imageChanged'))}
                if container:
                    journal['container']={'id':context['container']['Id'],'name':inv['container'],'plan':context['plan'],'candidate':context['candidate'],'envBefore':context['envBefore'],'renamed':'%s-docknest-%s'%(inv['container'],edit_id[:8])}
                    edit_store_file(d,0,'candidates',('\n'.join(context['env'])+'\n').encode())
                    journal['images']={inv['container']:{'id':context['plan']['imageId'],'ref':context['plan']['imageRef']}}
                else:
                    records=[];pending={**context['compose'],**context['env']}
                    for i,(path,(data,info)) in enumerate(sorted(context['originals'].items())):
                        edit_store_file(d,i,'originals',data);edit_store_file(d,i,'candidates',pending[path])
                        records.append({'index':i,'path':path,**info,'candidateSha256':edit_sha(pending[path])})
                    journal['files']=records;journal['currentModel']=context['current'];journal['currentEnv']=context['currentEnv'];journal['currentFirst']=context['currentFirst']
                    journal['changedServices']=edit_image_services(context['current'],context['candidate'])
                    images={}
                    for item in edit_project_containers(inv):
                        if item['service'] and item['image'] and item['service'] not in images:images[item['service']]={'id':item['image'],'ref':item['ref']}
                    for name,service in context['current']['services'].items():
                        if name not in images and service.get('image'):
                            try:images[name]={'id':edit_docker('image','inspect','--format','{{.Id}}',service['image'],inv=inv).decode().strip(),'ref':service['image']}
                            except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError):pass
                    journal['images']=images
                for service,item in journal['images'].items():
                    if item.get('id'):edit_docker('tag',item['id'],edit_tag(edit_id,service),inv=inv)
                edit_save(edit_id,journal)
            except OSError as error:
                if error.errno==errno.ENOSPC:edit_refuse('DISK_FULL')
                raise
        journal=edit_journal(edit_id);pulled=[]
        try:
            if container:
                if context['candidate']['imageRef']!=context['plan']['imageRef']:
                    edit_docker('pull',context['candidate']['imageRef'],timeout=EDIT_PULL_SECONDS,inv=inv);pulled=[inv['container']]
            elif journal['changedServices']:
                edit_compose(inv,['pull','--quiet',*journal['changedServices']],context['files'],context['envs'],timeout=EDIT_PULL_SECONDS);pulled=list(journal['changedServices'])
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired):
            edit_refuse('DISK_FULL' if edit_disk_low() else 'PULL_FAILED')
        emit(result={'ok':True,'pulled':pulled})
    finally:
        if not container:shutil.rmtree(context['folder'],ignore_errors=True)
def edit_restore_files(edit_id,journal):
    d=edit_dir(edit_id)
    for record in journal.get('files') or []:
        try:current=edit_sha(edit_read(record['path'])[0])
        except FileNotFoundError:current=None
        if current==record['sha256']:continue
        data=(d/'originals'/str(record['index'])).read_bytes()
        if edit_sha(data)!=record['sha256']:edit_refuse('ROLLBACK_FAILED')
        edit_atomic_write(record['path'],data,record['uid'],record['gid'],record['mode'],edit_id[:8])
def edit_reference(journal,inv,roots,key):
    """Gate on the REAL files in the real folder (item 5): same resolution, same gate, same digest."""
    _,model,env_digests=edit_resolve(inv,roots,key,None,None,None,journal['currentFirst'])
    edit_gate(journal['currentModel'],model,roots,journal['currentEnv'],env_digests)
    before={r['path']:r['sha256'] for r in journal['files']}
    return edit_digest(key,'compose',model,env_digests,before)
def edit_apply(req,edit_id,site,roots,inv):
    key=edit_model_key();cfg=edit_maintenance_config(req)
    journal=edit_journal(edit_id)
    if not journal:edit_refuse('NO_JOURNAL')
    if journal.get('state')!='prepared' or journal.get('reviewedModelSha256')!=req.get('reviewedModelSha256') or journal.get('invocation')!=inv:edit_refuse('INVALID_REQUEST')
    if 'maintenanceBefore' not in journal:journal['maintenanceBefore']=edit_maintenance_on_now(cfg)
    journal['maintenanceOn']=True;edit_save(edit_id,journal)
    edit_maintenance(cfg,True)
    if journal['kind']=='container':return edit_apply_container(edit_id,journal,inv,key,cfg)
    for record in journal['files']:
        try:_,info=edit_read(record['path'])
        except FileNotFoundError:edit_refuse('FILE_CHANGED',reason=EDIT_REASONS['FILE_CHANGED_APPLY'])
        if (info['inode'],info['dev'],info['sha256'])!=(record['inode'],record['dev'],record['sha256']):edit_refuse('FILE_CHANGED',reason=EDIT_REASONS['FILE_CHANGED_APPLY'])
    if journal.get('dataCopy'):
        edit_take_data_copy(edit_id,journal,cfg,edit_site_containers(inv),lambda:edit_compose(inv,['stop'],timeout=300))
    journal['resourcesBefore']=edit_project_resources(inv)
    journal['state']='candidate_written';journal['candidateWrittenAt']=time.time();edit_save(edit_id,journal)
    d=edit_dir(edit_id)
    for record in journal['files']:
        data=(d/'candidates'/str(record['index'])).read_bytes()
        if edit_sha(data)!=record['candidateSha256']:edit_refuse('FAILED')
        edit_atomic_write(record['path'],data,record['uid'],record['gid'],record['mode'],edit_id[:8])
    try:digest=edit_reference(journal,inv,roots,key)
    except EditRefused:digest=None
    if digest!=journal['reviewedModelSha256']:
        edit_restore_files(edit_id,journal)
        journal['state']='prepared';edit_save(edit_id,journal)
        edit_refuse('FILE_CHANGED',reason=EDIT_REASONS['FILE_CHANGED_APPLY'])
    started=time.time()
    try:edit_compose(inv,['up','-d','--no-build','--pull','never'],timeout=900)
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired):edit_refuse('APPLY_FAILED')
    journal['state']='applied';journal['startedAt']=started;edit_save(edit_id,journal)
    emit(result={'ok':True,'startedAt':started,'dataCopy':bool(journal.get('data') is not None),'dataBytes':journal.get('dataBytes')})
def edit_apply_container(edit_id,journal,inv,key,cfg):
    c=edit_container(inv['container'],inv);info=journal['container']
    if c.get('Id')!=info['id']:edit_refuse('FILE_CHANGED',reason=EDIT_REASONS['FILE_CHANGED_APPLY'])
    plan,env=edit_container_plan(c,inv)
    if edit_keyed(key,'\n'.join(env).encode())!=info['envBefore'] or json.loads(json.dumps(plan))!=info['plan']:edit_refuse('FILE_CHANGED',reason=EDIT_REASONS['FILE_CHANGED_APPLY'])
    d=edit_dir(edit_id);env_file=d/'container.env'
    candidate=(d/'candidates'/'0').read_bytes()
    if journal.get('dataCopy'):
        try:edit_take_data_copy(edit_id,journal,cfg,[c],lambda:edit_docker('stop','--time','30',info['id'],inv=inv))
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired):edit_refuse('APPLY_FAILED')
    journal['state']='candidate_written';journal['candidateWrittenAt']=time.time();edit_save(edit_id,journal)
    try:
        edit_docker('stop','--time','30',info['id'],inv=inv)
        edit_docker('rename',info['id'],info['renamed'],inv=inv)
        edit_private_write(env_file,candidate)
        try:new=edit_docker(*edit_create_args(info['candidate'],env_file,info['name']),inv=inv).decode().strip()
        finally:env_file.unlink(missing_ok=True)
        journal['container']['newId']=new;edit_save(edit_id,journal)
        for network in info['candidate']['extraNetworks']:
            edit_docker('network','connect',*[part for a in network['aliases'] for part in ('--alias',a)],network['name'],new,inv=inv)
        started=time.time();edit_docker('start',new,inv=inv)
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired):edit_refuse('APPLY_FAILED')
    journal['state']='applied';journal['startedAt']=started;edit_save(edit_id,journal)
    emit(result={'ok':True,'startedAt':started,'dataCopy':bool(journal.get('data') is not None),'dataBytes':journal.get('dataBytes')})
def edit_poll(req,edit_id,site,roots,inv):
    services=req.get('services');final=req.get('final') is True
    started=req.get('windowStartedAt');limit=req.get('timeLimitSeconds')
    if not isinstance(services,list) or not all(isinstance(s,str) for s in services) or not isinstance(started,(int,float)) or isinstance(started,bool) or not isinstance(limit,int) or not 60<=limit<=600:edit_refuse('INVALID_REQUEST')
    now=time.time();elapsed=max(0,round(now-started))
    final=final or elapsed>=limit
    def answer(state,reason=None):
        emit(result={'ok':True,'state':state,**({'reason':reason} if reason else {}),'healthSeconds':elapsed})
    if 'container' in inv:
        try:items=[{'service':inv['container'],'State':edit_container(inv['container'],inv).get('State') or {}}]
        except EditRefused:items=[]
    else:items=edit_project_containers(inv)
    by_service={}
    for item in items:by_service.setdefault(item['service'],[]).append(item['State'])
    waiting=False
    for name in services:
        states=by_service.get(name)
        if not states:
            if final:return answer('unhealthy','%s did not start.'%name[:64])
            waiting=True;continue
        for state in states:
            status=state.get('Status')
            if status in ('exited','dead'):return answer('unhealthy','%s stopped after it started.'%name[:64])
            if not state.get('Running') or status=='restarting':
                if final:return answer('unhealthy','%s is not running.'%name[:64])
                waiting=True;continue
            health=(state.get('Health') or {}).get('Status')
            if health=='unhealthy':return answer('unhealthy','%s reports unhealthy.'%name[:64])
            if health and health!='healthy':waiting=True
            try:since=__import__('calendar').timegm(time.strptime(str(state.get('StartedAt'))[:19],'%Y-%m-%dT%H:%M:%S')) if state.get('StartedAt') else now
            except ValueError:since=now
            if now-max(since,started)<60:waiting=True
    if not waiting and req.get('healthUrl'):
        url=req['healthUrl']
        if not isinstance(url,str) or not url.startswith(('http://','https://')) or len(url)>2048:edit_refuse('INVALID_REQUEST')
        try:
            status,body=fetch(url,10,tuple(((req.get('config') or {}).get('domains') or ())))
            if not (200<=status<=399) or b'dbm-maintenance-v1' in body:waiting=True
        except ProbePolicyError:waiting=True
        except Exception:waiting=True
    if not waiting:return answer('healthy')
    if final:return answer('unhealthy','The site did not become healthy in %d minutes.'%max(1,round(limit/60)))
    answer('waiting')
def edit_rollback(req,edit_id,site,roots,inv):
    journal=edit_journal(edit_id)
    if not journal:emit(result={'ok':True,'journal':False,'leftovers':0});return
    if journal.get('invocation')!=inv:edit_refuse('INVALID_REQUEST')
    if isinstance(req.get('restoreData'),bool):journal['restoreData']=req['restoreData']
    journal['rollbackStartedAt']=time.time();edit_save(edit_id,journal)
    leftovers=0
    try:
        if journal['kind']=='container':edit_rollback_container(edit_id,journal,inv)
        else:
            edit_restore_files(edit_id,journal)
            # Data back in place (only when an image changed): every container of the project stops first, the
            # candidate's new services included, so nothing writes while the copy goes back.
            if journal.get('restoreData') and journal.get('data') and journal.get('state') in ('candidate_written','applied','rolled_back') and any(r.get('state')!='restored' for r in journal['data']):
                ids=[c['id'] for c in edit_project_containers(inv) if c.get('id')]
                if ids:edit_docker('stop','--time','30',*ids,timeout=300,inv=inv)
                edit_restore_data(edit_id,journal)
            if journal.get('state') in ('candidate_written','applied','rolled_back') or journal.get('servicesStopped'):
                for service,item in (journal.get('images') or {}).items():
                    ref=item.get('ref')
                    if item.get('id') and isinstance(ref,str) and '@' not in ref and IMAGE_TAG.fullmatch(ref):
                        try:edit_docker('tag',edit_tag(edit_id,service),ref,inv=inv)
                        except subprocess.CalledProcessError:edit_docker('tag',item['id'],ref,inv=inv)
                edit_compose(inv,['up','-d','--no-build','--pull','never','--remove-orphans'],timeout=900)
                before=journal.get('resourcesBefore') or {}
                now=edit_project_resources(inv)
                for kind in ('volume','network'):
                    if before.get(kind) is None or now.get(kind) is None:continue
                    for name in sorted(set(now[kind])-set(before[kind])):
                        try:edit_docker(kind,'rm',name,inv=inv)
                        except (subprocess.CalledProcessError,subprocess.TimeoutExpired):leftovers+=1
    except EditRefused:raise
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError,KeyError,ValueError):edit_refuse('ROLLBACK_FAILED')
    if journal.get('state') in ('candidate_written','applied','rolled_back'):journal['state']='rolled_back'
    journal['rolledBackAt']=time.time();edit_save(edit_id,journal)
    emit(result={'ok':True,'journal':True,'leftovers':leftovers})
def edit_container_id(name,inv):
    try:return json.loads(edit_docker('inspect','--type','container',name,inv=inv))[0].get('Id')
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,OSError,IndexError):return None
def edit_rollback_container(edit_id,journal,inv):
    info=journal['container'];named=edit_container_id(info['name'],inv);renamed=edit_container_id(info['renamed'],inv)
    if named and named!=info['id']:
        edit_docker('rm','-f',named,inv=inv);named=None
    if journal.get('restoreData') and journal.get('data') and journal.get('state') in ('candidate_written','applied','rolled_back'):
        if (named or renamed)==info['id']:edit_docker('stop','--time','30',info['id'],inv=inv)
        edit_restore_data(edit_id,journal)
    if not named and renamed==info['id']:edit_docker('rename',info['id'],info['name'],inv=inv);named=info['id']
    if named!=info['id']:edit_refuse('ROLLBACK_FAILED')
    if info['plan'].get('running') or journal.get('servicesStopped'):edit_docker('start',info['id'],inv=inv)
def edit_finish(req,edit_id,site,roots,inv):
    journal=edit_journal(edit_id)
    if not journal:emit(result={'ok':True,'journal':False});return
    cfg=edit_maintenance_config(req)
    if journal.get('servicesStopped') and journal.get('state')=='prepared':
        # The safety copy stopped the site but nothing was written (no space, the copy failed): start it as it was.
        try:
            if journal['kind']=='container':edit_docker('start',journal['container']['id'],inv=inv)
            else:edit_compose(inv,['up','-d','--no-build','--pull','never'],timeout=900)
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired):edit_refuse('APPLY_FAILED')
    if journal.get('maintenanceOn') and not journal.get('maintenanceBefore'):
        running=[c['id'] for c in edit_project_containers(inv) if (c.get('State') or {}).get('Running')] if 'container' not in inv else [x for x in [edit_container_id(inv['container'],inv)] if x]
        edit_maintenance(cfg,False,running)
    if journal['kind']=='container':
        info=journal['container'];named=edit_container_id(info['name'],inv);renamed=edit_container_id(info['renamed'],inv)
        if renamed==info['id'] and named and named!=info['id']:
            try:edit_docker('rm',info['id'],inv=inv)
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired):pass
    for service in (journal.get('images') or {}):
        try:edit_docker('image','rm','--no-prune',edit_tag(edit_id,service),inv=inv)
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired):pass
    d=edit_dir(edit_id)
    if not d.is_symlink():shutil.rmtree(d,ignore_errors=True)
    if os.name=='posix':sync_directory(EDITS_ROOT)
    emit(result={'ok':True,'journal':True})
def edit_status(req,edit_id,site,roots,inv):
    journal=edit_journal(edit_id);cfg=req.get('config') if isinstance(req.get('config'),dict) else {}
    on=edit_maintenance_on_now(cfg)
    if not journal:emit(result={'ok':True,'journal':False,'files':'none','maintenance':on,'state':None});return
    if journal['kind']=='container':
        info=journal['container'];named=edit_container_id(info['name'],inv)
        files='original' if named==info['id'] else 'candidate' if named else 'mixed'
    else:
        seen=set()
        for record in journal.get('files') or []:
            try:current=edit_sha(edit_read(record['path'])[0])
            except (FileNotFoundError,EditRefused):current=None
            seen.add('original' if current==record['sha256'] else 'candidate' if current==record['candidateSha256'] else 'mixed')
        files='original' if seen<={'original'} else 'candidate' if seen=={'candidate'} else 'mixed'
    emit(result={'ok':True,'journal':True,'files':files,'maintenance':on,'state':journal.get('state'),'dataCopy':(edit_dir(edit_id)/'data').is_dir()})
EDIT_HANDLERS={'edit-load':edit_load,'edit-check':edit_check,'edit-prepare':edit_prepare,'edit-apply':edit_apply,'edit-poll':edit_poll,
    'edit-rollback':edit_rollback,'edit-finish':edit_finish,'edit-status':edit_status}
def edit_operation(req,watch=None):
    """Entry point for every edit-* op: validate, take the site lock, run, answer with one result line."""
    global SNAPSHOT_FILTER
    op=req.get('operation');lock=None
    try:
        edit_id,site,roots,inv=edit_request(req)
        lock=edit_lock(site)
        if watch and req.get('watchStdin'):
            SNAPSHOT_FILTER='label=com.docker.compose.project='+inv['project'] if 'project' in inv else 'name='+inv['container']
            watch()
        EDIT_HANDLERS[op](req,edit_id,site,roots,inv)
    except EditRefused as refused:
        emit(result={'ok':False,'code':refused.code,'reason':refused.reason,**({'field':refused.field[:200]} if refused.field else {})})
    except Exception as error:
        # Never str(error): Docker output, paths and values stay on the server.
        diagnostic(phase='edit-failure',exceptionType=type(error).__name__)
        code='DISK_FULL' if isinstance(error,OSError) and error.errno==errno.ENOSPC else 'ROLLBACK_FAILED' if op=='edit-rollback' else 'FAILED'
        emit(result={'ok':False,'code':code,'reason':EDIT_REASONS[code]})
    finally:
        if lock:lock.close()
