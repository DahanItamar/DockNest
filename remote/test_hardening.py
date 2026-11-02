"""Copies keep the original's hardening (issue 145): restores, restore tests and moves reproduce CapDrop, CapAdd within
Docker's defaults, ReadonlyRootfs (with its RAM folders), no-new-privileges, seccomp and AppArmor, or refuse with a
reason; each new copy of a hardened container is inspected before it starts. Docker is faked here; real Docker runs in
scripts/integration-copies.js, integration-restore-test.js and integration-move.js. Run: python3 remote/test_hardening.py"""
import unittest, tempfile, pathlib, json, os, sys, hashlib
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

PROFILE={'defaultAction':'SCMP_ACT_ERRNO','syscalls':[{'names':['read','write','exit_group'],'action':'SCMP_ACT_ALLOW'}]}

def container(name='app',networks=None,**host):
    return {'Id':'id-'+name,'Name':'/'+name,'State':{'Running':True},'Config':{'Hostname':name,'Labels':{}},'HostConfig':{'NetworkMode':'default','Tmpfs':{},**host},
        'NetworkSettings':{'Networks':networks or {}},'Mounts':[]}

def created_host_config(args):
    """What Docker stores for `docker create` flags: the CLI reads a seccomp profile file and stores its contents."""
    hc={'CapDrop':[],'CapAdd':[],'SecurityOpt':[],'ReadonlyRootfs':'--read-only' in args,'Privileged':'--privileged' in args,'Tmpfs':{}}
    for i,arg in enumerate(args[:-1]):
        value=args[i+1]
        if arg=='--cap-drop':hc['CapDrop'].append('CAP_'+value if value!='ALL' else value)
        if arg=='--cap-add':hc['CapAdd'].append('CAP_'+value)
        if arg=='--tmpfs':destination,_,options=value.partition(':');hc['Tmpfs'][destination]=options
        if arg=='--security-opt':
            key,_,option=value.partition('=')
            if key=='seccomp' and option.startswith('/'):value='seccomp='+json.dumps(json.loads(pathlib.Path(option).read_text()),separators=(',',':'))
            hc['SecurityOpt'].append(value)
    return hc

class FakeCreates:
    """Patches helper.docker for create (and the calls around it) and helper.inspect to report what was created."""
    def __init__(self,mutate=None):self.creates={};self.calls=[];self.mutate=mutate or (lambda hc:hc)
    def inspect(self,ids):return [{'Id':cid,'Name':'/'+cid,'State':{'Running':True},'NetworkSettings':{'Networks':{}},'HostConfig':self.mutate(created_host_config(self.creates[cid]))} for cid in ids]

class CapabilityTests(unittest.TestCase):
    def test_one_default_set_and_names_are_normalised(self):
        self.assertIn('NET_BIND_SERVICE',helper.DEFAULT_CAPABILITIES);self.assertNotIn('NET_RAW',helper.DEFAULT_CAPABILITIES)
        self.assertEqual(helper.capability_name('cap_chown'),'CHOWN');self.assertIsNone(helper.capability_name(None));self.assertIsNone(helper.capability_name('--x'))
        self.assertFalse(helper.extra_capabilities(['CAP_CHOWN','setuid']));self.assertFalse(helper.extra_capabilities(None))
        for added in [['ALL'],['NET_RAW'],['SYS_ADMIN'],['CHOWN','NET_ADMIN'],[None],['bad name']]:self.assertTrue(helper.extra_capabilities(added),added)
    def test_hardened_sites_that_drop_capabilities_and_add_defaults_back_are_now_accepted_and_reproduced(self):
        c=container(CapDrop=['ALL'],CapAdd=['CAP_NET_BIND_SERVICE','CHOWN'],ReadonlyRootfs=True,Tmpfs={'/tmp':'size=64m,mode=1777','/run':''})
        self.assertEqual(helper.restore_network_plan([c]),[{}])
        with tempfile.TemporaryDirectory() as d:args=helper.hardening_args(c,d)
        self.assertEqual(args,['--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--cap-add','CHOWN'])
        self.assertEqual(helper.temporary_mounts(c),[('/tmp','size=64m,mode=1777'),('/run','')],'RAM folders a read-only root needs are kept')
    def test_extra_capabilities_and_host_privileges_are_still_refused(self):
        for host in [{'CapAdd':['NET_RAW'],'CapDrop':['ALL']},{'CapAdd':['SYS_ADMIN']},{'CapAdd':['ALL']},{'Privileged':True,'ReadonlyRootfs':True},{'Devices':[{'PathOnHost':'/dev/fuse'}]},
                     {'NetworkMode':'host','ReadonlyRootfs':True,'CapDrop':['ALL']},{'PidMode':'host','SecurityOpt':['no-new-privileges']}]:
            with self.assertRaisesRegex(ValueError,'Host privileges or shared namespace',msg=host):helper.restore_network_plan([container(**host)])
        with self.assertRaisesRegex(ValueError,'Host privileges'):helper.hardening_args(container(CapAdd=['SYS_ADMIN']),'.')
    def test_an_unreadable_dropped_capability_is_refused(self):
        with self.assertRaisesRegex(ValueError,'does not recognize'):helper.hardening(container(CapDrop=['NET RAW']))

class SecurityOptionTests(unittest.TestCase):
    def args(self,*options,**host):
        with tempfile.TemporaryDirectory() as d:return helper.hardening_args(container(SecurityOpt=list(options),**host),d)
    def test_no_new_privileges_in_every_docker_spelling(self):
        for option in ['no-new-privileges','no-new-privileges:true','no-new-privileges=true']:self.assertEqual(self.args(option),['--security-opt','no-new-privileges=true'],option)
        self.assertEqual(self.args('no-new-privileges=false'),[])
    def test_seccomp_unconfined_is_reproduced_not_dropped(self):
        for option in ['seccomp=unconfined','seccomp:unconfined']:self.assertEqual(self.args(option),['--security-opt','seccomp=unconfined'])
        self.assertEqual(self.args('seccomp=builtin'),[],'builtin is the default profile')
    def test_a_custom_seccomp_profile_is_written_privately_and_passed_by_path(self):
        stored='seccomp='+json.dumps(PROFILE,separators=(',',':'))  # Docker stores the profile contents
        with tempfile.TemporaryDirectory() as d:
            args=helper.hardening_args(container(SecurityOpt=[stored]),d)
            self.assertEqual(args[0],'--security-opt');path=pathlib.Path(args[1].split('=',1)[1])
            self.assertEqual(path.parent,pathlib.Path(d));self.assertEqual(json.loads(path.read_text()),PROFILE)
            if os.name=='posix':self.assertEqual(path.stat().st_mode&0o777,0o600)
    def test_a_seccomp_profile_file_missing_on_this_server_is_refused(self):
        with self.assertRaisesRegex(ValueError,'not on this server'):self.args('seccomp=/etc/docker/seccomp/missing-profile.json')
        with self.assertRaisesRegex(ValueError,'absolute path'):self.args('seccomp=./profile.json')
        with self.assertRaisesRegex(ValueError,'cannot read'):self.args('seccomp={not json')
        with tempfile.TemporaryDirectory() as d:
            profile=pathlib.Path(d)/'profile.json';profile.write_text(json.dumps(PROFILE))
            if os.name=='posix':
                # Read the written copy while d still exists.
                args=helper.hardening_args(container(SecurityOpt=['seccomp='+str(profile)]),d)
                self.assertEqual(json.loads(pathlib.Path(args[1].split('=',1)[1]).read_text()),PROFILE)
            fifo=pathlib.Path(d)/'fifo.json'
            if hasattr(os,'mkfifo'):
                os.mkfifo(fifo)  # a FIFO never hangs the helper: opened non-blocking, refused as not a file
                with self.assertRaisesRegex(ValueError,'not on this server'):self.args('seccomp='+str(fifo))
    def test_apparmor_profiles_must_be_loaded_here(self):
        with tempfile.TemporaryDirectory() as d:
            loaded=pathlib.Path(d)/'profiles';loaded.write_text('docker-default (enforce)\nsite-profile (enforce)\n')
            with patch('helper.APPARMOR_PROFILES',str(loaded)):
                self.assertEqual(self.args('apparmor=site-profile'),['--security-opt','apparmor=site-profile'])
                self.assertEqual(self.args('apparmor:unconfined'),['--security-opt','apparmor=unconfined'])
                with self.assertRaisesRegex(ValueError,'AppArmor profile other-profile, which is not loaded on this server'):self.args('apparmor=other-profile')
            with patch('helper.APPARMOR_PROFILES',str(pathlib.Path(d)/'absent')),self.assertRaisesRegex(ValueError,'not loaded'):self.args('apparmor=docker-default')
    def test_options_docknest_cannot_copy_safely_are_refused_with_a_reason(self):
        for option in ['systempaths=masked','writable-cgroups=maybe','mask=/proc','seccomp=','apparmor=--x','no-new-privileges=maybe',5]:
            with self.assertRaises(ValueError,msg=option):self.args(option)
        with self.assertRaisesRegex(ValueError,'security option mask'):self.args('mask=/proc')
    def test_options_that_only_turn_protection_off_are_left_out_so_the_copy_is_stricter(self):
        # Upgrade safety: these sites restored before 2.14.0 (the option was dropped); they still do.
        for option in ['systempaths=unconfined','systempaths:unconfined','writable-cgroups=true','writable-cgroups=false']:self.assertEqual(self.args(option),[],option)
        self.assertEqual(helper.hardening(container(SecurityOpt=['systempaths=unconfined','writable-cgroups=false']))['relaxed'],['systempaths=unconfined'])
    def test_selinux_labels_are_kept(self):
        self.assertEqual(self.args('label=disable'),['--security-opt','label=disable'])
        self.assertEqual(self.args('label:level:s0:c100,c200'),['--security-opt','label=level:s0:c100,c200'])
    def test_plain_containers_get_no_extra_flags(self):
        self.assertEqual(self.args(),[]);self.assertFalse(helper.hardened(container()))

class ShortfallTests(unittest.TestCase):
    ORIGINAL=dict(CapDrop=['ALL'],CapAdd=['NET_BIND_SERVICE'],ReadonlyRootfs=True,SecurityOpt=['no-new-privileges:true','seccomp=unconfined'])
    def test_an_exact_copy_passes(self):
        o=container(**self.ORIGINAL)
        with tempfile.TemporaryDirectory() as d:copy={'Name':'/x','HostConfig':created_host_config(helper.hardening_args(o,d)+['img'])}
        self.assertIsNone(helper.hardening_shortfall(o,copy))
    def test_a_copy_that_drops_more_passes(self):
        # A restore test with internet drops NET_ADMIN on top.
        o=container(CapDrop=['NET_RAW'])
        self.assertIsNone(helper.hardening_shortfall(o,container(CapDrop=['NET_RAW','NET_ADMIN'])))
    def test_each_lost_protection_is_named(self):
        o=container(**self.ORIGINAL)
        for copy,text in [(dict(self.ORIGINAL,ReadonlyRootfs=False),'read-only root filesystem'),(dict(self.ORIGINAL,CapDrop=[]),'dropped capabilities'),
                          (dict(self.ORIGINAL,Privileged=True),'dropped capabilities'),(dict(self.ORIGINAL,SecurityOpt=['seccomp=unconfined']),'no-new-privileges')]:
            self.assertIn(text,helper.hardening_shortfall(o,container(**copy)) or '',copy)
        custom=container(SecurityOpt=['seccomp='+json.dumps(PROFILE),'apparmor=site-profile'])
        self.assertIn('seccomp profile',helper.hardening_shortfall(custom,container(SecurityOpt=['apparmor=site-profile'])))
        self.assertIn('AppArmor profile',helper.hardening_shortfall(custom,container(SecurityOpt=['seccomp='+json.dumps(PROFILE,indent=2)])))
        self.assertIsNone(helper.hardening_shortfall(custom,container(SecurityOpt=['seccomp='+json.dumps(PROFILE,indent=2),'apparmor=site-profile'])),'same profile, other spacing')
        self.assertIn('seccomp profile',helper.hardening_shortfall(container(),container(SecurityOpt=['seccomp=unconfined'])),'never weaker than the default either')
    def test_a_copy_that_unmasks_system_paths_the_original_kept_masked_is_weaker(self):
        self.assertIn('masked system paths',helper.hardening_shortfall(container(),container(SecurityOpt=['systempaths=unconfined'])))
        self.assertIsNone(helper.hardening_shortfall(container(SecurityOpt=['systempaths=unconfined']),container()),'the stricter copy passes')
    def test_compose_copies_are_always_inspected_and_never_weaker(self):
        # A Compose copy is built from the site's files, which may add what the original never had.
        plain=container('web')
        for weaker in [['seccomp=unconfined'],['apparmor=unconfined'],['label=disable'],['systempaths=unconfined']]:
            with patch('helper.inspect',return_value=[container('copy',SecurityOpt=weaker)]),self.assertRaises(ValueError,msg=weaker):helper.verify_hardening([plain],['cid'],every=True)
        with patch('helper.inspect',return_value=[container('copy',CapAdd=['CHOWN'],Privileged=True)]),self.assertRaisesRegex(ValueError,'dropped capabilities'):helper.verify_hardening([plain],['cid'],every=True)
        with patch('helper.inspect',return_value=[container('copy')]):helper.verify_hardening([plain],['cid'],every=True)
        with patch('helper.inspect',side_effect=AssertionError('no inspect')):helper.verify_hardening([plain],['cid'])
        self.assertIn('verify_hardening(containers,created,every=bool(compose))',pathlib.Path(helper.__file__).read_text(),'the move deploy checks every Compose copy')
    def test_copies_that_cannot_be_matched_fail_closed(self):
        with self.assertRaisesRegex(ValueError,'could not match'):helper.verify_hardening([container(ReadonlyRootfs=True)],[])
        with patch('helper.inspect',return_value=[]),self.assertRaisesRegex(ValueError,'could not inspect'):helper.verify_hardening([container(ReadonlyRootfs=True)],['cid'])
    def test_unhardened_originals_are_not_inspected(self):
        with patch('helper.inspect',side_effect=AssertionError('no inspect')):helper.verify_hardening([container()],['cid'])
        with patch('helper.inspect',return_value=[container()]),self.assertRaisesRegex(ValueError,'read-only root'):helper.verify_hardening([container(ReadonlyRootfs=True)],['cid'])

class ComposeTests(unittest.TestCase):
    """The Compose allow-list and the move plan (restore_network_plan) agree on capabilities."""
    def config(self,**service):return {'services':{'web':{'image':'x',**service}},'networks':{'default':{'name':'shop_default'}},'volumes':{}}
    def manifest(self):return {'containers':[{**container('web',{'shop_default':{}}),'Mounts':[]}]}
    def test_default_only_cap_add_is_accepted_by_both_the_plan_and_the_allow_list(self):
        for added in [['CHOWN'],['CAP_SETUID','SETGID','NET_BIND_SERVICE']]:
            self.assertEqual(helper.restore_network_plan([container(CapAdd=added)]),[{}])
            helper.check_compose_config(self.config(cap_add=added),['web'],self.manifest())
        for added in [['NET_ADMIN'],['ALL'],['NET_RAW']]:
            with self.assertRaises(ValueError):helper.restore_network_plan([container(CapAdd=added)])
            with self.assertRaisesRegex(ValueError,'beyond Docker'):helper.check_compose_config(self.config(cap_add=added),['web'],self.manifest())
    def test_hardened_compose_services_pass(self):
        helper.check_compose_config(self.config(cap_drop=['ALL'],cap_add=['NET_BIND_SERVICE'],read_only=True,tmpfs=['/tmp'],security_opt=['no-new-privileges:true','seccomp:unconfined']),['web'],self.manifest())
    def test_compose_settings_a_copy_cannot_have_are_refused(self):
        for service in [dict(security_opt=['mask=/proc']),dict(security_opt=['seccomp:/srv/missing/profile.json']),dict(security_opt=['seccomp:./profile.json']),
                        dict(cap_drop=['NET RAW']),dict(cap_add='CHOWN'),dict(security_opt=['apparmor=not-loaded-here'])]:
            with patch('helper.APPARMOR_PROFILES','/nonexistent/apparmor'),self.assertRaises(ValueError,msg=service):helper.check_compose_config(self.config(**service),['web'],self.manifest())

class MovePreflightFactTests(unittest.TestCase):
    def test_source_facts_name_problems_and_needed_profiles_and_the_target_reports_loaded_ones(self):
        facts=helper.hardening_facts([container('web',SecurityOpt=['apparmor=site-profile','no-new-privileges']),container('db',SecurityOpt=['mask=/proc']),container('cache',SecurityOpt=['apparmor=unconfined'])])
        self.assertTrue(facts['hardened']);self.assertEqual(facts['apparmor'],['site-profile'])
        self.assertEqual(len(facts['problems']),1);self.assertIn('Container db uses the security option mask',facts['problems'][0])
        self.assertEqual(helper.hardening_facts([container()]),{'hardened':False,'problems':[],'apparmor':[],'hostAppArmor':[]})
        self.assertEqual(helper.hardening_facts([{**container(),'AppArmorProfile':'docker-default'},{**container('b'),'AppArmorProfile':'unconfined'}])['hostAppArmor'],['docker-default'])
        with tempfile.TemporaryDirectory() as d:
            loaded=pathlib.Path(d)/'profiles';loaded.write_text('site-profile (enforce)\n')
            with patch('helper.APPARMOR_PROFILES',str(loaded)),patch('helper.docker',return_value=b''):
                probe=helper.target_probe({'paths':[],'names':{},'apparmor':['site-profile','other','--bad']})
        self.assertEqual(probe['apparmorLoaded'],['site-profile']);self.assertTrue(probe['apparmorEnabled'])
        with patch('helper.APPARMOR_PROFILES','/nonexistent/apparmor'),patch('helper.docker',return_value=b''):self.assertFalse(helper.target_probe({'paths':[],'names':{}})['apparmorEnabled'])

@unittest.skipUnless(os.name=='posix','Restore test journals sync directories (POSIX only)')
class RestoreTestCopyTests(unittest.TestCase):
    """A hardened site is testable: the restore test copy gets the original's protections and is checked."""
    def run_test(self,host,mutate=None,internet=False):
        import test_restore_tests as rt
        m=rt.manifest();m['containers'][0]['HostConfig'].update(host)
        fake=FakeCreates(mutate)
        with tempfile.TemporaryDirectory() as t,rt.Sandbox(t,m) as box:
            original=box.docker.__call__
            def docker(*args):
                result=original(*args)
                if args[0]=='create':fake.creates[result.decode().strip()]=list(args)
                return result
            with patch('helper.docker',side_effect=docker),patch('helper.inspect',side_effect=fake.inspect):
                box.prepare();result=box.restore(internet=internet)
            return result,next(iter(fake.creates.values()),None)
    def test_read_only_dropped_capabilities_and_no_new_privileges_reach_the_copy(self):
        result,args=self.run_test(dict(CapDrop=['ALL'],CapAdd=['CAP_NET_BIND_SERVICE'],ReadonlyRootfs=True,Tmpfs={'/tmp':'size=16m'},SecurityOpt=['no-new-privileges']))
        self.assertEqual(result['outcome'],'ok',result)
        for flag in ['--read-only','ALL','NET_BIND_SERVICE','no-new-privileges=true','/tmp:size=16m']:self.assertIn(flag,args)
    def test_a_copy_docker_weakened_ends_the_test_as_couldnt_run(self):
        result,_=self.run_test(dict(ReadonlyRootfs=True),mutate=lambda hc:{**hc,'ReadonlyRootfs':False})
        self.assertEqual(result['outcome'],'couldnt_run');self.assertIn('read-only root filesystem',result['reason'])
    def test_a_missing_apparmor_profile_is_a_plain_reason(self):
        with patch('helper.APPARMOR_PROFILES','/nonexistent/apparmor'):result,args=self.run_test(dict(SecurityOpt=['apparmor=site-profile']))
        self.assertEqual(result['outcome'],'couldnt_run');self.assertIn('not loaded on this server',result['reason']);self.assertIsNone(args)

class RestoreCopyTests(unittest.TestCase):
    def test_isolated_restore_reproduces_hardening_and_refuses_a_weaker_copy(self):
        import test_moves as tm
        for mutate,ok in [(None,True),(lambda hc:{**hc,'SecurityOpt':[]},False)]:
            manifest=tm.fixture_manifest()
            for c in manifest['containers']:c['HostConfig'].update(CapDrop=['ALL'],ReadonlyRootfs=True,SecurityOpt=['no-new-privileges'])
            fake=FakeCreates(mutate)
            with tempfile.TemporaryDirectory() as temporary:
                root=pathlib.Path(temporary)/tm.JOB;root.mkdir();(root/'payload.tar.gz').write_bytes(b'payload')
                host=tm.FakeHost(temporary,manifest);original=host.docker
                def docker(*args):
                    result=original(*args)
                    if args[0]=='create':fake.creates[result.decode().strip()]=list(args)
                    return result
                with patch('helper.owned_job_root',return_value=root),patch('helper.shutil.disk_usage',return_value=type('U',(),{'free':10**15})()):
                    patches=host.patches()+[patch('helper.docker',side_effect=docker),patch('helper.inspect',side_effect=fake.inspect)]
                    for item in patches:item.start()
                    try:
                        if ok:helper.restore({'job':tm.JOB,'plaintextChecksum':hashlib.sha256(b'payload').hexdigest()})
                        else:
                            with self.assertRaisesRegex(ValueError,'no-new-privileges'):helper.restore({'job':tm.JOB,'plaintextChecksum':hashlib.sha256(b'payload').hexdigest()})
                    finally:
                        for item in reversed(patches):item.stop()
            creates=[c for c in host.calls if c[0]=='create']
            self.assertEqual(len(creates),2)
            for args in creates:self.assertIn('--read-only',args);self.assertIn('no-new-privileges=true',args)
            if not ok:self.assertTrue(any(c[0]=='stop' for c in host.calls),'a refused copy is stopped like every failed restore')

@unittest.skipUnless(os.name=='posix','Deploy places files at absolute POSIX paths')
class MoveCopyTests(unittest.TestCase):
    def test_a_plain_move_reproduces_hardening(self):
        import test_moves as tm
        manifest=tm.fixture_manifest()
        for c in manifest['containers']:c['HostConfig'].update(CapDrop=['ALL'],CapAdd=['CHOWN'],ReadonlyRootfs=True,Tmpfs={'/tmp':''},SecurityOpt=['no-new-privileges:true','seccomp=unconfined'])
        fake=FakeCreates();case=tm.DeployRestoreTests()
        original=tm.FakeHost.docker
        def docker(self,*args):
            result=original(self,*args)
            if args[0]=='create':fake.creates[result.decode().strip()]=list(args)
            return result
        with tempfile.TemporaryDirectory() as temporary,patch.object(tm.FakeHost,'docker',docker),patch('helper.inspect',side_effect=fake.inspect):
            host,_,_=case.deploy(temporary,manifest=manifest)
        for args in [c for c in host.calls if c[0]=='create']:
            for flag in ['--read-only','ALL','CHOWN','no-new-privileges=true','seccomp=unconfined','/tmp']:self.assertIn(flag,args)

if __name__=='__main__':unittest.main()
