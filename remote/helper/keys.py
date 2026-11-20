# helper/keys.py: App encryption keys and configuration fingerprints (docs/keys-safe.md). A key value never leaves
# this module: answers hold rule ids, locations (env:<container> or file:<path>) and keyed fingerprints only.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno,hmac,base64,configparser
from .common import (
    NOFOLLOW, emit, inspect)
from .paths import (
    protected_mount)
# </build:header>
KEY_RULE_ID=re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
KEY_NAME=re.compile(r'[A-Za-z_][A-Za-z0-9_.]{0,127}')
KEY_RELATIVE=re.compile(r'[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*')
KEY_IMAGE_WORD=re.compile(r'[a-z0-9][a-z0-9._-]{0,63}')
KEY_FIELDS={'env':('name',),'ini':('file','section','name'),'php-array':('file','name'),'file':('path',)}
# Files larger than this are not read for keys (their whole-file fingerprint is still made).
KEY_FILE_LIMIT=1024*1024
# The search for key files inside a mount stops at this depth and after this many entries.
KEY_WALK_DEPTH=4
KEY_WALK_ENTRIES=5000
FILE_LABEL=b'docknest-file'

def key_rule_valid(rule):
    """The checks of shared/key-rules.js keyRuleProblems: a rule the helper does not understand is never applied."""
    if not isinstance(rule,dict) or rule.get('kind') not in KEY_FIELDS:return False
    fields=KEY_FIELDS[rule['kind']]
    if set(rule)-{'id','app','kind','image',*fields}:return False
    if not isinstance(rule.get('id'),str) or len(rule['id'])>64 or not KEY_RULE_ID.fullmatch(rule['id']):return False
    for field in fields:
        value=rule.get(field)
        if not isinstance(value,str):return False
        if field in ('name','section') and not KEY_NAME.fullmatch(value):return False
        if field in ('file','path') and (len(value)>256 or not KEY_RELATIVE.fullmatch(value) or '..' in value.split('/')):return False
    image=rule.get('image')
    return image is None or (isinstance(image,list) and 0<len(image)<=20 and all(isinstance(word,str) and KEY_IMAGE_WORD.fullmatch(word) for word in image))

def key_context(req):
    """The fingerprint key and rules of this one request, or None when the request carries none or they are invalid."""
    keys=req.get('keys')
    if not isinstance(keys,dict) or not isinstance(keys.get('fingerprintKey'),str):return None
    try:secret=base64.b64decode(keys['fingerprintKey'],validate=True)
    except ValueError:return None
    rules=keys.get('rules')
    if len(secret)!=32 or not isinstance(rules,list) or not 0<len(rules)<=200 or not all(key_rule_valid(rule) for rule in rules):return None
    return {'secret':secret,'rules':rules}

def rule_fingerprint(context,rule,value):
    """HMAC-SHA256(fpKey, rule id || 0x00 || value), truncated to 128 bits."""
    return hmac.new(context['secret'],rule['id'].encode()+b'\0'+value,hashlib.sha256).hexdigest()[:32]

def contained(path,root=None):
    """True when the path is its own real path (no symlinked folder on the way and no '..'; O_NOFOLLOW alone covers
    only the last part) and, with `root`, lies inside root."""
    try:real=os.path.realpath(path)
    except (OSError,ValueError):return False
    return real==path and (root is None or path==root or path.startswith(root.rstrip('/')+'/'))

def file_fingerprint(context,path):
    """Whole-file HMAC of a Compose, env or configuration file, or None when it cannot be read as a regular file."""
    digest=hmac.new(context['secret'],FILE_LABEL+b'\0',hashlib.sha256)
    if not contained(path):return None
    try:
        fd=os.open(path,os.O_RDONLY|NOFOLLOW)
        with os.fdopen(fd,'rb') as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):return None
            for chunk in iter(lambda:source.read(1024*1024),b''):digest.update(chunk)
    except OSError:return None
    return digest.hexdigest()[:32]

def read_small(path,root=None):
    """A regular file's bytes (no symlink anywhere on its path, inside `root` when given, at most KEY_FILE_LIMIT), or None."""
    if not contained(path,root):return None
    try:
        fd=os.open(path,os.O_RDONLY|NOFOLLOW)
        with os.fdopen(fd,'rb') as source:
            info=os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size>KEY_FILE_LIMIT:return None
            return source.read(KEY_FILE_LIMIT+1)[:KEY_FILE_LIMIT]
    except OSError:return None

def image_name(image):
    name=str(image or '').lower().split('@',1)[0]
    head,_,tail=name.rpartition('/')
    return (head+'/' if head else '')+tail.split(':',1)[0]

def hint_matches(rule,images):
    return 'image' not in rule or any(word in image_name(image) for image in images for word in rule['image'])

def unquote(value):
    if len(value)>=2 and value[0] in '"\'' and value.find(value[0],1)>0:return value[1:value.find(value[0],1)]
    return re.split(r'\s+#',value,maxsplit=1)[0].strip()

def assignment_value(text,name):
    """The first literal `name=value` (env file) or `name: value` / `- name=value` (Compose environment) in text.
    Interpolated values (${...}) and YAML block or anchor values are not literals and are skipped."""
    pattern=re.compile(r'(["\']?)'+re.escape(name)+r'\1\s*[:=]\s*(.*)')
    for line in text.splitlines():
        item=line.strip()
        if item.startswith('-'):
            item=item[1:].strip()
            if len(item)>=2 and item[0] in '"\'' and item.endswith(item[0]):item=item[1:-1]
        if item.startswith('export '):item=item[7:].lstrip()
        match=pattern.fullmatch(item)
        if not match:continue
        value=unquote(match[2].strip())
        if value and '${' not in value and value[0] not in '|>&*!{[':return value
    return None

def ini_value(text,section,name):
    parser=configparser.RawConfigParser(strict=False)
    try:
        parser.read_string('[docknest-top]\n'+text)
        value=parser.get(section,name)
    except Exception:return None  # parser messages can quote file lines; nothing of them is kept
    return value.strip() or None

def php_value(text,name):
    match=re.search(r'([\'"])'+re.escape(name)+r'\1\s*=>\s*([\'"])((?:\\.|(?!\2).)*)\2',text,re.S)
    return match[3] if match and match[3] else None

def rule_value(rule,data):
    """The key value of `rule` in a file's bytes, as bytes, or None."""
    text=data.decode('utf-8','surrogateescape');kind=rule['kind']
    value=assignment_value(text,rule['name']) if kind=='env' else ini_value(text,rule['section'],rule['name']) if kind=='ini' else php_value(text,rule['name']) if kind=='php-array' else text
    return value.encode('utf-8','surrogateescape') if value else None

def env_map(container):
    result={}
    for item in ((container.get('Config') or {}).get('Env') or []):
        name,sep,value=str(item).partition('=')
        if sep and name not in result:result[name]=value
    return result

def env_named(path):
    name=posixpath.basename(path)
    return name=='.env' or name.startswith('.env.') or name.endswith('.env')

def compose_env_files(path,data):
    """The env files Compose reads for this file: `.env` beside it and every `env_file:` entry, as absolute paths."""
    base=posixpath.dirname(path);found=[posixpath.join(base,'.env')];lines=(data or b'').decode('utf-8','replace').splitlines();i=0
    while i<len(lines):
        match=re.match(r'(\s*)env_file\s*:\s*(.*)$',lines[i]);i+=1
        if not match:continue
        indent=len(match[1]);value=match[2].strip()
        if value.startswith('['):found+=[unquote(item.strip()) for item in value.strip('[]').split(',') if item.strip()]
        elif value:found.append(unquote(value))
        else:
            while i<len(lines) and (not lines[i].strip() or len(lines[i])-len(lines[i].lstrip())>indent):
                entry=lines[i].strip();i+=1
                if entry.startswith('-'):
                    entry=entry[1:].strip()
                    if entry.startswith('path:'):entry=entry[5:].strip()
                    if entry:found.append(unquote(entry))
                elif entry.startswith('path:'):found.append(unquote(entry[5:].strip()))
    result=[]
    for item in found:
        full=posixpath.normpath(posixpath.join(base,item))
        if full.startswith('/') and '${' not in full and full not in result:result.append(full)
    return result

def key_sources(cfg):
    """(path, included, env format) for the app's Compose and configuration files (in the backup) and the env files
    Compose reads beside them (looked at too, so a key there that is not backed up is reported)."""
    compose=list(cfg.get('composeFiles',[]));config=list(cfg.get('configFiles',[]));included=set(compose+config)
    referenced=[ref for path in compose for ref in compose_env_files(path,read_small(path))]
    result=[];seen=set()
    for path,inc,env in [*((p,True,True) for p in compose),*((p,True,env_named(p) or p in referenced) for p in config),*((p,p in included,True) for p in referenced)]:
        if path not in seen:seen.add(path);result.append((path,inc,env))
    return result

def mount_key_files(rules,containers,skip):
    """Key files inside the app's mounts: (path, container index, mount index, env format). A mount's `.env` is read for
    env keys; other rules match a path that ends with their file within a bounded walk. Protected mounts are never read."""
    targets=[rule['path' if rule['kind']=='file' else 'file'] for rule in rules if rule['kind']!='env']
    found=[];seen=set(skip)
    def add(path,i,j,env):
        if path not in seen:seen.add(path);found.append((path,i,j,env))
    for i,c in enumerate(containers):
        for j,m in enumerate(c.get('Mounts') or []):
            source=m.get('Source') or ''
            if not source.startswith('/') or protected_mount(source):continue
            if os.path.isfile(source) and not os.path.islink(source):
                if env_named(source) or any(source.endswith('/'+target) for target in targets):add(source,i,j,env_named(source))
                continue
            if not os.path.isdir(source) or os.path.islink(source):continue
            if os.path.isfile(os.path.join(source,'.env')):add(os.path.join(source,'.env'),i,j,True)
            if not targets:continue
            entries=0
            for current,dirs,files in os.walk(source,followlinks=False):
                depth=len(os.path.relpath(current,source).split(os.sep)) if current!=source else 0
                dirs[:]=sorted(name for name in dirs if name not in ('.ssh','.gnupg') and depth<KEY_WALK_DEPTH)
                entries+=len(dirs)+len(files)
                for name in sorted(files):
                    path=os.path.join(current,name)
                    if any(path.endswith('/'+target) for target in targets) and not os.path.islink(path):add(path,i,j,False)
                if entries>=KEY_WALK_ENTRIES:break
    return found

def key_hits(context,cfg,containers):
    """Every key of the app with its live fingerprint, plus the whole-file fingerprints of its Compose, env and
    configuration files. A hit's `source` is env, config (in the backup), mount (in a mount archive) or outside."""
    images=[(c.get('Config') or {}).get('Image','') for c in containers];hits=[];files=[]
    def hit(rule,location,value,source,**extra):
        hits.append({'rule':rule,'location':location,'fingerprint':rule_fingerprint(context,rule,value),'source':source,**extra})
    for i,c in enumerate(containers):
        service=(c.get('Name') or '').lstrip('/');env=env_map(c)
        for rule in context['rules']:
            if rule['kind']=='env' and env.get(rule['name']) and hint_matches(rule,[images[i]]):hit(rule,'env:'+service,env[rule['name']].encode('utf-8','surrogateescape'),'env',service=service)
    def scan_file(path,env_format,source,root=None,**extra):
        data=read_small(path,root)
        if data is None:return
        for rule in context['rules']:
            if not hint_matches(rule,images):continue
            if rule['kind']=='env' and not env_format:continue
            if rule['kind']!='env' and not path.endswith('/'+rule['path' if rule['kind']=='file' else 'file']):continue
            value=rule_value(rule,data)
            if value:hit(rule,'file:'+path,value,source,path=path,**extra)
    sources=key_sources(cfg)
    for path,included,env_format in sources:
        fingerprint=file_fingerprint(context,path)
        if fingerprint is None:continue
        files.append({'path':path,'fingerprint':fingerprint})
        scan_file(path,env_format,'config' if included else 'outside')
    for path,i,j,env_format in mount_key_files(context['rules'],containers,[path for path,_,_ in sources]):
        scan_file(path,env_format,'mount',containers[i]['Mounts'][j]['Source'],container=i,mount=j)
    return hits,files

def public_key(hit):
    return {'rule':hit['rule']['id'],'location':hit['location'],'fingerprint':hit['fingerprint']}

def key_scan(context,cfg,containers):
    hits,files=key_hits(context,cfg,containers)
    return {'keys':[public_key(hit) for hit in hits],'files':files}

def key_proof(context,hits,packaged_containers,member,reason_for):
    """Each live key with inBackup: true only when the bytes written into the package give the same fingerprint.
    packaged_containers: the containers of the manifest as written; member(hit): the packaged file's bytes or None;
    reason_for(hit): why a key cannot be in the package (not-included, excluded) or None."""
    envs={(c.get('Name') or '').lstrip('/'):env_map(c) for c in packaged_containers}
    result=[]
    for hit in hits:
        reason=reason_for(hit)
        if reason is None:
            if hit['source']=='env':
                text=envs.get(hit['service'],{}).get(hit['rule']['name'])
                value=text.encode('utf-8','surrogateescape') if text else None
            else:
                data=member(hit)
                value=rule_value(hit['rule'],data) if data is not None else None
            packaged=rule_fingerprint(context,hit['rule'],value) if value else None
            reason=None if packaged==hit['fingerprint'] else 'not-in-package' if packaged is None else 'differs'
        result.append({**public_key(hit),'inBackup':reason is None,**({'reason':reason} if reason else {})})
    return result

def restored_keys(context,expected,env_of,file_of):
    """Fingerprints of the expected keys ({rule, location}) in a restored copy: env_of(service) gives a restored
    container's env, file_of(path) a restored file's bytes (None when absent)."""
    rules={rule['id']:rule for rule in context['rules']};result=[]
    for item in expected[:500]:
        rule=rules.get(item.get('rule')) if isinstance(item,dict) else None
        location=item.get('location') if rule else None
        if not isinstance(location,str):continue
        value=None
        if location.startswith('env:') and rule['kind']=='env':
            found=env_of(location[4:])
            value=found.get(rule['name']).encode('utf-8','surrogateescape') if found and found.get(rule['name']) else None
        elif location.startswith('file:/'):
            data=file_of(location[5:])
            value=rule_value(rule,data) if data is not None else None
        result.append({'rule':rule['id'],'location':location,'fingerprint':rule_fingerprint(context,rule,value) if value else None})
    return result

def key_scan_operation(req):
    context=key_context(req)
    if context is None:raise ValueError('The key scan request is not valid')
    cfg=req['config']
    if cfg.get('kind')=='static':emit(result={'keys':[],'files':[]});return
    ids=cfg.get('containers',[])
    if not ids or not all(isinstance(x,str) and x and not x.startswith('-') for x in ids):raise ValueError('Select valid containers')
    emit(result=key_scan(context,cfg,inspect(ids)))
