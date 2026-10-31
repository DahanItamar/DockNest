# helper/staging.py: Boot recovery installation and the staging folder (list, cleanup).
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    VERSION, atomic_json, emit, private_staging_base, run)
# </build:header>
def install_boot_recovery(req):
    if os.geteuid()!=0:raise ValueError('Boot recovery installation requires root')
    base=pathlib.Path(req['config'].get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts or base.resolve()!=base or str(base) in ['/','/var','/var/lib','/root','/home','/srv','/opt','/etc','/tmp']:raise ValueError('Dedicated root-owned staging directory required')
    private_staging_base(base)
    library=pathlib.Path('/usr/local/lib/docknest');registry=pathlib.Path('/etc/docknest')
    for directory in [library,registry]:
        if directory.resolve()!=directory:raise ValueError('Recovery installation paths cannot be symbolic links')
        directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        if directory.stat().st_uid!=0 or directory.stat().st_mode&0o077:raise ValueError('Recovery installation directory must be private and root-owned')
    for name,key_name in [('helper.py','helper'),('boot_recovery.py','bootHelper')]:
        content=__import__('base64').b64decode(req[key_name],validate=True)
        if len(content)>512*1024:raise ValueError('Recovery helper exceeds size limit')
        temporary=library/(name+'.new')
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as output:output.write(content);output.flush();os.fsync(output.fileno())
        os.replace(temporary,library/name)
    file=registry/'recovery-roots.json'
    roots=json.loads(file.read_text()).get('roots',[]) if file.exists() else []
    atomic_json(file,{'version':1,'roots':list(dict.fromkeys(roots+[str(base)]))})
    unit=pathlib.Path('/etc/systemd/system/docknest-source-recovery.service')
    if unit.is_symlink():raise ValueError('Recovery unit cannot be a symbolic link')
    unit.write_text('[Unit]\nDescription=DockNest interrupted source recovery\nAfter=docker.service network-online.target\nWants=network-online.target\nRequires=docker.service\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /usr/local/lib/docknest/boot_recovery.py\nTimeoutStartSec=1800\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n')
    os.chmod(unit,0o644);run(['systemctl','daemon-reload']);run(['systemctl','enable','docknest-source-recovery.service'])
    emit(result={'installed':True,'enabled':True,'startsOnNextBoot':True,'helperVersion':VERSION})

JOB_DIRECTORY=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
FORBIDDEN_STAGING=['/']
def staging_base(cfg):
    base=pathlib.Path(cfg.get('stagingRoot','/var/lib/docknest'))
    if not base.is_absolute() or '..' in base.parts or str(base) in FORBIDDEN_STAGING:raise ValueError('Use a dedicated absolute staging directory')
    return base
def is_regular(path):
    try:return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:return False
def job_folder_finished(path):
    """A real job directory (never a link) whose recovery completed and whose watchdog acknowledged it."""
    try:folder=os.lstat(path)
    except OSError:return False
    return stat.S_ISDIR(folder.st_mode) and is_regular(path/'disarmed') and is_regular(path/'watchdog.done')
def list_staging(cfg,now=None,limit=200):
    """Report job folders in the staging root for DockNest to decide on. Never deletes and never follows links."""
    now=time.time() if now is None else now
    base=staging_base(cfg);jobs=[]
    try:info=os.lstat(base)
    except FileNotFoundError:return {'root':str(base),'jobs':jobs}
    if not stat.S_ISDIR(info.st_mode) or base.resolve()!=base:raise ValueError('Staging directory cannot be a symbolic link')
    for entry in sorted(os.scandir(base),key=lambda item:item.name):
        if not JOB_DIRECTORY.fullmatch(entry.name) or not entry.is_dir(follow_symlinks=False):continue
        path=base/entry.name;finished=job_folder_finished(path);size=0;latest=os.lstat(path).st_mtime
        for current,dirs,files in os.walk(path,followlinks=False):
            for name in dirs+files:
                try:item=os.lstat(os.path.join(current,name));size+=item.st_size;latest=max(latest,item.st_mtime)
                except OSError:pass
        jobs.append({'job':entry.name,'finished':finished,'ageSeconds':max(0,int(now-latest)),'bytes':size})
        if len(jobs)>=limit:break
    return {'root':str(base),'jobs':jobs}
def cleanup_staging(req):
    root=pathlib.Path(req['root'])
    if not JOB_DIRECTORY.fullmatch(root.name) or str(root.parent)!=str(staging_base({'stagingRoot':str(root.parent)})):raise ValueError('Cleanup requires a job folder in the staging directory')
    if not job_folder_finished(root):raise ValueError('Recovery watchdog has not acknowledged disarm')
    # fd-based removal never follows a link planted inside the folder.
    if not getattr(shutil.rmtree,'avoids_symlink_attacks',False):raise ValueError('Safe directory removal is unavailable on this host')
    shutil.rmtree(root)
