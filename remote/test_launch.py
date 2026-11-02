"""Launch helper operations (docs/launch-site.md, "Security review changes"). Run: python3 remote/test_launch.py
Every command is faked: the tests record the exact argv and environment the helper would run (git under env -i, Compose
with explicit -p/-f/--env-file, buildx with the pinned BuildKit, certbot with --cert-name docknest-<slug>) and prove the
journal is written before each create, the deploy key never leaves its 0600 file, and teardown is label-gated."""
import unittest, tempfile, pathlib, json, io, os, sys, socket, stat, base64, hashlib, subprocess, time, shlex
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

LID='3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b'
SHA='a'*40
# Built at runtime so the file never holds a PEM-shaped block; the body is a made-up canary, not a key.
PEM_KIND='OPENSSH '+'PRIVATE'+' KEY'
KEY='-----BEGIN '+PEM_KIND+'-----\n'+'FAKEFIXTURE'*4+'\n'+'SECRETKEYMATERIAL0123456789=\n-----END '+PEM_KIND+'-----\n'
def host_blob(kind='ssh-ed25519'):
    raw=len(kind).to_bytes(4,'big')+kind.encode()+(32).to_bytes(4,'big')+b'k'*32
    return base64.b64encode(raw).decode()
HOST_LINE='github.com ssh-ed25519 '+host_blob()
SECRET='pa$$ w0rd"\'x'
PUBLIC_V4=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',443))]

def default_model(root,slug='shop'):
    return {'name':slug,'services':{'web':{'image':'nginx:alpine','ports':[{'target':80,'published':'8080','host_ip':'','protocol':'tcp'}]},
        'db':{'image':'postgres:16','volumes':[{'type':'volume','source':'db','target':'/var/lib/postgresql/data'}]}},
        'volumes':{'db':{'name':slug+'_db'}},'networks':{'default':{'name':slug+'_default'}}}

class Gate(Exception):
    def __init__(self,code,field):super().__init__(code);self.code=code;self.field=field

class Host:
    """A fake server. Every process the helper starts goes through launch_watch, which is replaced here."""
    def __init__(self,test,**kw):
        self.test=test;self.tmp=tempfile.TemporaryDirectory(ignore_cleanup_errors=True);test.addCleanup(self.tmp.cleanup);root=pathlib.Path(os.path.realpath(self.tmp.name))
        self.root=root;self.launches=root/'launches';self.sites=root/'srv'/'docknest';self.acme=root/'acme';self.le=root/'letsencrypt';self.conf=root/'nginx'/'conf.d'
        self.conf.mkdir(parents=True);(root/'srv').mkdir()
        self.calls=[];self.events=io.StringIO()
        self.git_version=kw.get('git_version','2.51.0');self.repo=kw.get('repo',{'compose.yaml':'services: {}\n'})
        self.model=kw.get('model');self.existing=kw.get('existing',{});self.images=kw.get('images',{})
        self.nginx_dump=kw.get('nginx_dump','# configuration file /etc/nginx/nginx.conf:\nevents {}\nhttp { include /etc/nginx/conf.d/*.conf; }\n')
        self.fail=kw.get('fail',{});self.dns=kw.get('dns',PUBLIC_V4);self.tools=set(kw.get('tools',{'ssh','nginx','certbot','git','docker','buildx','unshare','mount'}))
        self.ports=kw.get('ports',[]);self.addresses=kw.get('addresses',['203.0.113.10']);self.keyscan=kw.get('keyscan','')
        self.containers=kw.get('containers',[]);self.gate=kw.get('gate');self.on_call=kw.get('on_call')
        self.labels={}  # docker object -> launch label, for teardown
    def site(self,slug='shop'):return self.sites/slug
    def start_journal(self,**extra):
        (self.launches/LID).mkdir(parents=True,exist_ok=True)
        (self.launches/LID/'journal.json').write_text(json.dumps({'slug':'shop',**extra}))
        return self
    def journal(self):
        file=self.launches/LID/'journal.json'
        return json.loads(file.read_text()) if file.is_file() else None
    def watch(self,argv,env,timeout,folder=None,limit=None,cwd=None,journal=None):
        argv=list(argv);self.calls.append({'argv':argv,'env':env,'timeout':timeout,'folder':folder,'limit':limit,'cwd':cwd,'journal':journal is not None})
        if self.on_call:self.on_call(self,argv)
        words=argv[argv.index('docker'):] if argv[0]=='unshare' and 'docker' in argv else argv
        def out(code=0,stdout=b'',tail='',why=None):return code,stdout,tail,why
        for key,result in self.fail.items():
            if key in ' '.join(words):return result
        if 'git' in words:
            g=words[words.index('git')+1:]
            if g==['--version']:return out(stdout=('git version %s\n'%self.git_version).encode())
            if 'ls-remote' in g:return out(stdout=('%s\tHEAD\n%s\trefs/heads/main\n'%(SHA,SHA)).encode())
            if 'clone' in g:
                target=pathlib.Path(words[-1]);target.mkdir()
                (target/'.git').mkdir();(target/'.git'/'HEAD').write_text('ref')
                for name,content in self.repo.items():
                    path=target/name;path.parent.mkdir(parents=True,exist_ok=True)
                    if isinstance(content,tuple):os.symlink(content[1],path)
                    else:path.write_text(content)
                return out()
            if 'rev-parse' in g:return out(stdout=(SHA+'\n').encode())
        if words[:2]==['docker','compose']:
            if 'version' in words:return out(stdout=b'2.29.1\n')
            if 'config' in words:
                model=self.model(self) if callable(self.model) else (self.model or default_model(self.root))
                return out(stdout=json.dumps(model).encode())
            return out()
        if words[:2]==['docker','ps']:
            if '--filter' in words:
                f=words[words.index('--filter')+1]
                if f.startswith('label=docknest.launch='):return out(stdout='\n'.join(self.existing.get('own_containers',[])).encode())
                if f.startswith('label=com.docker.compose.project='):return out(stdout='\n'.join(self.existing.get('project',[])).encode())
            return out(stdout='\n'.join(self.existing.get('containers',[])).encode())
        if words[:2] in (['docker','volume'],['docker','network']) and words[2]=='ls':
            kind=words[1]+'s'
            if '--filter' in words:return out(stdout='\n'.join(self.existing.get('own_'+kind,[])).encode())
            return out(stdout='\n'.join(self.existing.get(kind,[])).encode())
        if words[:3]==['docker','image','inspect']:
            image=words[-1]
            if image in self.images:return out(stdout=json.dumps({'docknest.launch':self.images[image]} if self.images[image] else {}).encode())
            return out(1)
        if words[:2]==['docker','buildx']:
            if words[2]=='inspect':return out(0 if self.existing.get('builder') else 1)
            return out()
        if words[0]=='nginx' and words[1]=='-T':return out(stdout=self.nginx_dump.encode())
        if words[0]=='ssh-keyscan' or 'ssh-keyscan' in words:return out(stdout=self.keyscan.encode())
        return out()
    def which(self,name,path=None):
        return '/usr/bin/'+name if name in self.tools else None
    def getaddrinfo(self,host,port,*args,**kw):
        answers=self.dns(host) if callable(self.dns) else self.dns
        if answers is None:raise socket.gaierror('no')
        return answers
    def run(self,operation,**req):
        request={'operation':operation,'launchId':LID,'slug':'shop',**req}
        patches=[patch('helper.launch_watch',side_effect=self.watch),patch('helper.LAUNCH_ROOT',self.launches),patch('helper.LAUNCH_SITES',self.sites),
            patch('helper.LAUNCH_LOCK_PATH',str(self.root/'launch.lock')),patch('helper.ACME_ROOT',self.acme),patch('helper.LETSENCRYPT',self.le),
            patch('helper.launch_root_user',return_value=None),patch('helper.socket.getaddrinfo',side_effect=self.getaddrinfo),
            patch('helper.os.path.expanduser',side_effect=lambda p:p.replace('~','/nonexistent-home')),            patch('helper.EVENT_STREAM',self.events),patch('helper.shutil.which',side_effect=self.which),
            patch('helper.tool_version',side_effect=lambda args:'29.0.0' if 'docker' in self.tools and ('buildx' not in args or 'buildx' in self.tools) else None),patch('helper.listening_ports',return_value=self.ports),
            patch('helper.host_addresses',return_value=self.addresses),patch('helper.nginx_conf_dir',return_value=str(self.conf)),
            patch('helper.process_running',return_value=False),patch('helper.os_release',return_value={'id':'ubuntu','versionId':'24.04'}),
            patch('helper.package_manager',return_value='apt'),patch('helper.time.sleep',side_effect=AssertionError('no sleeping')),
            patch('helper.inspect',side_effect=lambda ids:[c for c in self.containers if c['Id'] in ids])]
        if self.gate is not None:patches.append(patch('helper.edit_gate',side_effect=self.gate,create=True))
        if os.name!='posix':patches.append(patch('helper.atomic_json',side_effect=lambda path,value:pathlib.Path(path).write_text(json.dumps(value))))  # Windows cannot open a folder to fsync it
        for item in patches:item.start()
        try:helper.main(request)
        finally:
            for item in patches:item.stop()
        return [json.loads(line) for line in self.events.getvalue().splitlines() if line.strip()][-1]['result']
    def argvs(self,word):return [c for c in self.calls if word in c['argv']]

def gate_ok(current,candidate,roots,current_env,candidate_env):return []

# The exact hardening of every git call (owner decision: git 2.37+, CVE classes closed by configuration).
GIT_CONFIG=['-c','protocol.allow=never','-c','protocol.https.allow=always','-c','protocol.ssh.allow=always','-c','protocol.file.allow=never','-c','protocol.ext.allow=never',
    '-c','http.followRedirects=false','-c','submodule.recurse=false','-c','transfer.bundleURI=false','-c','core.hooksPath=/dev/null','-c','core.symlinks=false']
def GIT_ENV(folder):
    return ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','HOME='+str(pathlib.Path(folder)/'git-home'),'GIT_TERMINAL_PROMPT=0','GIT_CONFIG_NOSYSTEM=1','GIT_CONFIG_GLOBAL=/dev/null','GIT_CEILING_DIRECTORIES=/','LC_ALL=C']

class UrlTests(unittest.TestCase):
    def test_git_never_runs_against_a_local_path(self):
        for url in ('/srv/repo','file:///srv/repo','./repo','ext::sh','-oX'):
            with self.assertRaises(helper.LaunchRefused,msg=url):helper.launch_git_argv('/h',{'url':url},None,['clone'])
        for url in ('https://h.example/x','ssh://git@8.8.8.8:2222/x','git@8.8.8.8:o/r','git@[2606:4700::1]:o/r'):
            self.assertEqual(helper.launch_git_argv('/h',{'url':url},None,['x'])[-1],'x')
    def test_accepted_forms(self):
        cases={'https://github.com/o/r.git':('https','github.com',443,None),'https://git.example.com:8443/o/r':('https','git.example.com',8443,None),
            'git@github.com:o/r.git':('ssh','github.com',22,'git'),'ssh://git@host.example:2222/o/r.git':('ssh','host.example',2222,'git'),
            'https://[2606:4700::1]/o/r':('https','2606:4700::1',443,None),'git@[2606:4700::1]:o/r':('ssh','2606:4700::1',22,'git'),
            'git@gitea.lan:~me/repo.git':('ssh','gitea.lan',22,'git')}
        for url,(kind,host,port,user) in cases.items():
            parsed=helper.launch_git_url(url)
            self.assertEqual((parsed['kind'],parsed['host'],parsed['port'],parsed['user']),(kind,host,port,user),url)
    def test_refused_forms(self):
        cases={'file:///etc/passwd':'URL_REFUSED','ext::sh -c touch% /tmp/x':'URL_REFUSED','-uhttps://x.y/z':'URL_REFUSED','http://github.com/o/r':'URL_REFUSED',
            'https://user:pw@github.com/o/r':'URL_USERINFO','https://token@github.com/o/r':'URL_USERINFO','ssh://git:pw@host.example/o/r':'URL_USERINFO',
            'git@host.example:-oProxyCommand=x':'URL_REFUSED','ssh://host.example/o/r':'URL_REFUSED','https://github.com/o/../r':'URL_REFUSED',
            'https://0x7f000001/o/r':'URL_REFUSED','https://2130706433/o/r':'URL_REFUSED','https://[fe80::1%25eth0]/o/r':'URL_REFUSED',
            'https://github.com/o/r?x=1':'URL_REFUSED','https://github.com:0/o/r':'URL_REFUSED','git@host.example:o r':'URL_REFUSED',
            'https://github.com/-o/r':'URL_REFUSED','https://-github.com/o/r':'URL_REFUSED','git@-host:o/r':'URL_REFUSED','fd::/x':'URL_REFUSED',
            "https://github.com/o/r'x":'URL_REFUSED','https://github.com':'URL_REFUSED','git://github.com/o/r':'URL_REFUSED','host.example:o/r':'URL_REFUSED'}
        for url,code in cases.items():
            with self.assertRaises(helper.LaunchRefused,msg=url) as caught:helper.launch_git_url(url)
            self.assertEqual(caught.exception.code,code,url)
    def test_address_policy(self):
        ip=helper.ipaddress.ip_address
        self.assertEqual(helper.launch_ip_problem(ip('10.0.0.5'),False),'URL_PRIVATE')
        self.assertIsNone(helper.launch_ip_problem(ip('10.0.0.5'),True))
        self.assertIsNone(helper.launch_ip_problem(ip('100.64.1.1'),True))
        for value in ('169.254.169.254','fd00:ec2::254','100.100.100.200','127.0.0.1','::1','::ffff:169.254.169.254','fe80::1','0.0.0.0','224.0.0.1'):
            self.assertEqual(helper.launch_ip_problem(ip(value),True),'URL_METADATA',value)
        for value in ('::ffff:10.0.0.1','2002:0a00:0001::1','64:ff9b::a00:1','fc00::1','192.168.1.2'):
            self.assertEqual(helper.launch_ip_problem(ip(value),False),'URL_PRIVATE',value)
        self.assertIsNone(helper.launch_ip_problem(ip('2606:4700::1111'),False))
        self.assertIsNone(helper.launch_ip_problem(ip('64:ff9b::8c52:7903'),False),'NAT64 of a public address (IPv6-only server with DNS64)')
        self.assertEqual(helper.launch_ip_problem(ip('64:ff9b::a9fe:a9fe'),True),'URL_METADATA')
    def test_every_answer_is_checked_and_the_first_is_pinned(self):
        mixed=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',443)),(socket.AF_INET,socket.SOCK_STREAM,6,'',('10.0.0.9',443))]
        with patch('helper.socket.getaddrinfo',return_value=mixed):
            with self.assertRaises(helper.LaunchRefused) as caught:helper.launch_resolve('github.com',443,False)
        self.assertEqual(caught.exception.code,'URL_PRIVATE')
        with patch('helper.socket.getaddrinfo',side_effect=socket.gaierror('x')):
            with self.assertRaises(helper.LaunchRefused) as caught:helper.launch_resolve('nowhere.example',443,False)
        self.assertEqual(caught.exception.code,'DNS_FAILED')
    def test_ipv6_only_dns_pins_with_brackets_and_the_real_port(self):
        v6=[(socket.AF_INET6,socket.SOCK_STREAM,6,'',('2606:4700::1111',8443,0,0))]
        with patch('helper.socket.getaddrinfo',return_value=v6):
            target=helper.launch_git_target(helper.launch_git_url('https://git.example.com:8443/o/r.git'),False)
        self.assertEqual(target['resolve'],'git.example.com:8443:[2606:4700::1111]')
        self.assertEqual(target['url'],'https://git.example.com:8443/o/r.git')
    def test_ssh_connects_to_the_checked_ip_with_the_name_as_host_key_alias(self):
        with patch('helper.socket.getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',22))]):
            scp=helper.launch_git_target(helper.launch_git_url('git@github.com:o/r.git'),False)
            port=helper.launch_git_target(helper.launch_git_url('ssh://git@git.example.com:2222/o/r.git'),False)
        self.assertEqual((scp['url'],scp['alias']),('git@8.8.8.8:o/r.git','github.com'))
        self.assertEqual((port['url'],port['alias']),('ssh://git@8.8.8.8:2222/o/r.git','[git.example.com]:2222'))
    def test_refs(self):
        for ref in ('main','v1.4.2','release/2.0'):self.assertEqual(helper.launch_ref(ref),ref)
        for ref in ('-x','a..b','x.lock','/x','x/','.hidden','a b','HEAD@{1}'):
            with self.assertRaises(helper.LaunchRefused,msg=ref):helper.launch_ref(ref)
    def test_git_minimum_version(self):
        for version,ok in (('2.30.2',False),('2.36.6',False),('2.37.0',True),('2.39.5',True),('2.43.0',True),('2.51.0',True),('3.0.0',True)):
            host=Host(self,git_version=version)
            with patch('helper.launch_watch',side_effect=host.watch):self.assertEqual(helper.launch_git_version(),(version,ok),version)
        self.assertEqual(helper.LAUNCH_GIT_MIN,(2,37,0))

class FetchTests(unittest.TestCase):
    def git_req(self,url='https://git.example.com:8443/o/r.git',**extra):
        return {'source':'git','repo':{'url':url,'ref':'main','composePath':'compose.yaml'},'env':{'DB_PASSWORD':SECRET},**extra}
    def test_https_clone_argv_and_environment_are_exact(self):
        host=Host(self,gate=gate_ok)
        result=host.run('launch-fetch',**self.git_req())
        self.assertTrue(result['ok'],result)
        clone=host.argvs('clone')[0];journal=str(host.launches/LID)
        self.assertEqual(clone['env'],{})
        self.assertEqual(clone['argv'],['env','-i',*GIT_ENV(journal),'git',*GIT_CONFIG,
            '-c','http.curloptResolve=git.example.com:8443:8.8.8.8','clone','--depth','1','--single-branch','--no-recurse-submodules','--branch','main','--','https://git.example.com:8443/o/r.git',str(host.site()/'app')])
        self.assertEqual((clone['timeout'],clone['limit'],clone['folder'],clone['cwd'],clone['journal']),(600,2*1024**3,str(host.site()),journal,True))
        self.assertNotIn('GIT_DIR=',' '.join(clone['argv']),'clone creates its own repository')
        self.assertFalse(any('proxy' in part.lower() for part in clone['argv']))
        self.assertEqual(result['commit'],SHA)
        self.assertEqual(host.journal()['commit'],SHA)
        rev=host.argvs('rev-parse')[0];repo=str(host.site()/'app')
        self.assertEqual(rev['argv'],['env','-i',*GIT_ENV(journal),'GIT_DIR='+repo+os.sep+'.git','git',*GIT_CONFIG,'-C',repo,'rev-parse','HEAD'])
        self.assertEqual((rev['env'],rev['cwd']),({},repo))
        self.assertEqual(list((host.launches/LID/'git-home').iterdir()),[],'HOME stays empty')
        self.assertFalse((host.site()/'app'/'.git').exists(),'.git is removed after the commit is recorded')
    def test_compose_runs_with_explicit_project_files_and_env_file(self):
        host=Host(self,gate=gate_ok);host.run('launch-fetch',**self.git_req())
        config=[c for c in host.calls if 'config' in c['argv']][0]
        site=host.site()
        sandbox=config['argv'][:config['argv'].index('docker')]
        self.assertEqual(sandbox[:5],['unshare','--mount','--propagation','private','--'])
        self.assertEqual(sandbox[6:8],['-I','-c']);self.assertEqual(sandbox[8],helper.LAUNCH_SANDBOX_CODE)
        spec=json.loads(sandbox[9]);self.assertEqual(spec['keep'],[str(site)])
        self.assertTrue({str(host.sites),str(host.launches),'/etc/docknest','/root','/home','/var/lib/docker/volumes'}<=set(spec['hide']))
        compile(helper.LAUNCH_SANDBOX_CODE,'<sandbox>','exec')
        self.assertEqual(config['argv'][len(sandbox):],['docker','compose','-p','shop','-f',str(site/'app'/'compose.yaml'),'--project-directory',str(site/'app'),'--env-file',str(site/'.env'),'config','--format','json'])
        self.assertEqual(config['env']['PATH'],helper.LAUNCH_PATH)
        self.assertFalse(any(k.startswith(('DOCKER_','COMPOSE_FILE','COMPOSE_PROJECT')) for k in config['env']))
        self.assertEqual((site/'.env').read_text(),'DB_PASSWORD="pa\\$\\$ w0rd\\"\'x"\n')
        if os.name=='posix':self.assertEqual(stat.S_IMODE((site/'.env').stat().st_mode),0o600)
    def test_journal_lists_the_site_folder_before_it_exists(self):
        seen=[]
        def on_call(host,argv):
            if 'clone' in argv:seen.append((str(host.site()) in host.journal()['created']['paths'],host.site().exists()))
        host=Host(self,gate=gate_ok,on_call=on_call);host.run('launch-fetch',**self.git_req())
        self.assertEqual(seen,[(True,True)])
    def test_ssh_deploy_key_file_is_private_outside_the_site_and_removed(self):
        files=[]
        def on_call(host,argv):
            if 'clone' in argv:
                command=next(a for a in argv if a.startswith('GIT_SSH_COMMAND='))[len('GIT_SSH_COMMAND='):]
                words=shlex.split(command);key=pathlib.Path(words[-1]);known=pathlib.Path(next(w for w in words if w.startswith('UserKnownHostsFile='))[len('UserKnownHostsFile='):])
                files.append((key,key.read_text(),known.read_text(),stat.S_IMODE(key.stat().st_mode),command,known))
        host=Host(self,gate=gate_ok,on_call=on_call,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',22))])
        result=host.run('launch-fetch',**self.git_req('git@github.com:o/r.git',deployKey={'privateKey':KEY,'hostKeyLine':HOST_LINE}))
        self.assertTrue(result['ok'],result)
        key,content,known,mode,command,known_file=files[0]
        self.assertEqual(content,KEY);self.assertEqual(known,'github.com ssh-ed25519 %s\n'%host_blob())
        self.assertEqual(key.parent,host.launches/LID);self.assertFalse(str(key).startswith(str(host.site())))
        if os.name=='posix':self.assertEqual(mode,0o600)
        self.assertFalse(key.exists(),'the key file is removed after the clone')
        self.assertEqual(shlex.split(command),['ssh','-F','/dev/null','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ProxyCommand=none','-o','ProxyJump=none','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(known_file),'-o','GlobalKnownHostsFile=/dev/null','-o','HostKeyAlias=github.com','-o','CheckHostIP=no','-o','UpdateHostKeys=no','-i',str(key)])
        self.assertFalse(known_file.exists())
        clone=host.argvs('clone')[0]['argv']
        self.assertIn('git@8.8.8.8:o/r.git',clone);self.assertNotIn('-c',clone[clone.index('clone'):])
        self.assertNotIn('SECRETKEYMATERIAL',json.dumps(host.calls)+host.events.getvalue())
        self.assertNotIn('w0rd',json.dumps([c['argv'] for c in host.calls])+host.events.getvalue())
    def test_key_file_is_removed_when_the_clone_fails_or_is_refused(self):
        for fail,repo,code in (({'clone':(128,b'','permission denied (publickey).',None)},None,'AUTH_FAILED'),
                ({'clone':(128,b'','host key verification failed.',None)},None,'HOST_KEY_MISMATCH'),
                ({},{'compose.yaml':'x','.gitmodules':'[submodule "x"]'},'SUBMODULES_REFUSED'),
                ({'clone':(-1,b'','',"size")},None,'REPO_TOO_LARGE'),({'clone':(-1,b'','','timeout')},None,'FETCH_TIMEOUT')):
            kw={'repo':repo} if repo else {}
            host=Host(self,gate=gate_ok,fail=fail,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',22))],**kw)
            result=host.run('launch-fetch',**self.git_req('git@github.com:o/r.git',deployKey={'privateKey':KEY,'hostKeyLine':HOST_LINE}))
            self.assertEqual((result['ok'],result['code']),(False,code))
            self.assertEqual([p for p in (host.launches/LID).iterdir() if p.name.startswith(('key-','known-hosts-'))],[],code)
            self.assertNotIn('SECRETKEYMATERIAL',host.events.getvalue())
    def test_ssh_needs_a_key_and_a_valid_pin(self):
        dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',22))]
        for key,code in ((None,'KEY_REQUIRED'),({'privateKey':'nope','hostKeyLine':HOST_LINE},'KEY_INVALID'),({'privateKey':KEY,'hostKeyLine':'github.com ssh-ed25519 '+host_blob('ssh-rsa')},'HOST_KEY_INVALID')):
            host=Host(self,gate=gate_ok,dns=dns)
            result=host.run('launch-fetch',**self.git_req('git@github.com:o/r.git',**({'deployKey':key} if key else {})))
            self.assertEqual(result['code'],code)
    def test_non_22_port_pins_the_bracketed_alias(self):
        lines=[]
        def on_call(host,argv):
            if 'clone' in argv:
                words=shlex.split(next(a for a in argv if a.startswith('GIT_SSH_COMMAND='))[len('GIT_SSH_COMMAND='):])
                lines.append(pathlib.Path(next(w for w in words if w.startswith('UserKnownHostsFile='))[len('UserKnownHostsFile='):]).read_text());lines.append(words)
        host=Host(self,gate=gate_ok,on_call=on_call,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',2222))])
        host.run('launch-fetch',**self.git_req('ssh://git@git.example.com:2222/o/r.git',deployKey={'privateKey':KEY,'hostKeyLine':'[git.example.com]:2222 ssh-ed25519 '+host_blob()}))
        self.assertTrue(lines[0].startswith('[git.example.com]:2222 ssh-ed25519 '))
        self.assertIn('HostKeyAlias=[git.example.com]:2222',lines[1])
    def test_dns_rebinding_between_check_and_fetch_is_refused(self):
        host=Host(self,gate=gate_ok,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('10.1.2.3',443))])
        result=host.run('launch-fetch',**self.git_req())
        self.assertEqual(result['code'],'URL_PRIVATE');self.assertEqual(host.argvs('clone'),[])
        self.assertFalse(host.site().exists())
    def test_symlink_escape_after_clone_is_refused(self):
        target=tempfile.mkdtemp()
        try:os.symlink(target,os.path.join(target,'probe'))
        except (OSError,NotImplementedError):self.skipTest('symbolic links need privileges here')
        host=Host(self,gate=gate_ok,repo={'compose.yaml':'x','data/link':('link',target)})
        result=host.run('launch-fetch',**self.git_req())
        self.assertEqual(result['code'],'SYMLINK_ESCAPE')
        inside=Host(self,gate=gate_ok,repo={'compose.yaml':'x','data/real.txt':'x','data/link':('link','real.txt')})
        self.assertTrue(inside.run('launch-fetch',**self.git_req())['ok'])
    def test_lfs_and_include_are_refused(self):
        self.assertEqual(Host(self,gate=gate_ok,repo={'compose.yaml':'x','.gitattributes':'*.bin filter=lfs diff=lfs'}).run('launch-fetch',**self.git_req())['code'],'LFS_REFUSED')
        self.assertEqual(Host(self,gate=gate_ok,repo={'compose.yaml':'include:\n  - ../other.yaml\n'}).run('launch-fetch',**self.git_req())['code'],'COMPOSE_INCLUDE_REFUSED')
    def test_monorepo_subfolder_compose_path(self):
        host=Host(self,gate=gate_ok,repo={'deploy/compose.yaml':'x','apps/web/Dockerfile':'FROM node:22\n'},
            model=lambda h:{'services':{'web':{'build':{'context':str(h.site()/'app'/'apps'/'web'),'dockerfile':'Dockerfile'},'expose':['3000']}}})
        req=self.git_req();req['repo']['composePath']='deploy/compose.yaml'
        result=host.run('launch-fetch',**req)
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['services'],[{'name':'web','ports':[3000],'build':True}])
        config=[c for c in host.calls if 'config' in c['argv']][0]['argv']
        self.assertEqual(config[config.index('--project-directory')+1],str(host.site()/'app'/'deploy'))
        for path in ('../x.yaml','/etc/x','-x.yaml','a/../../b'):
            req['repo']['composePath']=path
            self.assertEqual(Host(self,gate=gate_ok).run('launch-fetch',**req)['code'],'COMPOSE_PATH_INVALID',path)
    def test_environment_cannot_steer_compose(self):
        for env in ({'COMPOSE_FILE':'x'},{'DOCKER_HOST':'tcp://x'},{'buildkit_progress':'x'},{'A':'x\ny'},{'A':'x\0'},{'A':'x\r'},{'1A':'x'},{'A':5}):
            host=Host(self,gate=gate_ok)
            result=host.run('launch-fetch',source='compose',composeText='services: {}\n',env=env)
            self.assertEqual(result['code'],'ENV_REFUSED',env);self.assertFalse(host.site().exists())
    def test_existing_site_folder_or_project_is_refused(self):
        host=Host(self,gate=gate_ok);host.site().mkdir(parents=True)
        self.assertEqual(host.run('launch-fetch',source='compose',composeText='services: {}\n')['code'],'SITE_EXISTS')
        host=Host(self,gate=gate_ok,existing={'project':['abc']})
        result=host.run('launch-fetch',source='compose',composeText='services: {}\n')
        self.assertEqual(result['code'],'GATE_REFUSED');self.assertIn({'code':'PROJECT_EXISTS','service':None,'field':'name'},result['gate']['refusals'])
    def test_pasted_compose_is_private_and_the_env_based_image_resolves(self):
        model=lambda h:{'services':{'app':{'image':'ghcr.io/acme/app:1.2','environment':{'DB_PASSWORD':SECRET}}}}
        host=Host(self,gate=gate_ok,model=model)
        result=host.run('launch-fetch',source='compose',composeText='services:\n  app:\n    image: ${IMAGE}\n',env={'IMAGE':'ghcr.io/acme/app:1.2','DB_PASSWORD':SECRET})
        self.assertTrue(result['ok'],result)
        self.assertNotIn('w0rd',host.events.getvalue())
        compose=host.site()/'app'/'compose.yaml'
        if os.name=='posix':self.assertEqual(stat.S_IMODE(compose.stat().st_mode),0o600)
        self.assertIsNone(result['commit'])

class GateTests(unittest.TestCase):
    def test_without_the_safe_edit_gate_the_launch_is_refused(self):
        self.assertFalse(callable(getattr(helper,'edit_gate',None)),'remove this test when 2.15 lands; the lead wires real gate tests')
        result=Host(self).run('launch-fetch',source='compose',composeText='services: {}\n')
        self.assertEqual((result['ok'],result['code']),(False,'GATE_UNAVAILABLE'))
    def test_gate_is_called_with_the_site_folder_as_the_only_before(self):
        calls=[]
        def gate(current,candidate,roots,current_env,candidate_env):
            calls.append((current,candidate,roots));raise Gate('PRIVILEGE_ADDED','services.web.privileged')
        model=lambda h:{'services':{'web':{'image':'x','privileged':True,'build':{'context':str(h.site()/'app')}}}}
        host=Host(self,gate=gate,model=model,repo={'compose.yaml':'x','Dockerfile':'FROM scratch\n'})
        result=host.run('launch-fetch',source='git',repo={'url':'https://github.com/o/r.git'})
        current,candidate,roots=calls[0];site=str(host.site())
        self.assertEqual(current,{'services':{'web':{'volumes':[{'type':'bind','source':site,'target':'/docknest-launch-site'}]}}})
        self.assertNotIn('build',candidate['services']['web']);self.assertEqual(roots,[site])
        self.assertEqual((result['ok'],result['code']),(False,'GATE_REFUSED'))
        self.assertIn({'code':'PRIVILEGE_ADDED','service':'web','field':'services.web.privileged'},result['gate']['refusals'])
    def test_name_collisions_with_other_sites_are_refused(self):
        model=lambda h:{'services':{'db':{'image':'postgres','container_name':'shared-db'}},'volumes':{'db':{'name':'othersite_db'}},'networks':{'default':{'name':'shop_default'}}}
        host=Host(self,gate=gate_ok,model=model,existing={'volumes':['othersite_db'],'containers':['shared-db'],'networks':['bridge']})
        result=host.run('launch-fetch',source='compose',composeText='services: {}\n')
        fields=[r['field'] for r in result['gate']['refusals']]
        self.assertEqual(fields,['containers.shared-db','volumes.othersite_db'])
    def test_ports_must_be_loopback_except_the_web_service(self):
        model=lambda h:{'services':{'web':{'image':'x','ports':[{'target':80,'published':'80','host_ip':''}]},'db':{'image':'y','ports':[{'target':5432,'published':'5432','host_ip':'0.0.0.0'}]},'cache':{'image':'z','ports':[{'target':6379,'published':'6379','host_ip':'127.0.0.1'}]}}}
        result=Host(self,gate=gate_ok,model=model).run('launch-fetch',source='compose',composeText='x: 1\n',webService='web')
        self.assertEqual(result['gate']['refusals'],[{'code':'PORT_NOT_LOOPBACK','service':'db','field':'services.db.ports'}])
        self.assertTrue(Host(self,gate=gate_ok,model=model).run('launch-fetch',source='compose',composeText='x: 1\n')['ok'],'without the web service the rule waits for start')
    def test_env_file_outside_the_site_is_refused(self):
        model=lambda h:{'services':{'web':{'image':'x','env_file':[{'path':'/root/.ssh/id_rsa','required':True}]}}}
        result=Host(self,gate=gate_ok,model=model).run('launch-fetch',source='compose',composeText='x: 1\n')
        self.assertEqual(result['gate']['refusals'][0]['code'],'ENV_FILE_REFUSED')

class BuildTests(unittest.TestCase):
    def build_model(self,build=None,dockerfile='FROM node:22\nRUN npm ci\n',image=None):
        def model(h):
            service={'build':{'context':str(h.site()/'app'),'dockerfile':'Dockerfile',**(build or {})}}
            if image:service['image']=image
            return {'services':{'web':service}}
        return model,{'compose.yaml':'x','Dockerfile':dockerfile}
    def fetched(self,**kw):
        model,repo=self.build_model(**{k:v for k,v in kw.items() if k in ('build','dockerfile','image')})
        host=Host(self,gate=gate_ok,model=model,repo=repo,**{k:v for k,v in kw.items() if k not in ('build','dockerfile','image')})
        return host,host.run('launch-fetch',source='git',repo={'url':'https://github.com/o/r.git'})
    def test_build_allow_list(self):
        for build,field in (({'network':'host'},'network'),({'ssh':['default']},'ssh'),({'secrets':['x']},'secrets'),({'extra_hosts':['a:192.0.2.4']},'extra_hosts'),
                ({'privileged':True},'privileged'),({'entitlements':['network.host']},'entitlements'),({'cache_from':['x']},'cache_from'),
                ({'additional_contexts':{'x':'/etc'}},'additional_contexts'),({'dockerfile_inline':'FROM x'},'dockerfile_inline'),({'args':{'BUILDKIT_SYNTAX':'evil/frontend'}},'args')):
            host,result=self.fetched(build=build)
            self.assertEqual(result['gate']['refusals'],[{'code':'BUILD_SETTING_REFUSED','service':'web','field':'services.web.build.'+field}],build)
        host,result=self.fetched(build={'context':'/etc'})
        self.assertEqual(result['gate']['refusals'][0]['field'],'services.web.build.context')
        host,result=self.fetched(build={'context':'https://github.com/x/y.git'})
        self.assertEqual(result['gate']['refusals'][0]['field'],'services.web.build.context')
        host,result=self.fetched(build={'args':{'NODE_ENV':'production'},'target':'prod','labels':{'a':'b'},'platforms':['linux/amd64']})
        self.assertTrue(result['ok'],result)
    def test_dockerfile_scan(self):
        for text,code in (('FROM x\nRUN --network=host curl x\n','DOCKERFILE_REFUSED'),('FROM x\nRUN --security=insecure id\n','DOCKERFILE_REFUSED'),
                ('FROM x\nRUN --network="host" \\\n  id\n','DOCKERFILE_REFUSED'),('# syntax=evil/frontend:1\nFROM x\n','SYNTAX_REFUSED'),('#Syntax = ghcr.io/x/y\nFROM x\n','SYNTAX_REFUSED')):
            host,result=self.fetched(dockerfile=text)
            self.assertEqual(result['gate']['refusals'][0]['code'],code,text)
        for text in ('# syntax=docker/dockerfile:1.7\nFROM x\n','# syntax=docker.io/docker/dockerfile:1\n# check=error=true\nFROM x\n','FROM x\nRUN --network=none id\n'):
            host,result=self.fetched(dockerfile=text)
            self.assertTrue(result['ok'],text)
    def test_build_uses_a_journalled_pinned_builder_and_always_removes_it(self):
        seen=[]
        def on_call(host,argv):
            if argv[:3]==['docker','buildx','create']:j=host.journal();seen.append((list(j['created']['builders']),list(j['created']['images'])))
        host,_=self.fetched(on_call=on_call)
        host.images={}
        def watch_built(argv,*a,**k):
            if argv[:2]==['docker','compose'] and 'build' in argv:host.images['shop-web']=LID
            return Host.watch(host,argv,*a,**k)
        with patch.object(host,'watch',side_effect=watch_built):result=host.run('launch-build')
        self.assertTrue(result['ok'],result);self.assertEqual(result['images'],['shop-web'])
        builder='docknest-launch-'+LID.replace('-','')[:12]
        self.assertEqual(seen,[([builder],['shop-web'])])
        create=host.argvs('create')[0]['argv']
        self.assertEqual(create,['docker','buildx','create','--name',builder,'--driver','docker-container','--driver-opt','image='+helper.LAUNCH_BUILDKIT_IMAGE,'--bootstrap'])
        self.assertRegex(helper.LAUNCH_BUILDKIT_IMAGE,r'^moby/buildkit:v[0-9.]+@sha256:[0-9a-f]{64}$')
        build=[c for c in host.calls if c['argv'][:2]==['docker','compose'] and 'build' in c['argv']][0]
        self.assertEqual(build['argv'][-3:],['build','--builder',builder]);self.assertEqual(build['timeout'],1800)
        self.assertIn('--env-file',build['argv'])
        override=(host.site()/'compose.docknest-build.yaml').read_text()
        self.assertIn('docknest.launch: "%s"'%LID,override);self.assertIn('image: "shop-web"',override)
        self.assertEqual(host.argvs('rm')[-1]['argv'],['docker','buildx','rm',builder])
    def test_failed_or_slow_build_still_removes_the_builder(self):
        for fail,code in (({' build --builder':(1,b'','error',None)},'BUILD_FAILED'),({' build --builder':(-1,b'','','timeout')},'BUILD_TIMEOUT'),({' build --builder':(1,b'','exec format error',None)},'IMAGE_NO_ARCH')):
            host,_=self.fetched(fail=fail)
            result=host.run('launch-build')
            self.assertEqual(result['code'],code)
            self.assertEqual(host.argvs('rm')[-1]['argv'][:3],['docker','buildx','rm'])
    def test_an_existing_image_tag_is_never_overwritten(self):
        host,_=self.fetched(image='shop-web:1',images={'shop-web:1':None})
        self.assertEqual(host.run('launch-build')['code'],'IMAGE_EXISTS');self.assertEqual(host.argvs('create'),[])
    def test_build_needs_buildx(self):
        host,_=self.fetched();host.tools.discard('buildx')
        self.assertEqual(host.run('launch-build')['code'],'BUILDX_MISSING')

class StartPollTests(unittest.TestCase):
    def fetched(self,**kw):
        host=Host(self,gate=gate_ok,**kw);result=host.run('launch-fetch',source='compose',composeText='x: 1\n')
        self.assertTrue(result['ok'],result);return host
    def test_start_writes_the_override_and_journals_names_before_up(self):
        seen=[]
        def on_call(host,argv):
            if 'up' in argv:seen.append({k:list(v) for k,v in host.journal()['created'].items() if k in ('containers','volumes','networks')})
        host=self.fetched(on_call=on_call)
        result=host.run('launch-start',webService='web',webPort=80,loopbackPort=18080)
        self.assertTrue(result['ok'],result)
        self.assertEqual(seen,[{'containers':['shop-web-1','shop-db-1'],'volumes':['shop_db'],'networks':['shop_default']}])
        override=(host.site()/'compose.docknest.yaml').read_text()
        self.assertIn('  "web":\n    labels:\n      docknest.launch: "%s"\n    ports: !override\n      - "127.0.0.1:18080:80"\n'%LID,override)
        self.assertIn('volumes:\n  "db":\n    labels:\n      docknest.launch: "%s"'%LID,override)
        self.assertIn('networks:\n  "default":\n    labels:',override)
        up=host.argvs('up')[0]['argv']
        self.assertEqual(up[-3:],['up','-d','--no-build']);self.assertEqual(up[:4],['docker','compose','-p','shop'])
    def test_start_refusals(self):
        host=self.fetched(ports=[18080])
        self.assertEqual(host.run('launch-start',webService='web',webPort=80,loopbackPort=18080)['code'],'PORT_IN_USE')
        host=self.fetched()
        self.assertEqual(host.run('launch-start',webService='nope',webPort=80,loopbackPort=18080)['code'],'WEB_SERVICE_INVALID')
        host=self.fetched(fail={' up -d':(1,b'','no matching manifest for linux/arm64/v8',None)})
        self.assertEqual(host.run('launch-start',webService='web',webPort=80,loopbackPort=18080)['code'],'IMAGE_NO_ARCH')
        host=Host(self,gate=gate_ok)
        self.assertEqual(host.run('launch-start',webService='web',webPort=80,loopbackPort=18080)['code'],'NOT_FETCHED')
    def container(self,cid,service,running=True,health=None,exit_code=0,started='2020-01-01T00:00:00.1Z',restarts=0):
        state={'Running':running,'Restarting':False,'ExitCode':exit_code,'StartedAt':started}
        if health:state['Health']={'Status':health}
        return {'Id':cid,'State':state,'RestartCount':restarts,'Config':{'Labels':{'com.docker.compose.service':service}}}
    def poll(self,containers,status=200):
        host=Host(self,existing={'own_containers':[c['Id'] for c in containers]},containers=containers).start_journal(web={'service':'web'})
        probe=patch('helper.loopback_probe',return_value=(status,b'')) if isinstance(status,int) else patch('helper.loopback_probe',side_effect=ConnectionRefusedError())
        with probe:return host.run('launch-poll',loopbackPort=18080,domain='shop.example.com')
    def test_poll_is_one_look(self):
        now=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        self.assertEqual(self.poll([self.container('a','web')])['state'],'passed')
        self.assertEqual(self.poll([self.container('a','web',started=now)])['reason'],'SETTLING')
        self.assertEqual(self.poll([self.container('a','web',health='starting')])['state'],'waiting')
        self.assertEqual(self.poll([self.container('a','web',health='unhealthy')])['state'],'failed')
        self.assertEqual(self.poll([self.container('a','web'),self.container('b','migrate',running=False)])['state'],'passed')
        self.assertEqual(self.poll([self.container('a','web',running=False,exit_code=1)])['reason'],'SERVICE_STOPPED')
        self.assertEqual(self.poll([self.container('a','web',restarts=3)])['reason'],'CRASH_LOOP')
        self.assertEqual(self.poll([self.container('a','web')],status=None)['reason'],'NO_ANSWER')
        self.assertEqual(self.poll([self.container('a','web')],status=502)['reason'],'HTTP_ERROR')
        self.assertEqual(self.poll([self.container('a','web')],status=404)['state'],'passed')
        self.assertEqual(self.poll([])['reason'],'NO_CONTAINERS')

NGINX_BASE='# configuration file /etc/nginx/nginx.conf:\nevents {}\nhttp { include /etc/nginx/conf.d/*.conf; }\n'
def dump(*blocks):return NGINX_BASE+''.join('# configuration file /etc/nginx/conf.d/f%d.conf:\n%s\n'%(i,b) for i,b in enumerate(blocks))
class NginxTests(unittest.TestCase):
    def conflicts(self,text,names=('shop.example.com','www.shop.example.com')):
        host=Host(self,nginx_dump=text)
        with patch('helper.launch_watch',side_effect=host.watch):return helper.launch_nginx_conflicts(list(names))
    def test_conflicts(self):
        self.assertEqual(self.conflicts(dump('server { listen 80; server_name shop.example.com; }')),[{'name':'shop.example.com','kind':'exact'}])
        self.assertEqual(self.conflicts(dump('server { listen 80; server_name *.example.com; }'))[0]['kind'],'wildcard')
        self.assertEqual(self.conflicts(dump('server { server_name .shop.example.com; }'))[0]['kind'],'wildcard')
        self.assertEqual(self.conflicts(dump('server { server_name www.shop.*; }'))[0]['kind'],'wildcard')
        self.assertEqual(self.conflicts(dump('server { server_name "~^(?<sub>.+)\\.example\\.com$"; }'))[0]['kind'],'regex')
        self.assertEqual(self.conflicts(dump('server { server_name "~^(?<bad"; }'))[0]['kind'],'regex','an unreadable regex counts as a conflict')
        self.assertEqual(self.conflicts(dump('server { listen 80 default_server; server_name shop.example.com; }'))[0]['kind'],'default')
        self.assertEqual(self.conflicts(dump('server { listen 80 default_server; server_name _; root /var/www/html; }')),[],'the stock catch-all does not serve the domain once an exact name exists')
        self.assertEqual(self.conflicts(dump('server { server_name other.example.com; location / { proxy_pass http://x; } }','stream { server { listen 5000; } }','upstream u { server 127.0.0.1:1; }')),[])
        self.assertEqual(self.conflicts(dump('# server_name shop.example.com;\nserver { server_name a.example.com; }')),[])
    def test_unreadable_configuration_is_refused(self):
        host=Host(self,fail={'nginx -T':(1,b'','emerg',None)})
        with patch('helper.launch_watch',side_effect=host.watch):
            with self.assertRaises(helper.LaunchRefused) as caught:helper.launch_nginx_conflicts(['shop.example.com'])
        self.assertEqual(caught.exception.code,'NGINX_UNREADABLE')
    def test_web_refuses_an_existing_vhost_and_writes_its_own_file(self):
        host=Host(self,nginx_dump=dump('server { server_name shop.example.com; }')).start_journal()
        self.assertEqual(host.run('launch-web',domain='shop.example.com',loopbackPort=18080)['code'],'NGINX_DOMAIN_SERVED')
        self.assertEqual(list(host.conf.iterdir()),[])
        host=Host(self).start_journal()
        result=host.run('launch-web',domain='shop.example.com',www=True,loopbackPort=18080)
        self.assertTrue(result['ok'],result)
        text=(host.conf/'docknest-shop.conf').read_text()
        self.assertTrue(text.startswith('# Managed by DockNest launch %s;'%LID))
        self.assertIn('server_name shop.example.com www.shop.example.com;',text);self.assertIn('proxy_pass http://127.0.0.1:18080;',text)
        self.assertEqual(host.journal()['created']['nginx'],[str(host.conf/'docknest-shop.conf')])
        # A retry of the same step skips its own file when it reads nginx -T.
        own=dump('').replace('f0.conf','docknest-shop.conf').replace(':\n\n',':\n'+text+'\n')
        host.nginx_dump=own;host.events=io.StringIO()
        self.assertTrue(host.run('launch-web',domain='shop.example.com',loopbackPort=18080)['ok'])
    def test_failed_nginx_test_removes_the_file(self):
        host=Host(self,fail={'nginx -t':(1,b'','',None)}).start_journal()
        self.assertEqual(host.run('launch-web',domain='shop.example.com',loopbackPort=18080)['code'],'NGINX_TEST_FAILED')
        self.assertFalse((host.conf/'docknest-shop.conf').exists())
    def test_foreign_file_with_our_name_is_never_replaced(self):
        host=Host(self).start_journal();(host.conf/'docknest-shop.conf').write_text('server {}\n')
        self.assertEqual(host.run('launch-web',domain='shop.example.com',loopbackPort=18080)['code'],'NGINX_FILE_EXISTS')

class CertificateTests(unittest.TestCase):
    def webbed(self,**kw):
        host=Host(self,**kw).start_journal();self.assertTrue(host.run('launch-web',domain='shop.example.com',loopbackPort=18080)['ok']);host.events=io.StringIO()
        (host.le/'accounts').mkdir(parents=True);return host
    def test_issue_uses_the_launch_cert_name_and_journals_it_first(self):
        seen=[]
        def on_call(host,argv):
            if argv[0]=='certbot':seen.append(list(host.journal()['created']['certificates']))
        host=self.webbed(on_call=on_call,dns=lambda h:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('203.0.113.10',0))])
        result=host.run('launch-certificate',domain='shop.example.com')
        self.assertEqual(result['state'],'issued',result)
        certbot=host.argvs('certbot')[0]['argv']
        self.assertEqual(certbot,['certbot','certonly','--webroot','-w',str(host.acme/('launch-'+LID)),'--non-interactive','--keep-until-expiring','--cert-name','docknest-shop','-d','shop.example.com'])
        self.assertEqual(seen,[[{'name':'docknest-shop'}]])
        self.assertIn('listen 443 ssl;',(host.conf/'docknest-shop.conf').read_text())
    def test_dns_wildcard_rate_limit_and_lineages(self):
        public=lambda h:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('203.0.113.10',0))]
        host=self.webbed(dns=lambda h:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('1.1.1.1',0))])
        result=host.run('launch-certificate',domain='shop.example.com')
        self.assertEqual((result['state'],result['code']),('dns_waiting','DNS_WAITING'));self.assertEqual(host.argvs('certbot'),[])
        host=self.webbed(dns=lambda h:[(socket.AF_INET6,socket.SOCK_STREAM,6,'',('2001:db8::10',0,0,0))],addresses=['2001:db8::10'])
        self.assertEqual(host.run('launch-certificate',domain='shop.example.com')['state'],'issued','IPv6-only DNS')
        host=self.webbed(dns=public,fail={'certbot':(1,b'','too many certificates already issued',None)})
        self.assertEqual(host.run('launch-certificate',domain='shop.example.com')['code'],'RATE_LIMITED')
        host=self.webbed(dns=public,fail={'certbot':(1,b'','caa record prevents issuance',None)})
        self.assertEqual(host.run('launch-certificate',domain='shop.example.com')['code'],'CAA_REFUSED')
        host=self.webbed(dns=public)
        with patch('helper.launch_lineages',return_value=[{'name':'old','domains':['*.shop.example.com']}]):
            self.assertEqual(host.run('launch-certificate',domain='shop.example.com',www=True)['code'],'CERT_LINEAGE_EXISTS')
        host=self.webbed(dns=public)
        with patch('helper.launch_lineages',return_value=[{'name':'docknest-shop','domains':[]}]):
            self.assertEqual(host.run('launch-certificate',domain='shop.example.com')['code'],'CERT_LINEAGE_EXISTS')
        host=self.webbed(dns=public);(host.le/'accounts').rmdir()
        self.assertEqual(host.run('launch-certificate',domain='shop.example.com')['code'],'NO_ACCOUNT_EMAIL')
        host=self.webbed(dns=public);(host.le/'accounts').rmdir()
        self.assertEqual(host.run('launch-certificate',domain='shop.example.com',email='me@example.com')['state'],'issued')
        self.assertEqual(host.argvs('certbot')[0]['argv'][-4:],['--agree-tos','--no-eff-email','--email','me@example.com'])
        host=self.webbed(dns=public,tools={'nginx','docker'})
        self.assertEqual(host.run('launch-certificate',domain='shop.example.com')['code'],'CERTBOT_MISSING')

class TeardownTests(unittest.TestCase):
    def launched(self):
        host=Host(self,gate=gate_ok)
        self.assertTrue(host.run('launch-fetch',source='compose',composeText='x: 1\n')['ok'])
        self.assertTrue(host.run('launch-start',webService='web',webPort=80,loopbackPort=18080)['ok'])
        self.assertTrue(host.run('launch-web',domain='shop.example.com',loopbackPort=18080)['ok'])
        j=host.journal();j['created']['images'].append('shop-web');j['created']['builders'].append('docknest-launch-x');j['created']['certificates'].append({'name':'docknest-shop'})
        (host.launches/LID/'journal.json').write_text(json.dumps(j))
        (host.le/'live'/'docknest-shop').mkdir(parents=True)
        return host
    def test_teardown_is_journal_and_label_gated_and_idempotent(self):
        host=self.launched();host.calls=[]
        host.existing={'own_containers':['c1','c2'],'own_volumes':[],'volumes':['shop_db'],'own_networks':['shop_default'],'builder':True}
        host.images={'shop-web':LID}
        result=host.run('launch-teardown',keepBackup=True)
        self.assertTrue(result['ok'],result);self.assertEqual(result['left'],[]);self.assertTrue(result['keepBackup'])
        argvs=[c['argv'] for c in host.calls]
        self.assertIn(['docker','rm','-f','-v','c1','c2'],argvs)
        self.assertIn(['docker','network','rm','shop_default'],argvs)
        self.assertNotIn(['docker','volume','rm','shop_db'],argvs,'an unlabelled volume of the same name is never removed')
        self.assertIn(['docker','image','rm','shop-web'],argvs)
        self.assertFalse(any(a[:3]==['docker','image','rm'] and '-f' in a for a in argvs),'never -f on images')
        self.assertIn(['certbot','delete','--cert-name','docknest-shop','--non-interactive'],argvs)
        self.assertIn(['docker','buildx','rm','docknest-launch-x'],argvs)
        self.assertFalse(host.site().exists());self.assertFalse((host.conf/'docknest-shop.conf').exists());self.assertFalse((host.launches/LID).exists())
        host.events=io.StringIO()
        again=host.run('launch-teardown',keepBackup=True)
        self.assertEqual(again,{'ok':True,'removed':[],'left':[],'nothingToDo':True,'keepBackup':True})
    def test_teardown_keeps_what_is_not_ours(self):
        host=self.launched()
        (host.conf/'docknest-shop.conf').write_text('# someone else\n')
        host.images={'shop-web':'another-launch'}
        host.existing={'own_containers':[],'own_volumes':['shop_db'],'own_networks':[]}
        host.calls=[];result=host.run('launch-teardown',keepBackup=True)
        argvs=[c['argv'] for c in host.calls]
        self.assertTrue((host.conf/'docknest-shop.conf').exists())
        self.assertNotIn(['docker','image','rm','shop-web'],argvs)
        self.assertIn({'kind':'image-not-ours','name':'shop-web'},result['left'])
        self.assertIn(['docker','volume','rm','shop_db'],argvs)
        self.assertTrue((host.launches/LID/'journal.json').is_file(),'the journal stays while anything is left')
    def test_certbot_lineage_not_journalled_is_never_deleted(self):
        host=self.launched();j=host.journal();j['created']['certificates']=[];(host.launches/LID/'journal.json').write_text(json.dumps(j))
        host.calls=[];host.run('launch-teardown',keepBackup=True)
        self.assertEqual(host.argvs('certbot'),[])
    def test_status_lists_what_is_left(self):
        host=self.launched();host.events=io.StringIO()
        host.existing={'own_containers':[],'own_volumes':[],'own_networks':[]}
        result=host.run('launch-status')
        self.assertEqual(result['phase'],'web')
        kinds={item['kind'] for item in result['present']}
        self.assertTrue({'path','nginx','certificate'}<=kinds,result)
        empty=Host(self).run('launch-status')
        self.assertEqual(empty,{'ok':True,'journal':False,'present':[],'phase':None})

class FactsTests(unittest.TestCase):
    def test_facts_for_a_server_without_docker(self):
        host=Host(self,tools={'nginx'},git_version='2.36.6')
        result=host.run('launch-facts',source='git',domain='shop.example.com',repo={'url':'https://github.com/o/r.git'})
        checks={c['id']:c for c in result['checks']}
        self.assertEqual((checks['docker']['ok'],checks['docker']['code'],checks['docker']['install']),(False,'DOCKER_MISSING','docker'))
        self.assertEqual(checks['compose']['code'],'COMPOSE_TOOL_MISSING')
        self.assertEqual(checks['gitVersion']['code'],'GIT_TOO_OLD')
        self.assertEqual(checks['certbot']['install'],'certbot')
        self.assertFalse(result['tools']['docker']);self.assertEqual(result['versions']['gitMinimum'],'2.37.0')
        self.assertEqual(result['usedPorts'],[])
        self.assertEqual(Host(self,ports=[443,22,80]).run('launch-facts',source='compose',domain='shop.example.com')['usedPorts'],[22,80,443])
    def test_facts_with_ls_remote_and_a_wildcard_vhost(self):
        host=Host(self,nginx_dump=dump('server { server_name *.example.com; }'))
        result=host.run('launch-facts',source='git',domain='shop.example.com',repo={'url':'https://github.com/o/r.git','ref':'main'})
        self.assertTrue(result['ok'],result);self.assertEqual(result['refHead'],SHA)
        checks={c['id']:c for c in result['checks']}
        self.assertEqual(checks['nginxDomain']['code'],'NGINX_DOMAIN_SERVED');self.assertTrue(checks['repo']['ok'])
        self.assertEqual(result['nginxDomains'],[{'name':'*.example.com','kind':'wildcard'}])
        call=host.argvs('ls-remote')[0];ls=call['argv'];check=call['cwd']
        self.assertEqual(ls,['env','-i',*GIT_ENV(check),'git',*GIT_CONFIG,'-c','http.curloptResolve=github.com:443:8.8.8.8','ls-remote','--','https://github.com/o/r.git','refs/heads/main','refs/tags/main','refs/tags/main^{}'])
        self.assertEqual(call['env'],{});self.assertTrue(pathlib.PurePath(check).name.startswith('check-'))
        self.assertEqual([p.name for p in host.launches.iterdir()],[],'the check folder is removed')
    def test_facts_reports_a_private_repo_without_failing(self):
        host=Host(self,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('192.168.1.20',443))])
        result=host.run('launch-facts',source='git',domain='shop.example.com',repo={'url':'https://gitea.lan/o/r.git'})
        self.assertEqual({c['id']:c for c in result['checks']}['repo']['code'],'URL_PRIVATE')
        host=Host(self,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('192.168.1.20',443))])
        result=host.run('launch-facts',source='git',domain='shop.example.com',repo={'url':'https://gitea.lan/o/r.git','allowPrivate':True})
        self.assertTrue({c['id']:c for c in result['checks']}['repo']['ok'])
    def test_pasted_compose_services(self):
        host=Host(self)
        result=host.run('launch-facts',source='compose',domain='shop.example.com',composeText='services: {}\n')
        self.assertEqual([s['name'] for s in result['services']],['web','db'])
        self.assertEqual(result['services'][0]['ports'],[80])
        self.assertEqual([p.name for p in host.launches.iterdir()],[])
    def test_host_key_is_read_not_trusted(self):
        blob=host_blob();rsa=host_blob('ssh-rsa')
        host=Host(self,keyscan='8.8.8.8 ssh-rsa %s\n8.8.8.8 ssh-ed25519 %s\n'%(rsa,blob),dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',22))])
        result=host.run('launch-host-key',gitHost='github.com')
        self.assertEqual(result['hostKeyLine'],'github.com ssh-ed25519 '+blob)
        self.assertEqual(result['sha256'],'SHA256:'+base64.b64encode(hashlib.sha256(base64.b64decode(blob)).digest()).decode().rstrip('='))
        call=host.argvs('ssh-keyscan')[0]
        self.assertEqual((call['argv'][:2],call['env']),(['env','-i'],{}))
        self.assertEqual(call['argv'][-7:],['-T','10','-p','22','-t','ed25519,ecdsa,rsa','8.8.8.8'])
        host=Host(self,keyscan='',dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',2222))])
        self.assertEqual(host.run('launch-host-key',gitHost='git.example.com:2222')['code'],'CONNECT_FAILED')
        self.assertEqual(Host(self).run('launch-host-key',gitHost='169.254.169.254')['code'],'REFUSED_ADDRESS')
        self.assertEqual(Host(self).run('launch-host-key',gitHost='-oProxyCommand=x')['code'],'REFUSED_ADDRESS')
        self.assertEqual(Host(self,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('10.0.0.4',22))]).run('launch-host-key',gitHost='gitea.lan')['code'],'PRIVATE_ADDRESS')
        self.assertEqual(Host(self,dns=None).run('launch-host-key',gitHost='nowhere.example')['code'],'DNS_FAILED')
        blob=host_blob()
        host=Host(self,keyscan='[8.8.8.8]:2222 ssh-ed25519 %s\n'%blob,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('10.0.0.4',2222))])
        self.assertEqual(host.run('launch-host-key',gitHost='[2606:4700::1]:2222',allowPrivate=True)['hostKeyLine'],'[2606:4700::1]:2222 ssh-ed25519 '+blob)

class ReviewTests(unittest.TestCase):
    """Fixes from the #172 review."""
    def test_syntax_directives_in_every_form(self):
        for text in ('//syntax=evil/frontend\nFROM x\n','// syntax = evil/x\nFROM x\n','{"syntax":"evil/frontend"}\n','["FROM x"]\n',
                'FROM x\n# syntax=evil/frontend\n','  #SYNTAX=ghcr.io/x/y\nFROM x\n'):
            path=pathlib.Path(tempfile.mkdtemp())/'Dockerfile';path.write_text(text)
            self.assertEqual(helper.launch_dockerfile_problem(str(path)),'SYNTAX_REFUSED',text)
    def test_run_flags_are_an_allow_list(self):
        for text,problem in (('FROM x\nRUN --network=none id\n',None),('FROM x\nRUN --network=default id\n',None),('FROM x\nRUN --security=sandbox id\n',None),
                ('FROM x\nRUN --network=bridge id\n','DOCKERFILE_REFUSED'),('FROM x\nRUN --network=$NET id\n','DOCKERFILE_REFUSED'),('FROM x\nRUN --network=${N:-host} id\n','DOCKERFILE_REFUSED'),
                ('FROM x\nRUN --security=insecure id\n','DOCKERFILE_REFUSED'),('FROM x\nRUN --network host id\n','DOCKERFILE_REFUSED'),('FROM x\nRUN --network-alias=x --security-opt=y id\n',None)):
            path=pathlib.Path(tempfile.mkdtemp())/'Dockerfile';path.write_text(text)
            self.assertEqual(helper.launch_dockerfile_problem(str(path)),problem,text)
    def test_built_images_stay_in_the_launch_namespace(self):
        for image,ok in (('shop-web',True),('shop_web:1.2',True),('shop/web:latest',True),('shop-web/api',True),('postgres:16',False),('nginx',False),
                ('shop',False),('shopweb',False),('docker.io/shop-web',False),('shop-web@sha256:'+'a'*64,False),('localhost/shop-web',False),('shop.io/x',False),('shop-x:Bad',False)):
            self.assertEqual(helper.launch_image_ours(image,'shop'),ok,image)
        def model(h):return {'services':{'db':{'image':'postgres:16','build':{'context':str(h.site()/'app')}}}}
        result=Host(self,gate=gate_ok,model=model,repo={'compose.yaml':'x','Dockerfile':'FROM x\n'}).run('launch-fetch',source='git',repo={'url':'https://github.com/o/r.git'})
        self.assertEqual(result['gate']['refusals'],[{'code':'BUILD_IMAGE_REFUSED','service':'db','field':'services.db.build.image'}])
    def test_compose_text_rules(self):
        cases={'include:\n  - x.yaml\n':'COMPOSE_INCLUDE_REFUSED','services:\n  a:\n    extends:\n      file: ../x.yaml\n      service: b\n':'COMPOSE_EXTENDS_REFUSED',
            'services: {a: {extends: b}}\n':'COMPOSE_EXTENDS_REFUSED','{"services": {}}\n':'COMPOSE_FLOW_REFUSED','# c\n---\n{services: {}}\n':'COMPOSE_FLOW_REFUSED',
            '"include": [x.yaml]\n':'COMPOSE_INCLUDE_REFUSED','services:\n  a:\n    image: x\n    environment:\n      MYINCLUDE: 1\n':None}
        for text,code in cases.items():self.assertEqual(helper.launch_compose_text_problem(text.encode()),code,text)
    def test_refused_addresses_match_the_alert_policy(self):
        ip=helper.ipaddress.ip_address
        for value in ('168.63.129.16','100.100.100.100','fd00:ec2::1','0.1.2.3','192.0.2.5','198.51.100.1','203.0.113.9','192.88.99.1','2001:db8::1','fe80::1'):
            self.assertEqual(helper.launch_ip_problem(ip(value),True),'URL_METADATA',value)
        self.assertEqual(helper.launch_ip_problem(ip('fec0::1'),False),'URL_PRIVATE')
        self.assertIsNone(helper.launch_ip_problem(ip('fec0::1'),True))
        self.assertIsNone(helper.launch_ip_problem(ip('8.8.8.8'),False))
    def test_ipv6_host_on_port_22_uses_the_bare_address(self):
        target=helper.launch_git_target(helper.launch_git_url('git@[2606:4700::1111]:o/r.git'),False)
        self.assertEqual((target['alias'],target['url']),('2606:4700::1111','git@[2606:4700::1111]:o/r.git'))
        host=Host(self,keyscan='2606:4700::1111 ssh-ed25519 %s\n'%host_blob())
        self.assertEqual(host.run('launch-host-key',gitHost='[2606:4700::1111]')['hostKeyLine'],'2606:4700::1111 ssh-ed25519 '+host_blob())
    def test_a_key_pinned_for_another_name_is_refused(self):
        host=Host(self,gate=gate_ok,dns=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('8.8.8.8',2222))])
        result=host.run('launch-fetch',source='git',repo={'url':'ssh://git@git.example.com:2222/o/r.git'},deployKey={'privateKey':KEY,'hostKeyLine':'git.example.com ssh-ed25519 '+host_blob()})
        self.assertEqual(result['code'],'HOST_KEY_MISMATCH');self.assertEqual(host.argvs('clone'),[])
    def test_rw_binds_over_the_env_or_compose_file_are_refused(self):
        def model(bind,read_only=False):
            return lambda h:{'services':{'web':{'image':'x','volumes':[{'type':'bind','source':bind(h),'target':'/data','read_only':read_only}]}}}
        for bind in (lambda h:str(h.site()),lambda h:str(h.site()/'app'),lambda h:str(h.site()/'.env')):
            result=Host(self,gate=gate_ok,model=model(bind)).run('launch-fetch',source='compose',composeText='x: 1\n')
            self.assertEqual(result['gate']['refusals'],[{'code':'BIND_COVERS_SECRETS','service':'web','field':'services.web.volumes'}])
        self.assertTrue(Host(self,gate=gate_ok,model=model(lambda h:str(h.site()),True)).run('launch-fetch',source='compose',composeText='x: 1\n')['ok'])
        self.assertTrue(Host(self,gate=gate_ok,model=model(lambda h:str(h.site()/'app'/'data'))).run('launch-fetch',source='compose',composeText='x: 1\n')['ok'])
    def test_gate_field_keeps_only_service_and_setting(self):
        def gate(*a):raise Gate('PATH_REFUSED','services.web.volumes./etc/shadow')
        result=Host(self,gate=gate).run('launch-fetch',source='compose',composeText='x: 1\n')
        self.assertIn({'code':'PATH_REFUSED','service':'web','field':'services.web.volumes'},result['gate']['refusals'])
    def test_stale_check_folders_are_removed(self):
        host=Host(self);old=host.launches/'check-old';new=host.launches/'check-new';old.mkdir(parents=True);new.mkdir();(old/'key-x').write_text('k')
        os.utime(old,(time.time()-3600,time.time()-3600))
        host.run('launch-status')
        self.assertFalse(old.exists());self.assertTrue(new.exists())
    def test_recorded_process_groups_are_ended_by_teardown_and_status(self):
        killed=[]
        host=Host(self).start_journal(children=[{'pgid':4242,'start':77}],created={'paths':[]})
        with patch('helper.launch_proc_start',return_value=77),patch('helper.os.killpg',side_effect=lambda pid,sig:killed.append(pid),create=True):
            result=host.run('launch-status')
        self.assertEqual((killed,result['killed'],result['resumable']),([4242],1,False),'a cut-off step is never resumed')
        self.assertEqual(host.journal()['children'],[])
        host=Host(self).start_journal(children=[{'pgid':4242,'start':77}])
        with patch('helper.launch_proc_start',return_value=99),patch('helper.os.killpg',side_effect=lambda pid,sig:killed.append(pid),create=True):
            host.run('launch-teardown')
        self.assertEqual(killed,[4242],'a reused process number is never signalled')
    def test_watch_records_the_group_while_it_runs(self):
        folder=pathlib.Path(tempfile.mkdtemp());journal={'children':[]};seen=[]
        with patch('helper.launch_save',side_effect=lambda d,j:seen.append(list(j['children']))):
            code,out,_,_=helper.launch_watch([sys.executable,'-c','print(1)'],dict(os.environ),30,journal=(folder,journal))
        self.assertEqual(code,0);self.assertEqual(len(seen[0]),1);self.assertEqual(seen[-1],[]);self.assertEqual(journal['children'],[])
    def test_start_reports_names_and_files_and_status_says_resumable(self):
        host=Host(self,gate=gate_ok);host.run('launch-fetch',source='compose',composeText='x: 1\n')
        result=host.run('launch-start',webService='web',webPort=80,loopbackPort=18080)
        self.assertEqual(result['containerNames'],['shop-web-1','shop-db-1'])
        self.assertEqual(result['composeFiles'],[str(host.site()/'app'/'compose.yaml'),str(host.site()/'compose.docknest.yaml')])
        host.existing={'own_containers':[],'own_volumes':[],'own_networks':[]}
        self.assertEqual(host.run('launch-status')['resumable'],['check_health','web'])
    def test_facts_paste_gate_and_ip_listen_warning(self):
        host=Host(self,gate=gate_ok,nginx_dump=dump('server { listen 192.0.2.10:80; server_name other.example.com; }','server { listen 80; listen [::]:443 ssl; }'),model=lambda h:{**default_model(h.root),'name':'wp'})
        result=host.run('launch-facts',source='compose',domain='shop.example.com',composeText='services: {}\n')
        self.assertEqual(result['gate'],{'ok':True,'refusals':[]});self.assertEqual(result['composeName'],'wp')
        self.assertEqual(result['warnings'],[{'code':'NGINX_IP_LISTEN','listen':'192.0.2.10:80'}])
        nogate=Host(self).run('launch-facts',source='compose',domain='shop.example.com',composeText='services: {}\n')
        self.assertEqual(nogate['gate']['refusals'][0]['code'],'GATE_UNAVAILABLE')
    def test_unreadable_lineages_count_as_conflicts(self):
        host=Host(self);(host.le/'live'/'old').mkdir(parents=True)
        with patch('helper.LETSENCRYPT',host.le),patch('helper.ssl._ssl._test_decode_cert',None,create=True):
            self.assertEqual(helper.launch_lineage_conflicts(['shop.example.com'],'docknest-shop'),[{'name':'old','domains':[]}])
    def test_certbot_uses_the_names_nginx_serves(self):
        host=Host(self,dns=lambda h:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('203.0.113.10',0))]).start_journal()
        self.assertTrue(host.run('launch-web',domain='shop.example.com',www=True,loopbackPort=18080)['ok']);(host.le/'accounts').mkdir(parents=True)
        self.assertEqual(host.run('launch-certificate',domain='shop.example.com')['state'],'issued')
        self.assertEqual(host.argvs('certbot')[0]['argv'][-4:],['-d','shop.example.com','-d','www.shop.example.com'])
    def test_compose_bypasses_from_the_178_review(self):
        cases={'? include\n: [o.yaml]\n':'COMPOSE_SYNTAX_REFUSED','"\\x69nclude": [o.yaml]\n':'COMPOSE_SYNTAX_REFUSED','"include": [o.yaml]\n':'COMPOSE_INCLUDE_REFUSED',
            'services:\n  a:\n    "extends": {file: /etc/x.yaml, service: b}\n':'COMPOSE_EXTENDS_REFUSED','"inc\\\nlude": [o.yaml]\n':'COMPOSE_SYNTAX_REFUSED',
            '%YAML 1.2\n---\n{include: [o.yaml]}\n':'COMPOSE_SYNTAX_REFUSED','"include"\n  : [o.yaml]\n':'COMPOSE_INCLUDE_REFUSED',
            'x: &k include\n*k : [o.yaml]\n':'COMPOSE_SYNTAX_REFUSED','!!binary aW5jbHVkZQ==: [o.yaml]\n':'COMPOSE_SYNTAX_REFUSED',"'inc\nlude': [o.yaml]\n":'COMPOSE_SYNTAX_REFUSED',
            '{services: {a: {? extends : b}}}\n':'COMPOSE_SYNTAX_REFUSED',
            'services:\n  web:\n    image: nginx\n    ports: !override\n      - "127.0.0.1:8080:80"\n    command: ["sh","-c","echo \\"hi\\""]\n':None}
        for text,code in cases.items():self.assertEqual(helper.launch_compose_text_problem(text.encode()),code,text)
        self.assertEqual(helper.launch_compose_text_problem(b'services: {}\n\xff\n'),'COMPOSE_SYNTAX_REFUSED')
    def test_compose_bypasses_from_the_second_178_recheck(self):
        cases={'x-e: &e {file: other.yml, service: base}\nservices:\n  a: {image: alpine, "extends":*e}\n':'COMPOSE_EXTENDS_REFUSED',
            "x-e: &e {file: other.yml, service: base}\nservices:\n  a: {image: alpine, 'extends':*e}\n":'COMPOSE_EXTENDS_REFUSED',
            'services:\n  a: {image: alpine, "extends":!!map {file: other.yml, service: base}}\n':'COMPOSE_EXTENDS_REFUSED',
            'services:\n  a: {image: alpine, "extends":&q {file: other.yml, service: base}}\n':'COMPOSE_EXTENDS_REFUSED',
            '--- {"include":!!seq [other.yml], "services": {a: {image: alpine}}}\n':'COMPOSE_INCLUDE_REFUSED',
            '--- {"x-i": &i [other.yml], "include":*i, "services": {a: {image: alpine}}}\n':'COMPOSE_INCLUDE_REFUSED'}
        for text,code in cases.items():self.assertEqual(helper.launch_compose_text_problem(text.encode()),code,text)
        for text in ('--- {"services": {a: {image: alpine}}}\n','--- !!map {services: {}}\n','---\n&a {services: {}}\n'):
            self.assertEqual(helper.launch_compose_text_problem(text.encode()),'COMPOSE_FLOW_REFUSED',text)
    def test_compose_plugin_folders_are_bound_back_but_not_docker_config(self):
        config=pathlib.Path(tempfile.mkdtemp());(config/'cli-plugins').mkdir();(config/'config.json').write_text('{}')
        with patch.dict(os.environ,{'DOCKER_CONFIG':str(config)}):
            host=Host(self,gate=gate_ok);self.assertTrue(host.run('launch-fetch',source='compose',composeText='x: 1\n')['ok'])
        argv=[c for c in host.calls if 'config' in c['argv']][0]['argv']
        spec=json.loads(argv[argv.index('docker')-1])
        self.assertEqual(spec['keep'],[str(host.site()),str(config/'cli-plugins')])
        self.assertNotIn(str(config),spec['keep']);self.assertIn('/root',spec['hide'])
    def test_compose_config_without_a_sandbox_is_refused(self):
        host=Host(self,gate=gate_ok);host.tools.discard('unshare')
        self.assertEqual(host.run('launch-fetch',source='compose',composeText='x: 1\n')['code'],'SANDBOX_UNAVAILABLE')
        host=Host(self,gate=gate_ok,fail={' config ':(97,b'','',None)})
        self.assertEqual(host.run('launch-fetch',source='compose',composeText='x: 1\n')['code'],'SANDBOX_UNAVAILABLE')
    def test_certificate_resets_the_maintenance_setup(self):
        site='7c9e6679-7425-40de-944b-e07fc1f90ae7'
        host=Host(self,dns=lambda h:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('203.0.113.10',0))]).start_journal()
        mroot=host.root/'maintenance';(mroot/site).mkdir(parents=True);(mroot/site/'ready').write_text('')
        self.assertTrue(host.run('launch-web',domain='shop.example.com',loopbackPort=18080)['ok']);(host.le/'accounts').mkdir(parents=True)
        with patch('helper.LAUNCH_MAINTENANCE_ROOT',mroot):
            for bad in (str(mroot),str(mroot/'x'),str(mroot/site/'..'/site),'/etc/'+site,str(host.root/'other'/site),5):
                self.assertEqual(host.run('launch-certificate',domain='shop.example.com',maintenanceDirectory=bad)['code'],'INVALID_REQUEST',bad)
            self.assertTrue((mroot/site/'ready').exists(),'nothing changes on a refused request')
            result=host.run('launch-certificate',domain='shop.example.com',maintenanceDirectory=str(mroot)+'/'+site)
        self.assertEqual((result['state'],result['maintenanceReset']),('issued',True))
        self.assertFalse((mroot/site/'ready').exists())
        self.assertIn('listen 443 ssl;',(host.conf/'docknest-shop.conf').read_text())
        host.events=io.StringIO()
        with patch('helper.LAUNCH_MAINTENANCE_ROOT',mroot):
            self.assertFalse(host.run('launch-certificate',domain='shop.example.com',maintenanceDirectory=str(mroot)+'/'+site)['maintenanceReset'])
        self.assertFalse(host.run('launch-certificate',domain='shop.example.com')['maintenanceReset'])
    def test_maintenance_folder_through_a_link_is_refused(self):
        root=pathlib.Path(tempfile.mkdtemp());real=root/'real';real.mkdir()
        try:os.symlink(real,root/'maintenance')
        except (OSError,NotImplementedError):self.skipTest('symbolic links need privileges here')
        site='7c9e6679-7425-40de-944b-e07fc1f90ae7'
        with patch('helper.LAUNCH_MAINTENANCE_ROOT',root/'maintenance'):
            with self.assertRaises(helper.LaunchRefused):helper.launch_maintenance_dir(str(root/'maintenance')+'/'+site)
    def test_git_too_old_reason(self):
        self.assertEqual(helper.LAUNCH_REASONS['GIT_TOO_OLD'],'Git 2.37 or newer is needed. Update git, then try again.')

class EntryTests(unittest.TestCase):
    def test_bad_requests_and_unexpected_errors_never_leak_text(self):
        for op in ('launch-host-key','launch-facts','launch-fetch','launch-build','launch-start','launch-poll','launch-web','launch-certificate','launch-teardown','launch-status'):
            events=io.StringIO()
            with patch('helper.EVENT_STREAM',events):helper.main({'operation':op})
            result=json.loads(events.getvalue().splitlines()[-1])['result']
            self.assertEqual((result['ok'],result['code']),(False,'INVALID_REQUEST'),op)
        events=io.StringIO()
        def boom(*a,**k):raise RuntimeError('/secret/path token=abc')
        with patch('helper.EVENT_STREAM',events),patch('helper.launch_dir',side_effect=boom):
            helper.main({'operation':'launch-status','launchId':LID,'slug':'shop'})
        self.assertNotIn('secret',events.getvalue())
        self.assertEqual(json.loads(events.getvalue())['result'],{'ok':False,'code':'FAILED','reason':helper.LAUNCH_REASONS['FAILED'],'errorType':'RuntimeError'})
    def test_watch_kills_on_size_and_time_without_sleeping(self):
        folder=tempfile.mkdtemp()
        grow="import os,sys\nfor i in range(10**6):open(os.path.join(sys.argv[1],'f%d'%i),'wb').write(b'x'*65536)"
        with patch('helper.LAUNCH_WATCH_SECONDS',0.1),patch('helper.time.sleep',side_effect=AssertionError('no sleeping')):
            code,_,_,why=helper.launch_watch([sys.executable,'-c',grow,folder],dict(os.environ),60,folder=folder,limit=2*1024*1024)
            self.assertEqual((code,why),(-1,'size'))
            code,_,_,why=helper.launch_watch([sys.executable,'-c','import time;time.sleep(30)'],dict(os.environ),0.3)
            self.assertEqual((code,why),(-1,'timeout'))
            code,out,_,why=helper.launch_watch([sys.executable,'-c','print("hi")'],dict(os.environ),30)
            self.assertEqual((code,out.strip(),why),(0,b'hi',None))
        self.assertEqual(helper.LAUNCH_CHILDREN,set())

if __name__=='__main__':
    unittest.main()
