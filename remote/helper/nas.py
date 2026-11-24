# helper/nas.py: NAS app managers (Unraid templates, Synology projects, TrueNAS apps), read-only, and the Unraid template put-back.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    emit)
from .discovery import (
    read_config)
from .restore import (
    owned_job_root, safe_extract)
# </build:header>
# Everything read here comes from files on the NAS and is untrusted: sizes, counts and every field are capped and
# checked, XML with a DOCTYPE or entities is refused, and nothing is executed, fetched or changed. TrueNAS state is never
# touched (no midclt). Icon URLs are kept as text and never fetched.
UNRAID_TEMPLATES='/boot/config/plugins/dockerMan/templates-user'
UNRAID_TEMPLATE_NAME=re.compile(r'my-[A-Za-z0-9._-]{1,100}\.xml')
UNRAID_TEMPLATE_PATH=re.compile(re.escape(UNRAID_TEMPLATES)+r'/my-[A-Za-z0-9._-]{1,100}\.xml')
TEMPLATE_LIMIT=64*1024
TEMPLATE_COUNT=500
NAS_FILE_LIMIT=4096
TRUENAS_TOO_OLD='TrueNAS apps before 24.10 run on Kubernetes, which DockNest does not back up. Update TrueNAS to 24.10 or newer.'
TRUENAS_APPS_ROOT='/mnt/.ix-apps/app_configs'
SYNOLOGY_PROJECT=re.compile(r'/volume[0-9]{1,2}/docker/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:/.*)?')
UNRAID_COMPOSE=re.compile(r'/boot/config/plugins/compose\.manager/projects/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:/.*)?')
TRUENAS_APP=re.compile(re.escape(TRUENAS_APPS_ROOT)+r'/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:/.*)?')
def nas_text(value,limit):
    """A short single-line printable string, else None."""
    if not isinstance(value,str):return None
    value=value.strip()
    return value if 0<len(value)<=limit and all(ord(ch)>=32 and ord(ch)!=127 for ch in value) else None
def parse_template(data):
    """One Unraid template as plain facts, or None. DOCTYPE and entity declarations are refused before any parser sees
    the text, so entity expansion and external entities cannot happen."""
    if not isinstance(data,(bytes,bytearray)) or len(data)>TEMPLATE_LIMIT:return None
    # Plain UTF-8 only: a NUL byte or a UTF-16/32 byte order mark could hide a DOCTYPE from the check below.
    if b'\x00' in data or bytes(data[:2]) in (b'\xff\xfe',b'\xfe\xff') or bytes(data[:3])==b'\xef\xbb\xbf' and False:return None
    try:bytes(data).decode('utf-8')
    except UnicodeDecodeError:return None
    lowered=bytes(data).lower()
    if b'<!doctype' in lowered or b'<!entity' in lowered or b'<?xml-stylesheet' in lowered:return None
    try:
        import xml.etree.ElementTree as ET
        root=ET.fromstring(bytes(data))
    except Exception:return None
    if root.tag!='Container':return None
    name=nas_text(root.findtext('Name'),128)
    if not name:return None
    icon=nas_text(root.findtext('Icon'),512)
    if icon and not re.fullmatch(r'https?://[^\s<>"\']+',icon):icon=None
    # webUi is untrusted text from the NAS: a screen must show it as text, or use it only after checking for an http(s) scheme.
    web=nas_text(root.findtext('WebUI'),512)
    return {'name':name,'webUi':web,'icon':icon,'repository':nas_text(root.findtext('Repository'),256)}
def unraid_templates(folder=UNRAID_TEMPLATES):
    found={}
    try:
        if os.path.islink(folder) or not os.path.isdir(folder):return found
        names=sorted(entry for entry in os.listdir(folder) if UNRAID_TEMPLATE_NAME.fullmatch(entry))[:TEMPLATE_COUNT]
    except OSError:return found
    for entry in names:
        path=os.path.join(folder,entry)
        text=read_config(path,follow_links=False,limit=TEMPLATE_LIMIT)
        facts=parse_template(text.encode('utf-8')) if text is not None else None
        if facts and facts['name'] not in found:found[facts['name']]={**facts,'templateFile':folder+'/'+entry}
    return found
def nas_version_facts(root='/'):
    """{'kind','version'} from read-only files, or None for any other server."""
    def read(path):
        return read_config(os.path.join(root,path.lstrip('/')),follow_links=False,limit=NAS_FILE_LIMIT)
    text=read('/etc/unraid-version')
    if text is not None:
        match=re.search(r'version="([0-9][0-9A-Za-z.\-]{0,31})"',text)
        return {'kind':'unraid','version':match[1] if match else None}
    if read('/etc/synoinfo.conf') is not None:
        match=re.search(r'productversion="([0-9][0-9A-Za-z.\-]{0,31})"',read('/etc.defaults/VERSION') or '')
        return {'kind':'synology','version':match[1] if match else None}
    text=read('/etc/version')
    # 'TrueNAS-SCALE-24.10.2', 'TrueNAS-SCALE 25.04', 'TrueNAS-25.10.0' or a bare '25.04.1': midclt must exist too. A version
    # that cannot be read stays None, which refuses the server (fail closed).
    if text is not None and os.path.exists(os.path.join(root,'usr/bin/midclt')) and re.match(r'(?:TrueNAS|[0-9]{2}\.[0-9]{2})',text.lstrip()):
        match=re.search(r'(?<![0-9.])([0-9]{2}\.[0-9]{2}(?:\.[0-9]{1,3}){0,2})(?![0-9])',text[:256])
        return {'kind':'truenas','version':match[1] if match else None}
    return None
def truenas_supported(version):
    match=re.fullmatch(r'([0-9]{2})\.([0-9]{2})(?:\.[0-9]{1,3}){0,2}',version or '')
    return bool(match) and (int(match[1]),int(match[2]))>=(24,10)
def nas_app(container,kind,templates):
    """What the NAS's own app manager calls this container, or None."""
    labels=container.get('Config',{}).get('Labels') or {}
    name=str(container.get('Name','')).lstrip('/')
    if kind=='unraid':
        template=templates.get(name)
        if template:return {'manager':'unraid-template','displayName':template['name'],'webUi':template['webUi'],'icon':template['icon'],'templateFile':template['templateFile']}
        # Compose Manager plugin projects are plain Compose projects kept in a persistent folder: named only, read-only.
        working=str((container.get('Config',{}).get('Labels') or {}).get('com.docker.compose.project.working_dir',''))
        match=len(working)<=1024 and '..' not in working.split('/') and UNRAID_COMPOSE.fullmatch(working)
        return {'manager':'unraid-compose-manager','displayName':match[1],'project':match[1]} if match else None
    folders=[labels.get('com.docker.compose.project.working_dir','')]+[part.strip() for part in str(labels.get('com.docker.compose.project.config_files','')).split(',')][:8]
    pattern,manager=(SYNOLOGY_PROJECT,'synology-project') if kind=='synology' else (TRUENAS_APP,'truenas-app') if kind=='truenas' else (None,None)
    for value in folders:
        match=pattern and isinstance(value,str) and len(value)<=1024 and '..' not in value.split('/') and pattern.fullmatch(value)
        if match:
            display=match[1][3:] if manager=='truenas-app' and match[1].startswith('ix-') and len(match[1])>3 else match[1]
            return {'manager':manager,'displayName':display,'project':match[1]}
    return None
def attach_nas(result,containers,root='/',templates_folder=UNRAID_TEMPLATES):
    """Adds `nas` and per-container `nasApp` to a discovery result. Servers that are not a NAS get nothing added."""
    facts=nas_version_facts(root)
    if not facts:return result
    if facts['kind']=='truenas' and not truenas_supported(facts['version']):raise ValueError(TRUENAS_TOO_OLD)
    templates=unraid_templates(templates_folder) if facts['kind']=='unraid' else {}
    result['nas']=facts
    for item,container in zip(result.get('containers',[]),containers):
        app=nas_app(container,facts['kind'],templates)
        if not app:continue
        item['nasApp']=app
        template=app.get('templateFile')
        if template:
            # The template is captured as a configuration file so a restore keeps the Unraid Docker page in charge.
            configuration=item.setdefault('backupConfiguration',{})
            files=configuration.setdefault('configFiles',[])
            if template not in files:files.append(template)
    return result
def put_back_template(archive,original,scratch,folder=UNRAID_TEMPLATES):
    """Put one captured Unraid template back. Never overwrites a different file that is already there."""
    original=str(original)
    if posixpath.dirname(original)!=folder or not UNRAID_TEMPLATE_NAME.fullmatch(posixpath.basename(original)):raise ValueError('Not an Unraid template path')
    if os.path.islink(folder) or not os.path.isdir(folder):raise ValueError('The Unraid template folder is not available on this server')
    scratch=pathlib.Path(scratch)
    shutil.rmtree(scratch,ignore_errors=True)
    try:
        scratch.mkdir(parents=True,mode=0o700)
        safe_extract(archive,scratch)
        files=[item for item in scratch.rglob('*') if not item.is_dir()]
        name=posixpath.basename(original)
        if len(files)!=1 or files[0].name!=name or files[0].is_symlink():raise ValueError('The captured template archive is not a single template file')
        data=files[0].read_bytes()
        if parse_template(data) is None:raise ValueError('The captured template is not a valid Unraid template')
        if os.path.lexists(original):
            if read_config(original,follow_links=False,limit=TEMPLATE_LIMIT)==data.decode('utf-8','replace'):return {'status':'unchanged','path':original}
            return {'status':'kept-existing','path':original}
        temporary=folder+'/.docknest-'+uuid.uuid4().hex
        try:
            fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
            with os.fdopen(fd,'wb') as output:output.write(data);output.flush();os.fsync(output.fileno())
            # A hard link never replaces a file that appeared meanwhile; the temporary name is always removed.
            try:os.link(temporary,original)
            except FileExistsError:return {'status':'kept-existing','path':original}
            return {'status':'restored','path':original}
        finally:
            try:os.unlink(temporary)
            except OSError:pass
    finally:shutil.rmtree(scratch,ignore_errors=True)
def nas_template_restore(req):
    """After an app restore: put back every captured Unraid template named in the backup's manifest. The request holds only the
    job; the manifest and archives are the ones the restore already verified inside this job's folder."""
    root=owned_job_root(req).resolve()
    facts=nas_version_facts()
    if not facts or facts['kind']!='unraid':raise ValueError('Unraid templates are only put back on an Unraid server')
    unpacked=root/'unpacked'
    manifest_file=unpacked/'manifest.json'
    if not manifest_file.is_file() or manifest_file.is_symlink():emit(result={'templates':[]});return
    manifest=json.loads(manifest_file.read_text())
    results=[]
    for index,original in enumerate(manifest.get('configurationFiles') or []):
        if not isinstance(original,str) or not UNRAID_TEMPLATE_PATH.fullmatch(original):continue
        archive=(unpacked/('config-%d.tar'%index)).resolve()
        if root not in archive.parents or not archive.is_file() or archive.is_symlink():results.append({'status':'missing','path':original});continue
        try:results.append(put_back_template(archive,original,root/('nas-template-'+uuid.uuid4().hex),UNRAID_TEMPLATES))
        except ValueError as error:results.append({'status':'refused','path':original,'reason':str(error)[:200]})
    emit(result={'templates':results})
