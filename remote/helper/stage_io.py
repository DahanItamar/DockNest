# helper/stage_io.py: Move one staged package between DockNest and the server's root-only staging folders, through the helper.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno,base64
from .common import (
    emit, sync_directory)
from .paths import (
    SYSTEM_TREES, within)
from .staging import (
    staging_base)
# </build:header>
# A sudo SSH user on a NAS cannot read the root-only (0700) staging folders over SFTP, and they are not opened up to it. The helper
# runs as root and streams one package instead: stage-read writes it to stdout, stage-write reads it from stdin. Both are confined to
# DockNest's own staging folders: an absolute path with no '..', no symbolic link anywhere in it (checked with realpath and with
# O_NOFOLLOW on the file), a regular file, a size cap, and a SHA-256 and byte count that both ends compare.
STAGE_IO_ROOTS=('/var/lib/docknest','/var/lib/docker-backup-manager')
# A staging folder named by the request must be DockNest's own folder (the names the NAS staging base uses), not any deep path.
STAGE_IO_FOLDER_NAMES=('.docknest','@docknest','docknest')
STAGE_IO_MAX=1<<42
STAGE_IO_CHUNK=1024*1024
def stage_io_roots(extra):
    roots=list(STAGE_IO_ROOTS)
    if extra is not None:
        if not isinstance(extra,str):raise ValueError('Invalid staging folder')
        base=str(staging_base({'stagingRoot':extra}))
        if len(pathlib.PurePosixPath(base).parts)<3 or pathlib.PurePosixPath(base).name not in STAGE_IO_FOLDER_NAMES or any(within(base,tree) for tree in SYSTEM_TREES):raise ValueError('Invalid staging folder')
        roots.append(base)
    return roots
def stage_io_path(value,extra=None,parent_only=False):
    """The path itself (stage-read) or its folder (stage-write) must be a real folder entry below a staging root."""
    if not isinstance(value,str) or not value.startswith('/') or '\0' in value or len(value)>1024:raise ValueError('Invalid package path')
    path=pathlib.PurePosixPath(value)
    if '..' in path.parts or '.' in path.parts or str(path)!=value.rstrip('/') or value.endswith('/'):raise ValueError('Invalid package path')
    folder=str(path.parent) if parent_only else value
    if os.path.realpath(folder)!=folder:raise ValueError('Package paths cannot contain symbolic links')
    if not any(within(value,root) and value!=root and os.path.realpath(root)==root for root in stage_io_roots(extra)):raise ValueError('The package is outside the DockNest staging folders')
    return value
def stage_read(req):
    path=stage_io_path(req.get('path'),req.get('stagingBase'))
    flags=os.O_RDONLY|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_NOFOLLOW',0)
    fd=os.open(path,flags)
    with os.fdopen(fd,'rb') as source:
        info=os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):raise ValueError('The package is not a regular file')
        if info.st_size>STAGE_IO_MAX:raise ValueError('The package is too large')
        emit(total=info.st_size)
        digest=hashlib.sha256();count=0;out=sys.stdout.buffer
        while True:
            chunk=source.read(STAGE_IO_CHUNK)
            if not chunk:break
            digest.update(chunk);count+=len(chunk);out.write(chunk)
        out.flush()
        if count!=info.st_size:raise ValueError('The package changed while it was read')
    emit(result={'size':count,'sha256':digest.hexdigest()})
def stage_write(req):
    path=stage_io_path(req.get('path'),req.get('stagingBase'),parent_only=True)
    if os.path.islink(path):raise ValueError('Package paths cannot contain symbolic links')
    # The package is written to <path>.part (created new, owner only) and renamed into place once it is complete and checked, so a
    # refused or broken upload never touches an existing package, and only the .part file is ever removed.
    part=path+'.part'
    try:os.unlink(part)  # a leftover of an interrupted upload; never followed, it is DockNest's own name
    except FileNotFoundError:pass
    fd=os.open(part,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
    done=False
    try:
        with os.fdopen(fd,'wb') as target:
            if not stat.S_ISREG(os.fstat(target.fileno()).st_mode):raise ValueError('The package destination is not a regular file')
            digest=hashlib.sha256();count=0;end=None
            while True:
                line=sys.stdin.readline()
                if not line:raise ValueError('The package ended before its end marker')
                line=line.rstrip('\n')
                if line.startswith('D '):
                    chunk=base64.b64decode(line[2:],validate=True)
                    count+=len(chunk)
                    if count>STAGE_IO_MAX:raise ValueError('The package is too large')
                    digest.update(chunk);target.write(chunk)
                elif line.startswith('END '):
                    parts=line.split(' ')
                    if len(parts)!=3:raise ValueError('Invalid package end marker')
                    end=(int(parts[1]),parts[2]);break
                else:raise ValueError('Invalid package data')
            if end[0]!=count or end[1]!=digest.hexdigest():raise ValueError('The package did not arrive intact')
            target.flush();os.fsync(target.fileno())
        os.replace(part,path)
        sync_directory(os.path.dirname(path))
        done=True
    finally:
        if not done:
            try:os.unlink(part)
            except OSError:pass
    emit(result={'size':count,'sha256':digest.hexdigest()})
