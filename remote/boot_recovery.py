#!/usr/bin/env python3
"""Root-owned, opt-in boot recovery. Never execute config-supplied commands."""
import json,os,pathlib,stat,uuid,time,sys
from helper import inspect,restart_services,health,maintenance,atomic_json,complete_recovery

def private_path(path,directory=False):
    path=pathlib.Path(path)
    if not path.is_absolute() or path.resolve()!=path:raise ValueError('Recovery paths must not use symlinks')
    value=path.stat()
    if value.st_uid!=0 or value.st_mode&0o077:raise ValueError('Recovery journals must be root-owned and private')
    if directory and not stat.S_ISDIR(value.st_mode):raise ValueError('Recovery directory required')
    if not directory and not stat.S_ISREG(value.st_mode):raise ValueError('Recovery journal must be a regular file')
    return path

def recover_jobs(roots,boot_id=None):
    if os.geteuid()!=0:raise ValueError('Boot recovery requires root')
    boot_id=boot_id or pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    result={'recovered':0,'reviewRequired':0,'ignored':0}
    for value in roots:
        base=private_path(value,True)
        for candidate in base.iterdir():
            try:uuid.UUID(candidate.name)
            except ValueError:continue
            try:
                root=private_path(candidate,True)
                if (root/'disarmed').exists():result['ignored']+=1;continue
                completed=root/'boot-recovery-completed.json'
                if completed.exists():
                    completion=json.loads(private_path(completed).read_text())
                    if completion.get('version')!=1 or completion.get('completed') is not True:raise ValueError('Invalid recovery completion journal')
                    result['ignored']+=1;continue
                record=json.loads(private_path(root/'boot-recovery.json').read_text())
                if record.get('version')!=1:raise ValueError('Unsupported recovery journal')
                if record['bootId']==boot_id:result['ignored']+=1;continue # Current-boot watchdog may own it.
                states=inspect(list(record['identities']))
                if {c['Id']:c['Image'] for c in states}!=record['identities']:raise ValueError('Source service identity changed')
                if any(c['State']['Running'] and c['Id'] not in record['running'] for c in states):raise ValueError('Originally stopped service is unexpectedly running')
                cfg=record['config']
                restart_services(record['running'],cfg.get('_serviceContracts'))
                if not health(record['running'],cfg.get('maintenance',{}).get('healthUrl')):raise ValueError('Source health did not recover')
                maintenance(cfg,False)
                atomic_json(root/'recovery.json',{'recovered':True,'bootRecovery':True,'at':time.time()})
                # A retained successful journal must never restart an intentionally
                # stopped service on a later boot. Persist completion before return.
                complete_recovery(root,boot_id)
                (root/'watchdog.done').touch(mode=0o600)
                result['recovered']+=1
            except Exception:
                # Record no credential, config path, raw Docker error or source name.
                result['reviewRequired']+=1
                if candidate.is_dir() and not candidate.is_symlink():
                    try:atomic_json(candidate/'recovery.json',{'recovered':False,'bootRecovery':True,'at':time.time()})
                    except Exception:pass
    return result

if __name__=='__main__':
    try:
        registry=private_path('/etc/docknest/recovery-roots.json')
        result=recover_jobs(json.loads(registry.read_text())['roots'])
        print(json.dumps(result));sys.exit(1 if result['reviewRequired'] else 0)
    except Exception:print('Boot recovery needs operator review.',file=sys.stderr);sys.exit(1)
