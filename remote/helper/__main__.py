# helper/__main__.py: Locks, stdin watcher, operation dispatch (main) and the two command-line entry points.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    VERSION, diagnostic, docker, emit, inspect)
from .backup import (
    backup_plan, capture, public_plan, readiness)
from .incremental import (
    incremental_commit, incremental_discard)
from .net import (
    skip_refused_probes)
from .maintenance import (
    deploy_maintenance, maintenance, setup_maintenance)
from .discovery import (
    configuration_paths, list_project_files, nginx_sites, web_hints)
from .restore import (
    external_restore_plan, prepare_restore, restore, restore_chain_offline, verify_recovery,
    verify_restore_recovery)
from .staging import (
    cleanup_staging, install_boot_recovery, list_staging)
from .move import (
    MOVES_ROOT, deploy_restore, deploy_status, deploy_teardown, move_certificate, move_facts,
    move_finalize_target, move_id, move_remove_old, move_resume_source, move_retire_source, move_stop_target,
    move_test, move_unretire_source)
from .install import (
    install_package, install_status)
from .restore_test import (
    TEST_LABEL, egress_intact, restore_test_check, restore_test_prepare, restore_test_reap, restore_test_run,
    restore_test_status, restore_test_teardown, test_id, test_lock, test_state)
# Mutable state lives in common and is never copied by import: CAPTURE_DIAGNOSTICS, EVENT_STREAM, MOVE_ID, MOVE_LOCK, SNAPSHOT_FILTER, STOPPING
# </build:header>
LOCKED_TEST_OPS={'restore-test-prepare','restore-test-run','restore-test-teardown'}
LOCKED_MOVE_OPS={'deploy-restore','deploy-teardown','move-test','move-resume-source','move-retire-source','move-finalize-target','move-certificate','move-stop-target','move-unretire-source','move-remove-old'}
def move_lock(mid,wait=False):
    import fcntl
    d=MOVES_ROOT/mid;MOVES_ROOT.mkdir(parents=True,exist_ok=True,mode=0o700);d.mkdir(exist_ok=True,mode=0o700)
    handle=open(d/'.lock','a')
    try:fcntl.flock(handle,fcntl.LOCK_EX|(0 if wait else fcntl.LOCK_NB))
    except BlockingIOError:handle.close();return None
    return handle
def docker_snapshot():
    try:return subprocess.run(['docker','ps','-a','--no-trunc','--filter',SNAPSHOT_FILTER or 'label=docknest.move='+MOVE_ID,'--format','{{.ID}} {{.State}}'],capture_output=True,timeout=20).stdout.decode().split('\n')
    except Exception:return None
def stop_after_stdin(read=None,limit=180):
    """DockNest keeps stdin open while it waits. When it gives up (time limit) or its connection drops, stdin ends:
    end every child process, then keep the move lock (this process) until Docker has settled, meaning two snapshots of
    the move's containers 2 s apart are identical and none is restarting or being removed. A Try again never races
    Docker's own work."""
    global STOPPING
    try:(read or sys.stdin.read)()
    except Exception:pass
    STOPPING=True
    try:signal.signal(signal.SIGTERM,signal.SIG_IGN);os.killpg(os.getpgrp(),signal.SIGTERM)
    except Exception:pass
    deadline=time.time()+limit;previous=None
    while time.time()<deadline:
        current=docker_snapshot()
        if current is not None and current==previous and not any(line.endswith((' restarting',' removing')) for line in current):break
        previous=current;time.sleep(2)
    os._exit(1)
def watch_stdin():threading.Thread(target=stop_after_stdin,daemon=True).start()
def main(req):
    global EVENT_STREAM,CAPTURE_DIAGNOSTICS,MOVE_LOCK,MOVE_ID,SNAPSHOT_FILTER
    if req.get('operation')=='move-lock-status':
        handle=move_lock(move_id(req))
        emit(result={'busy':handle is None})
        return
    if req.get('operation') in LOCKED_MOVE_OPS:
        MOVE_LOCK=move_lock(move_id(req));MOVE_ID=move_id(req)
        if MOVE_LOCK is None:raise ValueError('Another DockNest step for this move is still running on this server.')
        if req.get('watchStdin'):watch_stdin()
    if req.get('operation') in LOCKED_TEST_OPS:
        tid=test_id(req)
        if req['operation']=='restore-test-prepare':test_state(tid,create=True)
        # Teardown waits for a step DockNest just stopped to let go of the copy; other steps never queue behind one.
        MOVE_LOCK=test_lock(tid,200 if req['operation']=='restore-test-teardown' else 0)
        SNAPSHOT_FILTER='label='+TEST_LABEL+'='+tid
        if req.get('watchStdin'):watch_stdin()
    op=req['operation']
    CAPTURE_DIAGNOSTICS=op in ['capture','capture-stream'] and bool(req.get('diagnostics'))
    if op=='capture-stream':EVENT_STREAM=sys.stderr
    if op=='readiness':emit(result=readiness(req['config']))
    elif op=='plan':emit(result=public_plan(backup_plan(req['config'])))
    elif op=='install-boot-recovery':install_boot_recovery(req)
    elif op=='test':
        emit(result={'helperVersion':VERSION,'docker':docker('version','--format','{{.Server.Version}}').decode().strip(),'architecture':docker('info','--format','{{.Architecture}}').decode().strip(),'freeBytes':shutil.disk_usage('/').free,'uid':os.geteuid()})
    elif op=='discover':
        ids=docker('ps','-aq').decode().split()
        cs=inspect(ids) if ids else []
        # Do not expose environment secrets to dashboard.
        routes=nginx_sites()
        emit(result={'staticSites':[site for site in routes if site['kind']=='static'],'containers':[{'id':c['Id'],'name':c['Name'].lstrip('/'),'image':c['Config']['Image'],'state':c['State']['Status'],'running':c['State']['Running'],'health':c['State'].get('Health',{}).get('Status'),'labels':c['Config'].get('Labels',{}),'mounts':c['Mounts'],'temporaryMemoryFolders':list(c.get('HostConfig',{}).get('Tmpfs',{})),'ports':c['NetworkSettings']['Ports'],'webHints':web_hints(c,routes),'backupConfiguration':configuration_paths(c)} for c in cs]})
    elif op=='list-project-files':emit(result=list_project_files(req['containers'],req.get('directory')))
    elif op=='capture':capture(req)
    elif op=='capture-stream':capture(req,sys.stdout.buffer)
    elif op=='prepare-restore':prepare_restore(req)
    elif op=='restore':restore(req)
    elif op=='plan-external-restore':emit(result=external_restore_plan(req['manifest'],req.get('externalReadOnly',[]),metadata_only=True))
    elif op=='verify-recovery':verify_recovery(req)
    elif op=='setup-maintenance':setup_maintenance(req)
    elif op=='verify-restore-recovery':verify_restore_recovery(req)
    elif op=='deploy-maintenance':deploy_maintenance(req)
    elif op=='maintenance':
        req['config'].setdefault('maintenance',{})['required']=True
        refused=skip_refused_probes(req['config'])
        if req['enabled'] and 'public' in refused:raise ValueError("Probe URL policy: %s. Update the site's public maintenance URL before enabling maintenance."%refused['public'])
        maintenance(req['config'],req['enabled']);emit(result={'enabled':req['enabled']})
    elif op=='cleanup':cleanup_staging(req);emit(result={'removed':True})
    elif op=='incremental-commit':incremental_commit(req)
    elif op=='incremental-discard':incremental_discard(req)
    elif op=='list-staging':emit(result=list_staging(req['config']))
    elif op=='move-facts':move_facts(req)
    elif op=='install-status':install_status()
    elif op=='install':install_package(req)
    elif op=='deploy-restore':deploy_restore(req)
    elif op=='deploy-teardown':deploy_teardown(req)
    elif op=='deploy-status':deploy_status(req)
    elif op=='move-test':move_test(req)
    elif op=='move-resume-source':move_resume_source(req)
    elif op=='move-retire-source':move_retire_source(req)
    elif op=='move-finalize-target':move_finalize_target(req)
    elif op=='move-certificate':move_certificate(req)
    elif op=='move-stop-target':move_stop_target(req)
    elif op=='move-unretire-source':move_unretire_source(req)
    elif op=='move-remove-old':move_remove_old(req)
    elif op=='restore-test-check':restore_test_check(req)
    elif op=='restore-test-prepare':restore_test_prepare(req)
    elif op=='restore-test-run':restore_test_run(req)
    elif op=='restore-test-teardown':restore_test_teardown(req)
    elif op=='restore-test-status':restore_test_status(req)
    elif op=='restore-test-mail-check':
        tid=test_id(req);_,state=test_state(tid);ids=[item['id'] for item in (state.get('restored') or {}).get('containers',[]) if item['id'] in (state.get('restored') or {}).get('running',[])]
        emit(result={'intact':egress_intact(tid,ids) if (state.get('restored') or {}).get('internet') else None})
    elif op=='restore-test-reap':restore_test_reap(req)
    else:raise ValueError('Unsupported helper operation')
if __name__=='__main__' and sys.argv[1:2]==['restore-chain']:
    # Recovery kit, run by hand as root: python3 helper.py restore-chain <decrypted chain folder> <new empty folder>.
    # DockNest itself runs the helper from stdin (python3 -c), so this never matches its own calls.
    if len(sys.argv)!=4:print('Usage: python3 helper.py restore-chain <folder written by decrypt-backup.js --chain> <new empty folder>',file=sys.stderr);sys.exit(2)
    try:restore_chain_offline(sys.argv[2],sys.argv[3])
    except Exception as e:print('Chain restore failed: %s'%e,file=sys.stderr);sys.exit(1)
elif __name__=='__main__':
    try:main(json.loads(sys.stdin.readline()))
    except Exception as e:
        diagnostic(phase='helper-failure',exceptionType=type(e).__name__)
        emit(error=str(e));sys.exit(1)
