# helper/runtime.py: Container engine runtime (docs/podman-rootless.md): which engine the helper talks to and how.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,pathlib,re,posixpath,stat,signal
from .common import docker, run
# STOPPING (common.py) is read at call time as a bare global: the one namespace of the built helper always holds its current value.
# </build:header>
# Root SSH stays the trust model. Root reaches every engine; no shell is ever used and every value that reaches an
# argv is validated first. The default runtime is rootful Docker and builds exactly the argv `docker` always had.
# Anything ambiguous (unknown user, no subuid range, a socket owned by someone else) is refused, never guessed.
RUNTIME_USER=re.compile(r'[a-z_][a-z0-9_-]{0,31}')
RUNTIME_UNIT=re.compile(r'[A-Za-z0-9_][A-Za-z0-9:_.@-]{0,200}\.service')
RUNTIME_ENGINES=('docker','podman')
STREAM_ERROR_TAIL=2048  # bytes of an engine's error output kept on a failed stream
STREAM_BYTES_PER_SECOND=10*1000*1000  # a slow disk or engine; the time allowed grows with the archive
STREAM_MIN_SECONDS=3600
STREAM_MAX_SECONDS=24*3600
MIN_RUNTIME_UID=1000
RUNTIME_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
class RuntimeRefused(ValueError):
    """A fixed, plain reason; never contains file contents."""
UNMAPPABLE='A file is owned by an ID the new user cannot map.'
def id_range(value,name):
    """[start, count] with start >= 1 (never host root) and a count of at least 1, or a refusal."""
    ok=isinstance(value,(list,tuple)) and len(value)==2 and all(type(v) is int for v in value) and value[0]>=1 and value[1]>=1 and value[0]+value[1]<=2**32-1
    if not ok:raise RuntimeRefused('The %s range is not valid.'%name)
    return [value[0],value[1]]
def parse_subid(text,user,uid):
    """The one [start, count] range /etc/subuid (or subgid) gives a user, by name or by numeric id.
    No range, a malformed line or more than one range is refused: rootless without subuid is never guessed."""
    found=[]
    for line in str(text or '').splitlines():
        line=line.strip()
        if not line or line.startswith('#'):continue
        parts=line.split(':')
        if len(parts)!=3:raise RuntimeRefused('A subordinate ID file has a line DockNest cannot read.')
        if parts[0]!=user and parts[0]!=str(uid):continue
        if not (all(len(x)<=10 and x.isascii() and x.isdigit() for x in parts[1:])):raise RuntimeRefused('A subordinate ID file has a line DockNest cannot read.')
        found.append(id_range([int(parts[1]),int(parts[2])],'subordinate ID'))
    if not found:raise RuntimeRefused('This user has no subordinate ID range, so DockNest cannot work with its containers.')
    if len(found)>1:raise RuntimeRefused('This user has more than one subordinate ID range, which DockNest does not support yet.')
    return found[0]
def id_map(uid,subuid,subgid,gid=None):
    """The mapping recorded in a backup manifest: the user's own ids and its subordinate ranges."""
    if type(uid) is not int or uid<MIN_RUNTIME_UID:raise RuntimeRefused('The user id is not valid.')
    gid=uid if gid is None else gid
    if type(gid) is not int or gid<MIN_RUNTIME_UID:raise RuntimeRefused('The group id is not valid.')
    return {'uid':uid,'gid':gid,'subuid':id_range(subuid,'subordinate user ID'),'subgid':id_range(subgid,'subordinate group ID')}
def translate_id(value,source,target,kind='uid'):
    """Map one on-disk id from the source map to the target map ('uid' or 'gid').
    The source user's own id becomes the target user's id; an id inside the source subordinate range keeps its offset in
    the target range. Anything else (including host root) or an offset beyond the target range is refused, and the
    result is never 0, so a restored file cannot become owned by host root."""
    if kind not in ('uid','gid'):raise RuntimeRefused('The id kind is not valid.')
    sub='sub'+kind
    try:
        own_source,own_target=source[kind],target[kind]
        start_source,count_source=id_range(source[sub],sub)
        start_target,count_target=id_range(target[sub],sub)
    except (KeyError,TypeError):raise RuntimeRefused('The id mapping is missing or not valid.')
    if type(own_source) is not int or type(own_target) is not int or own_source<1 or own_target<MIN_RUNTIME_UID:raise RuntimeRefused('The id mapping is missing or not valid.')
    if type(value) is not int or value<0:raise RuntimeRefused(UNMAPPABLE)
    if value==own_source:result=own_target
    elif start_source<=value<start_source+count_source:
        offset=value-start_source
        if offset>=count_target:raise RuntimeRefused(UNMAPPABLE)
        result=start_target+offset
    else:raise RuntimeRefused(UNMAPPABLE)
    if result<1:raise RuntimeRefused(UNMAPPABLE)
    return result
def systemd_unit(container):
    """The systemd unit that manages a Podman container (label PODMAN_SYSTEMD_UNIT), or None. An odd name is refused."""
    labels=((container or {}).get('Config') or {}).get('Labels') or {}
    unit=labels.get('PODMAN_SYSTEMD_UNIT')
    if unit is None or unit=='':return None
    if not isinstance(unit,str) or not RUNTIME_UNIT.fullmatch(unit):raise RuntimeRefused('A container is managed by a systemd unit with a name DockNest cannot use.')
    return unit
class Runtime:
    """engine docker|podman, rootless or not. Rootless needs a validated user, uid and (for Podman) home folder."""
    def __init__(self,engine='docker',rootless=False,user=None,uid=None,home=None):
        if engine not in RUNTIME_ENGINES or type(rootless) is not bool:raise RuntimeRefused('This container engine is not supported.')
        if rootless:
            if not isinstance(user,str) or not RUNTIME_USER.fullmatch(user) or type(uid) is not int or uid<MIN_RUNTIME_UID:raise RuntimeRefused('The rootless user is not valid.')
            if (not isinstance(home,str) or not home.startswith('/') or '\0' in home or '\n' in home or posixpath.normpath(home)!=home or home=='/'):raise RuntimeRefused('The rootless user has no usable home folder.')
        elif user is not None or uid is not None:raise RuntimeRefused('A rootful engine has no user.')
        self.engine,self.rootless,self.user,self.uid,self.home=engine,rootless,user,uid,home
    def describe(self):
        return {'engine':self.engine,'rootless':self.rootless,**({'user':self.user,'uid':self.uid} if self.rootless else {})}
    def argv(self,*args,bus=None):
        """The command line for one engine call. Rootful Docker is exactly ['docker', ...args]."""
        args=[str(a) for a in args]
        if self.engine=='docker' and not self.rootless:return ['docker',*args]
        if args and args[0] in ('create','run'):args=[args[0],'--pull','never',*args[1:]]  # a copy never pulls: its images come from the backup
        if not self.rootless:return ['podman',*args]
        # A rootless engine is always driven AS its user, never by root: root's Docker CLI would send root's registry logins to
        # whatever answers on a socket the user controls. env -i keeps root's environment out; PATH is fixed; a copy never
        # pulls an image (the images come from the backup).
        environment=['PATH='+RUNTIME_PATH,'XDG_RUNTIME_DIR=/run/user/%d'%self.uid,'HOME='+self.home]
        if self.engine=='docker':environment.append('DOCKER_HOST=unix:///run/user/%d/docker.sock'%self.uid)
        # Only the user's own bus path (session_bus checked it): a caller cannot name another one.
        if bus is not None and self.engine=='podman' and bus=='unix:path=/run/user/%d/bus'%self.uid:environment.append('DBUS_SESSION_BUS_ADDRESS='+bus)
        return ['runuser','-u',self.user,'--','env','-i',*environment,self.engine,*args]
    def save_arguments(self):
        """`save` with the format DockNest reads back. Podman's own default can be an OCI archive, whose image names live in index.json; a
        backup is always the docker archive (manifest.json), which is also what a Docker host writes and what a restore checks."""
        return ['save','--format','docker-archive'] if self.engine=='podman' else ['save']
    def session_bus(self,lstat=os.lstat):
        """The user's session bus address for rootless Podman, or None. Podman runs a container's health check as a systemd timer of
        the user's session, which it reaches through this bus; without it a container started by DockNest never reports healthy.
        Added only when the socket really is a socket of this user."""
        if self.engine!='podman' or not self.rootless:return None
        path='/run/user/%d/bus'%self.uid
        try:info=lstat(path)
        except OSError:return None
        return 'unix:path='+path if stat.S_ISSOCK(info.st_mode) and info.st_uid==self.uid else None
    def check_socket(self,lstat=os.lstat):
        """A rootless Docker socket is checked again right before each use: it must still be a socket of this user."""
        path='/run/user/%d/docker.sock'%self.uid
        try:info=lstat(path)
        except OSError:raise RuntimeRefused('The rootless Docker engine is not running for this user.')
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=self.uid:raise RuntimeRefused('The rootless Docker socket does not belong to this user.')
    def stream(self,*args,stdin=None,stdout=None,timeout=3600,poll=1.0):
        """One engine call whose data goes through file descriptors, never through DockNest's memory. A rootless engine runs as
        its user and cannot open root's private folders, so root opens the file and hands the engine the descriptor.
        The call is watched every `poll` seconds: a stopped step ends it (the engine is terminated, then killed) and a longer
        run than `timeout` is an error. The engine's last STREAM_ERROR_TAIL bytes of error output travel on the exception
        as `.stderr` only; they are never printed or sent."""
        if STOPPING:raise ValueError('DockNest stopped this step.')
        if self.engine=='docker' and self.rootless:self.check_socket()
        import tempfile
        with tempfile.TemporaryFile() as errors:
            # Its own session and process group: the engine child cannot outlive runuser, and a stop ends the whole group.
            command=self.argv(*args,bus=self.session_bus())
            process=subprocess.Popen(command,stdin=stdin,stdout=stdout if stdout is not None else subprocess.DEVNULL,stderr=errors,start_new_session=True,cwd=self.workdir())
            deadline=time.monotonic()+timeout
            def end(forced):
                group=getattr(os,'killpg',None)
                if group is None:
                    (process.kill if forced else process.terminate)();return
                try:group(process.pid,signal.SIGKILL if forced else signal.SIGTERM)
                except ProcessLookupError:pass  # the group is already gone
            def finish():
                end(False)
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:end(True);process.wait()
            try:
                while True:
                    try:code=process.wait(timeout=poll);break
                    except subprocess.TimeoutExpired:pass
                    if STOPPING:finish();raise ValueError('DockNest stopped this step.')
                    if time.monotonic()>=deadline:finish();raise subprocess.TimeoutExpired(command[:1],timeout)
            except BaseException:
                if process.poll() is None:finish()
                raise
            if code!=0:
                errors.seek(0,2);size=errors.tell();errors.seek(max(0,size-STREAM_ERROR_TAIL))
                raise subprocess.CalledProcessError(code,command[:1],stderr=errors.read(STREAM_ERROR_TAIL))
    def workdir(self):
        """The folder an engine of another user starts in: the helper's own working folder (root's home) is closed to that user, and
        a rootless engine that cannot enter it fails (podman ps, for one). Rootful Docker keeps the folder it always had."""
        return '/' if self.rootless else None
    def cli(self,*args,**options):
        if self.engine=='docker' and self.rootless:self.check_socket()
        if self.workdir() is not None:options.setdefault('cwd',self.workdir())
        return run(self.argv(*args,bus=self.session_bus()),**options)
    def inspect(self,ids):return json.loads(self.cli('inspect',*ids))
    def compose(self,*args):
        """Compose through the same engine: `docker compose` or `podman compose` (which runs the installed provider)."""
        return self.cli('compose',*args)
    def volume_path(self,name):
        # Lexical checks only. Callers (backup, restore) must realpath and open with no-follow before root reads or writes there.
        # The engine's answer, `inspect` and Mounts output, and a rootless user's socket are untrusted: that user controls them.
        """A named volume's folder, from the engine's own answer. Relative or odd answers are refused; a rootless volume
        must be inside the user's home."""
        if not isinstance(name,str) or not name or name.startswith('-') or '\0' in name:raise RuntimeRefused('The volume name is not valid.')
        answer=self.cli('volume','inspect','--format','{{.Mountpoint}}',name,timeout=30).decode('utf-8','replace').strip()
        if not answer.startswith('/') or '\0' in answer or '\n' in answer or posixpath.normpath(answer)!=answer:raise RuntimeRefused('The engine gave a volume folder DockNest cannot use.')
        if self.rootless and self.home is not None and not (answer==self.home or answer.startswith(self.home.rstrip('/')+'/')):raise RuntimeRefused('The engine gave a volume folder outside the home folder of the user.')
        return answer
    def unit_argv(self,action,unit):
        if action not in ('stop','start','is-active') or not isinstance(unit,str) or not RUNTIME_UNIT.fullmatch(unit):raise RuntimeRefused('The systemd unit is not valid.')
        if not self.rootless:return ['systemctl',action,'--',unit]
        return ['systemctl','--user','-M','%s@'%self.user,action,'--',unit]
    def unit_state(self,unit):
        try:return run(self.unit_argv('is-active',unit),timeout=30).decode('utf-8','replace').strip()
        except subprocess.CalledProcessError as error:return (error.output or b'').decode('utf-8','replace').strip() or 'unknown'
    def stop_unit(self,unit,container=None):
        """Stop a managed unit and require it to be inactive before the copy; anything else is refused.
        With a container name or id, the container itself must also report not running (fail closed on any other answer)."""
        run(self.unit_argv('stop',unit),timeout=300)
        if self.unit_state(unit)!='inactive':raise RuntimeRefused('A systemd unit did not stop, so DockNest did not copy its data.')
        if container is not None:
            if not isinstance(container,str) or not container or container.startswith('-'):raise RuntimeRefused('The container name is not valid.')
            try:state=self.cli('inspect','--format','{{.State.Running}}',container,timeout=30).decode('utf-8','replace').strip()
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError):state=None
            if state!='false':raise RuntimeRefused('A container is still running after its systemd unit stopped, so DockNest did not copy its data.')
    def start_unit(self,unit):run(self.unit_argv('start',unit),timeout=300)
def resolve_runtime(spec,passwd=None,subuid_text=None,socket_owner=None):
    """A Runtime from a saved site `runtime` (missing means rootful Docker), checked against the server.
    passwd(user) -> (uid, home) or None; subuid_text is /etc/subuid; socket_owner(path) -> uid. All default to the real host."""
    if spec is None:return Runtime()
    if not isinstance(spec,dict) or set(spec)-{'engine','rootless','user','uid'}:raise RuntimeRefused('The saved container engine setting is not valid.')
    engine,rootless,user,uid=spec.get('engine'),spec.get('rootless'),spec.get('user'),spec.get('uid')
    if not rootless:return Runtime(engine,rootless,user,uid)
    if not isinstance(user,str) or not RUNTIME_USER.fullmatch(user):raise RuntimeRefused('The rootless user is not valid.')
    if passwd is None:
        def passwd(name):
            import pwd
            try:entry=pwd.getpwnam(name)
            except KeyError:return None
            return entry.pw_uid,entry.pw_dir
    found=passwd(user)
    if not found or found[0]!=uid:raise RuntimeRefused('The rootless user does not match this server.')
    if type(uid) is not int or uid<MIN_RUNTIME_UID:raise RuntimeRefused('The rootless user is not valid.')
    if subuid_text is None:
        try:subuid_text=pathlib.Path('/etc/subuid').read_text()
        except OSError:raise RuntimeRefused('This server has no subordinate ID file, so DockNest cannot work with rootless containers.')
    parse_subid(subuid_text,user,uid)
    runtime=Runtime(engine,True,user,uid,found[1])
    if engine=='docker':
        path='/run/user/%d/docker.sock'%uid
        if socket_owner is None:
            def socket_owner(p):
                info=os.lstat(p)
                if not stat.S_ISSOCK(info.st_mode):raise OSError('not a socket')
                return info.st_uid
        try:owner=socket_owner(path)
        except OSError:raise RuntimeRefused('The rootless Docker engine is not running for this user.')
        if owner!=uid:raise RuntimeRefused('The rootless Docker socket does not belong to this user.')
    return runtime
def current_runtime():
    """The engine of the running operation (RUNTIME lives in common.py); rootful Docker when none is set."""
    return RUNTIME or Runtime()
class using_runtime:
    """`with using_runtime(runtime):` sets the module-wide RUNTIME for one operation and always restores the previous one,
    so one operation's engine can never leak into the next. Helper operations run one at a time in one process."""
    def __init__(self,runtime):
        if not isinstance(runtime,Runtime):raise RuntimeRefused('This container engine is not supported.')
        self.runtime=runtime
    def __enter__(self):
        global RUNTIME
        self.previous,RUNTIME=RUNTIME,self.runtime
        return self.runtime
    def __exit__(self,*exc):
        global RUNTIME
        RUNTIME=self.previous
        return False

# ---- Backup and restore through another engine (docs/podman-rootless.md, decisions 4, 5, 8) ----
# Facts of a rootless user's files are untrusted (that user controls them), so every source is checked on its way:
# absolute, normalised, no link in any component, and inside the user's home.
RUNTIME_ARCHITECTURES={'amd64':'x86_64','x86_64':'x86_64','arm64':'aarch64','aarch64':'aarch64'}
RUNTIME_OPERATIONS=('plan','readiness','capture','capture-stream','move-facts')
# Restore tests carry the runtime of the backup in `runtime`; the helper records it at prepare and every later step reads it back.
RESTORE_TEST_RUNTIME_OPERATIONS=('restore-test-check','restore-test-prepare')
def runtime_is_default(runtime):return runtime.engine=='docker' and not runtime.rootless
def check_runtime_source(runtime,path,lstat=os.lstat):
    """The path unchanged when it can be read as root for this runtime, else a refusal. Rootful Docker is never checked
    here (its existing checks apply). No link in any component, so a path cannot be swapped to point elsewhere."""
    if runtime_is_default(runtime):return path
    if not isinstance(path,str) or not path.startswith('/') or '\0' in path or '\n' in path or posixpath.normpath(path)!=path:raise RuntimeRefused('A source folder of this app has a path DockNest cannot use.')
    if runtime.rootless and not (runtime.home and (path==runtime.home or path.startswith(runtime.home.rstrip('/')+'/'))):raise RuntimeRefused('A rootless app can only be copied from its own home folder; a source is outside it.')
    current=''
    for part in path.strip('/').split('/'):
        current+='/'+part
        try:info=lstat(current)
        except OSError:raise RuntimeRefused('A source folder of this app cannot be read.')
        if stat.S_ISLNK(info.st_mode):
            if runtime.home and (runtime.home==current or runtime.home.startswith(current+'/')):raise RuntimeRefused('The home folder of '+str(runtime.user)+' goes through a link ('+current+', as on Fedora Atomic where /home is /var/home). DockNest cannot use it yet.')
            raise RuntimeRefused('A source folder of this app goes through a link, which needs a reviewed capture adapter.')
    return path
def host_id_map(runtime,subuid_text=None,subgid_text=None,group=None):
    """The ID map of a rootless runtime on this server (docs ADR decision 5). Refused when anything is missing."""
    if not runtime.rootless:raise RuntimeRefused('A rootful engine has no ID map.')
    if subuid_text is None or subgid_text is None:
        try:subuid_text,subgid_text=pathlib.Path('/etc/subuid').read_text(),pathlib.Path('/etc/subgid').read_text()
        except OSError:raise RuntimeRefused('This server has no subordinate ID files, so DockNest cannot work with rootless containers.')
    if group is None:
        import pwd
        try:group=pwd.getpwnam(runtime.user).pw_gid
        except KeyError:raise RuntimeRefused('The rootless user does not match this server.')
    return id_map(runtime.uid,parse_subid(subuid_text,runtime.user,runtime.uid),parse_subid(subgid_text,runtime.user,runtime.uid),group)
def manifest_runtime_problem(manifest):
    """None for a manifest this release may handle, else the plain refusal. Format 3 carries `runtime` (and `idMap` for
    rootless); it is the only format allowed to name anything but rootful Docker, and an incremental chain never is."""
    if not isinstance(manifest,dict):return 'Unsupported or incomplete backup'
    version,runtime=manifest.get('formatVersion'),manifest.get('runtime')
    if version!=3:return 'Unsupported or incomplete backup' if runtime is not None or 'idMap' in manifest else None
    if manifest.get('backupKind') is not None or manifest.get('chain') is not None:return 'Backups of Podman and rootless apps are not incremental yet.'
    if not isinstance(runtime,dict) or set(runtime)-{'engine','rootless','user','uid'}:return 'Unsupported or incomplete backup'
    try:
        engine=Runtime(runtime.get('engine'),runtime.get('rootless'),runtime.get('user'),runtime.get('uid'),'/home/x' if runtime.get('rootless') else None)
    except RuntimeRefused:return 'Unsupported or incomplete backup'
    if runtime_is_default(engine):return 'Unsupported or incomplete backup'
    if engine.rootless:
        try:id_map(manifest['idMap']['uid'],manifest['idMap']['subuid'],manifest['idMap']['subgid'],manifest['idMap']['gid'])
        except (RuntimeRefused,KeyError,TypeError):return 'This backup has no usable ID map.'
    elif 'idMap' in manifest:return 'Unsupported or incomplete backup'
    return None
def restore_target(manifest,requested,resolve=None,host_map=None):
    """(target Runtime, translation or None) for restoring a format 3 manifest. The target must be the same engine kind
    and the same rootless-ness; a rootless target with another map translates every owner (decision 5).
    Docker to Podman and rootful to rootless (or back) are refused in this release."""
    resolve=resolve or resolve_runtime
    spec=requested if requested is not None else manifest.get('runtime')
    target=resolve(spec)
    source=manifest.get('runtime') or {}
    if target.engine!=source.get('engine'):raise RuntimeRefused('A backup restores only into the same container engine in this release.')
    if target.rootless!=bool(source.get('rootless')):raise RuntimeRefused('A rootless backup restores only into a rootless engine, and a rootful one into a rootful engine, in this release.')
    if not target.rootless:return target,None
    target_map=(host_map or host_id_map)(target)
    source_map=manifest['idMap']
    same=all(source_map.get(key)==target_map.get(key) for key in ('uid','gid','subuid','subgid'))
    return target,(None if same else (source_map,target_map))
def translate_tree(directory,source,target,chown=None,fwalk=None,stat_at=None,opener=None,limit=2000000):
    """Re-own every entry under `directory` (which must be a real folder) from the source map to the target map.
    The first pass reads every owner and refuses the whole restore, naming the first file, when one cannot be mapped (host
    root included). The second pass re-owns children before parents, always through a directory file descriptor and
    never following a link (os.fwalk with follow_symlinks=False, chown with dir_fd and follow_symlinks=False), and it
    checks each entry still has the owner the first pass read, so a link swapped in meanwhile is re-owned as a link or
    refused, never followed to another file. Needs a platform with fwalk (Linux)."""
    chown=chown or os.chown;fwalk=fwalk or getattr(os,'fwalk',None);stat_at=stat_at or os.stat
    if fwalk is None:raise RuntimeRefused('Re-owning restored files needs Linux.')
    opener=opener or (lambda path:os.open(path,os.O_RDONLY|getattr(os,'O_DIRECTORY',0)|getattr(os,'O_NOFOLLOW',0)))
    def owner(info):
        return translate_id(info.st_uid,source,target,'uid'),translate_id(info.st_gid,source,target,'gid')
    try:top=opener(directory)
    except OSError:raise RuntimeRefused('A restore folder cannot be a link or missing.')
    try:
        plan=[];first=None;count=0
        for dirpath,dirs,files,fd in fwalk(directory,topdown=False,follow_symlinks=False):
            for name in files+dirs:
                count+=1
                if count>limit:raise RuntimeRefused('A backup holds too many files to restore with ID translation.')
                info=stat_at(name,dir_fd=fd,follow_symlinks=False)
                try:plan.append((dirpath,name,info.st_uid,info.st_gid)+owner(info))
                except RuntimeRefused:
                    if first is None:first=posixpath.join(dirpath,name)
        rootinfo=stat_at('.',dir_fd=top,follow_symlinks=False)
        try:root_owner=owner(rootinfo)
        except RuntimeRefused:
            if first is None:first=directory
        if first is not None:
            relative=posixpath.relpath(first,directory)
            raise RuntimeRefused(UNMAPPABLE+' First file: '+(relative if len(relative)<=200 else relative[:200]))
        wanted={(dirpath,name):(uid,gid,new_uid,new_gid) for dirpath,name,uid,gid,new_uid,new_gid in plan}
        changed=0
        for dirpath,dirs,files,fd in fwalk(directory,topdown=False,follow_symlinks=False):
            for name in files+dirs:
                uid,gid,new_uid,new_gid=wanted.get((dirpath,name),(None,)*4)
                info=stat_at(name,dir_fd=fd,follow_symlinks=False)
                if uid is None or (info.st_uid,info.st_gid)!=(uid,gid):raise RuntimeRefused('The restored files changed while their owners were being translated.')
                chown(name,new_uid,new_gid,dir_fd=fd,follow_symlinks=False);changed+=1
        chown('.',root_owner[0],root_owner[1],dir_fd=top,follow_symlinks=False)
        return changed+1
    finally:
        try:os.close(top)
        except (OSError,TypeError):pass
def chmod_folder(path,mode,opener=None,fchmod=None):
    """chmod of a real folder through a descriptor opened without following a link."""
    opener=opener or (lambda value:os.open(value,os.O_RDONLY|getattr(os,'O_DIRECTORY',0)|getattr(os,'O_NOFOLLOW',0)))
    try:fd=opener(str(path))
    except OSError:raise RuntimeRefused('A restore folder cannot be a link or missing.')
    try:(fchmod or os.fchmod)(fd,mode)
    finally:
        try:os.close(fd)
        except (OSError,TypeError):pass
def refuse_links(path,lstat=os.lstat,allow_missing=True):
    """No link in any component of an absolute path, else a refusal (a missing last component is fine when allowed)."""
    if not isinstance(path,str) or not path.startswith('/'):raise RuntimeRefused('A restored file has a path DockNest cannot use.')
    current=''
    for part in path.strip('/').split('/'):
        current+='/'+part
        try:info=lstat(current)
        except FileNotFoundError:
            if allow_missing and current==path:return
            raise RuntimeRefused('A restored file cannot be read.')
        except OSError:raise RuntimeRefused('A restored file cannot be read.')
        if stat.S_ISLNK(info.st_mode):raise RuntimeRefused('A restored database file goes through a link, so DockNest did not read it as root.')
def engine_architecture():
    runtime=current_runtime()
    if runtime.engine=='docker':return docker('info','--format','{{.Architecture}}').decode().strip()
    name=docker('info','--format','{{.Host.Arch}}').decode().strip()
    return RUNTIME_ARCHITECTURES.get(name,name)
def engine_storage_root():
    runtime=current_runtime()
    if runtime.engine=='docker':return docker('info','--format','{{.DockerRootDir}}').decode().strip()
    return docker('info','--format','{{.Store.GraphRoot}}').decode().strip()

RUNTIME_DATA_BASE='/var/lib/docker-backup-manager/rootless-restore'
def rootless_data_root(runtime,job,base=RUNTIME_DATA_BASE,lstat=os.lstat,mkdir=os.mkdir,chmod=os.chmod,geteuid=None,listdir=os.listdir):
    """The folder where a rootless restore keeps its data: root-owned and only traversable (0711) all the way down, so the
    rootless user can reach the data of its copy but never create, swap or link anything in the folders root writes into.
    An existing folder that is a link, not root-owned or writable by others is refused."""
    if not runtime.rootless or (geteuid or os.geteuid)()!=0:raise RuntimeRefused('A rootless restore needs root and a rootless engine.')
    if not isinstance(job,str) or not re.fullmatch(r'[0-9a-f-]{36}',job):raise RuntimeRefused('The restore job is not valid.')
    path=base
    for part in ['',str(runtime.uid),job]:
        path=posixpath.join(path,part) if part else path
        try:info=lstat(path)
        except FileNotFoundError:
            try:mkdir(path,0o711);chmod(path,0o711);info=lstat(path)
            except FileNotFoundError:raise RuntimeRefused('The folder for rootless restores cannot be made: '+posixpath.dirname(path)+' does not exist on this server.')
        except OSError:raise RuntimeRefused('The restore folder cannot be checked.')
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeRefused('The restore folder is not safe to use.')
        if part==job and listdir(path):raise RuntimeRefused('The restore folder is not empty.')
    return path

def remove_rootless_data_root(runtime,job,base=RUNTIME_DATA_BASE,lstat=os.lstat,rmtree=None):
    """Removes <base>/<uid>/<job> of a rootless restore. A folder that is a link, not root-owned or writable by others is
    left alone and refused. Nothing there to remove is fine. Returns True when a folder was removed."""
    if not runtime.rootless or not isinstance(job,str) or not re.fullmatch(r'[0-9a-f-]{36}',job):raise RuntimeRefused('The restore job is not valid.')
    path=posixpath.join(base,str(runtime.uid),job)
    try:info=lstat(path)
    except FileNotFoundError:return False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeRefused('The restore folder is not safe to remove.')
    if rmtree is None:
        import shutil
        if os.name=='posix' and not getattr(shutil.rmtree,'avoids_symlink_attacks',False):raise RuntimeRefused('Safe directory removal is unavailable on this host.')
        rmtree=shutil.rmtree
    rmtree(path)
    return True
def rootless_hardening_problem(runtime,hardening):
    """A rootless engine reads a custom seccomp profile as the user, from a file only root can read here: refused rather
    than created without it. `hardening` is the original container's hardening record."""
    if runtime.rootless and hardening.get('seccomp') not in ('default','unconfined'):return 'This app uses a custom seccomp profile, which a rootless copy cannot load yet.'
    return None

def engine_load(archive):
    """`docker load` of one image archive. Rootful Docker: exactly `docker load -i <archive>`. Another engine: the archive is
    opened by root (no link followed, a regular file only) and streamed to `load` on standard input."""
    runtime=current_runtime()
    if runtime_is_default(runtime):return docker('load','-i',str(archive))
    fd=os.open(str(archive),os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):raise RuntimeRefused('The image archive is not a regular file.')
        size=os.fstat(fd).st_size
        runtime.stream('load',stdin=fd,timeout=min(STREAM_MAX_SECONDS,max(STREAM_MIN_SECONDS,size//STREAM_BYTES_PER_SECOND+600)))
    finally:os.close(fd)
def engine_save(path,*references):
    """`docker save -o <path> <images>`. Rootful Docker: exactly that. Another engine: the engine writes to standard output,
    which is a file root creates (new, 0600, no link followed), so the engine never needs root's folder."""
    runtime=current_runtime()
    if runtime_is_default(runtime):return docker('save','-o',str(path),*references)
    fd=os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    try:runtime.stream(*runtime.save_arguments(),*references,stdout=fd,timeout=STREAM_MAX_SECONDS)  # the size is not known before the engine writes it
    except BaseException:
        os.close(fd);fd=None
        try:os.unlink(str(path))
        except OSError:pass
        raise
    finally:
        if fd is not None:os.close(fd)
