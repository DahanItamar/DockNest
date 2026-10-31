# helper/restore_test.py: Automatic restore tests: prepare, run, probe, teardown, reaper.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    NOFOLLOW, atomic_json, docker, emit, inspect, run)
from .databases import (
    cached_sqlite_file_proof, data_checks, restart_services)
from .backup import (
    tree_digest)
from .discovery import (
    temporary_mounts, tmpfs_argument)
from .restore import (
    MountLayoutError, chain_length, chain_paths, external_restore_plan, extract_mount, image_archives,
    mount_bytes, restore_network_plan, safe_extract, unpack_verified)
from .move import (
    save_state)
from .install import (
    systemd_present)
# Mutable state lives in common and is never copied by import: STOPPING
# </build:header>
# ---- Automatic restore tests (docs/restore-tests.md) ----
# A test restores a verified backup onto a test server with resource limits, checks it, and removes everything it
# created. Rules: every network, container, image, tag change, firewall rule and path is journalled in resources.json
# BEFORE it is created; teardown removes only what the journal lists and Docker still labels docknest.restore-test=<id>;
# it never uses `docker image rm -f`; plaintext staging lives only below the restore root and teardown removes it.
# Results say whether the backup came back ('failed' is the backup's fault) or the test could not finish ('couldnt_run').
RESTORE_TESTS_ROOT=pathlib.Path('/var/lib/docknest/restore-tests')
RESTORE_ROOT=pathlib.Path('/var/lib/docker-backup-manager/restore')
TEST_LABEL='docknest.restore-test'
TEST_MAIL_PORTS='25,465,587,2525'
TEST_MIN_FREE=1024**3
TEST_KINDS=['paths','networks','containers','images','tags','firewall']
REAPER_GRACE=600
TEST_PROBE_LIMIT=64*1024
TEST_PATH=re.compile(r'/[\x21-\x7e]{0,255}')
IMAGE_TAG=re.compile(r'[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}')
class TestOutcome(Exception):
    """A verdict, not a crash: 'failed' when the backup did not come back, 'couldnt_run' when the test server or a
    test limit stopped it. `stop` stops the copy's containers at once (watchdogs)."""
    def __init__(self,outcome,reason,checks=None,stop=False):
        super().__init__(reason);self.outcome=outcome;self.reason=reason;self.checks=checks or [];self.stop=stop
def test_id(req):
    value=str(req.get('testId',''))
    if value!=str(uuid.UUID(value)):raise ValueError('Invalid restore test id')
    return value
def test_limits(req):
    limits=req.get('limits') or {}
    memory=limits.get('memoryMb');cpus=limits.get('cpus')
    if not isinstance(memory,int) or isinstance(memory,bool) or not 256<=memory<=16384:raise ValueError('The memory limit must be a whole number from 256 to 16384 MB')
    if not isinstance(cpus,(int,float)) or isinstance(cpus,bool) or not 0.5<=cpus<=16 or cpus*4!=int(cpus*4):raise ValueError('The CPU limit must be 0.5 to 16 in steps of 0.25')
    return memory,float(cpus),limits.get('internet') is True
def limit_args(memory,cpus):
    # Swap equal to memory means no swap on top. Restart 'no' makes a crash loop visible to the stability check.
    return ['--memory','%dm'%memory,'--memory-swap','%dm'%memory,'--cpus','%g'%cpus,'--pids-limit','1024','--restart','no','--log-driver','local','--log-opt','max-size=10m','--log-opt','max-file=3']
def test_dir(tid):return RESTORE_TESTS_ROOT/tid
def test_staging(tid):return RESTORE_ROOT/tid
def test_state(tid,create=False):
    d=test_dir(tid)
    if RESTORE_TESTS_ROOT.is_symlink() or d.is_symlink():raise ValueError('The restore test folder cannot be a symbolic link')
    if create:RESTORE_TESTS_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700);d.mkdir(exist_ok=True,mode=0o700)
    file=d/'resources.json'
    state=json.loads(file.read_text()) if file.is_file() else {}
    state.setdefault('created',{})
    for kind in TEST_KINDS:state['created'].setdefault(kind,[])
    return d,state
def test_journal(d,state,kind,value):
    """Written before the effect: a crash after this line leaves a record teardown can act on."""
    if value not in state['created'][kind]:state['created'][kind].append(value)
    atomic_json(d/'resources.json',state)
def test_check(name,kind,target,status,detail=None):
    return {'name':name,'kind':kind,'target':target,'status':status,'detail':(str(detail)[:200] if detail is not None else None)}
def test_lock(tid,wait_seconds=0):
    import fcntl
    d=test_dir(tid)
    if not d.is_dir():return None
    handle=open(d/'.lock','a');deadline=time.time()+wait_seconds
    while True:
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);return handle
        except BlockingIOError:
            if time.time()>=deadline:handle.close();raise ValueError('Another DockNest step for this restore test is still running on this server.')
            time.sleep(2)
def existing_ancestor(path):
    path=pathlib.Path(path)
    while not path.exists() and path!=path.parent:path=path.parent
    return path
def mem_available(text=None):
    try:
        for line in (text if text is not None else pathlib.Path('/proc/meminfo').read_text()).splitlines():
            if line.startswith('MemAvailable:'):return int(line.split()[1])*1024
    except (OSError,ValueError,IndexError):pass
    return None
def cpu_count():
    try:return len(os.sched_getaffinity(0))
    except (AttributeError,OSError):return os.cpu_count() or 1
def docker_major():
    try:return int(docker('version','--format','{{.Server.Version}}').decode().strip().split('.')[0])
    except (ValueError,IndexError):return 0
TEST_CHAINS=('DOCKER-USER','INPUT')
def test_mail_rules(tid=None):
    """Every firewall rule a restore test added (comment docknest-restore-test-<id>), in both chains and families."""
    marker='docknest-restore-test-'+(tid or '')
    rules=[]
    for tool in ['iptables','ip6tables']:
        if not shutil.which(tool):continue
        for chain in TEST_CHAINS:
            try:lines=run([tool,'-S',chain],timeout=10).decode().splitlines()
            except Exception:continue
            rules+=[(tool,line) for line in lines if line.startswith('-A '+chain+' ') and marker in line]
    return rules
def test_leftovers(tid=None):
    selector='label='+TEST_LABEL+('='+tid if tid else '')
    return {'containers':len(docker('ps','-aq','--filter',selector).decode().split()),'networks':len(docker('network','ls','-q','--filter',selector).decode().split()),'firewall':len(test_mail_rules(tid))}
def restore_test_check(req):
    """Read-only preflight ("Check space"). Each miss is one plain sentence; the manager ends the test couldnt_run."""
    tid=test_id(req);need=req.get('need') or {};problems=[];facts={}
    memory,cpus,internet=test_limits(req)
    facts['uid']=os.geteuid() if hasattr(os,'geteuid') else 0
    if facts['uid']!=0:problems.append('Restore tests need root SSH on the test server.')
    facts['freeBytes']=shutil.disk_usage(existing_ancestor(RESTORE_ROOT)).free
    size=int(need.get('bytes') or 0);required=size*3+1024**3
    if facts['freeBytes']<required:problems.append('The test server needs %.1f GB free for this backup and has %.1f GB.'%(required/1e9,facts['freeBytes']/1e9))
    if need.get('kind')!='static':
        facts['docker']=docker('version','--format','{{.Server.Version}}').decode().strip()[:40]
        facts['architecture']=docker('info','--format','{{.Architecture}}').decode().strip()[:40]
        if need.get('architecture') and need['architecture']!=facts['architecture']:problems.append('The test server has a different CPU architecture (%s) than the backup (%s).'%(facts['architecture'],str(need['architecture'])[:40]))
        if need.get('grouped') and docker_major()<28:problems.append('Sites with more than one container need Docker 28 or newer on the test server.')
        containers=max(1,int(need.get('containers') or 1));factor=2 if need.get('liveServer') else 1
        facts['memAvailableBytes']=mem_available()
        wanted=containers*memory*1024**2*factor
        if facts['memAvailableBytes'] is not None and facts['memAvailableBytes']<wanted:problems.append('The test server has %d MB of memory available; this test needs %d MB (%d container%s at %d MB%s). Lower the memory limit or free memory.'%(facts['memAvailableBytes']//1024**2,wanted//1024**2,containers,'' if containers==1 else 's',memory,', twice on the live server' if factor==2 else ''))
        facts['nproc']=cpu_count()
        if cpus>facts['nproc']:problems.append('The test server has %d CPU%s, so it cannot give each container %g. Lower the CPU limit.'%(facts['nproc'],'' if facts['nproc']==1 else 's',cpus))
        left=test_leftovers()
        if any(left.values()):problems.append('An earlier restore test left containers, networks or firewall rules on the test server. DockNest cleans them up first.')
        facts['firewall']={'iptables':bool(shutil.which('iptables')),'ip6tables':bool(shutil.which('ip6tables')),'nsenter':bool(shutil.which('nsenter'))}
        if internet and not all(facts['firewall'].values()):problems.append('The test server needs nsenter, iptables and ip6tables to block outgoing mail inside the copy, so the test cannot run with internet.')
        facts['probeTools']=bool(shutil.which('nsenter') and shutil.which('setpriv'))
    emit(result={'ok':not problems,'problems':problems,'facts':facts})
def write_private(path,content):
    temporary=path.with_name(path.name+'.new')
    temporary.unlink(missing_ok=True)
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o700)
    with os.fdopen(fd,'wb') as output:output.write(content);output.flush();os.fsync(output.fileno())
    os.replace(temporary,path)
def start_reaper(d,tid,source):
    """The backstop for a manager that is down or rolled back: a detached copy of this reviewed helper, sent by the
    manager, runs teardown once at the deadline plus the clean-up time and exits early when the journal is gone."""
    content=__import__('base64').b64decode(source,validate=True)
    if len(content)>1024*1024:raise ValueError('The reaper exceeds its size limit')
    write_private(d/'reaper.py',content)
    atomic_json(d/'reaper.json',{'operation':'restore-test-reap','testId':tid})
    argv=[sys.executable or 'python3','-I',str(d/'reaper.py')]
    def spawn(command):
        with open(d/'reaper.json','rb') as request:
            return subprocess.Popen(command,stdin=request,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd=str(d),close_fds=True,start_new_session=True)
    # A new session survives the SSH channel closing. Under systemd, logind with KillUserProcesses=yes would still end
    # it with the SSH session, so it runs in its own transient scope; if systemd-run refuses, the plain session is used.
    if systemd_present() and shutil.which('systemd-run'):
        process=spawn([shutil.which('systemd-run'),'--scope','--quiet','--description=DockNest restore test reaper',*argv])
        time.sleep(0.5)
        if process.poll() not in (None,0):process=spawn(argv)
    else:process=spawn(argv)
    return process.pid
def restore_test_prepare(req):
    """Copy backup, first half: the journal, the private staging root and the reaper. The package follows over SFTP."""
    if hasattr(os,'geteuid') and os.geteuid()!=0:raise ValueError('Restore tests need root SSH on the test server.')
    tid=test_id(req);deadline=float(req['deadline']);chain_length(req)
    # The reaper waits the manager's own clean-up time after the deadline (default 10 minutes).
    grace=req.get('grace',REAPER_GRACE)
    if not isinstance(grace,int) or isinstance(grace,bool) or not 60<=grace<=3600:raise ValueError('The clean-up time must be 60 to 3600 seconds')
    d,state=test_state(tid,create=True)
    if state.get('prepared'):raise ValueError('This restore test already ran on this server; DockNest cleans it up first.')
    root=test_staging(tid)
    if RESTORE_ROOT.is_symlink():raise ValueError('The restore root cannot be a symbolic link')
    test_journal(d,state,'paths',str(root))
    if root.exists() or root.is_symlink():raise ValueError('Restore test staging already exists')
    RESTORE_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700);root.mkdir(mode=0o700)
    state['deadline']=deadline;state['grace']=grace;state['prepared']=time.time();save_state(d,state)
    pid=start_reaper(d,tid,req['reaper']) if req.get('reaper') else None
    if isinstance(pid,int) and not isinstance(pid,bool):state['reaperPid']=pid;state['reaperStart']=process_start(pid);save_state(d,state)
    emit(result={'root':str(root),'remotePath':str(root/'payload.tar.gz'),'reaper':pid is not None,**chain_paths(req,root)})
def backup_side(error):
    """Errors from checking and unpacking the package: the backup did not come back, unless the server ran out of room."""
    if STOPPING:return error
    text=str(error)
    if re.search(r'capacity|space',text,re.I):return TestOutcome('couldnt_run','The test server ran low on disk.')
    if 'checksum mismatch' in text:return TestOutcome('couldnt_run','The copy on the test server did not match the backup; the transfer was damaged. Try again.')
    return TestOutcome('failed',text)
def image_archive_tags(archive):
    """repo:tag names a `docker save` archive would set on load (manifest.json, legacy `repositories`)."""
    tags=[]
    with tarfile.open(archive,'r:') as tar:
        for name in ['manifest.json','repositories']:
            try:member=tar.getmember(name)
            except KeyError:continue
            if not member.isfile() or member.size>4*1024*1024:continue
            data=json.loads(tar.extractfile(member).read())
            if name=='manifest.json':tags+=[tag for item in data if isinstance(item,dict) for tag in item.get('RepoTags') or []]
            elif isinstance(data,dict):tags+=[repo+':'+tag for repo,items in data.items() if isinstance(items,dict) for tag in items]
    tags=[tag for tag in dict.fromkeys(tags) if isinstance(tag,str) and IMAGE_TAG.fullmatch(tag)]
    if len(tags)>200:raise ValueError('The image archive names too many tags')
    return tags
def image_archive_names(archive):
    """Every image name an archive would set on load: docker save's manifest.json and repositories, and OCI index.json
    annotations (containerd image store). A DockNest backup saves images by ID, so this is empty for a real package."""
    names=[]
    with tarfile.open(archive,'r:') as tar:
        for name in ['manifest.json','repositories','index.json']:
            try:member=tar.getmember(name)
            except KeyError:continue
            # Raw content counts, before any name filter: a record this check cannot read is refused too.
            if not member.isfile() or member.size>4*1024*1024:raise ValueError('Unreadable image archive record')
            data=json.loads(tar.extractfile(member).read())
            if name=='manifest.json':names+=[str(tag) for item in (data if isinstance(data,list) else [data]) for tag in ((item.get('RepoTags') if isinstance(item,dict) else item) or [])]
            elif name=='repositories':
                if data:names+=[str(repo)+':'+str(tag) for repo,items in (data.items() if isinstance(data,dict) else [('?',data)]) for tag in (items if isinstance(items,dict) and items else [items])]
            else:
                for item in (data.get('manifests') or [] if isinstance(data,dict) else [data]):
                    annotations=item.get('annotations') if isinstance(item,dict) else None
                    if isinstance(annotations,dict):names+=[str(annotations[key]) for key in ['io.containerd.image.name','org.opencontainers.image.ref.name'] if annotations.get(key)]
    return list(dict.fromkeys(names))
def image_id_of(reference):
    try:return docker('image','inspect','--format','{{.Id}}',reference).decode().strip() or None
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired):return None
def image_tags(reference):
    try:return [tag for tag in json.loads(docker('image','inspect','--format','{{json .RepoTags}}',reference)) or [] if isinstance(tag,str)]
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,TypeError):return []
def load_images_keeping_tags(archive):
    """docker load for a restore or move. A DockNest backup saves images by ID, so an archive that names any image is not
    one DockNest made and is refused before loading; the tag restore after the load stays as a second guard."""
    try:names=image_archive_names(archive)
    except (tarfile.TarError,ValueError,OSError,AttributeError,TypeError):raise ValueError('The image archive in the backup cannot be read')
    if names:raise ValueError('The image archive names images (%s); DockNest backups save images by ID only, so it is not loaded.'%', '.join(names[:3]))
    state={'created':{'tags':[]}}
    try:docker('load','-i',str(archive))
    finally:restore_test_tags(state)
def restore_test_tags(state):
    """Point every tag the load moved back at the image it named before, so a later `docker compose up` on this server
    runs exactly what it ran before the test."""
    changed=[]
    for record in state['created']['tags']:
        previous=record.get('previous')
        if previous and image_id_of(record['tag'])!=previous:docker('tag',previous,record['tag']);changed.append(record['tag'])
    return changed
TEST_METADATA={'iptables':'169.254.169.254/32','ip6tables':'fd00:ec2::254/128'}
TEST_EGRESS_REFUSED={'NET_ADMIN','NET_RAW','SYS_ADMIN','ALL'}
SANDBOX_KEY=re.compile(r'/(?:var/)?run/docker/netns/[0-9a-zA-Z]{1,64}')
def internet_problem(containers):
    """Allow internet relies on rules inside each copy's own network namespace, which a copy that can change its
    firewall (NET_ADMIN and friends) or shares another namespace could undo. Such sites are tested without internet."""
    for c in containers:
        hc=c.get('HostConfig',{});mode=hc.get('NetworkMode') or ''
        caps={str(cap).upper().removeprefix('CAP_') for cap in hc.get('CapAdd') or []}&TEST_EGRESS_REFUSED
        name=c.get('Name','').lstrip('/') or 'A container'
        if caps:return 'Allow internet is refused: %s adds %s, which could remove the mail block inside the copy. Test this site without internet.'%(name,', '.join(sorted(caps)))
        if hc.get('Privileged') or mode=='host' or mode.startswith('container:'):return 'Allow internet is refused: %s shares the host or another container\'s network. Test this site without internet.'%name
    return None
def sandbox_key(cid):
    """The network namespace of a running container, by Docker's own sandbox path (never by PID)."""
    info=docker('inspect','--format','{{.State.Running}} {{.NetworkSettings.SandboxKey}}',cid).decode().split()
    if len(info)!=2 or info[0]!='true' or not SANDBOX_KEY.fullmatch(info[1]):return None
    return info[1]
def host_reject_addresses(extra=()):
    """Every address of this server (all interfaces, Docker bridges included, so also the Docker gateway), without
    loopback or link-local, which the copy needs for itself."""
    found=list(extra)
    try:
        for line in run(['ip','-o','addr','show'],timeout=10).decode().splitlines():
            match=re.search(r'\binet6? ([0-9a-fA-F.:]+)/',line)
            if not match:continue
            address=ipaddress.ip_address(match[1])
            if address.is_loopback or address.is_link_local:continue
            found.append(str(address))
    except Exception:raise TestOutcome('couldnt_run','The test server did not list its own addresses, so the copy cannot be kept away from it. The test does not run with internet.',stop=True)
    return list(dict.fromkeys(found))
def egress_rules(addresses):
    """OUTPUT rules for one copy: outbound mail, the cloud metadata service and this server itself, both families."""
    rules=[]
    for tool in ['iptables','ip6tables']:
        family=6 if tool=='ip6tables' else 4
        rules.append((tool,['-p','tcp','-m','multiport','--dports',TEST_MAIL_PORTS,'-j','REJECT']))
        rules.append((tool,['-d',TEST_METADATA[tool],'-j','REJECT']))
        rules+=[(tool,['-d',address,'-j','REJECT']) for address in addresses if ipaddress.ip_address(address).version==family]
    return rules
def isolate_egress(tid,ids,egress):
    """Event, once per container after `docker start`: the copy runs only on its internal isolated networks (no route
    out), its OUTPUT rules go into its own network namespace and are verified, and only then does it join the egress
    network. A host firewall reload or flush cannot remove these rules; any failure stops the test before egress."""
    gateways=[c.get('Gateway') for c in (json.loads(docker('network','inspect',egress))[0].get('IPAM') or {}).get('Config') or [] if c.get('Gateway')]
    rules=egress_rules(host_reject_addresses(gateways))
    nsenter=shutil.which('nsenter')
    for cid in ids:
        key=sandbox_key(cid)
        if not key or not nsenter:raise TestOutcome('couldnt_run','Outgoing mail could not be blocked inside the copy, so the test stopped before it reached the internet.',stop=True)
        for tool,args in rules:
            binary=shutil.which(tool)
            try:
                if not binary:raise ValueError(tool)
                run([nsenter,'--net='+key,binary,'-w','-I','OUTPUT',*args],timeout=20)
                run([nsenter,'--net='+key,binary,'-w','-C','OUTPUT',*args],timeout=20)
            except Exception:raise TestOutcome('couldnt_run','Outgoing mail could not be blocked inside the copy (%s), so the test stopped before it reached the internet.'%tool,stop=True)
        docker('network','connect',egress,cid)
def egress_intact(tid,ids):
    """On demand (restore-test-mail-check): every OUTPUT rule is still in each running copy's namespace."""
    nsenter=shutil.which('nsenter');rules=egress_rules([]);result=bool(ids)
    for cid in ids:
        key=sandbox_key(cid)
        if not key:continue
        for tool,args in rules:
            try:run([nsenter,'--net='+key,shutil.which(tool),'-w','-C','OUTPUT',*args],timeout=20)
            except Exception:result=False
    return result
def test_disk_low(tid):
    roots=[test_staging(tid)]
    try:roots.append(pathlib.Path(docker('info','--format','{{.DockerRootDir}}').decode().strip() or '/var/lib/docker'))
    except Exception:pass
    return min(shutil.disk_usage(existing_ancestor(root)).free for root in roots)<TEST_MIN_FREE
DISK_LOW='The test server ran low on disk.'
def test_unblock_mail(tid):
    """Belt and braces: restore tests add no host rules, but teardown removes any rule carrying their comment."""
    removed=0
    for tool,rule in test_mail_rules(tid):
        try:run([tool,'-D',*shlex.split(rule)[1:]],timeout=10);removed+=1
        except Exception:pass
    return removed
def restore_test_restore(req):
    """Restore copy: verify the package, unpack, load images (tags restored at once), create networks and containers
    with the test's limits, and block mail when internet is allowed. Nothing starts here."""
    tid=test_id(req);memory,cpus,internet=test_limits(req)
    d,state=test_state(tid)
    if not state.get('prepared'):raise ValueError('This restore test was not prepared on this server')
    if state.get('restored') or state['created']['containers'] or state['created']['networks']:raise ValueError('This restore test already restored its copy')
    root=test_staging(tid)
    try:unpacked,manifest,artifacts_verified=unpack_verified(req,root)
    except ValueError as error:raise backup_side(error)
    checks=[test_check('Package complete','package',None,'passed' if artifacts_verified else 'skipped',None if artifacts_verified else 'This older backup has no artifact list.')]
    try:external_restore_plan(manifest,[])
    except ValueError:raise TestOutcome('couldnt_run','This site needs external storage that a restore test cannot attach.',checks)
    if manifest.get('kind')=='static':
        if manifest.get('containers'):raise TestOutcome('failed','Invalid static backup manifest.',checks)
        directory=root/'static-site'
        try:safe_extract(unpacked/'static-files.tar',directory)
        except ValueError as error:raise backup_side(error)
        entries=list(directory.iterdir())
        if len(entries)!=1 or not entries[0].is_dir():raise TestOutcome('failed','The static archive must hold one website folder.',checks)
        if tree_digest(entries[0])!=manifest.get('staticFiles'):
            checks.append(test_check('Static files','static-files',None,'failed','The restored files differ from the captured website.'))
            raise TestOutcome('failed','The restored static files differ from the captured website.',checks)
        checks.append(test_check('Static files','static-files',None,'passed','%s files match'%(manifest.get('staticFiles') or {}).get('files','All')))
        state['restored']={'kind':'static'};save_state(d,state)
        emit(result={'outcome':'ok','kind':'static','checks':checks});return
    if manifest['architecture']!=docker('info','--format','{{.Architecture}}').decode().strip():raise TestOutcome('couldnt_run','The test server has a different CPU architecture than the backup.',checks)
    containers=manifest['containers']
    if internet and internet_problem(containers):raise TestOutcome('couldnt_run',internet_problem(containers),checks)
    if internet and not (shutil.which('nsenter') and shutil.which('iptables') and shutil.which('ip6tables')):raise TestOutcome('couldnt_run','The test server needs nsenter, iptables and ip6tables to block outgoing mail inside the copy, so the test does not run with internet.',checks)
    try:plans=restore_network_plan(containers)
    except ValueError as error:raise TestOutcome('couldnt_run',str(error),checks)
    if len(manifest.get('snapshotImages',[]))!=len(containers):raise TestOutcome('failed','The backup is missing snapshot images.',checks)
    multi=len(containers)>1
    if multi and docker_major()<28:raise TestOutcome('couldnt_run','Sites with more than one container need Docker 28 or newer on the test server.',checks)
    if shutil.disk_usage(root).free<mount_bytes(unpacked)+TEST_MIN_FREE:raise TestOutcome('couldnt_run','The test server ran low on disk.',checks)
    prefix='dbm-test-'+tid[:12]
    labels=['--label',TEST_LABEL+'='+tid,'--label','com.docker.compose.project=docknest-test-'+tid[:12],'--label','com.docker.compose.project.working_dir=','--label','com.docker.compose.project.config_files=']
    definitions=[];sources={}
    for i,c in enumerate(containers):
        name=prefix+('-'+str(i) if multi else '')
        args=['create','--name',name,'--network','none',*labels,*limit_args(memory,cpus)]
        if internet:args+=['--cap-drop','NET_ADMIN']
        if multi and plans[i] and not internet:args+=['--dns','127.0.0.1']
        try:
            for destination,options in temporary_mounts(c):args+=['--tmpfs',tmpfs_argument(destination,options)]
        except ValueError as error:raise TestOutcome('couldnt_run',str(error),checks)
        for j,m in enumerate(c['Mounts']):
            try:source=extract_mount(unpacked,i,j,m,sources,root)
            except MountLayoutError as error:
                if error.kind=='overlap':raise TestOutcome('couldnt_run','Overlapping mount paths need a reviewed offline restore.',checks)
                raise TestOutcome('failed','A mount archive must hold exactly one entry.',checks)
            except ValueError as error:raise backup_side(error)
            if ',' in str(source) or ',' in m['Destination']:raise TestOutcome('couldnt_run','Mount paths with commas need a reviewed offline restore.',checks)
            mount='type=bind,src='+str(source)+',dst='+m['Destination']
            if not m.get('RW',True):mount+=',readonly'
            args+=['--mount',mount]
        definitions.append((name,args+[manifest['snapshotImages'][i]]))
    sqlite_cache={}
    for service in manifest.get('backupPlan',{}).get('services',[]):
        if not service.get('sqliteFiles'):continue
        original=next(c for c in containers if c['Id']==service['container'])
        restored={**original,'Mounts':[{**mount,'Source':str(sources[(mount['Type'],mount['Source'])])} for mount in original['Mounts']]}
        actual=cached_sqlite_file_proof(sqlite_cache,service,restored)
        target=original['Name'].lstrip('/')
        if actual!=service.get('expectedSqliteChecks'):
            checks.append(test_check('Database checks','sqlite',target,'failed','SQLite checks differ from capture.'))
            raise TestOutcome('failed','SQLite checks differ from the values recorded at capture.',checks)
        checks.extend(test_check('Database checks','sqlite',target,'passed',check.get('method')) for check in actual)
    # Images: containers use snapshot image IDs, never tags. Only IDs this server did not have are test-only.
    before=set(docker('images','-aq','--no-trunc').decode().split())
    wanted=list(dict.fromkeys(manifest['snapshotImages']+[item.get('Id') for item in manifest.get('originalImages') or [] if isinstance(item,dict) and isinstance(item.get('Id'),str)]))
    try:tags=[tag for archive in image_archives(unpacked) for tag in image_archive_names(archive)]
    except (tarfile.TarError,ValueError,OSError,AttributeError,TypeError):raise TestOutcome('failed','The image archive in the backup cannot be read.',checks)
    if len(tags)>200 or any(not IMAGE_TAG.fullmatch(tag) for tag in tags):raise TestOutcome('failed','The image archive in the backup names images DockNest cannot put back.',checks)
    for tag in tags:test_journal(d,state,'tags',{'tag':tag,'previous':image_id_of(tag)})
    for image in wanted:
        if image not in before:test_journal(d,state,'images',image)
    try:
        for archive in image_archives(unpacked):docker('load','-i',str(archive))
    finally:restore_test_tags(state)
    networks={};created=[]
    # Every copy starts on fresh internal isolated networks only. With internet, a single container gets one such
    # network too (a `none` container cannot join the egress network later).
    originals=list(dict.fromkeys(name for plan in plans for name in plan))
    if internet and not any(plans):originals=['']
    for index,original in enumerate(originals):
        name=prefix+'-net-'+str(index)
        test_journal(d,state,'networks',name)
        docker('network','create','--internal','--driver','bridge','--opt','com.docker.network.bridge.gateway_mode_ipv4=isolated','--opt','com.docker.network.bridge.gateway_mode_ipv6=isolated','--label',TEST_LABEL+'='+tid,name)
        networks[original]=name
        n=json.loads(docker('network','inspect',name))[0]
        if not n['Internal'] or n.get('EnableIPv6') or n.get('Options',{}).get('com.docker.network.bridge.gateway_mode_ipv4')!='isolated':raise TestOutcome('couldnt_run','The test server did not create an isolated network.',checks)
    egress=None
    if internet:
        egress=prefix+'-egress';test_journal(d,state,'networks',egress)
        docker('network','create','--driver','bridge','--label',TEST_LABEL+'='+tid,egress)
    for i,(name,args) in enumerate(definitions):
        primary=next(iter(plans[i]),None) if plans[i] else ('' if '' in networks else None)
        if primary is not None:
            args[args.index('--network')+1]=networks[primary]
            args[1:1]=[part for alias in (plans[i].get(primary) or []) for part in ['--network-alias',alias]]
        test_journal(d,state,'containers',name)
        cid=docker(*args).decode().strip();created.append(cid)
        for original,aliases in list(plans[i].items())[1:]:
            docker('network','connect',*[part for alias in aliases for part in ['--alias',alias]],networks[original],cid)
    ordered=manifest.get('backupPlan',{}).get('restartOrder',[c['Id'] for c in containers])
    mapping={c['Id']:cid for c,cid in zip(containers,created)}
    running=[mapping[o] for o in ordered if next(c for c in containers if c['Id']==o)['State'].get('Running')]
    state['restored']={'kind':'docker','containers':[{'name':definitions[i][0],'id':cid,'original':c['Name'].lstrip('/')} for i,(c,cid) in enumerate(zip(containers,created))],'running':running,'networks':list(networks.values()),'internet':internet,'egress':egress}
    save_state(d,state)
    emit(result={'outcome':'ok','kind':'docker','containers':len(created),'running':len(running),'networkMode':'internet' if internet else 'isolated-internal' if networks else 'none','mailBlocked':internet,'checks':checks})
def cgroup_counter(cid,filename,key):
    for base in ['/sys/fs/cgroup/system.slice/docker-%s.scope'%cid,'/sys/fs/cgroup/docker/%s'%cid]:
        try:
            for line in pathlib.Path(base,filename).read_text().splitlines():
                parts=line.split()
                if len(parts)==2 and parts[0]==key:return int(parts[1])
        except (OSError,ValueError):continue
    return 0
def limit_problem(states):
    """A container a test limit stopped: the test could not finish, which says nothing about the backup."""
    for c in states:
        if c['State'].get('OOMKilled') or cgroup_counter(c['Id'],'memory.events','oom_kill'):return 'memory'
        if cgroup_counter(c['Id'],'pids.events','max'):return 'process'
    return None
def limit_outcome(kind,checks=None):
    return TestOutcome('couldnt_run','Test couldn\'t finish: %s limit. Raise it in Advanced.'%kind,checks,stop=True)
def test_manifest(tid):
    return json.loads((test_staging(tid)/'unpacked'/'manifest.json').read_text())
def restored_state(tid):
    d,state=test_state(tid);restored=state.get('restored') or {}
    if restored.get('kind')!='docker':raise ValueError('This restore test has no containers to check on this server')
    return d,state,restored
def stop_test_containers(tid):
    try:
        ids=docker('ps','-q','--filter','label='+TEST_LABEL+'='+tid).decode().split()
        if ids:docker('stop','--time','10',*ids)
    except Exception:pass
def test_contracts(manifest,restored):
    mapping={c['Id']:item['id'] for c,item in zip(manifest['containers'],restored['containers'])}
    contracts=[{**s,'container':mapping[s['container']],'dependsOn':[mapping[x] for x in s.get('dependsOn',[]) if x in mapping]} for s in manifest.get('backupPlan',{}).get('services',[]) if s.get('container') in mapping]
    return mapping,contracts
def restore_test_start(req):
    """Start containers in the captured restart order; a level starts once the level before it is healthy."""
    tid=test_id(req);d,state,restored=restored_state(tid)
    if test_disk_low(tid):raise TestOutcome('couldnt_run',DISK_LOW)
    _,contracts=test_contracts(test_manifest(tid),restored)
    running=restored['running']
    started=(lambda ids:isolate_egress(tid,ids,restored['egress'])) if restored.get('internet') else None
    try:restart_services(running,contracts,started=started)
    except ValueError as error:
        if STOPPING:raise
        states=inspect(running) if running else []
        problem=limit_problem(states)
        if problem:raise limit_outcome(problem)
        raise TestOutcome('failed','The containers did not start and become healthy within 120 seconds.',[test_check('Docker health','health',None,'failed',str(error)[:200])])
    emit(result={'outcome':'ok','started':len(running)})
PROBE_SCRIPT=r'''
import http.client,json,sys,time
started=time.monotonic();status=None
try:
    connection=http.client.HTTPConnection('127.0.0.1',int(sys.argv[1]),timeout=10)
    connection.request('GET',sys.argv[2],headers={'User-Agent':'DockNest-restore-test','Connection':'close','Accept':'*/*'})
    response=connection.getresponse();response.read(65536);status=response.status
except Exception:pass
print(json.dumps({'status':status,'ms':round((time.monotonic()-started)*1000)}))
'''
def restore_test_probe(cid,probe,target):
    """GET on loopback inside the container's network namespace, as the nobody user with no new privileges, using the
    host's isolated Python: no tool in the image and no port opened. Only the status code and time are kept."""
    port=probe.get('port');path=probe.get('path') or '/'
    if not isinstance(port,int) or isinstance(port,bool) or not 1<=port<=65535 or not isinstance(path,str) or not TEST_PATH.fullmatch(path):return test_check('Internal web check','http',target,'skipped','The web check settings are not valid.')
    nsenter,setpriv=shutil.which('nsenter'),shutil.which('setpriv')
    if not nsenter or not setpriv:return test_check('Internal web check','http',target,'skipped','nsenter or setpriv (util-linux) is missing on the test server.')
    key=sandbox_key(cid)
    if not key:return test_check('Internal web check','http',target,'failed','The container is not running.')
    try:output=run([nsenter,'--net='+key,setpriv,'--reuid','65534','--regid','65534','--clear-groups','--no-new-privs',shutil.which('python3') or sys.executable,'-I','-c',PROBE_SCRIPT,str(port),path],timeout=20)
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired):return test_check('Internal web check','http',target,'failed','The web check could not run.')
    try:answer=json.loads(output.decode().strip().splitlines()[-1])
    except (ValueError,IndexError):return test_check('Internal web check','http',target,'failed','The web check gave no answer.')
    status=answer.get('status');ms=int(answer.get('ms') or 0)
    if isinstance(status,int) and 200<=status<=399:return test_check('Internal web check','http',target,'passed','HTTP %d in %d ms'%(status,ms))
    return test_check('Internal web check','http',target,'failed','HTTP %d'%status if isinstance(status,int) else 'No answer within 10 seconds')
def restore_test_poll(req):
    """One health poll across ticks: container state. The final poll, 60 seconds after start, is the end of the step:
    it re-checks free space and runs the configured database checks and the internal web check."""
    tid=test_id(req);d,state,restored=restored_state(tid);final=req.get('final') is True
    if final and test_disk_low(tid):raise TestOutcome('couldnt_run',DISK_LOW,stop=True)
    items={item['id']:item for item in restored['containers']}
    states=inspect(list(items)) if items else []
    running=set(restored['running'])
    for c in states:
        target=items.get(c['Id'],{}).get('original')
        if c['Id'] not in running:continue
        if not c['State'].get('Running'):
            problem=limit_problem([c])
            if problem:raise limit_outcome(problem)
            check=test_check('Still running' if final or req.get('stable') else 'Containers running','stable' if final or req.get('stable') else 'running',target,'failed','Stopped with exit code %s'%c['State'].get('ExitCode'))
            raise TestOutcome('failed','%s stopped after it started (exit code %s).'%(target,c['State'].get('ExitCode')),[check])
        if c['State'].get('Health',{}).get('Status')=='unhealthy':raise TestOutcome('failed','%s reports unhealthy.'%target,[test_check('Docker health','health',target,'failed','unhealthy')])
    healthy=all(c['State'].get('Health',{}).get('Status','healthy')=='healthy' for c in states if c['Id'] in running)
    result={'outcome':'ok','healthy':healthy,'running':len(running)}
    if final:
        if not healthy:raise TestOutcome('failed','A service did not stay healthy.',[test_check('Docker health','health',None,'failed','not healthy')])
        checks=[test_check('Containers running','running',None,'passed','%d running'%len(running))]
        if any('Health' in c['State'] for c in states if c['Id'] in running):checks.append(test_check('Docker health','health',None,'passed','healthy'))
        checks.append(test_check('Still running','stable',None,'passed','60 seconds later'))
        manifest=test_manifest(tid);mapping,contracts=test_contracts(manifest,restored)
        names={c['Id']:c['Name'].lstrip('/') for c in manifest['containers']}
        for original,service in zip([s['container'] for s in manifest.get('backupPlan',{}).get('services',[]) if s.get('container') in mapping],contracts):
            if service['engine']=='generic' or not service.get('checks'):continue
            try:actual=data_checks(service['container'],service)
            except (ValueError,subprocess.CalledProcessError,subprocess.TimeoutExpired):actual=None
            if actual!=service.get('expectedChecks',[]):
                checks.append(test_check('Database checks','database',names.get(original),'failed','Differs from capture'))
                raise TestOutcome('failed','Database checks differ from the values recorded at capture.',checks)
            checks.extend(test_check('Database checks','database',names.get(original),'passed',item['name']) for item in actual)
        probe=req.get('probe')
        if isinstance(probe,dict):
            by_name={item['original']:item['id'] for item in restored['containers']}
            target=probe.get('service')
            if target not in by_name:checks.append(test_check('Internal web check','http',str(target)[:80],'skipped','This backup has no service with that name.'))
            else:
                check=restore_test_probe(by_name[target],probe,target);checks.append(check)
                if check['status']=='failed':raise TestOutcome('failed','The internal web check failed: %s.'%check['detail'],checks)
        result['checks']=checks
    emit(result=result)
def restore_test_run(req):
    phase=req.get('phase')
    work={'restore':restore_test_restore,'start':restore_test_start,'poll':restore_test_poll}.get(phase)
    if not work:raise ValueError('Unsupported restore test phase')
    tid=test_id(req)
    try:work(req)
    except TestOutcome as outcome:
        if outcome.stop:stop_test_containers(tid)
        emit(result={'outcome':outcome.outcome,'reason':outcome.reason[:300],'checks':outcome.checks})
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as error:
        if STOPPING:raise
        # Docker's arguments hold data paths, so only the command name and exit code are reported.
        command=error.cmd[:2] if isinstance(error.cmd,list) else ['a command']
        label=' '.join(pathlib.Path(str(part)).name for part in command)
        emit(result={'outcome':'couldnt_run','reason':('The test server timed out running %s.'%label if isinstance(error,subprocess.TimeoutExpired) else 'The test server could not run %s (exit code %s).'%(label,error.returncode))[:300],'checks':[]})
def remove_test_path(value,tid):
    """Only the test's own staging folder directly below the restore root, never through a link."""
    p=pathlib.Path(value)
    if p.name!=tid or p.parent!=RESTORE_ROOT or RESTORE_ROOT.is_symlink():raise ValueError('Restore test clean-up refused a path outside the restore root')
    if os.path.realpath(p.parent)!=os.path.realpath(RESTORE_ROOT):raise ValueError('Restore test clean-up refused a linked restore root')
    if p.is_symlink():p.unlink();return
    if not p.exists():return
    if os.name=='posix' and not getattr(shutil.rmtree,'avoids_symlink_attacks',False):raise ValueError('Safe directory removal is unavailable on this host')
    shutil.rmtree(p)
def process_start(pid):
    """The kernel's start time of a process (field 22 of /proc/<pid>/stat), which a reused PID does not share."""
    try:return int(pathlib.Path('/proc/%d/stat'%pid).read_text().rsplit(')',1)[1].split()[19])
    except (OSError,ValueError,IndexError):return None
def process_cmdline(pid):
    try:return pathlib.Path('/proc/%d/cmdline'%pid).read_bytes()
    except OSError:return b''
def stop_reaper(tid,state):
    """Event, at teardown: the manager finished, so this test's reaper has nothing left to do. Only a process whose
    command line is this test's reaper is signalled, never a reused PID."""
    pid=state.get('reaperPid')
    if not isinstance(pid,int) or isinstance(pid,bool) or pid<=1 or pid==os.getpid():return False
    if ('restore-tests/%s/reaper.py'%tid).encode() not in process_cmdline(pid):return False  # already gone
    if state.get('reaperStart') is not None and process_start(pid)!=state['reaperStart']:return False  # a reused PID
    try:os.kill(pid,signal.SIGTERM);return True
    except OSError:return False  # exited meanwhile; teardown stays idempotent
def restore_test_teardown(req):
    """Idempotent. Containers by label, firewall rules by comment, then journalled networks that still carry the label,
    test-only tags and images (never -f), the staging folder and last the journal, once nothing is left."""
    tid=test_id(req);d=test_dir(tid)
    if d.is_symlink():raise ValueError('The restore test folder cannot be a symbolic link')
    state=test_state(tid)[1] if d.is_dir() else {'created':{kind:[] for kind in TEST_KINDS}}
    ids=docker('ps','-aq','--no-trunc','--filter','label='+TEST_LABEL+'='+tid).decode().split()
    if ids:docker('rm','-f',*ids)
    counts={'containers':len(ids),'firewall':test_unblock_mail(tid),'networks':0,'images':0,'tags':0,'paths':0}
    for name in reversed(state['created']['networks']):
        found=docker('network','ls','-q','--filter','name=^'+re.escape(name)+'$','--filter','label='+TEST_LABEL+'='+tid).decode().split()
        if found:docker('network','rm',*found);counts['networks']+=1
    test_images=set(state['created']['images']);kept=0
    try:restore_test_tags(state)
    except Exception:pass  # the earlier image is gone; nothing to point the tag back at
    for record in state['created']['tags']:
        # A tag the load added is untagged only when its image has other tags too; otherwise removing the image by
        # ID below takes the tag with it, and an image another container uses keeps its only name.
        if record.get('previous') is None and image_id_of(record['tag']) in test_images and len(image_tags(record['tag']))>1:
            try:docker('image','rm',record['tag']);counts['tags']+=1
            except Exception:pass
    for image in state['created']['images']:
        if image_id_of(image) is None:continue
        try:docker('image','rm',image);counts['images']+=1
        except Exception:kept+=1  # a non-test container uses it now; kept and reported
    for value in dict.fromkeys(state['created']['paths']+[str(test_staging(tid))]):
        if pathlib.Path(value).exists() or pathlib.Path(value).is_symlink():remove_test_path(value,tid);counts['paths']+=1
    left=test_leftovers(tid);left['staging']=int(test_staging(tid).exists())
    if any(left.values()):raise ValueError('Clean-up left %s on the test server.'%', '.join('%d %s'%(n,kind) for kind,n in left.items() if n))
    if d.is_dir():
        if os.path.realpath(d.parent)!=os.path.realpath(RESTORE_TESTS_ROOT):raise ValueError('Restore test clean-up refused a linked journal folder')
        stop_reaper(tid,state)
        shutil.rmtree(d)
    emit(result={'removed':True,'counts':counts,'keptImages':kept})
def restore_test_status(req):
    tid=test_id(req);left=test_leftovers(tid)
    result={**left,'staging':test_staging(tid).exists(),'journal':test_dir(tid).exists()}
    result['present']=bool(any(left.values()) or result['staging'] or result['journal'])
    emit(result=result)
def restore_test_reap(req,sleep=time.sleep,clock=time.time):
    """The detached reaper: one timer until the deadline plus the clean-up time, no periodic work. Then, only if the
    manager did not finish (the journal is still there), it runs teardown once and exits."""
    tid=test_id(req);file=test_dir(tid)/'resources.json'
    # The manager's teardown sends SIGTERM when it finished first: exit at once without acting.
    signal.signal(signal.SIGTERM,lambda *_:os._exit(0))
    try:
        state=json.loads(file.read_text());deadline=float(state.get('deadline'))
        grace=state.get('grace') if isinstance(state.get('grace'),int) and 60<=state.get('grace')<=3600 else REAPER_GRACE
    except (OSError,ValueError,TypeError):return
    while (remaining:=deadline+grace-clock())>0:sleep(remaining)  # re-arms only if the sleep ended early
    if not file.is_file():return
    lock=None
    try:
        lock=test_lock(tid,600) if os.name=='posix' else None
        if file.is_file():restore_test_teardown({'testId':tid})
    except Exception:pass
    finally:
        if lock:lock.close()
