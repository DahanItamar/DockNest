import unittest, json, sys, time
from unittest.mock import patch
import helper
from helper import inventory, exec_capped, parse_os_release, INVENTORY_MAX_CONTAINERS

SECRET='canary-secret-value-123'
def cid(n):return '%064x'%n
IMAGE='sha256:'+'a'*64
def container(n,running=True,image='php:8.3-apache',project='shop',labels=None):
    base={'com.docker.compose.project':project,'com.docker.compose.service':'web','org.opencontainers.image.version':'8.3.1','secret.label':SECRET}
    return {'Id':cid(n),'Name':'/c%d'%n,'Image':IMAGE,'State':{'Status':'running' if running else 'exited','Running':running},
            'Config':{'Image':image,'Env':['DB_PASSWORD='+SECRET],'Cmd':['php','-S',SECRET],'Labels':labels if labels is not None else base},
            'Mounts':[{'Source':'/srv/'+SECRET}],'HostConfig':{'Binds':['/'+SECRET+':/x']}}

class FakeDocker:
    """Records every docker argv; answers ps, inspect, image inspect, version and exec probes."""
    def __init__(self,containers,probe=None):
        self.containers=containers;self.calls=[];self.probe=probe or (lambda argv:{'php':b'8.3.1','node':None,'cat':b'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nHOME_URL="https://'+SECRET.encode()+b'"\n'}[argv[3]])
    def run(self,args,timeout=3600,input=None):
        self.calls.append(list(args));sub=args[1]
        if sub=='ps':return '\n'.join(c['Id'] for c in self.containers).encode()
        if sub=='inspect':return json.dumps([c for c in self.containers if c['Id'] in args[2:]]).encode()
        if sub=='image':return json.dumps([{'Id':IMAGE,'RepoTags':['php:8.3-apache'],'RepoDigests':['php@sha256:'+'b'*64],'Architecture':'amd64','Created':'2026-09-01T00:00:00Z','Config':{'Env':['X='+SECRET]}}]).encode()
        if sub=='version':return b'28.1.0\n'
        raise AssertionError('unexpected docker call %r'%(args,))
    def exec(self,argv,timeout=5,cap=512):
        self.calls.append(list(argv));return self.probe(argv)

def scan(fake,req=None):
    with patch('helper.run',fake.run),patch('helper.exec_capped',fake.exec):return inventory(req or {'operation':'inventory'})

class InventoryTests(unittest.TestCase):
    def test_collects_whitelisted_fields_and_never_env_cmd_mounts_or_other_labels(self):
        fake=FakeDocker([container(1),container(2,running=False)]);result=scan(fake)
        text=json.dumps(result)
        self.assertNotIn(SECRET,text);self.assertNotIn('Env',text);self.assertNotIn('Mounts',text)
        first=result['containers'][0]
        self.assertEqual(first['repoTags'],['php:8.3-apache']);self.assertEqual(first['architecture'],'amd64');self.assertEqual(first['imageId'],IMAGE)
        self.assertEqual(first['labels'],{'composeProject':'shop','composeService':'web','ociVersion':'8.3.1'})
        self.assertEqual(first['runtime'],{'php':'8.3.1','node':None,'os':{'id':'debian','versionId':'12','prettyName':'Debian GNU/Linux 12 (bookworm)'}})
        self.assertIsNone(result['containers'][1]['runtime'],'stopped containers are not probed')
        self.assertEqual(result['host']['docker'],'28.1.0')

    def test_performs_no_write_stop_start_or_rm_calls(self):
        fake=FakeDocker([container(1),container(2,running=False),container(3,project='docknest')]);scan(fake)
        allowed={('ps',),('inspect',),('image','inspect'),('version',)}
        probes=[['php','-r','echo PHP_VERSION;'],['node','-v'],['cat','/etc/os-release']]
        for call in fake.calls:
            self.assertEqual(call[0],'docker')
            if call[1]=='exec':
                self.assertRegex(call[2],r'^[0-9a-f]{64}$');self.assertIn(call[3:],probes,'only fixed probes, no -u, no shell')
            else:self.assertTrue(any(tuple(call[1:1+len(a)])==a for a in allowed),call)
            for word in ['stop','start','rm','kill','restart','commit','cp','pause','update','rename','create','run','pull','sh','-u','--user']:
                self.assertNotIn(word,call[1:2]+call[3:4])

    def test_probes_flag_skips_docker_exec_and_own_containers_are_not_probed(self):
        fake=FakeDocker([container(1)]);result=scan(fake,{'operation':'inventory','probes':False})
        self.assertFalse(any(call[1]=='exec' for call in fake.calls));self.assertIsNone(result['containers'][0]['runtime'])
        fake=FakeDocker([container(1,project='docknest'),container(2,project='x',image='ghcr.io/acme/docknest:2.5.0')]);result=scan(fake)
        self.assertFalse(any(call[1]=='exec' for call in fake.calls));self.assertTrue(all(c['own'] for c in result['containers']))

    def test_garbage_and_missing_binaries_are_normal(self):
        outputs={'php':b'PHP Warning: <script>8.3.1','node':None,'cat':b'\xff\xfe\x00garbage'}
        result=scan(FakeDocker([container(1)],lambda argv:outputs[argv[3]]))
        self.assertEqual(result['containers'][0]['runtime'],{'php':None,'node':None,'os':None})
        result=scan(FakeDocker([container(1)],lambda argv:{'php':b'8.2.10-dev','node':b'v22.11.0\n','cat':b'ID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="$(rm -rf /)"'}[argv[3]]))
        self.assertEqual(result['containers'][0]['runtime'],{'php':'8.2.10-dev','node':'22.11.0','os':{'id':'alpine','versionId':'3.20.3'}})

    def test_caps_containers(self):
        fake=FakeDocker([container(n,running=False) for n in range(INVENTORY_MAX_CONTAINERS+5)]);result=scan(fake)
        self.assertTrue(result['truncated']);self.assertEqual(len(result['containers']),INVENTORY_MAX_CONTAINERS)

    def test_no_containers_runs_no_inspect_or_exec(self):
        fake=FakeDocker([]);result=scan(fake)
        self.assertEqual(result['containers'],[]);self.assertFalse(result['truncated'])
        self.assertFalse(any(call[1] in ('inspect','exec','image') for call in fake.calls))

    def test_container_removed_between_ps_and_inspect_is_skipped(self):
        fake=FakeDocker([container(1),container(2)]);gone=cid(2);original=fake.run
        def run(args,timeout=3600,input=None):
            if args[1]=='inspect' and gone in args[2:]:
                fake.calls.append(list(args));raise helper.subprocess.CalledProcessError(1,args)
            return original(args,timeout,input)
        fake.run=run;result=scan(fake)
        self.assertEqual([c['id'] for c in result['containers']],[cid(1)])

    def test_digest_only_and_private_registry_images_are_reported_as_given(self):
        digest='php@sha256:'+'c'*64
        result=scan(FakeDocker([container(1,image=digest),container(2,image='registry.example.invalid:5000/team/php:8.3')]))
        self.assertEqual([c['image'] for c in result['containers']],[digest,'registry.example.invalid:5000/team/php:8.3'])

    def test_probe_budget_stops_probing_and_marks_truncated(self):
        fake=FakeDocker([container(1),container(2),container(3)])
        with patch('helper.INVENTORY_PROBE_BUDGET',0):result=scan(fake)
        self.assertFalse(any(call[1]=='exec' for call in fake.calls),'no probe after the budget')
        self.assertTrue(result['truncated']);self.assertTrue(result['probeBudgetExceeded'])
        self.assertTrue(all(c['runtime'] is None for c in result['containers']))
        result=scan(FakeDocker([container(1)]));self.assertFalse(result['truncated']);self.assertFalse(result['probeBudgetExceeded'])

    def test_os_release_whitelist(self):
        self.assertEqual(parse_os_release('NAME=x\nID=ubuntu\nVERSION_ID="24.04"\nPASSWORD=y\n'),{'id':'ubuntu','versionId':'24.04'})
        self.assertIsNone(parse_os_release('NAME=only'))

class ExecCappedTests(unittest.TestCase):
    def test_timeout_overflow_failure_and_missing_binary(self):
        started=time.monotonic()
        self.assertIsNone(exec_capped([sys.executable,'-c','import time;time.sleep(30)'],timeout=1))
        self.assertLess(time.monotonic()-started,10)
        self.assertIsNone(exec_capped([sys.executable,'-c','print("x"*100000)']),'output above the cap is refused')
        self.assertIsNone(exec_capped([sys.executable,'-c','import sys;sys.exit(127)']))
        self.assertIsNone(exec_capped(['docknest-no-such-binary-xyz']))
        self.assertEqual(exec_capped([sys.executable,'-c','print("8.3.1")']).strip(),b'8.3.1')

if __name__=='__main__':unittest.main()
