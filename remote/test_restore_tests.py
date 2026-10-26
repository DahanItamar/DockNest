"""Automatic restore test operations (docs/restore-tests.md): journal before create, limits and isolation flags,
defensive tag restore, mail blocking and its re-check, teardown that is idempotent, label-gated and root-bound,
the reaper, the probe's limits and status output. Docker is faked; real Docker runs in scripts/integration-restore-test.js.
Run: python3 remote/test_restore_tests.py"""
import unittest, tempfile, pathlib, json, io, os, sys, tarfile, subprocess, hashlib
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper

TID='3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b'
OTHER='9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

def container(i,name,running=True,networks=None):
    return {'Id':'c%d'%i,'Name':'/'+name,'State':{'Running':running},'Config':{'Hostname':name,'Image':'img','Labels':{}},
        'HostConfig':{'NetworkMode':'app_default' if networks else 'default','Tmpfs':{}},
        'NetworkSettings':{'Networks':networks if networks is not None else {}},
        'Mounts':[{'Type':'volume','Name':'data%d'%i,'Source':'/var/lib/docker/volumes/data%d/_data'%i,'Destination':'/data','RW':True}]}
def manifest(grouped=False):
    if grouped:cs=[container(0,'web',True,{'app_default':{'Aliases':['web']}}),container(1,'db',True,{'app_default':{'Aliases':['db']}}),container(2,'worker',False,{'app_default':{'Aliases':['worker']}})]
    else:cs=[container(0,'web')]
    return {'formatVersion':1,'complete':True,'architecture':'x86_64','containers':cs,'snapshotImages':['sha256:snap%d'%i for i in range(len(cs))],
        'originalImages':[{'Id':'sha256:orig'}],'backupPlan':{'services':[],'restartOrder':[c['Id'] for c in reversed(cs)]},'configurationFiles':[],'temporaryMemoryFolders':[]}

class FakeDocker:
    """Containers, networks, images and tags with labels. Every create first asserts the journal already lists it."""
    def __init__(self,journal,archive_tags=(),existing_images=(),existing_tags=None):
        self.journal=journal;self.calls=[];self.containers={};self.networks={};self.images=set(existing_images);self.tags=dict(existing_tags or {})
        self.archive_tags=list(archive_tags);self.loaded=['sha256:snap0','sha256:snap1','sha256:snap2','sha256:orig'];self.in_use=set();self.counter=0
    def journalled(self,kind,value):
        state=json.loads((self.journal()/'resources.json').read_text())
        assert value in state['created'][kind],'%s %s was created before it was journalled'%(kind,value)
    def labels(self,args):
        result={}
        for i,arg in enumerate(args):
            if arg=='--label':key,_,value=args[i+1].partition('=');result[key]=value
        return result
    def match(self,labels,filters):
        for f in filters:
            if f.startswith('label='):
                key,_,value=f[6:].partition('=')
                if key not in labels or (value and labels[key]!=value):return False
            if f.startswith('name='):
                return None
        return True
    def filters(self,args):return [args[i+1] for i,a in enumerate(args) if a=='--filter']
    def __call__(self,*args):
        args=list(args);self.calls.append(args)
        fail=lambda:(_ for _ in ()).throw(subprocess.CalledProcessError(1,['docker',*args[:2]]))
        if args[:2]==['info','--format']:return b'x86_64\n' if 'Architecture' in args[2] else b'/var/lib/docker\n'
        if args[:2]==['version','--format']:return b'29.0.0\n'
        if args[:2]==['images','-aq']:return ('\n'.join(sorted(self.images))+'\n').encode()
        if args[:2]==['image','inspect']:
            ref=args[-1]
            if ref in self.tags:return (self.tags[ref]+'\n').encode()
            if ref in self.images:return (ref+'\n').encode()
            fail()
        if args[0]=='load':
            self.images.update(self.loaded)
            for tag in self.archive_tags:self.tags[tag]='sha256:snap0'
            return b'Loaded\n'
        if args[0]=='tag':self.tags[args[2]]=args[1];return b''
        if args[:2]==['image','rm']:
            ref=args[2]
            if ref in self.tags:
                image=self.tags.pop(ref)
                if image not in self.tags.values() and image not in self.in_use:self.images.discard(image)
                return b''
            if ref in self.in_use or ref in self.tags.values() or ref not in self.images:fail()
            self.images.discard(ref);return b''
        if args[:2]==['network','create']:
            name=args[-1];self.journalled('networks',name)
            self.networks[name]={'labels':self.labels(args),'internal':'--internal' in args,'opts':[args[i+1] for i,a in enumerate(args) if a=='--opt']};return (name+'-id\n').encode()
        if args[:2]==['network','inspect']:
            n=self.networks[args[2]]
            return json.dumps([{'Internal':n['internal'],'EnableIPv6':False,'Options':dict(o.split('=',1) for o in n['opts']),'IPAM':{'Config':[{'Subnet':'172.30.%d.0/24'%len(self.networks)}]}}]).encode()
        if args[:2]==['network','connect']:return b''
        if args[:2]==['network','ls']:
            fs=self.filters(args);names=[f[6:-1] for f in fs if f.startswith('name=^')]
            found=[n for n,v in self.networks.items() if self.match(v['labels'],[f for f in fs if f.startswith('label=')]) and (not names or n==names[0].replace('\\',''))]
            return ('\n'.join(found)+'\n').encode() if found else b''
        if args[:2]==['network','rm']:
            for n in args[2:]:self.networks.pop(n,None)
            return b''
        if args[0]=='create':
            name=args[args.index('--name')+1];self.journalled('containers',name)
            cid=name+'-id';self.containers[cid]={'name':name,'labels':self.labels(args),'args':args};return (cid+'\n').encode()
        if args[0]=='ps':
            fs=self.filters(args)
            return ('\n'.join(c for c,v in self.containers.items() if self.match(v['labels'],fs))+'\n').encode()
        if args[:2]==['rm','-f']:
            for c in args[2:]:self.containers.pop(c,None)
            return b''
        if args[0]=='stop':return b''
        raise AssertionError('unexpected docker call %r'%args)

class Sandbox:
    """Temporary restore and journal roots; unpack_verified returns a fake unpacked package with a real images.tar."""
    def __init__(self,temporary,m=None,tags=()):
        self.base=pathlib.Path(temporary);self.manifest=m or manifest()
        self.restore_root=self.base/'restore';self.tests_root=self.base/'restore-tests'
        self.docker=FakeDocker(lambda:self.tests_root/TID,archive_tags=tags)
        self.events=io.StringIO();self.tags=tags;self.iptables=[]
    def unpack(self,req,root):
        unpacked=root/'unpacked';unpacked.mkdir()
        (unpacked/'manifest.json').write_text(json.dumps(self.manifest))
        data=json.dumps([{'Config':'x.json','RepoTags':list(self.tags),'Layers':[]}]).encode()
        with tarfile.open(unpacked/'images.tar','w') as tar:
            info=tarfile.TarInfo('manifest.json');info.size=len(data);tar.addfile(info,io.BytesIO(data))
        return unpacked,self.manifest,True
    def extract(self,archive,destination):
        destination=pathlib.Path(destination);destination.mkdir(parents=True,exist_ok=True);(destination/'entry').mkdir()
    def fake_run(self,args,timeout=3600,input=None):
        if args[0] in ('iptables','ip6tables'):
            if args[1]=='-S':return ('-N DOCKER-USER\n'+''.join('-A DOCKER-USER '+rule+'\n' for tool,rule in self.iptables if tool==args[0])).encode()
            if args[1]=='-I':
                rule=' '.join(args[3:5]+args[5:]).replace('--comment docknest','--comment docknest')
                self.iptables.append((args[0],' '.join(args[3:])));return b''
            if args[1]=='-D':
                text=' '.join(args[3:]);self.iptables=[item for item in self.iptables if not (item[0]==args[0] and item[1]==text)];return b''
        raise AssertionError('unexpected command %r'%args)
    def __enter__(self):
        self.patches=[patch('helper.RESTORE_ROOT',self.restore_root),patch('helper.RESTORE_TESTS_ROOT',self.tests_root),patch('helper.docker',side_effect=self.docker),
            patch('helper.unpack_verified',side_effect=self.unpack),patch('helper.safe_extract',side_effect=self.extract),patch('helper.EVENT_STREAM',self.events),
            patch('helper.shutil.disk_usage',return_value=type('U',(),{'free':10**15})()),patch('helper.run',side_effect=self.fake_run),
            patch('helper.shutil.which',side_effect=lambda name:'/usr/sbin/'+name),patch('helper.time.sleep',return_value=None)]
        for item in self.patches:item.start()
        return self
    def __exit__(self,*_):
        for item in reversed(self.patches):item.stop()
    def results(self):return [json.loads(line).get('result') for line in self.events.getvalue().splitlines() if line.strip()]
    def prepare(self,deadline=10**10):
        with patch('helper.os.geteuid',return_value=0,create=True):helper.restore_test_prepare({'testId':TID,'deadline':deadline})
    def restore(self,internet=False,memory=1024,cpus=1):
        helper.restore_test_run({'testId':TID,'phase':'restore','plaintextChecksum':'x','limits':{'memoryMb':memory,'cpus':cpus,'internet':internet}})
        return self.results()[-1]
    def state(self):return json.loads((self.tests_root/TID/'resources.json').read_text())

class LimitTests(unittest.TestCase):
    def test_presets_and_custom_values_inside_the_ranges_are_accepted(self):
        for memory in [256,512,1024,2048,4096,8192,16384,700]:self.assertEqual(helper.test_limits({'limits':{'memoryMb':memory,'cpus':1}})[0],memory)
        for cpus in [0.5,0.75,1,2,4,16,3.25]:self.assertEqual(helper.test_limits({'limits':{'memoryMb':1024,'cpus':cpus}})[1],cpus)
    def test_values_outside_the_ranges_or_steps_are_refused(self):
        for memory in [255,16385,1024.5,'1024',True,None]:
            with self.assertRaises(ValueError):helper.test_limits({'limits':{'memoryMb':memory,'cpus':1}})
        for cpus in [0.25,0.4,16.25,1.1,'1',True,None]:
            with self.assertRaises(ValueError):helper.test_limits({'limits':{'memoryMb':1024,'cpus':cpus}})
    def test_internet_only_when_exactly_true(self):
        self.assertFalse(helper.test_limits({'limits':{'memoryMb':1024,'cpus':1,'internet':'yes'}})[2])
        self.assertTrue(helper.test_limits({'limits':{'memoryMb':1024,'cpus':1,'internet':True}})[2])
    def test_test_ids_must_be_canonical(self):
        for value in ['', '../x', TID.upper(), '{'+TID+'}', 'urn:uuid:'+TID]:
            with self.assertRaises(ValueError):helper.test_id({'testId':value})

class RestoreTests(unittest.TestCase):
    def test_single_container_gets_every_limit_no_network_no_ports_and_unique_labels(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();result=box.restore(memory=2048,cpus=0.5)
            self.assertEqual(result['outcome'],'ok',result);self.assertEqual(result['networkMode'],'none')
            [(cid,c)]=box.docker.containers.items();args=c['args']
            self.assertEqual(c['name'],'dbm-test-'+TID[:12])
            for flag,value in [('--memory','2048m'),('--memory-swap','2048m'),('--cpus','0.5'),('--pids-limit','1024'),('--restart','no'),('--log-driver','local'),('--network','none')]:self.assertEqual(args[args.index(flag)+1],value)
            self.assertIn('max-size=10m',args);self.assertIn('max-file=3',args)
            self.assertNotIn('-p',args);self.assertNotIn('--privileged',args)
            self.assertEqual(c['labels'][helper.TEST_LABEL],TID);self.assertEqual(c['labels']['com.docker.compose.project'],'docknest-test-'+TID[:12])
            self.assertEqual(args[-1],'sha256:snap0','created from the snapshot image ID, never a tag')
            self.assertEqual(box.docker.networks,{})
    def test_grouped_site_uses_fresh_isolated_internal_networks_with_aliases(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t,manifest(True)) as box:
            box.prepare();result=box.restore()
            self.assertEqual(result['outcome'],'ok',result);self.assertEqual(result['networkMode'],'isolated-internal')
            [(name,n)]=box.docker.networks.items()
            self.assertTrue(n['internal']);self.assertIn('com.docker.network.bridge.gateway_mode_ipv4=isolated',n['opts']);self.assertEqual(n['labels'][helper.TEST_LABEL],TID)
            for c in box.docker.containers.values():
                self.assertEqual(c['args'][c['args'].index('--network')+1],name);self.assertIn('--dns',c['args'])
            self.assertEqual(box.state()['restored']['running'],['dbm-test-'+TID[:12]+'-1-id','dbm-test-'+TID[:12]+'-0-id'],'restart order, stopped services stay stopped')
    def test_images_and_tags_are_journalled_before_load_and_moved_tags_are_restored(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t,tags=['shop:latest','fresh:1']) as box:
            box.docker.images|={'sha256:old','sha256:orig'};box.docker.tags['shop:latest']='sha256:old'
            box.prepare();self.assertEqual(box.restore()['outcome'],'ok')
            state=box.state()
            self.assertEqual(state['created']['images'],['sha256:snap0'],'images the server already had are never test-only')
            self.assertIn({'tag':'shop:latest','previous':'sha256:old'},state['created']['tags']);self.assertIn({'tag':'fresh:1','previous':None},state['created']['tags'])
            self.assertEqual(box.docker.tags['shop:latest'],'sha256:old','a moved tag points back at its old image right after load')
            load=next(i for i,c in enumerate(box.docker.calls) if c[0]=='load');retag=next(i for i,c in enumerate(box.docker.calls) if c[0]=='tag')
            self.assertGreater(retag,load)
    def test_internet_creates_own_networks_and_blocks_all_four_mail_ports_before_start(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();result=box.restore(internet=True)
            self.assertEqual(result['outcome'],'ok',result);self.assertTrue(result['mailBlocked']);self.assertEqual(result['networkMode'],'internet')
            [(name,n)]=box.docker.networks.items();self.assertFalse(n['internal'])
            [(tool,rule)]=box.iptables
            self.assertEqual(tool,'iptables');self.assertIn('--dports 25,465,587,2525',rule);self.assertIn('docknest-restore-test-'+TID,rule);self.assertIn('REJECT',rule)
            self.assertEqual(box.state()['created']['firewall'],[{'tool':'iptables','subnet':'172.30.1.0/24'}])
            self.assertFalse(any(c[0]=='start' for c in box.docker.calls),'nothing starts in the restore phase')
    def test_mail_rule_flush_is_seen_by_the_next_poll_which_stops_the_copy(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();box.restore(internet=True)
            with patch('helper.inspect',return_value=[{'Id':'dbm-test-'+TID[:12]+'-id','State':{'Running':True}}]):
                helper.restore_test_run({'testId':TID,'phase':'poll'});self.assertEqual(box.results()[-1]['outcome'],'ok')
                box.iptables.clear()
                helper.restore_test_run({'testId':TID,'phase':'poll'})
            result=box.results()[-1]
            self.assertEqual(result['outcome'],'couldnt_run');self.assertIn('Mail blocking was removed',result['reason'])
            self.assertTrue(any(c[0]=='stop' for c in box.docker.calls))
    def test_missing_firewall_chain_refuses_internet(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box,patch('helper.firewall_ready',return_value=False):
            box.prepare();result=box.restore(internet=True)
            self.assertEqual(result['outcome'],'couldnt_run');self.assertIn('mail could not be blocked',result['reason'])
    def test_package_problems_are_backup_side_and_transfer_or_disk_problems_are_not(self):
        cases=[('Backup artifacts are missing, changed or unexpected','failed'),('Restore transfer checksum mismatch','couldnt_run'),('Insufficient target capacity to extract the archive','couldnt_run')]
        for message,outcome in cases:
            with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
                box.prepare()
                with patch('helper.unpack_verified',side_effect=ValueError(message)):result=box.restore()
                self.assertEqual(result['outcome'],outcome,message)
    def test_required_external_storage_is_skipped_with_the_plain_reason(self):
        m=manifest();m['excludedPaths']=[{'path':'/mnt/media','source':'/mnt/media','requiredForRestore':True}]
        with tempfile.TemporaryDirectory() as t,Sandbox(t,m) as box:
            box.prepare();result=box.restore()
            self.assertEqual(result,{'outcome':'couldnt_run','reason':'This site needs external storage that a restore test cannot attach.','checks':result['checks']})
    def test_docker_errors_never_report_arguments(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare()
            original=box.docker.__call__
            def broken(*args):
                if args[0]=='create':raise subprocess.CalledProcessError(125,['docker','create','--mount','type=bind,src=/secret/path'])
                return original(*args)
            with patch('helper.docker',side_effect=broken):result=box.restore()
            self.assertEqual(result['outcome'],'couldnt_run');self.assertNotIn('/secret',result['reason']);self.assertIn('docker create',result['reason'])
    def test_restoring_twice_is_refused(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();box.restore()
            with self.assertRaises(ValueError):box.restore()

class PollTests(unittest.TestCase):
    def poll(self,box,states,**extra):
        with patch('helper.inspect',return_value=states):helper.restore_test_run({'testId':TID,'phase':'poll',**extra})
        return box.results()[-1]
    def test_crash_after_start_fails_still_running_and_oom_is_a_test_limit(self):
        cid='dbm-test-'+TID[:12]+'-id'
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();box.restore()
            result=self.poll(box,[{'Id':cid,'State':{'Running':False,'ExitCode':3}}],final=True)
            self.assertEqual(result['outcome'],'failed');self.assertEqual(result['checks'][0]['name'],'Still running')
            result=self.poll(box,[{'Id':cid,'State':{'Running':False,'ExitCode':137,'OOMKilled':True}}])
            self.assertEqual(result['outcome'],'couldnt_run');self.assertIn('memory limit',result['reason'])
    def test_disk_watchdog_stops_the_copy(self):
        cid='dbm-test-'+TID[:12]+'-id'
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();box.restore()
            with patch('helper.shutil.disk_usage',return_value=type('U',(),{'free':10**8})()):result=self.poll(box,[{'Id':cid,'State':{'Running':True}}])
            self.assertEqual(result['outcome'],'couldnt_run');self.assertIn('low on disk',result['reason']);self.assertTrue(any(c[0]=='stop' for c in box.docker.calls))
    def test_final_poll_passes_running_health_and_stability(self):
        cid='dbm-test-'+TID[:12]+'-id'
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();box.restore()
            result=self.poll(box,[{'Id':cid,'State':{'Running':True,'Health':{'Status':'healthy'}}}],final=True)
            self.assertEqual(result['outcome'],'ok');self.assertEqual([c['kind'] for c in result['checks']],['running','health','stable'])
    def test_probe_is_skipped_without_tools_or_with_invalid_settings_and_runs_as_nobody(self):
        with patch('helper.shutil.which',return_value=None):self.assertEqual(helper.restore_test_probe('c',{'port':80,'path':'/'},'web')['status'],'skipped')
        for probe in [{'port':0},{'port':70000},{'port':80,'path':'no-slash'},{'port':80,'path':'/a b'},{'port':'80'}]:self.assertEqual(helper.restore_test_probe('c',probe,'web')['status'],'skipped',probe)
        calls=[]
        def fake(args,timeout=3600,input=None):calls.append(args);return b'{"status": 302, "ms": 12}\n'
        with patch('helper.shutil.which',side_effect=lambda name:'/usr/bin/'+name),patch('helper.docker',return_value=b'4242\n'),patch('helper.run',side_effect=fake):
            check=helper.restore_test_probe('c',{'port':8080,'path':'/health'},'web')
        self.assertEqual(check['status'],'passed');self.assertEqual(check['detail'],'HTTP 302 in 12 ms')
        argv=calls[0]
        self.assertEqual(argv[:4],['/usr/bin/nsenter','--target','4242','--net'])
        self.assertEqual(argv[4:11],['/usr/bin/setpriv','--reuid','65534','--regid','65534','--clear-groups','--no-new-privs'])
        self.assertEqual(argv[12],'-I');self.assertEqual(argv[-2:],['8080','/health'])
        self.assertIn('read(65536)',helper.PROBE_SCRIPT);self.assertIn('timeout=10',helper.PROBE_SCRIPT)
        with patch('helper.shutil.which',side_effect=lambda name:'/usr/bin/'+name),patch('helper.docker',return_value=b'4242\n'),patch('helper.run',return_value=b'{"status": 500, "ms": 3}\n'):
            self.assertEqual(helper.restore_test_probe('c',{'port':8080},'web')['status'],'failed')

class TeardownTests(unittest.TestCase):
    def test_teardown_removes_everything_it_created_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t,manifest(True),tags=['fresh:1','shop:latest']) as box:
            box.docker.images|={'sha256:old','sha256:orig','sha256:base'};box.docker.tags['shop:latest']='sha256:old'
            box.docker.containers['live-id']={'name':'live','labels':{'com.docker.compose.project':'shop'},'args':[]}
            box.docker.networks['shop_default']={'labels':{},'internal':False,'opts':[]}
            box.prepare();box.restore(internet=True)
            self.assertTrue((box.restore_root/TID).exists())
            helper.restore_test_teardown({'testId':TID})
            result=box.results()[-1];self.assertTrue(result['removed'])
            self.assertEqual(list(box.docker.containers),['live-id']);self.assertEqual(list(box.docker.networks),['shop_default'])
            self.assertEqual(box.iptables,[]);self.assertFalse((box.restore_root/TID).exists());self.assertFalse((box.tests_root/TID).exists())
            self.assertEqual(box.docker.tags,{'shop:latest':'sha256:old'});self.assertEqual(box.docker.images,{'sha256:old','sha256:orig','sha256:base'})
            self.assertFalse(any(c[:2]==['image','rm'] and '-f' in c for c in box.docker.calls),'never docker image rm -f')
            helper.restore_test_teardown({'testId':TID});self.assertEqual(box.results()[-1]['counts']['containers'],0)
            helper.restore_test_status({'testId':TID});self.assertEqual(box.results()[-1]['present'],False)
    def test_teardown_ignores_other_tests_and_unlabelled_networks_with_journalled_names(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t,manifest(True)) as box:
            box.prepare();box.restore()
            box.docker.containers['other-id']={'name':'other','labels':{helper.TEST_LABEL:OTHER},'args':[]}
            name=next(iter(box.docker.networks));box.docker.networks[name]['labels']={}
            helper.restore_test_teardown({'testId':TID})
            self.assertIn(name,box.docker.networks,'a network without the label is never removed');self.assertIn('other-id',box.docker.containers,'another test is never touched')
            self.assertEqual([c['name'] for c in box.docker.containers.values()],['other'])
    def test_the_journal_stays_while_something_is_left(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t,manifest(True)) as box:
            box.prepare();box.restore()
            original=box.docker.__call__
            def stuck(*args):
                if args[:2]==('network','rm'):return b''
                return original(*args)
            with patch('helper.docker',side_effect=stuck),self.assertRaises(ValueError):helper.restore_test_teardown({'testId':TID})
            self.assertTrue((box.tests_root/TID).exists())
    def test_image_used_by_another_container_is_kept_and_reported(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();box.restore();box.docker.in_use.add('sha256:snap0')
            helper.restore_test_teardown({'testId':TID})
            self.assertEqual(box.results()[-1]['keptImages'],1);self.assertIn('sha256:snap0',box.docker.images)
    def test_paths_outside_the_restore_root_are_refused(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            for value in [str(box.base/TID),str(box.restore_root/OTHER),str(box.restore_root/TID/'..'/'..'),'/etc']:
                with self.assertRaises(ValueError):helper.remove_test_path(value,TID)
    def test_a_crash_after_journalling_still_lets_teardown_act(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t,manifest(True)) as box:
            box.prepare()
            original=box.docker.__call__
            def crash(*args):
                if args[0]=='create' and args[args.index('--name')+1].endswith('-1'):raise KeyboardInterrupt
                return original(*args)
            with patch('helper.docker',side_effect=crash),self.assertRaises(KeyboardInterrupt):box.restore()
            self.assertEqual(len(box.state()['created']['containers']),2,'the second container was journalled before the crash')
            helper.restore_test_teardown({'testId':TID})
            self.assertEqual(box.docker.containers,{});self.assertEqual(box.docker.networks,{})

class ReaperAndStatusTests(unittest.TestCase):
    def test_reaper_exits_at_once_without_a_journal(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box,patch('helper.restore_test_teardown') as teardown:
            helper.restore_test_reap({'testId':TID},sleep=lambda s:self.fail('slept'),clock=lambda:0)
            teardown.assert_not_called()
    def test_reaper_waits_for_deadline_plus_grace_then_tears_down_once(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box,patch('helper.restore_test_teardown') as teardown:
            box.prepare(deadline=1000);now=[0];slept=[]
            def sleep(seconds):slept.append(seconds);now[0]+=seconds
            helper.restore_test_reap({'testId':TID},sleep=sleep,clock=lambda:now[0])
            self.assertGreaterEqual(now[0],1000+helper.REAPER_GRACE);self.assertTrue(all(s<=30 for s in slept))
            teardown.assert_called_once_with({'testId':TID})
    def test_reaper_stops_when_the_manager_cleaned_up_while_it_waited(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box,patch('helper.restore_test_teardown') as teardown:
            box.prepare(deadline=1000);now=[0]
            def sleep(seconds):
                now[0]+=seconds
                if now[0]>100:
                    import shutil;shutil.rmtree(box.tests_root/TID,ignore_errors=True)
            helper.restore_test_reap({'testId':TID},sleep=sleep,clock=lambda:now[0])
            teardown.assert_not_called()
    def test_prepare_writes_the_reaper_privately_and_starts_it_detached(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box,patch('helper.subprocess.Popen') as popen,patch('helper.os.geteuid',return_value=0,create=True):
            popen.return_value.pid=4242
            helper.restore_test_prepare({'testId':TID,'deadline':5,'reaper':__import__('base64').b64encode(b'print(1)').decode()})
            d=box.tests_root/TID
            self.assertEqual((d/'reaper.py').read_bytes(),b'print(1)');self.assertEqual(json.loads((d/'reaper.json').read_text()),{'operation':'restore-test-reap','testId':TID})
            kwargs=popen.call_args.kwargs;self.assertTrue(kwargs['start_new_session']);self.assertIn('-I',popen.call_args.args[0])
            self.assertEqual(box.state()['created']['paths'],[str(box.restore_root/TID)]);self.assertTrue(box.results()[-1]['reaper'])
            with self.assertRaises(ValueError):helper.restore_test_prepare({'testId':TID,'deadline':5})
    def test_status_reports_leftovers_and_journal(self):
        with tempfile.TemporaryDirectory() as t,Sandbox(t) as box:
            box.prepare();helper.restore_test_status({'testId':TID})
            self.assertEqual(box.results()[-1],{'containers':0,'networks':0,'firewall':0,'staging':True,'journal':True,'present':True})

class CheckTests(unittest.TestCase):
    def check(self,need,limits=None,meminfo='MemAvailable: 8388608 kB\n',nproc=4):
        events=io.StringIO()
        with patch('helper.docker',side_effect=lambda *a:b'x86_64\n' if 'Architecture' in a[-1] else b'29.1.0\n' if a[0]=='version' else b''),patch('helper.EVENT_STREAM',events),\
            patch('helper.shutil.disk_usage',return_value=type('U',(),{'free':50*1024**3})()),patch('helper.mem_available',return_value=helper.mem_available(meminfo)),\
            patch('helper.cpu_count',return_value=nproc),patch('helper.test_mail_rules',return_value=[]),patch('helper.firewall_ready',return_value=True),\
            patch('helper.shutil.which',return_value='/usr/bin/x'),patch('helper.os.geteuid',return_value=0,create=True):
            helper.restore_test_check({'testId':TID,'need':need,'limits':limits or {'memoryMb':1024,'cpus':1}})
        return json.loads(events.getvalue().splitlines()[-1])['result']
    def test_a_fitting_server_passes(self):
        result=self.check({'bytes':10**9,'containers':2,'architecture':'x86_64','grouped':True})
        self.assertTrue(result['ok'],result);self.assertEqual(result['facts']['nproc'],4)
    def test_cpus_above_nproc_memory_disk_and_architecture_each_give_one_plain_reason(self):
        self.assertIn('has 4 CPUs',self.check({'containers':1},{'memoryMb':1024,'cpus':8})['problems'][0])
        self.assertIn('memory',self.check({'containers':4,'liveServer':True},{'memoryMb':2048,'cpus':1})['problems'][0])
        self.assertIn('GB free',self.check({'bytes':20*1024**3})['problems'][0])
        self.assertIn('architecture',self.check({'architecture':'aarch64'})['problems'][0])
    def test_meminfo_parsing(self):
        self.assertEqual(helper.mem_available('MemTotal: 1 kB\nMemAvailable: 2048 kB\n'),2*1024**2);self.assertIsNone(helper.mem_available('nothing'))

if __name__=='__main__':unittest.main()
