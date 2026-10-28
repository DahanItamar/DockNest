#!/usr/bin/env python3
"""Export an already authenticated private backup as a browsable, complete ZIP."""
import io,sys,tarfile,zipfile,json,pathlib,shutil,re,stat,os

START_STATIC='DockNest static website backup\n\nsite-files/ contains the captured HTML, assets and other website files. configuration/ contains the selected nginx and deployment files. recovery-originals/static-files.tar preserves Linux owners, permissions, ACLs and xattrs; use it for a faithful Linux restore. Verify the manifest file digest before a separate nginx cutover. The existing website, TLS keys and external services are not changed or automatically restored. This ZIP is decrypted and may contain private configuration. Keep it private.\n'
START_DOCKER='DockNest site backup\n\nsite-files/ contains browsable copies of captured persistent data, including selected database files and uploads. Read manifest.excludedPaths for any data outside the selected backup scope. Excluded external storage must be recovered separately.\nconfiguration/ contains your deployment configuration.\nrecovery-originals/ contains the complete original backup bundle: exact Docker images (including writable application layers), mount archives preserving Linux UID/GID, permissions, links, ACLs and xattrs, the private manifest and restore guide. Use these original archives for a faithful Linux restore; ZIP browsing copies do not preserve every Linux attribute.\n\nDatabase data files require the matching database image; this is not a SQL dump. Temporary RAM folders are recreated empty.\nThis ZIP contains credentials and is decrypted. Keep it private.\n'

class IncrementalBackup(ValueError):
    """A format v2 increment holds only changed files, so it cannot become a complete ZIP on its own."""
    def __init__(self):super().__init__('This backup is incremental. Use Download chain.')

def checked_manifest(manifest):
    if not isinstance(manifest,dict) or manifest.get('formatVersion') not in (1,2) or not manifest.get('complete'):raise ValueError('Incomplete backup')
    if manifest['formatVersion']==2 and manifest.get('backupKind')!='full':raise IncrementalBackup()
    return manifest

def safe_name(name):
    p=pathlib.PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '\\' in name or not p.parts:raise ValueError('Unsafe archive path')
    return str(p)

def copy_entry(z,name,source,size,mode=0o600):
    item=zipfile.ZipInfo(safe_name(name));item.create_system=3;item.external_attr=(stat.S_IFREG|(mode&0o777))<<16
    item.compress_type=zipfile.ZIP_DEFLATED
    item._compresslevel=1
    with z.open(item,'w',force_zip64=True) as output:shutil.copyfileobj(source,output,1024*1024)

def export_zip(payload,output):
    with tarfile.open(payload,'r:gz') as package:
        members=package.getmembers()
        names=[safe_name(m.name) for m in members]
        regular={m.name:m for m in members if m.isfile()}
        for member in members:
            if member.islnk():
                if not re.fullmatch(r'mount-\d+-\d+\.tar',member.name) or not re.fullmatch(r'mount-\d+-\d+\.tar',member.linkname) or member.linkname not in regular:raise ValueError('Invalid shared mount archive link')
            elif not member.isfile():raise ValueError('Invalid backup package')
        if len(names)!=len(set(names)):raise ValueError('Invalid backup package')
        if any(not OUTER.fullmatch(n) for n in names):raise ValueError('Unexpected backup entry')
        manifest=checked_manifest(json.load(package.extractfile('manifest.json')))
        if any(SNAPSHOT.fullmatch(n) for n in names) and manifest['formatVersion']!=2:raise ValueError('Unexpected backup entry')
        with zipfile.ZipFile(output,'w',allowZip64=True,compression=zipfile.ZIP_DEFLATED,compresslevel=1) as z:
            z.writestr('START-HERE.txt',START_STATIC if manifest.get('kind')=='static' else START_DOCKER);output.flush()
            for member in members:
                copy_entry(z,'recovery-originals/'+member.name,package.extractfile(member),regular[member.linkname].size if member.islnk() else member.size)
                match=re.fullmatch(r'mount-(\d+)-(\d+)\.tar',member.name)
                if match:
                    i,j=map(int,match.groups());container=manifest['containers'][i];mount=container['Mounts'][j]
                    prefix='site-files/'+safe_name(container['Name'].lstrip('/'))+'/'+safe_name(mount['Destination'].lstrip('/'))
                elif member.name=='static-files.tar':
                    if manifest.get('kind')!='static':raise ValueError('Static archive requires a static-site manifest')
                    prefix='site-files/'+safe_name(pathlib.PurePosixPath(manifest['documentRoot']).name)
                elif re.fullmatch(r'config-\d+\.tar',member.name):
                    index=int(member.name[7:-4]);prefix='configuration/'+safe_name(manifest['configurationFiles'][index].lstrip('/'))
                else:continue
                with tarfile.open(fileobj=package.extractfile(member),mode='r:') as nested:
                    root=None;seen=set()
                    for entry in nested:
                        name=safe_name(entry.name);parts=pathlib.PurePosixPath(name).parts
                        if root is None:root=parts[0]
                        if parts[0]!=root:raise ValueError('Invalid mount archive root')
                        relative='/'.join(parts[1:]);target=prefix+('/'+relative if relative else '')
                        if target in seen:raise ValueError('Duplicate mount entry')
                        seen.add(target)
                        if entry.isfile():copy_entry(z,target,nested.extractfile(entry),entry.size,entry.mode)
                        elif entry.islnk():
                            linked=entry;visited=set()
                            while linked.islnk():
                                link=safe_name(linked.linkname)
                                if link in visited or pathlib.PurePosixPath(link).parts[0]!=root:raise ValueError('Unsafe hard link')
                                visited.add(link);linked=nested.getmember(link)
                            if not linked.isfile():raise ValueError('Hard link target is not a regular file')
                            copy_entry(z,target,nested.extractfile(linked),linked.size,entry.mode)
                        elif entry.isdir():z.writestr(target+'/',b'')
                        elif entry.issym():
                            # Original tar archives retain link semantics; browsing copies never create a potentially unsafe link.
                            z.writestr(target+'.docknest-link.txt','Original Linux link: '+entry.linkname+'\nRestore it from recovery-originals, preserving its original semantics.\n')
                        else:raise ValueError('Unsupported file type in backup')

# --- Streaming mode: the server never stores the decrypted backup. ---------------------------------------------
# --scan   stdin: plaintext gzip tar. Validates the package layout and writes manifest.json to stdout.
# --stream stdin: 8-byte plaintext length, 8-byte manifest length, the manifest, then the plaintext gzip tar twice.
#          The first pass writes recovery-originals/, the second the browsable site-files/ and configuration/ copies
#          (a ZIP can only write one entry at a time). Hard links cannot be re-read from a stream: they are written as
#          small .docknest-link.txt notes; the exact bytes remain in recovery-originals/.
# snapshot-*.snar: GNU tar snapshot files of a format v2 package; kept in recovery-originals, never browsed.
OUTER=re.compile(r'(?:manifest.json|images.tar|static-files.tar|restore-guide.md|mount-\d+-\d+\.tar|config-\d+\.tar|snapshot-[0-9a-f]{64}\.snar)')
SNAPSHOT=re.compile(r'snapshot-[0-9a-f]{64}\.snar')
MOUNT=re.compile(r'mount-\d+-\d+\.tar')
MAX_MANIFEST=16*1024*1024

class Sink:
    # A plain forward-only writer: zipfile then always uses data descriptors, even where a pipe reports a position (Windows).
    def __init__(self,target):self.target=target
    def write(self,data):return self.target.write(data)
    def flush(self):self.target.flush()

class Limited:
    def __init__(self,source,length):self.source=source;self.left=length
    def read(self,size=-1):
        if self.left<=0:return b''
        if size is None or size<0 or size>self.left:size=self.left
        data=self.source.read(size);self.left-=len(data);return data
    def finish(self):
        while self.left>0:
            if not self.read(1024*1024):raise ValueError('Truncated backup stream')

def outer_members(stream):
    with tarfile.open(fileobj=stream,mode='r|gz') as package:
        seen=set();regular=set()
        for member in package:
            name=safe_name(member.name)
            if name in seen or not OUTER.fullmatch(name):raise ValueError('Invalid backup package')
            if member.islnk():
                if not MOUNT.fullmatch(name) or not MOUNT.fullmatch(member.linkname) or member.linkname not in regular:raise ValueError('Invalid shared mount archive link')
            elif member.isfile():regular.add(name)
            else:raise ValueError('Invalid backup package')
            seen.add(name)
            yield member,package

def read_manifest(member,package):
    if member.size>MAX_MANIFEST:raise ValueError('Manifest is too large')
    return package.extractfile(member).read()

def check_manifest(raw):
    return checked_manifest(json.loads(raw))

def prefix_for(name,manifest):
    if MOUNT.fullmatch(name):
        i,j=map(int,re.fullmatch(r'mount-(\d+)-(\d+)\.tar',name).groups());container=manifest['containers'][i];mount=container['Mounts'][j]
        return 'site-files/'+safe_name(container['Name'].lstrip('/'))+'/'+safe_name(mount['Destination'].lstrip('/'))
    if name=='static-files.tar':
        if manifest.get('kind')!='static':raise ValueError('Static archive requires a static-site manifest')
        return 'site-files/'+safe_name(pathlib.PurePosixPath(manifest['documentRoot']).name)
    if re.fullmatch(r'config-\d+\.tar',name):
        index=int(name[7:-4]);return 'configuration/'+safe_name(manifest['configurationFiles'][index].lstrip('/'))
    return None

def scan_stream(stream,output):
    raw=None;names=[]
    for member,package in outer_members(stream):
        names.append(member.name)
        if member.name=='manifest.json':raw=read_manifest(member,package)
    if raw is None:raise ValueError('Backup has no manifest')
    manifest=check_manifest(raw)
    if any(SNAPSHOT.fullmatch(n) for n in names) and manifest['formatVersion']!=2:raise ValueError('Unexpected backup entry')
    for name in names:prefix_for(name,manifest)
    output.write(raw)

def stream_originals(z,stream,pinned):
    seen_manifest=False
    for member,package in outer_members(stream):
        name='recovery-originals/'+member.name
        if member.islnk():
            z.writestr(name+'.docknest-link.txt','This file has exactly the same content as recovery-originals/'+member.linkname+'.\n');continue
        if member.name=='manifest.json':
            raw=read_manifest(member,package)
            if raw!=pinned:raise ValueError('Backup changed while exporting')
            seen_manifest=True;z.writestr(name,raw);continue
        copy_entry(z,name,package.extractfile(member),member.size)
    if not seen_manifest:raise ValueError('Backup has no manifest')

def stream_browsing(z,stream,manifest):
    for member,package in outer_members(stream):
        prefix=prefix_for(member.name,manifest)
        if prefix is None:continue
        if member.islnk():
            z.writestr(prefix+'/DOCKNEST-SHARED-MOUNT.txt','This mount holds the same data as '+member.linkname+'; browse that folder or use recovery-originals/'+member.linkname+'.\n');continue
        with tarfile.open(fileobj=package.extractfile(member),mode='r|') as nested:
            root=None;seen=set()
            for entry in nested:
                name=safe_name(entry.name);parts=pathlib.PurePosixPath(name).parts
                if root is None:root=parts[0]
                if parts[0]!=root:raise ValueError('Invalid mount archive root')
                relative='/'.join(parts[1:]);target=prefix+('/'+relative if relative else '')
                if target in seen:raise ValueError('Duplicate mount entry')
                seen.add(target)
                if entry.isfile():copy_entry(z,target,nested.extractfile(entry),entry.size,entry.mode)
                elif entry.islnk():
                    link=safe_name(entry.linkname)
                    if pathlib.PurePosixPath(link).parts[0]!=root:raise ValueError('Unsafe hard link')
                    z.writestr(target+'.docknest-link.txt','Original Linux hard link to '+'/'.join(pathlib.PurePosixPath(link).parts[1:])+'\nThe content is in that file; restore links from recovery-originals, preserving their original semantics.\n')
                elif entry.isdir():z.writestr(target+'/',b'')
                elif entry.issym():z.writestr(target+'.docknest-link.txt','Original Linux link: '+entry.linkname+'\nRestore it from recovery-originals, preserving its original semantics.\n')
                else:raise ValueError('Unsupported file type in backup')

def export_stream(source,output):
    head=source.read(16)
    if len(head)!=16:raise ValueError('Truncated input')
    length=int.from_bytes(head[:8],'big');manifest_length=int.from_bytes(head[8:],'big')
    if manifest_length>MAX_MANIFEST:raise ValueError('Manifest is too large')
    pinned=source.read(manifest_length)
    if len(pinned)!=manifest_length:raise ValueError('Truncated input')
    manifest=check_manifest(pinned)
    with zipfile.ZipFile(output,'w',allowZip64=True,compression=zipfile.ZIP_DEFLATED,compresslevel=1) as z:
        z.writestr('START-HERE.txt',START_STATIC if manifest.get('kind')=='static' else START_DOCKER)
        first=Limited(source,length);stream_originals(z,first,pinned);first.finish()
        second=Limited(source,length);stream_browsing(z,second,manifest);second.finish()

if __name__=='__main__':
    try:
        if sys.argv[1:]==['--scan']:scan_stream(sys.stdin.buffer,sys.stdout.buffer)
        elif sys.argv[1:]==['--stream']:export_stream(sys.stdin.buffer,Sink(sys.stdout.buffer))
        elif len(sys.argv)>2:
            with open(sys.argv[2],'xb') as output:
                os.chmod(sys.argv[2],0o600);export_zip(sys.argv[1],output)
            with zipfile.ZipFile(sys.argv[2]) as completed:
                if completed.testzip() is not None:raise ValueError('ZIP integrity verification failed')
        else:export_zip(sys.argv[1],Sink(sys.stdout.buffer))
    except (BrokenPipeError,ConnectionResetError):sys.exit(1)
    except IncrementalBackup as error:
        print(str(error),file=sys.stderr);sys.exit(1)
    except Exception:
        print('Could not export the complete backup ZIP.',file=sys.stderr);sys.exit(1)
