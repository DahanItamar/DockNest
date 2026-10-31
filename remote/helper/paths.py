# helper/paths.py: Protected paths, mount table and source classification, source archives.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    emit, run)
# </build:header>
# A Docker bind path can conceal a remote filesystem. Unknown filesystems fail closed.
LOCAL_FILESYSTEMS={'ext2','ext3','ext4','xfs','btrfs','zfs','overlay'}
# Credentials, SSH and GPG keys and kernel interfaces are never captured, whoever configured the site.
PROTECTED_FILES={'/etc/shadow','/etc/shadow-','/etc/gshadow','/etc/gshadow-'}
PROTECTED_TREES=('/root/.ssh','/proc','/sys','/dev')
# A directory source that contains any of these would capture them too.
PROTECTED_CONTENT=tuple(PROTECTED_FILES)+PROTECTED_TREES+('/etc/ssh','/etc/sudoers','/etc/sudoers.d')
# Per-user key folders: an entry with one of these names is never captured, wherever it is (a /home/<user> bind mount
# would otherwise carry ~/.ssh and ~/.gnupg). Only private key stores; tokens such as ~/.aws stay application data.
PROTECTED_NAMES=('.ssh','.gnupg')
def lexical(value):
    # The helper runs on Linux; the separator swap only lets the unit tests run on a Windows workstation.
    path=posixpath.normpath(str(value).replace(os.sep,'/'))
    # POSIX keeps a leading '//' after normpath; on Linux it names the same file as '/'.
    return '/'+path.lstrip('/') if path.startswith('/') else path
def within(path,root):
    root=root.rstrip('/') or '/'
    return path==root or root=='/' or path.startswith(root+'/')
def resolved(value):
    # Both the written path and the path after following symlinks (parent links included) are checked.
    path=lexical(value)
    return [path,lexical(os.path.realpath(path))] if path.startswith('/') else [path]
def protected_lexical(path):
    return path in PROTECTED_FILES or path.startswith('/etc/sudoers') or bool(re.fullmatch(r'/etc/ssh/[^/]*_key',path)) or any(within(path,root) for root in PROTECTED_TREES) or any(part in PROTECTED_NAMES for part in pathlib.PurePosixPath(path).parts)
def protected_path(value):
    return any(protected_lexical(path) for path in resolved(value))
def protected_content(value):
    return any(any(within(item,path) for item in PROTECTED_CONTENT) for path in resolved(value) if os.path.isdir(path))
def refuse_protected_sources(cfg):
    for value in ([cfg['documentRoot']] if cfg.get('kind')=='static' and cfg.get('documentRoot') else [])+cfg.get('composeFiles',[])+cfg.get('configFiles',[]):
        if protected_path(value) or protected_content(value):raise ValueError('Protected system path refused: %s. Password databases, sudoers, SSH and GPG keys, /proc, /sys and /dev are never captured.'%value)
def protected_mount(source):
    return bool(source) and (protected_path(source) or protected_content(source))
def protected_mounts(containers):
    """Bind mounts of password databases, sudoers, SSH or GPG keys (or folders holding them) are never copied: the backup keeps
    an empty placeholder in their place and records them here, so they are recovered separately like external data."""
    return [{'container':c.get('Name','').lstrip('/'),'source':m['Source'],'destination':m.get('Destination','')} for c in containers for m in c.get('Mounts') or [] if m.get('Type')=='bind' and protected_mount(m.get('Source'))]
def protected_mount_warning(items):
    return 'Not copied: %s. These mounts hold passwords, sudo rules or SSH or GPG keys, which DockNest never copies; recover them separately before using a restored copy.'%'; '.join('%s (mounted into %s)'%(item['source'],item['container'] or 'a container') for item in items)
# The readiness check stops walking a mount after this many entries; capture always walks it all.
READINESS_SCAN_ENTRIES=200000
def protected_subpaths(source,excluded=(),limit=None):
    """Entries named .ssh or .gnupg inside a copied bind mount (2.12.1), at any depth, and whether the walk finished
    (it stops after `limit` entries). tar leaves out every entry with these names whatever this walk finds (guarded
    archives); the list names them in the warning and the manifest."""
    found=[];seen=0
    if not source or not os.path.isdir(source) or os.path.islink(source):return found,True
    for current,dirs,files in os.walk(source,followlinks=False):
        seen+=len(dirs)+len(files)
        if limit is not None and seen>limit:return found,False
        dirs.sort()
        for name in sorted(dirs+files):
            path=lexical(os.path.join(current,name))
            if name in PROTECTED_NAMES and not excluded_path(path,excluded):found.append(path)
        dirs[:]=[name for name in dirs if name not in PROTECTED_NAMES and not excluded_path(lexical(os.path.join(current,name)),excluded)]
    return found,True
def guarded_mount(m):
    """A copied bind mount: its archive leaves out every .ssh and .gnupg entry. Volumes are the container's own data."""
    return m.get('Type')=='bind' and not protected_mount(m.get('Source'))
def protected_paths(containers,exclusions=None,limit=None):
    """Key folders left out of copied bind mounts, one record per mount source (the first container that mounts it),
    and the sources whose walk stopped at `limit`."""
    result=[];seen=set();unscanned=[]
    for c in containers:
        for m in c.get('Mounts') or []:
            source=m.get('Source')
            if source in seen or not guarded_mount(m):continue
            seen.add(source)
            found,complete=protected_subpaths(source,(exclusions or {}).get(source,[]),limit)
            if not complete:unscanned.append(source)
            result+=[{'container':c.get('Name','').lstrip('/'),'source':source,'path':path} for path in found]
    return result,unscanned
def protected_path_warning(items,unscanned=()):
    more=' and %d more'%(len(items)-20) if len(items)>20 else ''
    text='Not copied: %s%s. These folders hold SSH or GPG keys, which DockNest never copies; recover them separately before using a restored copy.'%('; '.join('%s (mounted into %s)'%(item['path'],item['container'] or 'a container') for item in items[:20]),more) if items else ''
    if unscanned:text+=(' ' if text else '')+'Not fully scanned: %s. Backups leave out every .ssh and .gnupg folder in them anyway.'%'; '.join(unscanned[:20])
    return text
# The maintenance page belongs in the site's staging root, its project folders or a web root, never in system folders.
MAINTENANCE_ROOTS=('/var/lib/docknest','/var/www','/srv','/usr/share/nginx')
SYSTEM_TREES=('/etc','/root','/boot','/proc','/sys','/dev','/bin','/sbin','/lib','/lib32','/lib64','/usr/bin','/usr/sbin','/usr/lib','/usr/local/bin','/usr/local/sbin','/var/spool','/var/log','/run')
def maintenance_link_escape(directory):
    # A symlink from an allowed folder into a system folder is refused outright, even for an existing deployment.
    path=lexical(directory);real=lexical(os.path.realpath(path))
    return real!=path and real.startswith('/') and (protected_lexical(real) or any(within(real,root) for root in SYSTEM_TREES))
def system_path(value):
    return any(protected_lexical(path) or any(within(path,root) for root in SYSTEM_TREES) for path in resolved(value))
def maintenance_directory_problem(cfg,directory):
    path=lexical(directory)
    # Symlinks are followed for the system-folder check, so /var/www/x -> /etc/cron.d is refused.
    if system_path(path):return 'Maintenance directory %s is inside a system folder'%path
    roots=list(MAINTENANCE_ROOTS)+[cfg.get('stagingRoot') or '']+[posixpath.dirname(value) for value in cfg.get('composeFiles',[])]+([cfg['documentRoot']] if cfg.get('documentRoot') else [])
    if any(root and lexical(root)!='/' and within(path,lexical(root)) for root in roots):return None
    return "Maintenance directory %s is outside the site's staging root, project folders and web roots (/var/www, /srv, /usr/share/nginx)"%path
def warn(message):emit(warning=message)
def mount_table(text=None):
    if text is None:
        try:text=pathlib.Path('/proc/self/mountinfo').read_text()
        except OSError:raise ValueError('Cannot inspect Linux mount tables; capture is blocked')
    def unescape(value):return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),value)
    result=[]
    for line in text.splitlines():
        fields=line.split();
        try:
            divider=fields.index('-')
            if divider<6 or len(fields)<divider+4:raise ValueError()
            result.append({'id':fields[0],'device':fields[2],'root':unescape(fields[3]),'path':unescape(fields[4]),'filesystem':fields[divider+1],'readOnly':'ro' in fields[5].split(',')})
        except (ValueError,IndexError):raise ValueError('Malformed Linux mount table; capture is blocked')
    if not result:raise ValueError('Empty Linux mount table; capture is blocked')
    return result

def classify_source(source,table=None,excluded=()):
    table=mount_table() if table is None else table
    value=os.path.abspath(source)
    if os.path.realpath(value)!=value:raise ValueError('Source path contains a symbolic link; reviewed mapping required')
    covering=[m for m in table if value==m['path'] or value.startswith(m['path'].rstrip('/')+'/')]
    if not covering:raise ValueError('Source filesystem could not be classified')
    mount=max(covering,key=lambda m:len(m['path']))
    if mount['filesystem'] not in LOCAL_FILESYSTEMS:raise ValueError('Unsupported source filesystem: '+mount['filesystem']+'. NFS/CIFS/FUSE and unknown filesystems require an adapter.')
    if any(m['path']!=value and m['path'].startswith(value.rstrip('/')+'/') and not excluded_path(m['path'],excluded) for m in table):raise ValueError('Source contains a nested mount; reviewed capture adapter required')
    metadata=os.stat(value,follow_symlinks=False)
    result={'filesystem':mount['filesystem'],'mountId':mount['id'],'device':metadata.st_dev,'inode':metadata.st_ino,'path':value}
    if excluded:result['excludedPaths']=sorted(excluded)
    return result

def excluded_path(path,excluded):
    return any(path==entry or path.startswith(entry+'/') for entry in excluded)

def mount_exclusions(cfg,containers):
    declarations=cfg.get('mountExclusions',[])
    if declarations and not cfg.get('mountExclusionsConfirmed'):raise ValueError('Confirm excluded data is outside this backup and must be recovered separately')
    sources={m['Source'] for c in containers for m in c['Mounts']};result={}
    for item in declarations:
        source=item.get('source','');path=item.get('path','')
        if source not in sources or not re.fullmatch(r'/[a-zA-Z0-9_./-]+',path) or '..' in pathlib.PurePosixPath(path).parts or str(pathlib.PurePosixPath(path))!=path or not path.startswith(source.rstrip('/')+'/'):
            raise ValueError('Mount exclusions require a current selected source and an exact child path')
        if not isinstance(item.get('reason'),str) or not item['reason'].strip():raise ValueError('Every mount exclusion needs a recovery reason')
        if 'requiredForRestore' in item and not isinstance(item['requiredForRestore'],bool):raise ValueError('External restore requirement must be a boolean')
        if os.path.realpath(path)!=path:raise ValueError('Excluded paths cannot contain symbolic links')
        if path in result.get(source,[]):raise ValueError('Duplicate mount exclusion')
        result.setdefault(source,[]).append(path)
    for filename in cfg.get('composeFiles',[])+cfg.get('configFiles',[]):
        if any(excluded_path(filename,paths) for paths in result.values()):raise ValueError('Required configuration cannot be excluded')
    return {source:sorted(paths) for source,paths in result.items()}

def scoped_classify(source,table,exclusions):
    paths=exclusions.get(source,[])
    return classify_source(source,table,paths) if paths else classify_source(source,table)

def exclude_options(source,excluded=(),guard=False):
    options=['--no-wildcards','--anchored',*('--exclude='+source.name+'/'+os.path.relpath(path,source) for path in excluded)] if excluded else []
    # Unanchored, literal: any member whose last component is .ssh or .gnupg (and all below it), at any depth.
    if guard:options+=['--no-wildcards','--no-anchored',*('--exclude='+name for name in PROTECTED_NAMES)]
    return options

def source_archive(source,target,excluded=(),snapshot=None,guard=False):
    if snapshot is not None:
        # Incremental archives always use the POSIX format: GNU-format incremental headers keep atime/ctime where
        # ustar keeps the name prefix, so the restore path checks would read different names than GNU tar extracts.
        command=source_archive_command(source,excluded,snapshot,guard);command[command.index('-cpf')+1]=str(target)
        run(command);return
    source=pathlib.Path(source)
    options=exclude_options(source,excluded,guard)
    run(['tar','--xattrs','--acls','--numeric-owner',*options,'-cpf',str(target),'-C',str(source.parent),'--',source.name])

def source_archive_command(source,excluded=(),snapshot=None,guard=False):
    source=pathlib.Path(source)
    options=exclude_options(source,excluded,guard)
    if snapshot is not None:options=['--listed-incremental='+str(snapshot),*options]
    # atime changes when the first pass reads data; ctime is not restored.
    return ['tar','--format=posix','--pax-option=delete=atime,delete=ctime,exthdr.name=%d/PaxHeaders/%f','--xattrs','--acls','--numeric-owner',*options,'-cpf','-','-C',str(source.parent),'--',source.name]
