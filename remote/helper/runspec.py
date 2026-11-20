# helper/runspec.py: Run spec of a plain (docker run) container: one normalised record read from docker inspect, the
# docker create flags and a readable Compose file made from it (describe-containers, backup run-definition/, Move).
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    SAFE_NAME, container_label, emit, extra_capabilities, hardening, inspect, mount_option)
from .discovery import (
    temporary_mounts, tmpfs_argument)
# </build:header>
# ---- Run spec (docs/coverage-and-restore-check.md A2) ----
# One source of truth for recreating a container. A spec never holds environment values, only their names; the values
# are written by env_file_text, into the encrypted backup package only. A setting neither docker create nor this
# Compose file can recreate is named in spec['unsupported'] in plain words, never dropped silently. Reading a spec never
# fails: what DockNest refuses to copy stays refused where it was refused before (backup preflight, restore network
# plan, hardening_args).
RESTART_POLICIES={'no','always','unless-stopped','on-failure'}
LOG_DRIVERS={'json-file','local','none'}  # need nothing on the server; journald and others keep Docker's default
DOCKER_SHM_BYTES=64*1024*1024
EXTRA_HOST=re.compile(r'[A-Za-z0-9.-]+:[0-9a-fA-F.:]+|[A-Za-z0-9.-]+:host-gateway')
PLAIN_WORD=re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}')
SYSCTL_KEY=re.compile(r'[a-z0-9_-]+(?:\.[a-z0-9_-]+)+')
BUILTIN_NETWORKS=('bridge','default','host','none')
UNREADABLE_MOUNTS='mounts without a source or target'
ENV_NAME=re.compile(r'[A-Za-z_][A-Za-z0-9_.]{0,255}')
ENV_LITERAL=re.compile(r"[^'\r\n\0]*")
# HostConfig settings that are recreated by neither path, named when set.
UNRECREATED=(('Privileged','privileged mode'),('Devices','devices'),('DeviceRequests','GPUs and other device requests'),('DeviceCgroupRules','device rules'),
    ('CgroupParent','a custom cgroup parent'),('VolumesFrom','volumes from other containers'),('Links','legacy container links'),('CpuQuota','a CPU quota'),
    ('CpuPeriod','a CPU period'),('CpuRealtimeRuntime','real-time CPU time'),('CpusetMems','memory nodes (cpuset-mems)'),('BlkioWeight','disk I/O weight'),
    ('BlkioWeightDevice','disk I/O weight per device'),('BlkioDeviceReadBps','disk read limits'),('BlkioDeviceWriteBps','disk write limits'),
    ('BlkioDeviceReadIOps','disk read limits'),('BlkioDeviceWriteIOps','disk write limits'),('OomKillDisable','a turned-off OOM killer'),
    ('OomScoreAdj','an OOM score'),('StorageOpt','storage options'))
NAMESPACES=(('NetworkMode','network'),('PidMode','process namespace'),('IpcMode','IPC namespace'),('UTSMode','host name namespace'),('UsernsMode','user namespace'))
# (spec key, docker create flag, Compose key) for settings that are one value, a list or an on/off switch.
VALUE_SETTINGS=(('hostname','--hostname','hostname'),('domainname','--domainname','domainname'),('memory','--memory','mem_limit'),
    ('memoryReservation','--memory-reservation','mem_reservation'),('memorySwap','--memory-swap','memswap_limit'),('cpus','--cpus','cpus'),
    ('cpuShares','--cpu-shares','cpu_shares'),('cpusetCpus','--cpuset-cpus','cpuset'),('pidsLimit','--pids-limit','pids_limit'),('shmSize','--shm-size','shm_size'))
LIST_SETTINGS=(('extraHosts','--add-host','extra_hosts'),('dns','--dns','dns'),('dnsSearch','--dns-search','dns_search'),('dnsOptions','--dns-option','dns_opt'),
    ('groupAdd','--group-add','group_add'))
SWITCH_SETTINGS=(('init','--init','init'),('tty','--tty','tty'),('stdinOpen','--interactive','stdin_open'))

def yaml_str(value):
    """A Compose scalar: a JSON string is a valid YAML double-quoted scalar (no YAML library), and $ is written as $$
    so Compose never reads part of a value as a variable."""
    return json.dumps(('true' if value else 'false') if isinstance(value,bool) else str(value).replace('$','$$'))
def yaml_key(key):return json.dumps(str(key))
def port_bindings(c):
    result=[]
    for internal,bindings in (c.get('HostConfig',{}).get('PortBindings') or {}).items():
        port,_,protocol=internal.partition('/')
        for binding in bindings or []:
            host=str(binding.get('HostPort') or '')
            if host.isdigit() and port.isdigit():result.append({'container':c['Name'].lstrip('/'),'hostIp':binding.get('HostIp') or '0.0.0.0','hostPort':int(host),'containerPort':int(port),'protocol':protocol or 'tcp'})
    return result
def port_argument(ip,host_port,container_port,protocol):
    """One `-p` / Compose ports value: [ip:]host:container/protocol, an IPv6 address in brackets."""
    host='' if ip in ['','0.0.0.0'] else '['+ip+']:' if ':' in ip else ip+':'
    return host+str(host_port)+':'+str(container_port)+'/'+protocol
def integer(value):return value if isinstance(value,int) and not isinstance(value,bool) else None
def positive(value):return value if integer(value) is not None and value>0 else None
def cpu_limit(nano):
    value=positive(nano)
    return None if value is None else ('%.9f'%(value/1e9)).rstrip('0').rstrip('.')
def words(values):return [str(v) for v in values or [] if isinstance(v,(str,int)) and not isinstance(v,bool) and str(v) and '\n' not in str(v) and '\0' not in str(v)]
def unsupported_settings(c,hc):
    found=[label for key,label in UNRECREATED if hc.get(key)]
    if hc.get('Runtime') not in [None,'','runc']:found.append('the %s runtime'%hc['Runtime'] if PLAIN_WORD.fullmatch(str(hc['Runtime'])) else 'a custom runtime')
    for key,label in NAMESPACES:
        mode=str(hc.get(key) or '')
        if mode=='host' and key!='NetworkMode':found.append("the host's "+label)
        elif mode.startswith('container:'):found.append("another container's "+label)
    joined=(c.get('NetworkSettings') or {}).get('Networks') or {}
    if any((n or {}).get('IPAMConfig') for n in joined.values()):found.append('a fixed IP address')
    if any(not SAFE_NAME.fullmatch(name) for name in joined):found.append('a network with an unusual name')
    driver=(hc.get('LogConfig') or {}).get('Type')
    if driver and driver not in LOG_DRIVERS:found.append('the %s log driver'%driver if PLAIN_WORD.fullmatch(str(driver)) else 'a custom log driver')
    if any(m.get('Type') not in ['bind','volume','tmpfs'] for m in c.get('Mounts') or []):found.append('mounts other than folders, volumes and RAM folders')
    if any(not (isinstance(h,str) and EXTRA_HOST.fullmatch(h)) for h in hc.get('ExtraHosts') or []):found.append('host entries DockNest cannot read')
    return found
def restart_policy(hc):
    policy=hc.get('RestartPolicy') or {};name=policy.get('Name') or 'no'
    if name not in RESTART_POLICIES:return 'no'
    retries=positive(policy.get('MaximumRetryCount'))
    return name+':%d'%retries if name=='on-failure' and retries else name
def container_networks(c):
    """Network name -> aliases a copy keeps (Docker adds the short ID itself), and the network it starts on."""
    hc=c.get('HostConfig') or {};joined=(c.get('NetworkSettings') or {}).get('Networks') or {}
    networks={name:[] if name in BUILTIN_NETWORKS else list(dict.fromkeys(a for a in (n or {}).get('Aliases') or [] if a and a!=str(c.get('Id',''))[:12] and SAFE_NAME.fullmatch(a))) for name,n in joined.items() if name!='none' and SAFE_NAME.fullmatch(name)}
    primary=hc.get('NetworkMode') if hc.get('NetworkMode') in networks else next(iter(networks),'none')
    return networks,'bridge' if primary=='default' else primary
def spec_hardening(c):
    """read-only root, capabilities and security options for Compose; None when DockNest cannot read them."""
    try:h=hardening(c)
    except ValueError:return None
    return {'readOnly':h['readonly'],'capDrop':h['drop'],'capAdd':h['add'],'noNewPrivileges':h['noNewPrivileges'],'seccomp':h['seccomp'] if h['seccomp'] in ['default','unconfined'] else 'custom','apparmor':h['apparmor'],'labels':h['labels']}
def spec_tmpfs(c):
    """RAM folders and None, or [] and the reason DockNest cannot recreate one."""
    try:return [[destination,options] for destination,options in temporary_mounts(c)],None
    except ValueError as error:return [],str(error)
def spec_mounts(c):
    return [{'type':m['Type'],'source':m.get('Name' if m['Type']=='volume' else 'Source'),'target':m.get('Destination'),'readOnly':not m.get('RW',True)} for m in c.get('Mounts') or [] if m.get('Type') in ['bind','volume']]
def readable(m):return bool(m['source'] and m['target'])
def run_spec(c):
    """The normalised run spec of one inspect record, with the settings it cannot recreate in 'unsupported'."""
    config=c.get('Config') or {};hc=c.get('HostConfig') or {};unsupported=unsupported_settings(c,hc)
    networks,primary=container_networks(c);log=hc.get('LogConfig') or {};secure=spec_hardening(c);tmpfs,tmpfs_problem=spec_tmpfs(c)
    if secure is None:unsupported.append('security options DockNest cannot copy')
    elif extra_capabilities(secure['capAdd']):unsupported.append('extra capabilities')
    if tmpfs_problem:unsupported.append('RAM folders DockNest cannot recreate')
    mounts=spec_mounts(c)
    if not all(map(readable,mounts)):unsupported.append(UNREADABLE_MOUNTS)
    # With the host's network or host name namespace the container has the server's own name: nothing to set.
    hostname=str(config.get('Hostname') or '') if 'host' not in [hc.get('NetworkMode'),hc.get('UTSMode')] else ''
    swap=hc.get('MemorySwap') if positive(hc.get('Memory')) and hc.get('MemorySwap') not in [None,0] else None
    shm=positive(hc.get('ShmSize'))
    return {'name':container_label(c),'image':str(config.get('Image') or ''),'environment':[item.partition('=')[0] for item in config.get('Env') or [] if isinstance(item,str)],
        'hostname':hostname if hostname and hostname!=str(c.get('Id',''))[:12] else None,'domainname':(config.get('Domainname') or None) if hostname else None,
        'restart':restart_policy(hc),'network':primary,'networks':networks,'ports':port_bindings(c),'publishAll':bool(hc.get('PublishAllPorts')),
        'exposed':sorted(str(p) for p in config.get('ExposedPorts') or {}),'tmpfs':tmpfs,'tmpfsProblem':tmpfs_problem,'mounts':mounts,
        'extraHosts':[h for h in hc.get('ExtraHosts') or [] if isinstance(h,str) and EXTRA_HOST.fullmatch(h)],'init':bool(hc.get('Init')),
        'tty':bool(config.get('Tty')),'stdinOpen':bool(config.get('OpenStdin')),'memory':positive(hc.get('Memory')),'memoryReservation':positive(hc.get('MemoryReservation')),
        'memorySwap':swap,'cpus':cpu_limit(hc.get('NanoCpus')),'cpuShares':positive(hc.get('CpuShares')),'cpusetCpus':hc.get('CpusetCpus') or None,
        'pidsLimit':positive(hc.get('PidsLimit')),'shmSize':shm if shm and shm!=DOCKER_SHM_BYTES else None,
        'ulimits':[{'name':u['Name'],'soft':u['Soft'],'hard':u['Hard']} for u in hc.get('Ulimits') or [] if isinstance(u,dict) and PLAIN_WORD.fullmatch(str(u.get('Name'))) and integer(u.get('Soft')) is not None and integer(u.get('Hard')) is not None],
        'logging':{'driver':log['Type'],'options':{str(k):str(v) for k,v in (log.get('Config') or {}).items()}} if log.get('Type') in LOG_DRIVERS else None,
        'dns':words(hc.get('Dns')),'dnsSearch':words(hc.get('DnsSearch')),'dnsOptions':words(hc.get('DnsOptions')),
        'sysctls':{str(k):str(v) for k,v in (hc.get('Sysctls') or {}).items()},'groupAdd':words(hc.get('GroupAdd')),
        'stopTimeout':integer(config.get('StopTimeout')),
        'hardening':secure,'unsupported':unsupported}
def cpu_fit(cpus,cpuset,count):
    """The CPU limit and CPU set a server with `count` CPUs accepts: a larger limit is capped to the count and a set
    naming CPUs it lacks is left out (docker create refuses both). Mirrored in src/moves/preflight.js."""
    numbers=[int(n) for n in re.findall(r'\d+',cpuset or '')]
    return (str(count) if cpus and float(cpus)>count else cpus),(None if numbers and max(numbers)>=count else cpuset)
def sysctl_present(key):
    return bool(SYSCTL_KEY.fullmatch(key)) and os.path.exists('/proc/sys/'+key.replace('.','/'))
def fit_host(spec,count):
    """The spec this server can start, and what was changed in plain words: a move never fails on a setting it used to
    drop. CPU limits are fitted (cpu_fit) and a sysctl this kernel does not have is left out."""
    fitted={**spec,'sysctls':{k:v for k,v in spec['sysctls'].items() if sysctl_present(k)}}
    fitted['cpus'],fitted['cpusetCpus']=cpu_fit(spec['cpus'],spec['cpusetCpus'],count)
    notes=(['its CPU limit, capped to %s'%fitted['cpus']] if fitted['cpus']!=spec['cpus'] else [])+(['its CPU set'] if fitted['cpusetCpus']!=spec['cpusetCpus'] else [])
    notes+=['the sysctl '+k for k in spec['sysctls'] if k not in fitted['sysctls']]
    return fitted,notes
def unbound_exposed(spec):
    """Exposed ports `-P` publishes: those without a host port of their own."""
    bound={'%d/%s'%(b['containerPort'],b['protocol']) for b in spec['ports']}
    return [port for port in spec['exposed'] if spec['publishAll'] and port not in bound]
def create_args(spec,restart,network,ports,publish_all):
    """`docker create` flags that recreate a spec. The caller picks the restart policy, the network the copy starts on,
    its `-p` values and whether `-P` applies (a move test copy differs), and adds its own name, labels and hardening_args.
    A copy without one of the original's RAM folders or mounts would lose its data: refused, never skipped."""
    if spec['tmpfsProblem']:raise ValueError(spec['tmpfsProblem'])
    args=['--restart',restart,'--network',network]
    if network not in BUILTIN_NETWORKS:args+=[part for alias in spec['networks'].get(network,[]) for part in ['--network-alias',alias]]
    for port in ports:args+=['-p',port]
    if publish_all:args.append('--publish-all')
    for destination,options in spec['tmpfs']:args+=['--tmpfs',tmpfs_argument(destination,options)]
    for m in spec['mounts']:
        if not readable(m):raise ValueError('Container %s has a mount without a source or target, which DockNest cannot recreate.'%spec['name'])
        args+=['--mount',mount_option(m['type'],m['source'],m['target'],m['readOnly'])]
    for key,flag,_ in VALUE_SETTINGS:
        if spec[key] is not None:args+=[flag,str(spec[key])]
    for key,flag,_ in LIST_SETTINGS:args+=[part for value in spec[key] for part in [flag,value]]
    args+=[flag for key,flag,_ in SWITCH_SETTINGS if spec[key]]
    for u in spec['ulimits']:args+=['--ulimit','%s=%d:%d'%(u['name'],u['soft'],u['hard'])]
    if spec['logging']:args+=['--log-driver',spec['logging']['driver']]+[part for k,v in spec['logging']['options'].items() for part in ['--log-opt',k+'='+v]]
    for key,value in spec['sysctls'].items():args+=['--sysctl',key+'='+value]
    if spec['stopTimeout'] is not None:args+=['--stop-timeout',str(spec['stopTimeout'])]
    return args

# ---- Compose file of plain containers ----
def env_file_name(spec):return spec['name']+'.env'
def env_file_text(c):
    """The container's environment as a Compose env file, every value single-quoted (literal). A value such a file
    cannot hold (a quote or a line break) is noted by name only; the snapshot image keeps every value anyway."""
    lines=[]
    for item in (c.get('Config') or {}).get('Env') or []:
        key,_,value=str(item).partition('=')
        if not ENV_NAME.fullmatch(key):lines.append('# A variable with an unusual name is kept in the snapshot image only.')
        elif ENV_LITERAL.fullmatch(value):lines.append("%s='%s'"%(key,value))
        else:lines.append('# %s is kept in the snapshot image only (its value has a quote or a line break).'%key)
    return ''.join(line+'\n' for line in lines)
def compose_security(h):
    options=(['no-new-privileges:true'] if h['noNewPrivileges'] else [])+(['seccomp:unconfined'] if h['seccomp']=='unconfined' else [])
    return options+(['apparmor:'+h['apparmor']] if h['apparmor'] else [])+['label:'+label for label in h['labels']]
def compose_service(spec,image):
    service={'image':image,'pull_policy':'never','container_name':spec['name']}
    if image!=spec['image']:service['labels']={'docknest.original-image':spec['image']}
    if spec['environment']:service['env_file']=[env_file_name(spec)]
    service['restart']=spec['restart']
    if spec['network'] in BUILTIN_NETWORKS:service['network_mode']=spec['network']
    else:service['networks']={name:({'aliases':aliases} if aliases else {}) for name,aliases in spec['networks'].items() if name not in BUILTIN_NETWORKS}
    # -P: each exposed port on a free host port. The host network publishes nothing (the ports are the server's own).
    ports=[port_argument(b['hostIp'],b['hostPort'],b['containerPort'],b['protocol']) for b in spec['ports']]+unbound_exposed(spec)
    if ports and spec['network']!='host':service['ports']=ports
    if spec['tmpfs']:service['tmpfs']=[tmpfs_argument(destination,options) for destination,options in spec['tmpfs']]
    mounts=[m for m in spec['mounts'] if readable(m)]  # the others are named at the top of the file
    if mounts:service['volumes']=[{'type':m['type'],'source':m['source'],'target':m['target'],**({'read_only':True} if m['readOnly'] else {})} for m in mounts]
    for key,_,name in VALUE_SETTINGS:
        if spec[key] is not None:service[name]=spec[key]
    for key,_,name in LIST_SETTINGS:
        if spec[key]:service[name]=spec[key]
    for key,_,name in SWITCH_SETTINGS:
        if spec[key]:service[name]=True
    if spec['ulimits']:service['ulimits']={u['name']:{'soft':u['soft'],'hard':u['hard']} for u in spec['ulimits']}
    if spec['logging']:service['logging']={'driver':spec['logging']['driver'],**({'options':spec['logging']['options']} if spec['logging']['options'] else {})}
    if spec['sysctls']:service['sysctls']=spec['sysctls']
    if spec['stopTimeout'] is not None:service['stop_grace_period']='%ds'%spec['stopTimeout']
    h=spec['hardening']
    if h:
        if h['readOnly']:service['read_only']=True
        if h['capDrop']:service['cap_drop']=h['capDrop']
        if h['capAdd']:service['cap_add']=h['capAdd']
        if compose_security(h):service['security_opt']=compose_security(h)
    return service
def compose_notes(spec):
    """What this Compose file leaves out for one container, in plain words (spec['unsupported'] plus Compose-only gaps)."""
    notes=list(spec['unsupported'])
    if spec['hardening'] and spec['hardening']['seccomp']=='custom':notes.append('its custom seccomp profile (kept in manifest.json)')
    others=[name for name in spec['networks'] if name not in BUILTIN_NETWORKS]
    if spec['network']=='bridge' and others:notes.append("its networks next to Docker's default bridge (%s)"%', '.join(others))
    elif spec['network'] not in BUILTIN_NETWORKS and len(others)<len(spec['networks']):notes.append("Docker's default bridge network next to its own")
    return notes
def yaml_inline(item):
    """A scalar, {} or [] on one line; None for a dict or list that needs a block."""
    if isinstance(item,dict):return None if item else '{}'
    if isinstance(item,list):return None if item else '[]'
    return yaml_str(item)
def yaml_lines(value,indent=0):
    """Block YAML of dicts and lists whose every key and scalar is JSON-quoted."""
    pad=' '*indent;lines=[]
    for key,item in (value.items() if isinstance(value,dict) else ((None,item) for item in value)):
        head=pad+('-' if key is None else yaml_key(key)+':');inline=yaml_inline(item)
        if inline is not None:lines.append(head+' '+inline)
        elif key is None and isinstance(item,dict):
            nested=yaml_lines(item,indent+2);lines+=[head+' '+nested[0].lstrip()]+nested[1:]
        else:lines+=[head]+yaml_lines(item,indent+2)
    return lines
def compose_document(specs,images):
    """A Compose file that recreates the containers: images[i] is the image for specs[i] (a backup's snapshot image, or
    the original reference in a preview). Environment values live in the env files it names, never in this file."""
    header=['# Written by DockNest: recreates %s as docker inspect showed %s.'%(', '.join(spec['name'] for spec in specs),'it' if len(specs)==1 else 'them'),
        '# Environment values are read from the env_file of each service.']
    header+=['# Not recreated for %s: %s.'%(spec['name'],', '.join(compose_notes(spec))) for spec in specs if compose_notes(spec)]
    document={'services':{spec['name']:compose_service(spec,image) for spec,image in zip(specs,images)}}
    networks=sorted({name for spec in specs if spec['network'] not in BUILTIN_NETWORKS for name in spec['networks'] if name not in BUILTIN_NETWORKS})
    volumes=sorted({m['source'] for spec in specs for m in spec['mounts'] if m['type']=='volume' and readable(m)})
    if networks:document['networks']={name:{'name':name} for name in networks}
    if volumes:document['volumes']={name:{'name':name} for name in volumes}
    return '\n'.join(header+yaml_lines(document))+'\n'
ORCHESTRATOR_LABELS=('com.docker.compose.project','com.docker.stack.namespace','com.docker.swarm.service.name')
def standalone(containers):
    """Plain containers only: none was started by Docker Compose or is a Swarm task (Swarm recreates its own tasks)."""
    return not any(((c.get('Config') or {}).get('Labels') or {}).get(label) for c in containers for label in ORCHESTRATOR_LABELS)
def run_definition(containers,images):
    """run-definition/ files of a backup package: compose.yaml (snapshot images) and one env file per container."""
    specs=[run_spec(c) for c in containers]
    files={'run-definition/compose.yaml':compose_document(specs,images)}
    files.update({'run-definition/'+env_file_name(spec):env_file_text(c) for spec,c in zip(specs,containers) if spec['environment']})
    return files
def describe_containers(req):
    """Read-only preview of how DockNest would recreate the named containers. Never returns environment values and
    never stops, creates or changes anything."""
    names=req.get('containers')
    if not isinstance(names,list) or not 1<=len(names)<=30 or not all(isinstance(name,str) and SAFE_NAME.fullmatch(name) for name in names):raise ValueError('Name 1 to 30 containers.')
    try:cs=inspect(list(dict.fromkeys(names)))
    except subprocess.CalledProcessError:raise ValueError('A container was not found on this server. Scan again.')
    specs=[run_spec(c) for c in cs]
    emit(result={'containers':specs,'compose':compose_document(specs,[spec['image'] for spec in specs])})
