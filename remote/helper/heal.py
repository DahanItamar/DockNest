# helper/heal.py: Self-heal (docs/self-heal.md): find watched containers, the read-only health event stream and the
# guarded restart of one unhealthy container.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    emit, inspect)
from .incremental import (
    INCREMENTAL_ROOT, SITE_KEY, incremental_root)
from .restore_test import (
    TEST_LABEL)
# </build:header>
# Identity (security review item 2): a Compose container by its project and service labels, a single container by its
# exact name. Restore test copies (dbm-test-*, label docknest.restore-test) and move copies (label docknest.move) never
# match, whatever their names or labels say.
HEAL_NAME=re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}')
HEAL_ID=re.compile(r'[0-9a-f]{64}')
HEAL_ACTION=re.compile(r'health_status: (healthy|unhealthy|starting)')
HEAL_PROJECT='com.docker.compose.project'
HEAL_SERVICE='com.docker.compose.service'
HEAL_MOVE_LABEL='docknest.move'
HEAL_LINE_LIMIT=4096
HEAL_WATCH_LIMIT=60
# `docker restart` exit codes as fixed sentences (security review item 7); stderr is never read or forwarded.
HEAL_RESTART_SENTENCES={1:'Docker could not restart the container.',125:'Docker refused the restart command.',126:'Docker could not run the restart command.',127:'Docker was not found on the server.',137:'The restart was stopped before it finished.'}

def heal_watch(req):
    items=req.get('watch')
    if not isinstance(items,list) or not 1<=len(items)<=HEAL_WATCH_LIMIT:raise ValueError('Invalid watch list')
    watch=[]
    for item in items:
        if not isinstance(item,dict):raise ValueError('Invalid watch entry')
        name,project,service=item.get('name'),item.get('project'),item.get('service')
        if not isinstance(name,str) or not HEAL_NAME.fullmatch(name):raise ValueError('Invalid container name')
        if (project is None)!=(service is None):raise ValueError('Invalid Compose identity')
        for value in (project,service):
            if value is not None and (not isinstance(value,str) or not HEAL_NAME.fullmatch(value)):raise ValueError('Invalid Compose identity')
        watch.append({'name':name,'project':project,'service':service})
    return watch
def heal_excluded(name,labels):
    return name.startswith('dbm-test-') or TEST_LABEL in labels or HEAL_MOVE_LABEL in labels or any(key.startswith(TEST_LABEL+'.') or key.startswith(HEAL_MOVE_LABEL+'.') for key in labels)
def heal_matches(entry,name,labels):
    if not isinstance(labels,dict) or heal_excluded(name,labels):return False
    if entry['project'] is not None:return labels.get(HEAL_PROJECT)==entry['project'] and labels.get(HEAL_SERVICE)==entry['service']
    return name==entry['name']
def heal_identity(container):
    labels=(container.get('Config') or {}).get('Labels') or {}
    project,service=labels.get(HEAL_PROJECT),labels.get(HEAL_SERVICE)
    if isinstance(project,str) and isinstance(service,str) and HEAL_NAME.fullmatch(project) and HEAL_NAME.fullmatch(service):return project,service
    return None,None
def heal_has_check(container):
    test=((container.get('Config') or {}).get('Healthcheck') or {}).get('Test') or []
    return bool(test) and test[0]!='NONE' or bool((container.get('State') or {}).get('Health'))
def heal_health(container):
    status=((container.get('State') or {}).get('Health') or {}).get('Status')
    return status if status in ('healthy','unhealthy','starting') else None
def heal_containers():
    ids=subprocess.run(['docker','ps','-a','--no-trunc','--format','{{.ID}}'],capture_output=True,timeout=30,check=True).stdout.decode().split()
    return inspect(ids) if ids else []
def heal_resolve(watch,containers):
    """Each watched entry's current container, or None. A Compose service scaled to several containers prefers the one
    with the saved name, then a running one, then the first by name, so the choice is stable."""
    resolved=[]
    for entry in watch:
        found=[c for c in containers if heal_matches(entry,c['Name'].lstrip('/'),(c.get('Config') or {}).get('Labels') or {})]
        found.sort(key=lambda c:(c['Name'].lstrip('/')!=entry['name'],not (c.get('State') or {}).get('Running'),c['Name']))
        resolved.append(found[0] if found else None)
    return resolved

def self_heal_resolve(req):
    """Which of the site's saved containers have a Docker health check, with their Compose identity. Read-only."""
    names=req.get('names')
    if not isinstance(names,list) or not 1<=len(names)<=HEAL_WATCH_LIMIT or not all(isinstance(n,str) and HEAL_NAME.fullmatch(n) for n in names):raise ValueError('Invalid container names')
    by_name={c['Name'].lstrip('/'):c for c in heal_containers()}
    found=[]
    for name in names:
        c=by_name.get(name)
        if c is None:continue
        labels=(c.get('Config') or {}).get('Labels') or {}
        if heal_excluded(name,labels):continue
        project,service=heal_identity(c)
        found.append({'name':name,'project':project,'service':service,'healthcheck':heal_has_check(c),'running':bool((c.get('State') or {}).get('Running')),'health':heal_health(c)})
    emit(result={'containers':found})

def heal_event(line,watch):
    """One `docker events --format '{{json .}}'` line as {container,status,at,id,timeNano}, or None when it is not a
    health event of a watched container. Malformed output raises, which closes the stream (security review item 6)."""
    if len(line)>HEAL_LINE_LIMIT:raise ValueError('Docker sent an event line over 4 KB.')
    event=json.loads(line)
    if not isinstance(event,dict) or not isinstance(event.get('Action'),str):raise ValueError('Docker sent an event without an action.')
    action=event['Action']
    if not action.startswith('health_status'):return None
    match=HEAL_ACTION.fullmatch(action)
    if not match:raise ValueError('Docker sent a health event in an unknown format.')
    actor=event.get('Actor')
    if not isinstance(actor,dict) or not isinstance(actor.get('Attributes') or {},dict):raise ValueError('Docker sent a health event without its container.')
    cid,labels=actor.get('ID'),actor.get('Attributes') or {}
    name=labels.get('name')
    nano=event.get('timeNano')
    if not isinstance(cid,str) or not HEAL_ID.fullmatch(cid) or not isinstance(name,str) or not HEAL_NAME.fullmatch(name) or isinstance(nano,bool) or not isinstance(nano,int) or nano<=0:raise ValueError('Docker sent a health event in an unknown format.')
    if not any(heal_matches(entry,name,labels) for entry in watch):return None
    return {'container':name,'status':match[1],'at':nano/1e9,'id':cid,'timeNano':nano}

def heal_stop_with_stdin(process,read=None):
    """DockNest keeps stdin open for as long as it watches. When it closes (DockNest stops watching, the worker or the
    connection goes away), `docker events` and its whole process group end, then the helper exits."""
    try:(read or sys.stdin.read)()
    except Exception:pass
    try:os.killpg(process.pid,signal.SIGTERM)
    except Exception:pass
    try:process.wait(timeout=5)
    except Exception:
        try:os.killpg(process.pid,signal.SIGKILL)
        except Exception:pass
    os._exit(0)

def health_events(req,popen=None,containers=None,watch_stdin=True):
    """The held stream: start `docker events` (own process group, no --since), then report the current health of the
    watched containers once, then forward health events of watched containers only. Read-only."""
    watch=heal_watch(req)
    process=(popen or subprocess.Popen)(['docker','events','--filter','type=container','--filter','event=health_status','--format','{{json .}}'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
    if watch_stdin:threading.Thread(target=heal_stop_with_stdin,args=(process,),daemon=True).start()
    try:
        # The snapshot runs after `docker events` started, so a change during the snapshot is still streamed.
        resolved=heal_resolve(watch,heal_containers() if containers is None else containers)
        emit(watching=[{'name':c['Name'].lstrip('/'),'id':c['Id']} if c is not None and HEAL_ID.fullmatch(c.get('Id') or '') and HEAL_NAME.fullmatch(c['Name'].lstrip('/')) else None for c in resolved])
        for c in resolved:
            status=heal_health(c) if c is not None else None
            if status is not None and HEAL_ID.fullmatch(c.get('Id') or ''):emit(container=c['Name'].lstrip('/'),status=status,at=time.time(),id=c['Id'],timeNano=0)
        while True:
            raw=process.stdout.readline(HEAL_LINE_LIMIT+2)
            if not raw:raise ValueError('docker events stopped.')
            if len(raw.rstrip(b'\r\n'))>HEAL_LINE_LIMIT:raise ValueError('Docker sent an event line over 4 KB.')
            line=raw.decode('utf-8','strict').strip()
            if not line:continue
            event=heal_event(line,watch)
            if event is not None:emit(**event)
    finally:
        try:os.killpg(process.pid,signal.SIGTERM)
        except Exception:pass

def heal_lock(site):
    """The per-site lock file backup and edit operations take (remote/helper/incremental.py site_lock), without waiting:
    a restart never queues behind DockNest's own work on the site."""
    try:import fcntl
    except ImportError:return True
    if not isinstance(site,str) or not SITE_KEY.fullmatch(site):raise ValueError('Invalid site key')
    incremental_root()
    handle=open(INCREMENTAL_ROOT/('.lock-'+site),'a')
    try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:handle.close();return None
    return handle

def self_heal_restart(req,run=None):
    """Restart one container that is still running and unhealthy, under the site lock, outside maintenance, after
    checking it is the same container (labels and ID) the event named. Refusals and failures are codes, never stderr."""
    name,project,service,cid=req.get('name'),req.get('project'),req.get('service'),req.get('containerId')
    entry=heal_watch({'watch':[{'name':name,'project':project,'service':service}]})[0]
    if not isinstance(cid,str) or not HEAL_ID.fullmatch(cid):raise ValueError('Invalid container ID')
    directory=req.get('maintenanceDirectory')
    if directory is not None and (not isinstance(directory,str) or not directory.startswith('/') or '..' in directory.split('/')):raise ValueError('Invalid maintenance directory')
    if not isinstance(req.get('siteKey'),str) or not SITE_KEY.fullmatch(req['siteKey']):raise ValueError('Invalid site key')
    def refused(code):emit(result={'outcome':'refused','code':code})
    lock=heal_lock(req['siteKey'])
    if lock is None:return refused('busy')
    try:
        if directory is not None and os.path.lexists(os.path.join(directory,'enabled')):return refused('maintenance')
        found=subprocess.run(['docker','inspect','--type','container',entry['name']],capture_output=True,timeout=30)
        if found.returncode!=0:return refused('missing')
        try:c=json.loads(found.stdout)[0]
        except Exception:return refused('missing')
        if not heal_matches(entry,c['Name'].lstrip('/'),(c.get('Config') or {}).get('Labels') or {}):return refused('labels')
        if c.get('Id')!=cid:return refused('recreated')
        if not (c.get('State') or {}).get('Running'):return refused('not_running')
        if heal_health(c)!='unhealthy':return refused('not_unhealthy')
        try:code=(run or subprocess.run)(['docker','restart','--time','30',entry['name']],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120).returncode
        except subprocess.TimeoutExpired:return emit(result={'outcome':'failed','code':'timeout','message':'The restart did not finish in 2 minutes.'})
        if code==0:return emit(result={'outcome':'restarted'})
        emit(result={'outcome':'failed','code':'exit_%d'%code if code in HEAL_RESTART_SENTENCES else 'exit_other','exitCode':code if isinstance(code,int) and 0<=code<=255 else None,'message':HEAL_RESTART_SENTENCES.get(code,'Docker could not restart the container.')})
    finally:
        if lock is not True:lock.close()
