# helper/dumps.py: Online logical database dumps (docs/online-dumps.md): which databases take one, the dump artifact,
# and loading it into a fresh copy before a restore starts the app.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    NOFOLLOW, diagnostic, docker, run)
from .engine_base import (
    writable_mount_source, writable_mounts_covering)
from .databases import (
    ENGINES, file_sha256)
# </build:header>
# A dump is opt-in per app and only for a capture that may leave the database running: never for a move (the source
# must stop) and never with incremental backups (a chain stores files, not dumps). Every other case keeps the stopped
# file copy, which stays the default. Any problem before or during a dump falls back to that copy; the reason is kept.
DUMP_ENGINE_NAMES={'postgres':'PostgreSQL','mysql':'MySQL','mariadb':'MariaDB','redis':'Redis','mongo':'MongoDB'}
DUMP_ARTIFACT=re.compile(r'database-\d{1,3}\.tar')
# Files inside a dump artifact: the engine's dump files, a listing and the data-folder settings files it carries.
DUMP_MEMBER=re.compile(r'(?:globals\.sql|all-databases\.sql|dump\.rdb|database-\d{1,3}\.pgdump|listing\.json|config/\.?[a-z][a-z_.-]{0,40}\.conf|config/\.?[a-z][a-z_.-]{0,40}\.cnf)')
DUMP_CONFIG_LIMIT=1024*1024
DUMP_INIT_SECONDS=600
DUMP_LOAD_SECONDS=21600

def dump_timeout(cfg):
    value=int(cfg.get('dumpTimeout',3600))
    if value<60 or value>21600:raise ValueError('Online dump timeout must be 60..21600 seconds')
    return value

def official_entrypoint(c):
    """The official images set up an empty data folder on first start; a restore of a dump relies on that."""
    entrypoint=(c.get('Config') or {}).get('Entrypoint') or []
    # The Valkey image runs it under tini: [tini, --, docker-entrypoint.sh].
    if len(entrypoint)==3 and isinstance(entrypoint[0],str) and posixpath.basename(entrypoint[0])=='tini' and entrypoint[1]=='--':entrypoint=entrypoint[2:]
    return len(entrypoint)==1 and isinstance(entrypoint[0],str) and posixpath.basename(entrypoint[0])=='docker-entrypoint.sh'

def dump_data_folder(service,c):
    """The host folder of the database's data directory, refused when it cannot be left out of the file copy."""
    engine=ENGINES[service['engine']]
    data=engine.data_directory(service,c)
    if not data or not data.startswith('/') or '..' in pathlib.PurePosixPath(data).parts:return None,None,'its data folder could not be read'
    host=writable_mount_source(data,c)
    if host is None:return None,None,'its data folder is not in a captured folder'
    if host.is_symlink() or not host.is_dir() or host.resolve()!=host:return None,None,'its data folder must be a plain folder without links'
    return data,host,None

def dump_blocker(service,c,containers):
    """Why this database cannot take an online dump now (None when it can). Read-only."""
    engine=ENGINES.get(service['engine'])
    name=DUMP_ENGINE_NAMES.get(service['engine'],'This database')
    if engine is None or not engine.dump_format:return name+' has no online dump yet'
    if service.get('persistence')=='cache':return 'it keeps nothing on disk'
    if not official_entrypoint(c):return 'its image does not use the official entrypoint that sets up an empty database on restore'
    data,host,problem=dump_data_folder(service,c)
    if problem:return problem
    source=max(writable_mounts_covering(data,c),key=lambda m:len(m['Destination']))['Source']
    for other in containers:
        if other['Id']!=c['Id'] and any(m['Source']==source for m in other['Mounts']):return 'another container in this app mounts its data folder'
    return engine.dump_blocker(service,c,host)

def dump_candidates(req,cfg,plan,containers,running):
    """{container id: (data directory, host folder)} for the running databases that take an online dump, and the
    reason for every other database. Without the request nothing changes: every database stops for the file copy."""
    if not req.get('onlineDumps'):return {},[]
    dump_timeout(cfg)
    by_id={c['Id']:c for c in containers};chosen={};fallbacks=[]
    for service in plan['services']:
        if service['role']!='database' or service['container'] not in running:continue
        c=by_id[service['container']]
        try:reason=dump_blocker(service,c,containers)
        except ValueError as error:reason=str(error)
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError):reason='its settings could not be read'
        if reason:fallbacks.append({'container':c.get('Name','').lstrip('/'),'engine':service['engine'],'reason':reason})
        else:
            data,host,_=dump_data_folder(service,c)
            chosen[service['container']]=(data,host)
    return chosen,fallbacks

def dump_failure(error):
    """A fixed reason for a failed dump. Tool output never leaves the helper: it can hold table names or data."""
    if isinstance(error,subprocess.TimeoutExpired):return 'the dump did not finish in time'
    if isinstance(error,ValueError):return str(error)
    return 'the dump command failed'

def write_member(archive,name,path):
    info=tarfile.TarInfo(name);info.size=path.stat().st_size;info.mode=0o600;info.mtime=0
    with open(path,'rb') as source:archive.addfile(info,source)

def take_dump(service,c,data,host,root,index,timeout):
    """Dump one running database into root/database-INDEX.tar and return its record. Nothing is left on failure."""
    engine=ENGINES[service['engine']]
    work=root/('database-%d'%index);target=root/('database-%d.tar'%index)
    work.mkdir(mode=0o700)
    try:
        started=time.monotonic();diagnostic(command='online dump',phase='start',engine=service['engine'])
        # One deadline for the whole dump of this database, shared by every command it runs.
        record=engine.dump(c['Id'],service,work,started+timeout)
        carried=[]
        for filename in engine.dump_config:
            # Settings files in the data folder (a dump does not hold them); read on the host, never through a link.
            try:fd=os.open(host/filename,os.O_RDONLY|NOFOLLOW|getattr(os,'O_NONBLOCK',0))
            except FileNotFoundError:continue
            except OSError:raise ValueError('a settings file in its data folder is not a regular file') from None
            with os.fdopen(fd,'rb') as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):raise ValueError('a settings file in its data folder is not a regular file')
                content=source.read(DUMP_CONFIG_LIMIT+1)
            if len(content)>DUMP_CONFIG_LIMIT:raise ValueError('a settings file in its data folder is too large')
            (work/'config').mkdir(mode=0o700,exist_ok=True)
            fd=os.open(work/'config'/filename,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as output:output.write(content)
            carried.append(filename)
        listing={'engine':service['engine'],'format':record['format'],'databases':record.get('databases',[]),'dataDirectory':data,'config':carried,**record.get('listing',{})}
        fd=os.open(work/'listing.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as output:json.dump(listing,output)
        names=sorted(p.relative_to(work).as_posix() for p in work.rglob('*') if p.is_file())
        if not all(DUMP_MEMBER.fullmatch(name) for name in names):raise ValueError('the dump wrote an unexpected file')
        with tarfile.open(target,'w',format=tarfile.PAX_FORMAT) as archive:
            for name in names:write_member(archive,name,work/name)
        os.chmod(target,0o600)
        diagnostic(command='online dump',phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='ok')
        # dataBytes: the live data folder's size, so a restore can check it has room for the loaded database.
        size=int(run(['du','-sb',str(host)]).split()[0])
        return {**listing,'method':'online logical dump','artifact':target.name,'bytes':target.stat().st_size,'sha256':file_sha256(target),'dataBytes':size}
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    finally:shutil.rmtree(work,ignore_errors=True)

def dump_artifacts(manifest):
    """The dump artifacts a manifest names; a malformed name refuses the package."""
    names=[]
    for service in (manifest.get('backupPlan') or {}).get('services') or []:
        dump=service.get('dump') if isinstance(service,dict) else None
        if dump is None:continue
        if not isinstance(dump,dict) or not isinstance(dump.get('artifact'),str) or not DUMP_ARTIFACT.fullmatch(dump['artifact']):raise ValueError('Backup names an invalid database dump')
        names.append(dump['artifact'])
    if len(names)!=len(set(names)):raise ValueError('Backup names an invalid database dump')
    return names

def dumped_services(manifest):
    return [s for s in (manifest.get('backupPlan') or {}).get('services') or [] if isinstance(s,dict) and s.get('dump')]

def read_dump(archive,destination):
    """Unpack a verified dump artifact: regular files with known names only, never a link or a path outside."""
    destination.mkdir(mode=0o700)
    with tarfile.open(archive,'r:') as tar:
        for member in tar.getmembers():
            if not member.isfile() or not DUMP_MEMBER.fullmatch(member.name):raise ValueError('The database dump in this backup holds an unexpected entry')
            target=destination/member.name
            target.parent.mkdir(mode=0o700,exist_ok=True)
            fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as output:shutil.copyfileobj(tar.extractfile(member),output,1024*1024)
    listing=json.loads((destination/'listing.json').read_text())
    if not isinstance(listing,dict) or not isinstance(listing.get('config'),list) or not isinstance(listing.get('databases'),list):raise ValueError('The database dump in this backup has no valid listing')
    return listing

def dump_bytes(manifest):
    """Room a restore needs for its dumps: the unpacked dump plus the database it becomes."""
    return sum(int(s['dump'].get('bytes') or 0)+int(s['dump'].get('dataBytes') or 0) for s in dumped_services(manifest))

def wait_for(condition,seconds,message):
    deadline=time.time()+seconds
    while time.time()<deadline:
        try:
            if condition():return
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError):pass
        time.sleep(2)
    raise ValueError(message)

def container_logs(cid):
    output=subprocess.run(['docker','logs','--tail','2000',cid],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
    return (output.stdout+output.stderr).decode(errors='replace')

def place_config(listing,directory,data_folder):
    """Put the carried settings files back in the restored data folder, owned like the folder itself."""
    owner=os.stat(data_folder,follow_symlinks=False)
    for filename in listing['config']:
        if not isinstance(filename,str) or not DUMP_MEMBER.fullmatch('config/'+filename):raise ValueError('The database dump in this backup has no valid listing')
        content=(directory/'config'/filename).read_bytes()
        path=data_folder/filename
        # Never truncate or block on something that is not a regular file (a planted FIFO or device): check, then cut.
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|NOFOLLOW|getattr(os,'O_NONBLOCK',0),0o600)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('A restored database settings file is not a regular file')
            os.ftruncate(fd,0)
            os.write(fd,content)
            if hasattr(os,'fchown'):os.fchown(fd,owner.st_uid,owner.st_gid)
        finally:os.close(fd)

def load_dumps(manifest,unpacked,root,definitions,sources,journal=None):
    """Before a restore creates the app: for every dumped database, start a throwaway copy of its container (network
    none) on the restored, empty data folder, let the official entrypoint set it up, put the carried settings back,
    restart it, load the dump and stop it cleanly. The app then starts on a loaded database and the usual data checks
    compare it with the values recorded at backup. `journal(name)` runs before the copy is created (restore tests)."""
    containers=manifest['containers']
    for service in dumped_services(manifest):
        i=next(index for index,c in enumerate(containers) if c['Id']==service['container'])
        c=containers[i];engine=ENGINES.get(service['engine'])
        if engine is None or not engine.dump_format:raise ValueError('This backup holds a database dump this helper cannot load')
        directory=root/('database-%d'%i)
        listing=read_dump(unpacked/service['dump']['artifact'],directory)
        data=listing.get('dataDirectory')
        if not isinstance(data,str) or not data.startswith('/') or '..' in pathlib.PurePosixPath(data).parts:raise ValueError('The database dump in this backup has no valid listing')
        mounts=writable_mounts_covering(data,c)
        if not mounts:raise ValueError('The database dump in this backup has no data folder to load into')
        mount=max(mounts,key=lambda m:len(m['Destination']))
        folder=pathlib.Path(sources[(mount['Type'],mount['Source'])])/pathlib.PurePosixPath(data).relative_to(mount['Destination'])
        name,args=definitions[i]
        loader=name+'-load';args=list(args);args[args.index('--name')+1]=loader
        args[args.index('--network')+1]='none'
        while '--dns' in args:del args[args.index('--dns'):args.index('--dns')+2]
        if journal:journal(loader)
        cid=docker(*args[:-1],'--log-driver','json-file',args[-1]).decode().strip()
        try:
            started=time.monotonic();diagnostic(command='load dump',phase='start',engine=service['engine'])
            docker('start',cid)
            wait_for(lambda:engine.init_marker in container_logs(cid),DUMP_INIT_SECONDS,'The restored database did not finish its first-start setup')
            wait_for(lambda:engine.ready(cid,service),120,'The restored database did not answer after its first-start setup')
            if listing['config']:
                if not folder.is_dir() or folder.is_symlink():raise ValueError('The restored database data folder is missing')
                place_config(listing,directory,folder)
                docker('restart','--time','60',cid)
                wait_for(lambda:engine.ready(cid,service),120,'The restored database did not start with its saved settings')
            engine.load_dump(cid,service,directory,listing,DUMP_LOAD_SECONDS)
            docker('stop','--time','120',cid)
            state=json.loads(docker('inspect',cid))[0]['State']
            if state['Running'] or state['ExitCode']!=0:raise ValueError('The restored database did not stop cleanly after loading its dump')
            diagnostic(command='load dump',phase='finish',elapsedMs=round((time.monotonic()-started)*1000),outcome='ok')
        except subprocess.TimeoutExpired:raise ValueError('Loading the database dump did not finish in time') from None
        except subprocess.CalledProcessError:raise ValueError('The database dump could not be loaded into the restored copy') from None
        finally:
            try:docker('rm','-f',cid)
            except Exception:pass
            shutil.rmtree(directory,ignore_errors=True)
