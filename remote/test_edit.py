"""Safe Edit helper operations (docs/safe-edit.md): the .env editor, the gate and its refusals, fixed reasons, the
journal before the first write, atomic writes that keep owner and mode, the inode/hash check, rollback idempotence and
no environment value in any argv. Docker and Compose are faked; real Docker runs in the Linux integration test.
Run: py -3 -m unittest remote.test_edit   (or python3 remote/test_edit.py)"""
import unittest, tempfile, pathlib, json, io, os, sys, re, shutil, subprocess, uuid
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

EDIT='3f2b8c1e-7d4a-4b6e-9f10-2a3b4c5d6e7f'
SITE='site-1'
SECRET='S3cr3t-Value-xyz!'
BUILD=pathlib.Path(__file__).resolve().parent.parent/'build'

def posix(path):
    """A real temp folder as an absolute POSIX path (on Windows: same drive, drive letter dropped)."""
    text=(os.path.realpath(path) if os.name=='posix' else str(path)).replace('\\','/')
    return text[2:] if re.match(r'^[A-Za-z]:',text) else text

def interpolate(value,env):
    if isinstance(value,str):return re.sub(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}',lambda m:env.get(m[1],''),value)
    if isinstance(value,list):return [interpolate(v,env) for v in value]
    if isinstance(value,dict):return {k:interpolate(v,env) for k,v in value.items()}
    return value

def parse_env(text):
    values={}
    for line in text.splitlines():
        m=re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$',line)
        if not m:continue
        v=m[2]
        if v[:1] in '"\'' and v.endswith(v[:1]) and len(v)>1:v=v[1:-1]
        values[m[1]]=v
    return values

class FakeDocker:
    """Records every process Safe Edit starts (argv and environment) and answers like Docker and Compose would.
    `docker compose config` reads the -f files as JSON (valid YAML), merges services, interpolates ${VAR} from the
    --env-file files (or the project's .env) and resolves relative paths unless --no-*-resolution is given."""
    def __init__(self,base):
        self.base=base;self.calls=[];self.version=b'2.29.1\n';self.pull_fail=False;self.up_fail=False
        self.containers=[];self.volumes=['shop_data'];self.networks=['shop_default'];self.tags={};self.created=[]
        self.on_up=None;self.single=None;self.config_hook=None;self.env_file_seen=None;self.stops=[];self.holders={}
    def __call__(self,args,timeout=120,env=None):
        self.calls.append({'args':list(args),'env':dict(env or {})})
        if args[:2]!=['docker','compose'] or args[2:4]==['version','--short']:return self.docker(args[1:])
        tail=args[args.index('--project-directory')+2:]
        while tail and tail[0]=='--env-file':tail=tail[2:]
        if tail[0]=='config':return self.config(args)
        if tail[0]=='pull':
            if self.pull_fail:raise subprocess.CalledProcessError(1,args[:2])
            return b''
        if tail[0]=='stop':self.stops.append(list(args));return b''
        if tail[0]=='up':
            if self.up_fail:raise subprocess.CalledProcessError(1,args[:2])
            if self.on_up:self.on_up(args)
            return b''
        raise AssertionError('unexpected compose call %r'%tail)
    def config(self,args):
        files=[args[i+1] for i,a in enumerate(args) if a=='-f'];envs=[args[i+1] for i,a in enumerate(args) if a=='--env-file']
        directory=args[args.index('--project-directory')+1];first='--no-interpolate' in args
        model={'name':args[args.index('-p')+1],'services':{}}
        for f in files:
            data=json.loads(pathlib.Path(f).read_text())
            for k,v in data.items():
                if k=='services':
                    for name,svc in v.items():model['services'].setdefault(name,{}).update(svc)
                else:model.setdefault(k,{}).update(v) if isinstance(v,dict) else model.__setitem__(k,v)
        if self.config_hook:model=self.config_hook(model,first)
        if first:return json.dumps(model).encode()
        default=pathlib.Path(directory)/'.env'
        values={}
        for e in envs or ([str(default)] if default.exists() else []):values.update(parse_env(pathlib.Path(e).read_text()))
        model=interpolate(model,values)
        for svc in model['services'].values():
            if 'env_file' in svc:svc['env_file']=[{'path':p if p.startswith('/') else directory+'/'+p,'required':True} for p in svc['env_file']]
            for m in svc.get('volumes') or []:
                if m.get('type')=='bind' and m['source'].startswith('./'):m['source']=directory+m['source'][1:]
        return json.dumps(model).encode()
    def docker(self,args):
        if args[:3]==['compose','version','--short']:return self.version
        if args[:2]==['ps','-aq']:return '\n'.join(c['Id'] for c in self.containers).encode()
        if args[0]=='inspect':
            if args[1:3]==['--type','container']:
                name=args[3]
                if name in self.holders:return json.dumps([{'Id':'hold-'+name,'Name':'/'+name,'Image':self.holders[name]}]).encode()
                found=[c for c in ([self.single] if self.single else [])+self.created if c and c['Name'].lstrip('/')==name]
                if not found:raise subprocess.CalledProcessError(1,['docker','inspect'])
                return json.dumps(found[-1:]).encode()
            return json.dumps([c for c in self.containers if c['Id'] in args[1:]]).encode()
        if args[:2]==['image','inspect']:
            if args[2:4]==['--format','{{.Id}}']:return b'sha256:'+b'1'*64+b'\n'
            return json.dumps([{'Config':{'Env':['PATH=/usr/bin'],'Labels':{'img':'1'},'Cmd':['run'],'Entrypoint':None,'WorkingDir':'/app','User':'','Healthcheck':None}}]).encode()
        if args[0]=='tag':self.tags[args[2]]=args[1];return b''
        if args[0] in ('volume','network') and args[1]=='ls':return '\n'.join(self.volumes if args[0]=='volume' else self.networks).encode()
        if args[0] in ('volume','network') and args[1]=='rm':
            (self.volumes if args[0]=='volume' else self.networks).remove(args[2]);return b''
        if args[:2]==['image','rm']:self.tags.pop(args[-1],None);return b''
        if args[0]=='pull':
            if self.pull_fail:raise subprocess.CalledProcessError(1,['docker','pull'])
            return b''
        if args[0]=='stop':self.stops.append(list(args));return b''
        if args[0]=='rename':
            for c in [self.single]+self.created:
                if c and (c['Id']==args[1] or c['Name'].lstrip('/')==args[1]):c['Name']='/'+args[2]
            return b''
        if args[0]=='create' and any(str(a).startswith('docknest.edit.hold=') for a in args):
            name=args[args.index('--name')+1]
            if name in self.holders:raise subprocess.CalledProcessError(1,['docker','create'])
            self.holders[name]=args[-1];return ('hold-%s\n'%name).encode()
        if args[0]=='create':
            env_file=args[args.index('--env-file')+1]
            self.env_file_seen={'exists':os.path.exists(env_file),'text':pathlib.Path(env_file).read_text(),'path':env_file}
            new={'Id':'new%d'%len(self.created),'Name':'/'+args[args.index('--name')+1],'State':{'Running':False}}
            self.created.append(new);return (new['Id']+'\n').encode()
        if args[0]=='rm':
            target=args[-1];self.holders.pop(target,None);self.created=[c for c in self.created if c['Id']!=target and c['Name'].lstrip('/')!=target]
            if self.single and self.single['Id']==target:self.single=None
            return b''
        if args[0] in ('start','network'):return b''
        raise AssertionError('unexpected docker call %r'%args)
    def argv_text(self):return '\n'.join(' '.join(c['args']) for c in self.calls)

def compose_doc(services,**top):
    return json.dumps({'services':services,**top},indent=2)+'\n'

class EditCase(unittest.TestCase):
    def setUp(self):
        BUILD.mkdir(exist_ok=True)
        self.tmp=pathlib.Path(tempfile.mkdtemp(prefix='edit-test-',dir=str(BUILD)))
        self.root=posix(self.tmp)+'/site';os.makedirs(self.root+'/data');os.makedirs(self.root+'/data/uploads')
        self.compose=self.root+'/compose.yaml';self.envfile=self.root+'/.env'
        self.services={'web':{'image':'shop:${TAG}','environment':{'MODE':'prod'},'env_file':['.env'],
                'ports':[{'mode':'ingress','target':80,'published':'8080','protocol':'tcp','host_ip':'127.0.0.1'}],
                'volumes':[{'type':'bind','source':'./data','target':'/data'}],'labels':{'app':'shop'}},
            'proxy':{'image':'proxy:1','volumes':[{'type':'bind','source':'/var/run/docker.sock','target':'/var/run/docker.sock','read_only':True}]},
            'db':{'image':'${DBIMG}','environment':{'POSTGRES_PASSWORD':'${DB_PASSWORD}'}}}
        pathlib.Path(self.compose).write_bytes((compose_doc(self.services).encode()))
        self.env_text='# shop settings\nTAG=1.0\nexport DB_PASSWORD="old pass#1"\nDBIMG=postgres:16\n'
        pathlib.Path(self.envfile).write_bytes((self.env_text).encode())
        self.fake=FakeDocker(self.tmp)
        self.fake.containers=[{'Id':'c-%s'%s,'Image':'sha256:'+str(i)*64,'Config':{'Image':img,'Labels':{'com.docker.compose.service':s,'com.docker.compose.project':'shop'}},'State':{'Running':True,'Status':'running','StartedAt':'2020-01-01T00:00:00.0Z'},'Mounts':[{'Type':'bind','Source':self.root+'/data','Destination':'/data','RW':True}] if s=='web' else []} for i,(s,img) in enumerate([('web','shop:1.0'),('proxy','proxy:1'),('db','postgres:16')],1)]
        self.events=io.StringIO();self.maint=[]
        self.patches=[patch('helper.edit_exec',side_effect=self.fake),patch('helper.EVENT_STREAM',self.events),patch('helper.EDITS_ROOT',pathlib.Path(posix(self.tmp)+'/edits')),
            patch('helper.INCREMENTAL_ROOT',pathlib.Path(posix(self.tmp)+'/incremental')),patch('helper.listening_ports',return_value=[22,8080,3306]),
            patch('helper.maintenance',side_effect=lambda cfg,enabled:self.maint.append(enabled)),patch('helper.skip_refused_probes',return_value={})]
        if os.name!='posix':self.patches.append(patch('helper.atomic_json',side_effect=lambda path,value:pathlib.Path(path).write_bytes(json.dumps(value).encode())))
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        shutil.rmtree(self.tmp,ignore_errors=True)
    def request(self,operation,**extra):
        req={'operation':operation,'editId':EDIT,'siteId':SITE,'allowedRoots':[self.root],
             'invocation':{'project':'shop','files':[self.compose],'projectDirectory':self.root,'envFiles':[]},
             'config':{'maintenance':{'directory':self.root+'/maint'},'containers':[]},**extra}
        return req
    def run_op(self,operation,**extra):
        self.events.seek(0);self.events.truncate()
        helper.edit_operation(self.request(operation,**extra))
        lines=[json.loads(l) for l in self.events.getvalue().splitlines() if l.strip()]
        results=[l['result'] for l in lines if 'result' in l]
        self.assertEqual(len(results),1,lines)
        return results[0]
    def sha(self,path):return helper.edit_sha(pathlib.Path(path).read_bytes())
    def candidate(self,services=None,**top):
        return [{'path':self.compose,'sha256':self.sha(self.compose),'text':compose_doc(services if services is not None else self.services,**top)}]
    def edited(self,**changes):
        services=json.loads(json.dumps(self.services))
        for path,value in changes.items():
            service,key=path.split('.',1);services.setdefault(service,{})[key]=value
        return services
    def refused(self,result,code):
        self.assertFalse(result['ok'],result);self.assertEqual(result['code'],code,result)
        self.assertEqual(result['reason'],helper.EDIT_REASONS[code] if code!='FILE_CHANGED' or result['reason']==helper.EDIT_REASONS['FILE_CHANGED'] else helper.EDIT_REASONS['FILE_CHANGED_APPLY'])

class EnvEditor(unittest.TestCase):
    def roundtrip(self,text,edits):return helper.edit_env_apply(text,edits)
    def test_keeps_comments_order_quoting_and_export(self):
        text='# top comment\n\nA=1\nexport B="two words"\nC=\'single\'\n# trailing comment\nD=plain # inline\n'
        out=self.roundtrip(text,[{'key':'B','value':'new value'},{'key':'C','value':'it is'}])
        self.assertEqual(out,'# top comment\n\nA=1\nexport B="new value"\nC=\'it is\'\n# trailing comment\nD=plain # inline\n')
        self.assertEqual(helper.edit_env_keys(out),['A','B','C','D'])
    def test_crlf_and_missing_final_newline(self):
        text='A=1\r\nB=2\r\nC=3'
        self.assertEqual(self.roundtrip(text,[{'key':'B','value':'x'}]),'A=1\r\nB=x\r\nC=3')
        self.assertEqual(self.roundtrip(text,[{'key':'D','value':'4'}]),'A=1\r\nB=2\r\nC=3\r\nD=4')
        self.assertEqual(self.roundtrip(text,[{'key':'C','remove':True}]),'A=1\r\nB=2')
        self.assertEqual(self.roundtrip('A=1\n',[{'key':'B','value':'2'}]),'A=1\nB=2\n')
        self.assertEqual(self.roundtrip('',[{'key':'B','value':'2'}]),'B=2\n')
    def test_values_are_quoted_so_compose_reads_them_literally(self):
        self.assertEqual(self.roundtrip('A=1\n',[{'key':'A','value':'has #hash and $DOLLAR'}]),"A='has #hash and $DOLLAR'\n")
        self.assertEqual(self.roundtrip('A=1\n',[{'key':'A','value':"it's $x"}]),'A="it\'s \\$x"\n')
        self.assertEqual(self.roundtrip('A="1"\n',[{'key':'A','value':'a"b\\c'}]),'A="a\\"b\\\\c"\n')
        self.assertEqual(self.roundtrip('A=1\n',[{'key':'A','value':'simple-1.2'}]),'A=simple-1.2\n')
    def test_multiline_quoted_value_is_one_entry(self):
        text='A="line one\nline two"\nB=2\n'
        self.assertEqual(helper.edit_env_keys(text),['A','B'])
        self.assertEqual(self.roundtrip(text,[{'key':'A','value':'one'}]),'A="one"\nB=2\n')
    def test_unparsed_lines_survive_untouched(self):
        text='not a pair\nexport\nA=1\n  # indented comment\n'
        self.assertEqual(self.roundtrip(text,[{'key':'A','value':'2'}]),'not a pair\nexport\nA=2\n  # indented comment\n')

class EnvRules(EditCase):
    def check_env(self,items):return self.run_op('edit-check',files=[],env=items)
    def test_compose_and_docker_keys_and_injection_are_refused(self):
        for key in ('COMPOSE_FILE','COMPOSE_PROJECT_NAME','DOCKER_HOST','BUILDKIT_PROGRESS','compose_file'):
            result=self.check_env([{'file':self.envfile,'key':key,'value':'x'}]);self.refused(result,'ENV_REFUSED');self.assertEqual(result['field'],key)
        for value in ('a\nCOMPOSE_FILE=/etc/x.yml','a\rb','a\0b','x'*(8*1024+1)):
            result=self.check_env([{'file':self.envfile,'key':'TAG','value':value}]);self.refused(result,'ENV_REFUSED')
            self.assertNotIn(value[:20],json.dumps(result))
        for key in ('1BAD','BAD-KEY','BAD KEY',''):self.refused(self.check_env([{'file':self.envfile,'key':key,'value':'x'}]),'ENV_REFUSED')
        self.refused(self.check_env([{'file':self.root+'/other.env','key':'TAG','value':'x'}]),'ENV_REFUSED')
        self.refused(self.check_env([{'file':self.envfile,'key':'NOPE','remove':True}]),'ENV_REFUSED')
        self.refused(self.check_env([{'file':self.envfile,'key':'K%d'%i,'value':'v'} for i in range(201)]),'ENV_REFUSED')
        self.refused(self.check_env([{'file':self.envfile,'key':'K%d'%i,'value':'v'} for i in range(198)]),'ENV_REFUSED')  # file would hold 201 keys
    def test_value_change_is_reported_by_key_only(self):
        result=self.check_env([{'file':self.envfile,'key':'DB_PASSWORD','value':SECRET},{'file':self.envfile,'key':'NEW_KEY','value':SECRET}])
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['verdict']['envChanged'],{'added':['NEW_KEY'],'replaced':['DB_PASSWORD'],'removed':[]})
        self.assertNotIn(SECRET,json.dumps(result));self.assertNotIn(SECRET,self.fake.argv_text())
        env_hash=[h for h in result['verdict']['hashes'] if h['path']==self.envfile][0]
        self.assertTrue(env_hash['keyed']);self.assertNotEqual(env_hash['after'],helper.edit_sha(pathlib.Path(self.envfile).read_bytes()))
        self.assertEqual(pathlib.Path(self.envfile).read_text(),self.env_text,'check never writes')
        self.assertFalse(any(p.name.startswith('.check-') for p in pathlib.Path(posix(self.tmp)+'/edits').iterdir()),'the private folder is deleted')

class Gate(EditCase):
    def check(self,services=None,**top):return self.run_op('edit-check',files=self.candidate(services,**top))
    def test_privilege_refusals(self):
        cases=[('web.privileged',True,'PRIVILEGE_ADDED'),('web.cap_add',['SYS_ADMIN'],'PRIVILEGE_ADDED'),('web.cap_add',['ALL'],'PRIVILEGE_ADDED'),
            ('web.network_mode','host','PRIVILEGE_ADDED'),('web.pid','host','PRIVILEGE_ADDED'),('web.use_api_socket',True,'PRIVILEGE_ADDED'),
            ('web.devices',['/dev/sda:/dev/sda'],'PRIVILEGE_ADDED'),('web.security_opt',['seccomp:unconfined'],'PRIVILEGE_ADDED'),
            ('web.gpus','all','PRIVILEGE_ADDED'),('web.runtime','nvidia','PRIVILEGE_ADDED'),('web.group_add',['docker'],'PRIVILEGE_ADDED'),
            ('web.labels',{'app':'shop','docknest.site':'other'},'PRIVILEGE_ADDED'),('web.labels',{'app':'shop','com.docker.compose.project':'x'},'PRIVILEGE_ADDED'),
            ('web.logging',{'driver':'syslog','options':{'syslog-address':'udp://192.0.2.4:514'}},'PRIVILEGE_ADDED'),
            ('web.build',{'context':'.'},'PRIVILEGE_ADDED'),('web.mac_address','02:42:ac:11:00:02','UNKNOWN_SETTING'),
            ('web.deploy',{'resources':{'reservations':{'devices':[{'capabilities':['gpu']}]}}},'PRIVILEGE_ADDED')]
        for path,value,code in cases:
            with self.subTest(path=path,value=value):
                result=self.check(self.edited(**{path:value}));self.refused(result,code)
                self.assertTrue(result['field'].startswith('services.web.'),result)
    def test_new_service_with_privilege_is_refused(self):
        self.refused(self.check(self.edited(**{'evil.image':'alpine','evil.privileged':True})),'PRIVILEGE_ADDED')
    def test_default_capabilities_are_not_added(self):
        result=self.check(self.edited(**{'web.cap_add':['CHOWN','NET_BIND_SERVICE']}));self.assertTrue(result['ok'],result)
        self.refused(self.check(self.edited(**{'web.cap_add':['CHOWN'],'web.cap_drop':['ALL']})),'PRIVILEGE_ADDED')
    def test_mount_refusals(self):
        def bind(source):return [{'type':'bind','source':'./data','target':'/data'},{'type':'bind','source':source,'target':'/x'}]
        for source in ('/var/run/docker.sock','/run/containerd/containerd.sock','/etc','/etc/shadow','/','/root/.ssh','/home/other/app','/srv/elsewhere'):
            with self.subTest(source=source):self.refused(self.check(self.edited(**{'web.volumes':bind(source)})),'PATH_REFUSED')
        self.refused(self.check(self.edited(**{'web.volumes':bind(self.root+'/compose-secrets')})),'PATH_REFUSED')  # in the site, not in a bound folder
        result=self.check(self.edited(**{'web.volumes':bind(self.root+'/data/uploads')}));self.assertTrue(result['ok'],result)
    def test_symlinked_bind_source_is_refused(self):
        # A real symbolic link inside the site's folder (POSIX), never a process-wide os.lstat patch (B1): realpath and
        # every other path call keep their real behaviour. Without symlink support only the component check is faked.
        link=self.root+'/data/link';os.makedirs(self.root+'/data/real/inner',exist_ok=True)
        volumes={'web.volumes':[{'type':'bind','source':'./data','target':'/data'},{'type':'bind','source':link+'/inner','target':'/x'}]}
        try:os.symlink(self.root+'/data/real',link,target_is_directory=True);linked=True
        except (OSError,NotImplementedError):linked=False
        if linked:result=self.check(self.edited(**volumes))
        else:
            real=helper.edit_symlink_component
            with patch('helper.edit_symlink_component',side_effect=lambda p:p.startswith(link) or real(p)):result=self.check(self.edited(**volumes))
        self.refused(result,'SYMLINK_REFUSED')
    def test_nested_read_write_binds_across_services_are_refused(self):
        services=self.edited(**{'db.volumes':[{'type':'bind','source':self.root+'/data/uploads','target':'/u'}]})
        self.refused(self.check(services),'PATH_REFUSED')
        services['db']['volumes'][0]['read_only']=True
        self.assertTrue(self.check(services)['ok'])
    def test_env_file_outside_is_refused_without_leaking_the_path(self):
        result=self.check(self.edited(**{'db.env_file':['/etc/shadow']}))
        self.refused(result,'PATH_REFUSED');text=json.dumps(result)
        self.assertNotIn('shadow',text);self.assertNotIn('/etc',text)
        self.assertFalse(any('--no-interpolate' not in c['args'] and 'config' in c['args'] and c['args'][c['args'].index('-f')+1]!=self.compose for c in self.fake.calls),'no full pass on the candidate')
        self.refused(self.check(self.edited(**{'db.env_file':['../outside.env']})),'INVALID_REQUEST' if False else 'PATH_REFUSED')
        self.refused(self.check(self.edited(**{'db.env_file':['${HOME}/x.env']})),'PATH_REFUSED')
    def test_include_and_extends_files_are_checked_before_compose_runs(self):
        text=compose_doc(self.services).replace('{\n','{\n  "x-a": {"extends": {"file": "/etc/passwd", "service": "x"}},\n',1)
        before=len(self.fake.calls)
        result=self.run_op('edit-check',files=[{'path':self.compose,'sha256':self.sha(self.compose),'text':text}])
        self.refused(result,'PATH_REFUSED');self.assertNotIn('passwd',json.dumps(result))
        self.assertFalse(any('config' in c['args'] and c['args'][c['args'].index('-f')+1]!=self.compose for c in self.fake.calls[before:]))
        result=self.run_op('edit-check',files=[{'path':self.compose,'sha256':self.sha(self.compose),'text':'include:\n  - other.yaml\n'+compose_doc(self.services)}])
        self.refused(result,'PATH_REFUSED');self.assertEqual(result['field'],'include')
    def test_frozen_service_keeps_image_command_and_environment(self):
        self.refused(self.check(self.edited(**{'proxy.image':'proxy:2'})),'SERVICE_FROZEN')
        self.refused(self.check(self.edited(**{'proxy.environment':{'A':'1'}})),'SERVICE_FROZEN')
        result=self.check(self.edited(**{'proxy.labels':{'note':'ok'}}));self.assertTrue(result['ok'],result);self.assertEqual(result['verdict']['frozen'],['proxy'])
        load=self.run_op('edit-load');self.assertEqual({s['name']:s['frozen'] for s in load['services']},{'db':False,'proxy':True,'web':False})
    def test_frozen_image_through_env_interpolation_is_refused(self):
        self.services['proxy']['image']='${PROXY_IMG}';pathlib.Path(self.compose).write_bytes((compose_doc(self.services).encode()))
        pathlib.Path(self.envfile).write_bytes((self.env_text+'PROXY_IMG=proxy:1\n').encode())
        result=self.run_op('edit-check',files=[],env=[{'file':self.envfile,'key':'PROXY_IMG','value':'evil:latest'}])
        self.refused(result,'SERVICE_FROZEN');self.assertEqual(result['field'],'services.proxy.image')
    def test_service_removed_unknown_top_level_and_ports(self):
        services=json.loads(json.dumps(self.services));del services['db']
        self.refused(self.check(services),'SERVICE_REMOVED')
        self.refused(self.check(self.services,models={'a':1}),'UNKNOWN_SETTING')
        def port(n,ip=''):return self.edited(**{'web.ports':[{'mode':'ingress','target':80,'published':str(n),'protocol':'tcp','host_ip':ip}]})
        self.refused(self.check(port(22)),'PORT_IN_USE');self.refused(self.check(port(3306)),'PORT_IN_USE')
        self.refused(self.run_op('edit-check',files=self.candidate(port(2222)),sshPort=2222),'PORT_IN_USE')
        result=self.check(port(8081));self.assertTrue(result['ok']);self.assertEqual(result['verdict']['newPorts'],[{'host':8081,'allAddresses':True}])
        result=self.check(port(8081,'127.0.0.1'));self.assertEqual(result['verdict']['newPorts'],[{'host':8081,'allAddresses':False}])
        self.assertEqual(self.check(port(8080,'127.0.0.1'))['verdict']['newPorts'],[],'the site already publishes 8080')
    def test_external_network_and_volume_driver_are_refused(self):
        self.refused(self.check(self.services,networks={'outside':{'external':True}}),'PRIVILEGE_ADDED')
        self.refused(self.check(self.services,volumes={'nfs':{'driver':'local','driver_opts':{'type':'nfs'}}}),'PRIVILEGE_ADDED')
    def test_compose_older_than_2_24_is_refused(self):
        self.fake.version=b'2.23.3\n'
        self.refused(self.check(self.edited(**{'web.image':'shop:2'})),'COMPOSE_TOO_OLD')
        load=self.run_op('edit-load');self.assertEqual(load['reasons'],{'compose':'COMPOSE_TOO_OLD','env':'COMPOSE_TOO_OLD','ports':'COMPOSE_TOO_OLD','image':'COMPOSE_TOO_OLD'})
    def test_file_changed_since_load(self):
        stale=self.candidate(self.edited(**{'web.image':'shop:2'}));stale[0]['sha256']='0'*64
        self.refused(self.run_op('edit-check',files=stale),'FILE_CHANGED')
    def test_verdict_and_stable_digest(self):
        files=self.candidate(self.edited(**{'web.image':'shop:2.0'}))
        first=self.run_op('edit-check',files=files);second=self.run_op('edit-check',files=files)
        self.assertTrue(first['ok'],first);v=first['verdict']
        self.assertEqual(v['changed'],['services.web.image']);self.assertTrue(v['imageChanged'])
        self.assertEqual(v['reviewedModelSha256'],second['verdict']['reviewedModelSha256'])
        self.assertEqual(v['hashes'][0]['before'],self.sha(self.compose))
        pathlib.Path(self.envfile).write_bytes((self.env_text+'# hand edit\n').encode())
        self.assertNotEqual(self.run_op('edit-check',files=files)['verdict']['reviewedModelSha256'],v['reviewedModelSha256'],'an env-file edit changes the model inputs')
    def test_every_compose_call_runs_under_a_clean_environment(self):
        self.check(self.edited(**{'web.image':'shop:2'}))
        for call in self.fake.calls:
            self.assertEqual(call['env'],{'PATH':helper.EDIT_PATH,'HOME':'/root','COMPOSE_EXPERIMENTAL_GIT_REMOTE':'0','COMPOSE_EXPERIMENTAL_OCI_REMOTE':'0'})
        config=[c['args'] for c in self.fake.calls if 'config' in c['args']]
        self.assertTrue(any('--no-interpolate' in a and '--no-env-resolution' in a and '--no-path-resolution' in a for a in config))
        self.assertTrue(all(a[:5]==['docker','compose','-p','shop','-f'] and '--project-directory' in a for a in config))

class Load(EditCase):
    def test_load_lists_keys_never_values(self):
        result=self.run_op('edit-load')
        self.assertTrue(result['ok']);self.assertEqual(result['env'],[{'file':self.envfile,'keys':['TAG','DB_PASSWORD','DBIMG']}])
        self.assertNotIn('old pass',json.dumps(result));self.assertEqual(result['files'][0]['text'],pathlib.Path(self.compose).read_bytes().decode())
        self.assertEqual(result['usable'],{'compose':True,'env':True,'ports':True,'image':True})
        web=[s for s in result['services'] if s['name']=='web'][0]
        self.assertEqual(web['image'],'shop:1.0');self.assertEqual(web['ports'],[{'host':'8080','container':80,'protocol':'tcp','hostIp':'127.0.0.1','at':{'file':self.compose,'line':web['ports'][0]['at']['line']}}])
        # Guided tabs: the port's one line; the image comes from TAG in .env; proxy's image line is unique.
        lines=pathlib.Path(self.compose).read_text().splitlines()
        self.assertIn('8080',lines[web['ports'][0]['at']['line']-1])
        self.assertEqual((web['imageAt'],web['imageReason'],web['imageVariable']),(None,'IMAGE_FROM_ENV','TAG'))
        proxy=[s for s in result['services'] if s['name']=='proxy'][0];self.assertIn('proxy:1',lines[proxy['imageAt']['line']-1]);self.assertIsNone(proxy['imageReason'])
    def test_large_file(self):
        pathlib.Path(self.compose).write_bytes(compose_doc(self.services).encode()+b' '*(256*1024))
        result=self.run_op('edit-load');self.assertIsNone(result['files'][0]['text']);self.assertEqual(result['reasons']['compose'],'FILE_TOO_LARGE')
    def test_paths_outside_the_site_are_refused(self):
        req=self.request('edit-load');req['invocation']['files']=['/etc/compose.yaml']
        self.events.seek(0);self.events.truncate();helper.edit_operation(req)
        self.assertEqual(json.loads(self.events.getvalue())['result']['code'],'PATH_REFUSED')
        for roots in (['/'],['/srv'],['/etc/app']):
            req=self.request('edit-load');req['allowedRoots']=roots
            self.events.seek(0);self.events.truncate();helper.edit_operation(req)
            self.assertFalse(json.loads(self.events.getvalue())['result']['ok'])

class Lifecycle(EditCase):
    def prepare(self,files=None,env=None):
        files=files if files is not None else self.candidate(self.edited(**{'web.image':'shop:2.0'}))
        env=env if env is not None else [{'file':self.envfile,'key':'DB_PASSWORD','value':SECRET}]
        check=self.run_op('edit-check',files=files,env=env);self.assertTrue(check['ok'],check)
        digest=check['verdict']['reviewedModelSha256']
        result=self.run_op('edit-prepare',files=files,env=env,reviewedModelSha256=digest);self.assertTrue(result['ok'],result)
        return digest,result
    def journal(self):return json.loads((pathlib.Path(posix(self.tmp))/'edits'/EDIT/'journal.json').read_text())
    def test_full_flow_and_no_value_in_argv(self):
        original_compose=pathlib.Path(self.compose).read_bytes();original_env=pathlib.Path(self.envfile).read_bytes()
        digest,prepared=self.prepare()
        self.assertEqual(prepared['pulled'],['web'])
        self.assertIn('docknest-edit/%s:web'%EDIT,self.fake.tags)
        journal=self.journal();self.assertEqual(journal['state'],'prepared');self.assertEqual(len(journal['files']),2)
        self.assertEqual(pathlib.Path(self.compose).read_bytes(),original_compose,'prepare never writes the site')
        self.fake.on_up=lambda args:'--remove-orphans' in args or self.fake.volumes.append('shop_new')
        applied=self.run_op('edit-apply',reviewedModelSha256=digest);self.assertTrue(applied['ok'],applied)
        self.assertEqual(self.maint,[True])
        self.assertIn('shop:2.0',pathlib.Path(self.compose).read_text())
        self.assertIn('export DB_PASSWORD="%s"'%SECRET,pathlib.Path(self.envfile).read_text());self.assertTrue(pathlib.Path(self.envfile).read_text().startswith('# shop settings\n'))
        up=[c['args'] for c in self.fake.calls if 'up' in c['args']][-1]
        self.assertEqual(up[-5:],['up','-d','--no-build','--pull','never'])
        status=self.run_op('edit-status');self.assertEqual((status['files'],status['state']),('candidate','applied'))
        for _ in range(2):
            rolled=self.run_op('edit-rollback',restoreData=True);self.assertTrue(rolled['ok'],rolled)
            self.assertEqual(pathlib.Path(self.compose).read_bytes(),original_compose);self.assertEqual(pathlib.Path(self.envfile).read_bytes(),original_env)
        ups=[c['args'] for c in self.fake.calls if 'up' in c['args']]
        self.assertEqual(ups[-1][-6:],['up','-d','--no-build','--pull','never','--remove-orphans'])
        self.assertNotIn('shop_new',self.fake.volumes);self.assertIn('shop_data',self.fake.volumes)
        self.assertEqual(self.fake.tags.get('shop:1.0'),'docknest-edit/%s:web'%EDIT,'the old tag is pinned back to the journal image')
        self.assertTrue(self.journal()['restoreData'])
        self.assertEqual(self.run_op('edit-status')['files'],'original')
        finished=self.run_op('edit-finish');self.assertTrue(finished['ok']);self.assertEqual(self.maint,[True,False])
        self.assertFalse((pathlib.Path(posix(self.tmp))/'edits'/EDIT).exists());self.assertNotIn('docknest-edit/%s:web'%EDIT,self.fake.tags)
        self.assertEqual(self.run_op('edit-finish'),{'ok':True,'journal':False})
        self.assertEqual(self.run_op('edit-rollback',restoreData=False),{'ok':True,'journal':False,'leftovers':0,'dataCopy':False,'dataRestored':False})
        self.assertNotIn(SECRET,self.fake.argv_text());self.assertNotIn('old pass',self.fake.argv_text())
        for call in self.fake.calls:self.assertNotIn(SECRET,json.dumps(call['env']))
    def test_journal_is_written_before_the_first_write(self):
        digest,_=self.prepare();seen=[]
        real=helper.edit_atomic_write
        def spy(path,*args):
            seen.append(self.journal()['state']);return real(path,*args)
        with patch('helper.edit_atomic_write',side_effect=spy):self.assertTrue(self.run_op('edit-apply',reviewedModelSha256=digest)['ok'])
        self.assertEqual(seen,['candidate_written','candidate_written'])
    def test_atomic_write_keeps_owner_and_mode(self):
        digest,_=self.prepare();owners=[];modes=[]
        journal=self.journal()
        for record in journal['files']:record['uid'],record['gid'],record['mode']=1000+record['index'],2000,0o640
        (pathlib.Path(posix(self.tmp))/'edits'/EDIT/'journal.json').write_bytes((json.dumps(journal).encode()))
        with patch('helper.os.fchown',create=True,side_effect=lambda fd,u,g:owners.append((u,g))),patch('helper.os.fchmod',create=True,side_effect=lambda fd,m:modes.append(m)),patch('helper.os.chmod'):
            self.assertTrue(self.run_op('edit-apply',reviewedModelSha256=digest)['ok'])
        self.assertEqual(sorted(owners),[(1000,2000),(1001,2000)]);self.assertEqual(modes,[0o640,0o640])
        self.assertFalse([p for p in pathlib.Path(self.root).iterdir() if '.docknest-' in p.name],'no temporary file is left')
    def test_atomic_write_refuses_a_symbolic_link_target(self):
        with patch('helper.os.path.islink',return_value=True):
            with self.assertRaises(helper.EditRefused):helper.edit_atomic_write(self.compose,b'x',0,0,0o644,'t')
        self.assertNotEqual(pathlib.Path(self.compose).read_bytes(),b'x')
    def test_hand_edit_after_prepare_is_refused_at_apply(self):
        digest,_=self.prepare()
        pathlib.Path(self.compose).write_bytes(pathlib.Path(self.compose).read_bytes()+b' ')
        result=self.run_op('edit-apply',reviewedModelSha256=digest)
        self.assertEqual((result['code'],result['reason']),('FILE_CHANGED','The files changed during the backup.'))
        self.assertEqual(self.journal()['state'],'prepared');self.assertFalse(any('up' in c['args'] for c in self.fake.calls))
        self.assertEqual(self.run_op('edit-finish')['ok'],True);self.assertEqual(self.maint,[True,False],'maintenance switched on by apply goes off again')
    def test_hand_edit_before_prepare_changes_the_digest(self):
        files=self.candidate(self.edited(**{'web.image':'shop:2.0'}));env=[{'file':self.envfile,'key':'TAG','value':'2.0'}]
        digest=self.run_op('edit-check',files=files,env=env)['verdict']['reviewedModelSha256']
        pathlib.Path(self.envfile).write_bytes((self.env_text.replace('postgres:16','postgres:17').encode()))
        self.refused(self.run_op('edit-prepare',files=files,env=env,reviewedModelSha256=digest),'FILE_CHANGED')
        self.assertFalse((pathlib.Path(posix(self.tmp))/'edits'/EDIT).exists())
    def test_apply_gate_mismatch_restores_originals(self):
        digest,_=self.prepare();original=pathlib.Path(self.compose).read_bytes()
        def hook(model,first):
            if not first and 'shop:2.0' in json.dumps(model):model['services']['web']['privileged']=True
            return model
        self.fake.config_hook=hook
        result=self.run_op('edit-apply',reviewedModelSha256=digest)
        self.assertEqual(result['code'],'FILE_CHANGED');self.assertEqual(pathlib.Path(self.compose).read_bytes(),original)
        self.assertFalse(any('up' in c['args'] for c in self.fake.calls))
    def test_prepare_is_idempotent_and_pull_failure_is_fixed(self):
        digest,_=self.prepare();self.prepare()
        self.fake.pull_fail=True
        files=self.candidate(self.edited(**{'web.image':'shop:2.0'}))
        with patch('helper.edit_disk_low',return_value=False):
            self.refused(self.run_op('edit-prepare',files=files,env=[{'file':self.envfile,'key':'DB_PASSWORD','value':SECRET}],reviewedModelSha256=digest),'PULL_FAILED')
        with patch('helper.edit_disk_low',return_value=True):
            self.refused(self.run_op('edit-prepare',files=files,env=[{'file':self.envfile,'key':'DB_PASSWORD','value':SECRET}],reviewedModelSha256=digest),'DISK_FULL')
    def test_apply_needs_a_prepared_journal_and_the_reviewed_digest(self):
        self.refused(self.run_op('edit-apply',reviewedModelSha256='0'*64),'NO_JOURNAL')
        digest,_=self.prepare()
        self.refused(self.run_op('edit-apply',reviewedModelSha256='0'*64),'INVALID_REQUEST')
        self.assertEqual(self.maint,[])
    def test_apply_failure_reports_a_fixed_code(self):
        digest,_=self.prepare();self.fake.up_fail=True
        self.refused(self.run_op('edit-apply',reviewedModelSha256=digest),'APPLY_FAILED')
        self.assertEqual(self.run_op('edit-status')['files'],'candidate')
        self.refused(self.run_op('edit-rollback',restoreData=False),'ROLLBACK_FAILED')  # Compose still failing
        self.fake.up_fail=False
        self.assertTrue(self.run_op('edit-rollback',restoreData=False)['ok'],'Try again re-runs the rollback')
        self.assertEqual(self.run_op('edit-status')['files'],'original')
    def test_unexpected_errors_never_leak_text(self):
        with patch('helper.edit_compose_check',side_effect=RuntimeError('/etc/shadow root:$6$secret')):
            result=self.run_op('edit-check',files=[])
        self.assertEqual(result,{'ok':False,'code':'FAILED','reason':helper.EDIT_REASONS['FAILED']})

class DataCopy(EditCase):
    """Owner decision: an image change rolls the data back in place from a safety copy in the journal folder."""
    prepare=Lifecycle.prepare;journal=Lifecycle.journal
    def data(self):return pathlib.Path(self.root+'/data')
    def seed(self):
        d=self.data();(d/'uploads'/'a.txt').write_text('before');(d/'db.sqlite').write_bytes(b'v1')
        outside=pathlib.Path(posix(self.tmp)+'/outside.txt');outside.write_text('outside')
        try:os.symlink(str(outside),str(d/'link'))
        except (OSError,NotImplementedError):pass
        if os.name=='posix':os.chmod(d/'db.sqlite',0o640)
        return outside
    def copy_dir(self):return pathlib.Path(posix(self.tmp))/'edits'/EDIT/'data'
    def with_config(self,op,**extra):
        return self.run_op(op,config={'maintenance':{'directory':self.root+'/maint'},'mountExclusions':[{'source':self.root+'/data','path':self.root+'/data/cache','reason':'cache'}]},**extra)
    def test_image_change_copies_data_and_rollback_puts_it_back_exactly(self):
        outside=self.seed()
        digest,_=self.prepare()
        self.assertTrue(self.journal()['dataCopy'])
        applied=self.run_op('edit-apply',reviewedModelSha256=digest);self.assertTrue(applied['ok'],applied)
        self.assertTrue(applied['dataCopy']);self.assertGreaterEqual(applied['dataBytes'],len('before')+2)
        self.assertTrue(self.fake.stops,'the services stop before the copy')
        journal=self.journal();self.assertEqual([r['state'] for r in journal['data']],['saved']);self.assertEqual(journal['data'][0]['path'],self.root+'/data')
        self.assertTrue(journal['servicesStopped'])
        # The new version "migrates" the data and adds files.
        d=self.data();(d/'db.sqlite').write_bytes(b'v2-migrated');(d/'new.txt').write_text('extra');(d/'uploads'/'a.txt').unlink()
        for _ in range(2):
            rolled=self.run_op('edit-rollback',restoreData=True);self.assertTrue(rolled['ok'],rolled)
            self.assertEqual((d/'db.sqlite').read_bytes(),b'v1');self.assertEqual((d/'uploads'/'a.txt').read_text(),'before')
            self.assertFalse((d/'new.txt').exists(),'extras are removed')
        if os.path.islink(str(d/'link')):
            self.assertEqual(os.readlink(str(d/'link')),str(outside),'a symbolic link comes back as the same link')
            self.assertTrue((self.copy_dir()/'0'/'link').is_symlink(),'the copy kept the link, never its target')
            self.assertEqual(outside.read_text(),'outside')
        if os.name=='posix':self.assertEqual(os.stat(d/'db.sqlite').st_mode&0o777,0o640)
        self.assertEqual([r['state'] for r in self.journal()['data']],['restored'])
        self.assertTrue(self.run_op('edit-status')['dataCopy'],'the copy stays until finish')
        self.assertTrue(self.run_op('edit-finish')['ok']);self.assertFalse(self.copy_dir().exists(),'finish removes the copy')
    def test_owner_and_mode_are_kept(self):
        self.seed();digest,_=self.prepare();owners=[]
        # Only the copy's own root check and chown are replaced: private_staging_base still sees the real euid (B1).
        with patch('helper.edit_is_root',return_value=True),patch('helper.edit_chown',side_effect=lambda path,u,g:owners.append(os.path.basename(str(path)))):
            self.assertTrue(self.run_op('edit-apply',reviewedModelSha256=digest)['ok'])
            self.assertIn('db.sqlite',owners,'owners are copied (as root)')
            if os.name=='posix':self.assertEqual(os.stat(self.copy_dir()/'0'/'db.sqlite').st_mode&0o777,0o640)
    def test_rollback_without_restore_data_leaves_data_alone(self):
        self.seed();digest,_=self.prepare();self.run_op('edit-apply',reviewedModelSha256=digest)
        (self.data()/'new.txt').write_text('kept')
        self.assertTrue(self.run_op('edit-rollback',restoreData=False)['ok']);self.assertTrue((self.data()/'new.txt').exists())
    def test_env_only_change_takes_no_copy(self):
        digest,_=self.prepare(files=[],env=[{'file':self.envfile,'key':'DB_PASSWORD','value':SECRET}])
        self.assertFalse(self.journal()['dataCopy'])
        applied=self.run_op('edit-apply',reviewedModelSha256=digest);self.assertTrue(applied['ok'],applied);self.assertFalse(applied['dataCopy'])
        self.assertFalse(self.fake.stops);self.assertFalse(self.copy_dir().exists())
    def test_not_enough_space_refuses_before_any_write(self):
        self.seed();digest,_=self.prepare();original=pathlib.Path(self.compose).read_bytes()
        with patch('helper.shutil.disk_usage',return_value=type('Usage',(),{'free':1})()):result=self.run_op('edit-apply',reviewedModelSha256=digest)
        self.assertEqual((result['ok'],result['code'],result['reason']),(False,'DATA_COPY_SPACE','Not enough free disk space for the safety copy.'))
        self.assertEqual(pathlib.Path(self.compose).read_bytes(),original);self.assertFalse(self.fake.stops,'nothing stopped');self.assertEqual(self.journal()['state'],'prepared')
    def test_copy_interrupted_restarts_the_site_at_finish(self):
        self.seed();digest,_=self.prepare()
        with patch('helper.edit_copy_tree',side_effect=OSError(28,'No space left on device')):result=self.run_op('edit-apply',reviewedModelSha256=digest)
        self.assertEqual(result['code'],'DATA_COPY_SPACE');self.assertEqual(self.journal()['state'],'prepared');self.assertTrue(self.journal()['servicesStopped'])
        self.assertEqual(self.run_op('edit-status')['files'],'original')
        self.assertTrue(self.run_op('edit-finish')['ok'])
        ups=[c['args'] for c in self.fake.calls if 'up' in c['args']];self.assertTrue(ups,'the stopped site starts again with its own files')
    def test_failed_rollback_keeps_the_copy(self):
        self.seed();digest,_=self.prepare();self.run_op('edit-apply',reviewedModelSha256=digest)
        self.fake.up_fail=True
        self.refused(self.run_op('edit-rollback',restoreData=True),'ROLLBACK_FAILED')
        self.assertTrue((self.copy_dir()/'0').is_dir());self.assertTrue(self.run_op('edit-status')['dataCopy'])
    def test_excluded_paths_are_neither_copied_nor_removed(self):
        self.seed();(self.data()/'cache').mkdir();(self.data()/'cache'/'big.bin').write_bytes(b'x')
        digest,_=self.prepare()
        self.assertTrue(self.with_config('edit-apply',reviewedModelSha256=digest)['ok'])
        self.assertFalse((self.copy_dir()/'0'/'cache').exists())
        (self.data()/'cache'/'big.bin').write_bytes(b'new cache')
        self.assertTrue(self.run_op('edit-rollback',restoreData=True)['ok'])
        self.assertEqual((self.data()/'cache'/'big.bin').read_bytes(),b'new cache','an excluded folder is left as it is')
    def test_volume_of_another_driver_is_refused_when_the_image_changes(self):
        self.fake.containers[0]['Mounts']=[{'Type':'volume','Name':'nfs_data','Source':'/x','Destination':'/data','RW':True,'Driver':'nfs'}]
        self.refused(self.run_op('edit-check',files=self.candidate(self.edited(**{'web.image':'shop:2.0'})),env=[]),'DATA_NOT_LOCAL')
        self.assertTrue(self.run_op('edit-check',files=[],env=[{'file':self.envfile,'key':'DB_PASSWORD','value':'x'}])['ok'],'no image change: no data copy needed')
    def test_review_reports_the_data_size_for_an_image_change(self):
        self.seed()
        verdict=self.run_op('edit-check',files=self.candidate(self.edited(**{'web.image':'shop:2.0'})),env=[])['verdict'];self.assertGreater(verdict['dataBytes'],0)
    def test_docknest_itself_is_refused(self):
        self.fake.containers[0]['Config']['Labels']['io.github.dahanitamar.docknest']='app'
        self.refused(self.run_op('edit-check',files=self.candidate(self.edited(**{'web.image':'shop:2.0'})),env=[]),'OWN_SITE')

class Guided(unittest.TestCase):
    def test_anchors_extends_and_two_files_are_never_guessed(self):
        texts={'/s/a.yaml':'services:\n  web:\n    image: shop:1.0\n    ports:\n      - "8080:80"\n','/s/b.yaml':'services:\n  web:\n    ports:\n      - "8080:80"\n'}
        first={'services':{'web':{'image':'shop:1.0','ports':[{'published':'8080','target':80}]},'api':{'image':'base:1','extends':{'service':'web'}},'w2':{'image':'shared:1'},'w3':{'image':'shared:1'}}}
        guided=helper.edit_guided(first,texts)
        self.assertEqual(guided['web']['imageAt'],{'file':'/s/a.yaml','line':3})
        self.assertEqual(guided['web']['ports'][0]['reason'],'EDIT_IN_COMPOSE','the same port line in two files')
        self.assertEqual(guided['api']['imageReason'],'EDIT_IN_COMPOSE','extends')
        self.assertEqual((guided['w2']['imageReason'],guided['w3']['imageReason']),('EDIT_IN_COMPOSE','EDIT_IN_COMPOSE'),'one anchor line shared by two services')
        port=helper.edit_guided({'services':{'web':{'image':'x:1','ports':[{'published':'${PORT}','target':80}]}}},{'/s/a.yaml':'services: {}'})['web']['ports'][0]
        self.assertEqual(port['reason'],'EDIT_IN_COMPOSE')
        override=helper.edit_guided({'services':{'web':{'image':'shop:1.0','ports':[{'published':'9090','target':81}]}}},{'/s/a.yaml':'services:\n  web:\n    image: shop:1.0\n','/s/o.yaml':'services:\n  web:\n    ports:\n      - published: 9090\n        target: 81\n'})['web']
        self.assertEqual(override['ports'][0]['at'],{'file':'/s/o.yaml','line':4},'the port in the override file')

class ReviewFixes(EditCase):
    """Regression tests for the independent review of PR #157 (B2-B6 and the follow-ups)."""
    prepare=Lifecycle.prepare;journal=Lifecycle.journal
    def data(self):return pathlib.Path(self.root+'/data')
    def copy_dir(self):return pathlib.Path(posix(self.tmp))/'edits'/EDIT/'data'
    def edits(self):return pathlib.Path(posix(self.tmp))/'edits'/EDIT
    def seed(self):(self.data()/'uploads'/'a.txt').write_text('before');(self.data()/'db.sqlite').write_bytes(b'v1')
    # B2
    def test_out_of_space_after_the_candidate_is_written_is_a_plain_failure_and_keeps_the_journal(self):
        self.seed();digest,_=self.prepare()
        def full(args):raise OSError(28,'No space left on device')
        self.fake.on_up=full
        result=self.run_op('edit-apply',reviewedModelSha256=digest)
        self.assertEqual(result['code'],'FAILED',result);self.assertTrue(result['dataCopy'])
        self.assertTrue(self.edits().is_dir(),'the journal with originals and data copy stays');self.assertEqual(self.journal()['state'],'candidate_written')
        self.assertEqual(self.run_op('edit-status')['files'],'candidate','edit-status sends the edit to rollback')
    # B3
    def test_copy_too_large_for_the_time_limit_is_refused_at_review(self):
        self.seed()
        with patch('helper.EDIT_COPY_MAX_SECONDS',0):self.refused(self.run_op('edit-check',files=self.candidate(self.edited(**{'web.image':'shop:2.0'})),env=[]),'DATA_TOO_LARGE')
        with patch('helper.EDIT_DATA_SCAN_LIMIT',1),patch('helper.edit_data_size.__defaults__',(1,)):
            self.refused(self.run_op('edit-check',files=self.candidate(self.edited(**{'web.image':'shop:2.0'})),env=[]),'DATA_TOO_LARGE')
    def test_unreadable_data_fails_closed(self):
        self.seed();real=os.scandir;target=self.root+'/data/uploads'
        def scan(path='.'):
            if str(path).replace('\\','/')==target:raise PermissionError(13,'denied')
            return real(path)
        with patch('helper.os.scandir',side_effect=scan):self.refused(self.run_op('edit-check',files=self.candidate(self.edited(**{'web.image':'shop:2.0'})),env=[]),'DATA_UNREADABLE')
    def test_a_stop_during_the_copy_leaves_a_true_marker_and_a_rerun_finishes(self):
        self.seed();digest,_=self.prepare()
        with patch('helper.edit_stopping',return_value=True):result=self.run_op('edit-apply',reviewedModelSha256=digest)
        self.assertEqual(result['code'],'FAILED');journal=self.journal()
        self.assertEqual([r['state'] for r in journal['data']],['copying']);self.assertEqual(journal['state'],'prepared')
        self.assertEqual(self.run_op('edit-status')['files'],'original','nothing written: the edit ends and finish starts the site')
    def test_restore_is_resumable_per_set(self):
        self.seed();digest,_=self.prepare();self.assertTrue(self.run_op('edit-apply',reviewedModelSha256=digest)['ok'])
        (self.data()/'db.sqlite').write_bytes(b'v2');(self.data()/'extra.txt').write_text('x')
        real=helper.edit_copy_tree;calls=[]
        def broken(source,target,exclude=()):
            calls.append(target)
            if len(calls)==1:raise OSError(5,'I/O error')
            return real(source,target,exclude)
        with patch('helper.edit_copy_tree',side_effect=broken):self.refused(self.run_op('edit-rollback',restoreData=True),'ROLLBACK_FAILED')
        self.assertEqual([r['state'] for r in self.journal()['data']],['restoring'],'the half-cleared folder is recorded')
        result=self.run_op('edit-rollback',restoreData=True);self.assertTrue(result['ok'],result);self.assertTrue(result['dataRestored'])
        self.assertEqual((self.data()/'db.sqlite').read_bytes(),b'v1');self.assertFalse((self.data()/'extra.txt').exists())
        self.assertEqual((self.data()/'uploads'/'a.txt').read_text(),'before')
    # B4
    def test_raw_yaml_tricks_are_refused_before_compose_runs(self):
        base=compose_doc(self.services)
        cases={
            'escaped-key':base.replace('{\n','{\n  "\\u0069nclude": ["/etc/x.yaml"],\n',1),
            'complex-key':base+'? include\n: [/etc/x.yaml]\n',
            'top-level-merge':base+'<<: {include: [/etc/x.yaml]}\n',
        }
        for name,text in cases.items():
            calls=len(self.fake.calls)
            result=self.run_op('edit-check',files=[{'path':self.compose,'sha256':self.sha(self.compose),'text':text}],env=[])
            self.assertFalse(result['ok'],name);self.assertIn(result['code'],('YAML_REFUSED','PATH_REFUSED'),name)
            self.assertFalse([c for c in self.fake.calls[calls:] if 'config' in c['args']],name+': no Compose call')
        yaml_doc='services:\n  web:\n    image: shop:1.0\n'
        flow='{services: {web: {image: shop:1.0}}, include: [/etc/x.yaml]}\n'
        self.assertEqual(helper.EDIT_RAW_PATTERNS['top-level-flow'].findall(flow)!=[],True)
        with self.assertRaises(helper.EditRefused) as refused:helper.edit_raw_problems(yaml_doc,flow)
        self.assertEqual(refused.exception.code,'YAML_REFUSED')
        for text,token in [(yaml_doc+'  api:\n    extends:\n      file: ./common.yaml\n      service: base\n','extends'),(yaml_doc+'secrets:\n  s:\n    "file": ./s.txt\n','file'),(yaml_doc+"x-a: {'include': [/x]}\n",'include'),(yaml_doc+'x-b:\n  - INCLUDE: [/x]\n','include')]:
            with self.assertRaises(helper.EditRefused) as refused:helper.edit_raw_problems(yaml_doc,text)
            self.assertEqual((refused.exception.code,refused.exception.field),('PATH_REFUSED',token),text)
        existing=yaml_doc+'  api:\n    extends:\n      file: ./common.yaml\n      service: base\n'
        helper.edit_raw_problems(existing,existing.replace('shop:1.0','shop:1.1'))  # what the site already has stays allowed
    # B6 + follow-ups
    def test_holder_containers_keep_the_image_ids_and_finish_removes_them(self):
        digest,_=self.prepare()
        holders=self.journal()['holders'];self.assertIn('docknest-edit-hold-%s-web'%EDIT[:8],holders)
        create=[c['args'] for c in self.fake.calls if c['args'][1:2]==['create']][0]
        self.assertIn('com.docker.compose.project=',create,'outside the Compose project');self.assertNotIn('start',[c['args'][1] for c in self.fake.calls])
        self.assertTrue(self.run_op('edit-prepare',files=self.candidate(self.edited(**{'web.image':'shop:2.0'})),env=[{'file':self.envfile,'key':'DB_PASSWORD','value':SECRET}],reviewedModelSha256=digest)['ok'],'idempotent')
        self.assertTrue(self.run_op('edit-finish')['ok']);self.assertEqual(self.fake.holders,{})
    def test_a_new_service_alone_takes_no_data_copy(self):
        services=self.edited(**{'cache.image':'redis:7'})
        check=self.run_op('edit-check',files=self.candidate(services),env=[]);self.assertTrue(check['ok'],check);self.assertFalse(check['verdict']['imageChanged'])
    def test_rollback_and_finish_remove_temporaries_of_an_interrupted_write(self):
        digest,_=self.prepare();self.assertTrue(self.run_op('edit-apply',reviewedModelSha256=digest)['ok'])
        leftover=pathlib.Path(self.root)/('.compose.yaml.docknest-%s.tmp'%EDIT[:8]);leftover.write_text('half')
        self.assertTrue(self.run_op('edit-rollback',restoreData=False)['ok']);self.assertFalse(leftover.exists())
        leftover.write_text('half');self.assertTrue(self.run_op('edit-finish')['ok']);self.assertFalse(leftover.exists())
    def test_finish_after_restore_backup_keeps_the_maintenance_page(self):
        digest,_=self.prepare();self.assertTrue(self.run_op('edit-apply',reviewedModelSha256=digest)['ok'])
        self.assertTrue(self.run_op('edit-finish',keepMaintenance=True)['ok'])
        self.assertEqual(self.maint,[True],'maintenance stays on');self.assertFalse(self.edits().exists(),'journal, copy and holders removed')
    def test_rollback_reports_the_data_copy_even_when_it_fails(self):
        self.seed();digest,_=self.prepare();self.run_op('edit-apply',reviewedModelSha256=digest)
        self.fake.up_fail=True
        result=self.run_op('edit-rollback',restoreData=True);self.assertEqual(result['code'],'ROLLBACK_FAILED');self.assertTrue(result['dataCopy'])
        self.assertTrue(self.run_op('edit-status')['dataCopy'])
    def test_the_journal_is_never_copied_into_itself(self):
        sets=helper.edit_data_sets({},[{'Mounts':[{'Type':'bind','Source':str(helper.EDITS_ROOT),'RW':True},{'Type':'bind','Source':str(helper.EDITS_ROOT.parent),'RW':True}]}])
        for s in sets:self.assertTrue(str(helper.EDITS_ROOT) in s['exclude'] or not helper.within(str(helper.EDITS_ROOT),s['path']))
        self.assertFalse([s for s in sets if s['path']==str(helper.EDITS_ROOT)])


class Poll(EditCase):
    def poll(self,**extra):
        req={'services':['web','db'],'windowStartedAt':helper.time.time()-30,'timeLimitSeconds':120,'final':False,**extra}
        return self.run_op('edit-poll',**req)
    def test_states(self):
        self.assertEqual(self.poll()['state'],'waiting','within 60 seconds of the start')
        self.assertEqual(self.poll(windowStartedAt=helper.time.time()-61)['state'],'healthy')
        self.fake.containers[0]['State']={'Running':True,'Status':'running','Health':{'Status':'starting'},'StartedAt':'2020-01-01T00:00:00Z'}
        self.assertEqual(self.poll(windowStartedAt=helper.time.time()-61)['state'],'waiting')
        result=self.poll(windowStartedAt=helper.time.time()-130)
        self.assertEqual((result['state'],result['reason']),('unhealthy','The site did not become healthy in 2 minutes.'))
        self.fake.containers[0]['State']={'Running':False,'Status':'exited'}
        self.assertEqual(self.poll()['state'],'unhealthy')
        self.fake.containers[0]['State']={'Running':True,'Status':'running','Health':{'Status':'unhealthy'}}
        self.assertEqual(self.poll()['reason'],'web reports unhealthy.')
    def test_health_url(self):
        self.fake.containers[0]['State']={'Running':True,'Status':'running','StartedAt':'2020-01-01T00:00:00Z'}
        with patch('helper.fetch',return_value=(503,b'dbm-maintenance-v1')):self.assertEqual(self.poll(windowStartedAt=helper.time.time()-61,healthUrl='http://127.0.0.1:8080/')['state'],'waiting')
        with patch('helper.fetch',return_value=(302,b'')):self.assertEqual(self.poll(windowStartedAt=helper.time.time()-61,healthUrl='http://127.0.0.1:8080/')['state'],'healthy')

class SingleContainer(EditCase):
    def setUp(self):
        super().setUp()
        self.volume=posix(self.tmp)+'/volumes/blog_content/_data';os.makedirs(self.volume);pathlib.Path(self.volume+'/post.md').write_text('first')
        self.fake.single={'Id':'orig','Name':'/blog','Image':'sha256:'+'a'*64,'State':{'Running':True,'Status':'running','StartedAt':'2020-01-01T00:00:00Z'},
            'Config':{'Image':'ghost:5','Env':['PATH=/usr/bin','DB_PASS=old-secret','MODE=prod'],'Labels':{'img':'1','team':'web'},'Cmd':['run'],'Entrypoint':None,'WorkingDir':'/app','User':'','Hostname':'orig'[:12],'Healthcheck':None},
            'HostConfig':{'NetworkMode':'blognet','RestartPolicy':{'Name':'unless-stopped'},'PortBindings':{'2368/tcp':[{'HostIp':'127.0.0.1','HostPort':'2368'}]},'LogConfig':{'Type':'json-file','Config':{}},'Tmpfs':{}},
            'NetworkSettings':{'Networks':{'blognet':{'Aliases':['blog']}}},'Mounts':[{'Type':'volume','Name':'blog_content','Source':self.volume,'Destination':'/var/lib/ghost/content','RW':True,'Driver':'local'}]}
    def request(self,operation,**extra):
        req=super().request(operation,**extra);req['invocation']={'container':'blog'};return req
    def test_recreate_uses_a_private_env_file_and_rolls_back_by_rename(self):
        load=self.run_op('edit-load');self.assertEqual(load['env'],[{'file':'container','keys':['DB_PASS','MODE']}]);self.assertNotIn('old-secret',json.dumps(load))
        env=[{'file':'container','key':'DB_PASS','value':SECRET}];changes={'image':'ghost:5.1','ports':[{'host':2369,'container':2368,'protocol':'tcp','hostIp':'127.0.0.1'}]}
        check=self.run_op('edit-check',env=env,containerChanges=changes);self.assertTrue(check['ok'],check)
        v=check['verdict'];self.assertEqual(v['changed'],['container.image','container.ports','container.environment']);self.assertEqual(v['newPorts'],[{'host':2369,'allAddresses':False}])
        prepared=self.run_op('edit-prepare',env=env,containerChanges=changes,reviewedModelSha256=v['reviewedModelSha256']);self.assertEqual(prepared,{'ok':True,'pulled':['blog']})
        applied=self.run_op('edit-apply',reviewedModelSha256=v['reviewedModelSha256']);self.assertTrue(applied['ok'],applied)
        seen=self.fake.env_file_seen;self.assertTrue(seen['exists']);self.assertIn('DB_PASS=%s'%SECRET,seen['text']);self.assertNotIn('PATH=',seen['text'])
        self.assertFalse(os.path.exists(seen['path']),'the env file is removed after create')
        create=[c['args'] for c in self.fake.calls if c['args'][1:2]==['create'] and not any(a.startswith('docknest.edit.hold=') for a in c['args'])][0]
        self.assertIn('127.0.0.1:2369:2368/tcp',create);self.assertEqual(create[-2:],['ghost:5.1','run'] if 'run' in create else create[-2:])
        self.assertIn('type=volume,src=blog_content,dst=/var/lib/ghost/content',create);self.assertIn('team=web',create);self.assertNotIn('img=1',create)
        self.assertNotIn(SECRET,self.fake.argv_text());self.assertNotIn('old-secret',self.fake.argv_text())
        self.assertEqual(self.fake.single['Name'],'/blog-docknest-%s'%EDIT[:8])
        for _ in range(2):self.assertTrue(self.run_op('edit-rollback',restoreData=False)['ok'])
        self.assertEqual(self.fake.single['Name'],'/blog');self.assertEqual(self.fake.created,[])
        self.assertEqual(self.run_op('edit-status')['files'],'original')
    def test_unsupported_settings_refuse_the_recreate(self):
        self.fake.single['HostConfig']['Privileged']=True
        load=self.run_op('edit-load');self.assertFalse(load['usable']['env']);self.assertEqual(load['reasons']['env'],'UNSUPPORTED_CONTAINER')
        self.refused(self.run_op('edit-check',env=[{'file':'container','key':'MODE','value':'x'}]),'UNSUPPORTED_CONTAINER')

if __name__=='__main__':
    unittest.main()
