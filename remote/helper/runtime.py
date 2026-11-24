# helper/runtime.py: Container engine runtime (docs/podman-rootless.md): which engine the helper talks to and how.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,pathlib,re,posixpath,stat
# </build:header>
# Root SSH stays the trust model. Root reaches every engine; no shell is ever used and every value that reaches an
# argv is validated first. The default runtime is rootful Docker and builds exactly the argv `docker` always had.
# Anything ambiguous (unknown user, no subuid range, a socket owned by someone else) is refused, never guessed.
RUNTIME_USER=re.compile(r'[a-z_][a-z0-9_-]{0,31}')
RUNTIME_UNIT=re.compile(r'[A-Za-z0-9_][A-Za-z0-9:_.@-]{0,200}\.service')
RUNTIME_ENGINES=('docker','podman')
MIN_RUNTIME_UID=1000
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
    if type(own_source) is not int or type(own_target) is not int or own_source<1 or own_target<1:raise RuntimeRefused('The id mapping is missing or not valid.')
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
    def argv(self,*args):
        """The command line for one engine call. Rootful Docker is exactly ['docker', ...args]."""
        args=[str(a) for a in args]
        if self.engine=='docker' and not self.rootless:return ['docker',*args]
        if self.engine=='docker':return ['docker','--host','unix:///run/user/%d/docker.sock'%self.uid,*args]
        if not self.rootless:return ['podman',*args]
        return ['runuser','-u',self.user,'--','env','XDG_RUNTIME_DIR=/run/user/%d'%self.uid,'HOME='+self.home,'podman',*args]
    def cli(self,*args,**options):return run(self.argv(*args),**options)
    def inspect(self,ids):return json.loads(self.cli('inspect',*ids))
    def compose(self,*args):
        """Compose through the same engine: `docker compose` or `podman compose` (which runs the installed provider)."""
        return self.cli('compose',*args)
    def volume_path(self,name):
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
    def stop_unit(self,unit):
        """Stop a managed unit and require it to be inactive before the copy; anything else is refused."""
        run(self.unit_argv('stop',unit),timeout=300)
        if self.unit_state(unit)!='inactive':raise RuntimeRefused('A systemd unit did not stop, so DockNest did not copy its data.')
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
RUNTIME=Runtime()
