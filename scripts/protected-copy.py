#!/usr/bin/env python3
"""Run on a separate Linux archive host, never with the manager's credentials."""
import os,sys,pathlib,hashlib,uuid,json,re,stat

def protect_copy(source,destination,expected):
    if os.geteuid()!=0:raise ValueError('Run as the independent archive administrator')
    source=pathlib.Path(source);destination=pathlib.Path(destination)
    if not re.fullmatch(r'[a-f0-9]{64}',expected):raise ValueError('Expected authenticated package checksum required')
    if source.resolve()!=source or not source.is_file():raise ValueError('Input must be a regular absolute non-symlink file')
    if not destination.is_absolute() or destination.resolve()!=destination or destination==source.parent or destination in source.parents:raise ValueError('Separate archive directory required')
    # Every ancestor must be controlled by root; a writable parent allows renaming the protected directory.
    for parent in [destination,*destination.parents]:
        value=parent.stat()
        if value.st_uid!=0 or value.st_mode&0o022:raise ValueError('Archive and ancestors must be root-owned without group/other write access')
    if destination.stat().st_mode&0o077:raise ValueError('Archive directory must have mode 0700')
    name=str(uuid.uuid4())+('.dkit' if source.suffix=='.dkit' else '.enc');temporary=destination/('.incoming-'+name);published=destination/name
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);digest=hashlib.sha256();size=0
    try:
        source_fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(source_fd,'rb') as input_file,os.fdopen(fd,'wb') as output:
            if not stat.S_ISREG(os.fstat(input_file.fileno()).st_mode):raise ValueError('Regular input required')
            for chunk in iter(lambda:input_file.read(1024*1024),b''):output.write(chunk);digest.update(chunk);size+=len(chunk)
            output.flush();os.fsync(output.fileno())
        if digest.hexdigest()!=expected:raise ValueError('Protected-copy checksum differs from authenticated source')
        os.chmod(temporary,0o400);os.link(temporary,published);temporary.unlink()
        # The index is private; it contains no source paths, names or credentials.
        record={'version':1,'file':name,'sha256':expected,'bytes':size,'protection':'independent root-owned archive; manager has no deletion credential'}
        index=published.with_suffix(published.suffix+'.json')
        descriptor=os.open(index,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
        with os.fdopen(descriptor,'w') as output:json.dump(record,output);output.flush();os.fsync(output.fileno())
        directory_fd=os.open(destination,os.O_RDONLY)
        try:os.fsync(directory_fd)
        finally:os.close(directory_fd)
        return record
    finally:temporary.unlink(missing_ok=True)

if __name__=='__main__':
    try:
        if len(sys.argv)!=4:raise ValueError('Usage: protected-copy.py ABSOLUTE_INPUT PRIVATE_ARCHIVE EXPECTED_SHA256')
        print(json.dumps(protect_copy(*sys.argv[1:])))
    except Exception:print('Protected copy failed: verify independent root ownership, paths, capacity and source checksum.',file=sys.stderr);sys.exit(1)
