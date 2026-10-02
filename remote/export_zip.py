#!/usr/bin/env python3
"""Export an already authenticated private backup as a browsable, complete ZIP."""
import sys,tarfile,zipfile,json,pathlib,shutil,re,stat,os

def safe_name(name):
    p=pathlib.PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '\\' in name or not p.parts:raise ValueError('Unsafe archive path')
    return str(p)

def copy_entry(z,name,source,size,mode=0o600):
    item=zipfile.ZipInfo(safe_name(name));item.create_system=3;item.external_attr=(stat.S_IFREG|mode)<<16
    item.compress_type=zipfile.ZIP_DEFLATED
    item._compresslevel=1
    with z.open(item,'w',force_zip64=True) as output:shutil.copyfileobj(source,output,1024*1024)

def export_zip(payload,output):
    with tarfile.open(payload,'r:gz') as package:
        members=package.getmembers()
        names=[safe_name(m.name) for m in members]
        if len(names)!=len(set(names)) or any(not m.isfile() for m in members):raise ValueError('Invalid backup package')
        if any(not re.fullmatch(r'(?:manifest.json|images.tar|static-files.tar|restore-guide.md|mount-\d+-\d+\.tar|config-\d+\.tar)',n) for n in names):raise ValueError('Unexpected backup entry')
        manifest=json.load(package.extractfile('manifest.json'))
        if manifest.get('formatVersion')!=1 or not manifest.get('complete'):raise ValueError('Incomplete backup')
        with zipfile.ZipFile(output,'w',allowZip64=True,compression=zipfile.ZIP_DEFLATED,compresslevel=1) as z:
            z.writestr('START-HERE.txt','DockNest static website backup\n\nsite-files/ contains the captured HTML, assets and other website files. configuration/ contains the selected nginx and deployment files. recovery-originals/static-files.tar preserves Linux owners, permissions, ACLs and xattrs; use it for a faithful Linux restore. Verify the manifest file digest before a separate nginx cutover. The existing website, TLS keys and external services are not changed or automatically restored. This ZIP is decrypted and may contain private configuration. Keep it private.\n' if manifest.get('kind')=='static' else 'DockNest full site backup\n\nsite-files/ contains browsable copies of all persistent mounted data, including database files and uploads.\nconfiguration/ contains your deployment configuration.\nrecovery-originals/ contains the complete original backup bundle: exact Docker images (including writable application layers), mount archives preserving Linux UID/GID, permissions, links, ACLs and xattrs, the private manifest and restore guide. Use these original archives for a faithful Linux restore; ZIP browsing copies do not preserve every Linux attribute.\n\nDatabase data files require the matching database image; this is not a SQL dump. Temporary RAM folders are recreated empty.\nThis ZIP contains credentials and is decrypted. Keep it private.\n')
            for member in members:
                copy_entry(z,'recovery-originals/'+member.name,package.extractfile(member),member.size)
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

if __name__=='__main__':
    try:
        if len(sys.argv)>2:
            with open(sys.argv[2],'xb') as output:
                os.chmod(sys.argv[2],0o600);export_zip(sys.argv[1],output)
            with zipfile.ZipFile(sys.argv[2]) as completed:
                if completed.testzip() is not None:raise ValueError('ZIP integrity verification failed')
        else:export_zip(sys.argv[1],sys.stdout.buffer)
    except (BrokenPipeError,ConnectionResetError):sys.exit(1)
    except Exception:
        print('Could not export the complete backup ZIP.',file=sys.stderr);sys.exit(1)
