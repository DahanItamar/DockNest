"""Install on server helper operation (docs/moving-sites.md). Run: python3 remote/test_install.py
Proves the allow-list: a package NAME maps to fixed argv, nothing else is ever run, and unsupported, installed or
unknown requests are refused before any command starts."""
import unittest, tempfile, pathlib, json, io, sys, inspect
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper
try:import fcntl
except ImportError:
    # Windows has no fcntl or geteuid; the real tests run on Linux (CI). A stub keeps the logic testable here.
    fcntl=None
    import types
    stub=types.ModuleType('fcntl');stub.LOCK_EX=2;stub.LOCK_NB=4;stub.flock=lambda handle,flags:None;sys.modules['fcntl']=stub

class Host:
    """Fakes the system and records every argv the helper would run."""
    def __init__(self,os_id='ubuntu',version='24.04',installed=(),ports=(),results=None,systemd=True,uid=0):
        self.calls=[];self.events=io.StringIO();self.os_id=os_id;self.version=version;self.installed=set(installed);self.ports=list(ports)
        self.results=results or {};self.systemd=systemd;self.uid=uid
        self.directory=tempfile.TemporaryDirectory()
    def run_fixed(self,argv,timeout):
        self.calls.append(list(argv))
        return self.results.get(argv[0],(0,''))
    def patches(self):
        manager={'debian':'apt','ubuntu':'apt','fedora':'dnf','rhel':'dnf','rocky':'dnf','almalinux':'dnf'}.get(self.os_id)
        return [patch('helper.run_fixed',side_effect=self.run_fixed),patch('helper.os_release',return_value={'id':self.os_id,'versionId':self.version}),
            patch('helper.package_manager',return_value=manager),patch('helper.package_installed',side_effect=lambda name,manager=None:name in self.installed),
            patch('helper.listening_ports',return_value=self.ports),patch('helper.EVENT_STREAM',self.events),patch('helper.systemd_present',return_value=self.systemd),
            patch('helper.INSTALL_LOCK_PATH',str(pathlib.Path(self.directory.name)/'lock')),patch('helper.os.geteuid',return_value=self.uid,create=True),patch('helper.time.sleep',return_value=None)]
    def install(self,name):
        patches=self.patches()
        for item in patches:item.start()
        try:helper.install_package({'package':name})
        finally:
            for item in patches:item.stop()
    def events_list(self):
        return [json.loads(line) for line in self.events.getvalue().splitlines() if line.strip()]

class InstallTests(unittest.TestCase):
    def tearDown(self):patch.stopall()
    def test_apt_runs_update_then_install_with_fixed_argv_then_checks(self):
        host=Host();host.install('nginx')
        self.assertEqual(host.calls,[['apt-get','-o','DPkg::Lock::Timeout=120','update'],
            ['apt-get','-o','DPkg::Lock::Timeout=120','install','-y','--no-install-recommends','--no-remove','nginx'],
            ['systemctl','enable','--now','nginx'],['nginx','-v'],['nginx','-t']])
        stages=[event['stage'] for event in host.events_list() if 'stage' in event]
        self.assertEqual(stages,['connected','update','install','verify'])
        self.assertEqual(host.events_list()[-1],{'result':{'package':'nginx','installed':True}})
    def test_certbot_on_apt_adds_the_nginx_plugin_and_has_no_service(self):
        host=Host(os_id='debian',version='12');host.install('certbot')
        self.assertEqual(host.calls[1][-2:],['certbot','python3-certbot-nginx'])
        self.assertNotIn(['systemctl','enable','--now','certbot'],host.calls)
        self.assertEqual(host.calls[-1],['certbot','--version'])
    def test_dnf_installs_only_the_fixed_packages_without_a_separate_update(self):
        host=Host(os_id='fedora',version='41');host.install('docker')
        self.assertEqual(host.calls[0],['dnf','install','-y','moby-engine'])
        self.assertEqual(host.calls[1],['systemctl','enable','--now','docker'])
    def test_compose_on_ubuntu_uses_the_distro_package_and_checks_the_plugin(self):
        host=Host(version='22.04');host.install('compose')
        self.assertEqual(host.calls[1][-1],'docker-compose-v2')
        self.assertEqual(host.calls[-1],['docker','compose','version'])
    def test_without_systemd_no_service_is_started(self):
        host=Host(systemd=False);host.install('nginx')
        self.assertFalse([call for call in host.calls if call[0]=='systemctl'])
    def test_unknown_package_is_refused_before_anything_runs(self):
        for name in ['bash','nginx; rm -rf /','../nginx','','NGINX',None,['nginx'],{'a':1}]:
            host=Host()
            with self.assertRaises(ValueError):host.install(name)
            self.assertEqual(host.calls,[])
    def test_a_command_in_the_request_is_ignored(self):
        host=Host()
        patches=host.patches()
        for item in patches:item.start()
        try:helper.install_package({'package':'nginx','command':'rm -rf /','argv':['rm','-rf','/'],'packages':['evil']})
        finally:
            for item in patches:item.stop()
        flat=[part for call in host.calls for part in call]
        self.assertNotIn('rm',flat);self.assertNotIn('evil',flat)
    def test_unsupported_systems_are_refused(self):
        for os_id,version,name in [('rocky','9.4','certbot'),('rocky','9.4','docker'),('rhel','9.4','compose'),('debian','12','compose'),('ubuntu','20.04','compose'),('alpine','3.20','nginx'),('arch','','nginx'),('fedora','41','compose')]:
            host=Host(os_id=os_id,version=version)
            with self.assertRaises(ValueError):host.install(name)
            self.assertEqual(host.calls,[],(os_id,name))
    def test_already_installed_is_refused(self):
        host=Host(installed=['nginx'])
        with self.assertRaises(ValueError):host.install('nginx')
        self.assertEqual(host.calls,[])
    def test_nginx_is_refused_when_another_program_uses_port_80(self):
        host=Host(ports=[22,80])
        with self.assertRaises(ValueError) as caught:host.install('nginx')
        self.assertEqual(str(caught.exception),'PORT_80');self.assertEqual(host.calls,[])
    def test_not_root_is_refused(self):
        host=Host(uid=1000)
        with self.assertRaises(ValueError):host.install('nginx')
        self.assertEqual(host.calls,[])
    def test_failures_give_a_plain_message_and_never_return_output(self):
        secret='token=SECRET-VALUE-123'
        host=Host(results={'apt-get':(100,'e: could not get lock /var/lib/dpkg/lock '+secret)})
        with self.assertRaises(ValueError) as caught:host.install('nginx')
        self.assertEqual(str(caught.exception),'PACKAGE_TOOL_BUSY');self.assertNotIn('SECRET',str(caught.exception))
        host=Host(results={'apt-get':(1,'weird '+secret)})
        with self.assertRaises(ValueError) as caught:host.install('nginx')
        self.assertNotIn('SECRET',str(caught.exception));self.assertNotIn('SECRET',host.events.getvalue())
    def test_failed_check_after_install_is_reported(self):
        host=Host(results={'nginx':(1,'')})
        with self.assertRaises(ValueError) as caught:host.install('nginx')
        self.assertEqual(str(caught.exception),'VERIFY_FAILED')
    @unittest.skipIf(fcntl is None,'needs a real flock')
    def test_a_concurrent_install_is_refused(self):
        host=Host();patches=host.patches()
        for item in patches:item.start()
        try:
            with open(helper.INSTALL_LOCK_PATH,'a') as held:
                fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaises(ValueError):helper.install_package({'package':'nginx'})
        finally:
            for item in patches:item.stop()
        self.assertEqual(host.calls,[])
    def test_docker_from_another_source_is_never_installed_over(self):
        # docker-ce / containerd.io known to dpkg or rpm, binary present or not, means "already there".
        host=Host(installed=[])
        patches=host.patches()
        patches=[item for item in patches if getattr(item,'attribute','')!='package_installed']
        for item in patches:item.start()
        try:
            def known(manager,package):return package in ('docker-ce','containerd.io')
            with patch('helper.package_known',side_effect=known),patch('helper.shutil.which',return_value=None),patch('helper.tool_version',return_value=None):
                self.assertTrue(helper.package_installed('docker','apt'))
                self.assertFalse(helper.package_installed('nginx','apt'))
                with self.assertRaises(helper.InstallError) as caught:helper.install_package({'package':'docker'})
        finally:
            for item in patches:item.stop()
        self.assertEqual(str(caught.exception),'DOCKER_NOT_RUNNING')
        self.assertEqual([call for call in host.calls if call[0] in ('apt-get','dnf')],[])
    def test_package_known_reads_dpkg_and_rpm(self):
        with patch('helper.run_fixed',return_value=(0,'install ok installed')) as run:
            self.assertTrue(helper.package_known('apt','docker-ce'))
            self.assertEqual(run.call_args[0][0],['dpkg-query','-W','-f=${Status}','docker-ce'])
        with patch('helper.run_fixed',return_value=(0,'deinstall ok config-files')):self.assertFalse(helper.package_known('apt','docker-ce'))
        with patch('helper.run_fixed',return_value=(1,'')):self.assertFalse(helper.package_known('dnf','moby-engine'))
        with patch('helper.run_fixed',return_value=(0,'')) as run:
            self.assertTrue(helper.package_known('dnf','moby-engine'));self.assertEqual(run.call_args[0][0],['rpm','-q','moby-engine'])
        self.assertFalse(helper.package_known(None,'docker-ce'))
    def test_update_and_install_have_their_own_time_budgets(self):
        host=Host();seen=[]
        original=host.run_fixed
        def record(argv,timeout):
            seen.append((argv[1:3] if argv[0]=='apt-get' else argv[:1],timeout));return original(argv,timeout)
        host.run_fixed=record
        host.install('nginx')
        self.assertEqual(seen[0][1],helper.INSTALL_UPDATE_TIMEOUT);self.assertEqual(seen[1][1],helper.INSTALL_TIMEOUT)
        self.assertLess(helper.INSTALL_UPDATE_TIMEOUT,helper.INSTALL_TIMEOUT)
    def test_timeouts_say_what_to_do_and_apt_mentions_dpkg(self):
        self.assertEqual(helper.install_failure(-1,'','apt','update'),'TIMEOUT_APT_UPDATE')
        self.assertEqual(helper.install_failure(-1,'','apt','install'),'TIMEOUT_APT_INSTALL')
        self.assertEqual(helper.install_failure(-1,'','dnf','install'),'TIMEOUT_INSTALL')
        host=Host(results={'apt-get':(-1,'')})
        with self.assertRaises(helper.InstallError) as caught:host.install('nginx')
        self.assertEqual(str(caught.exception),'TIMEOUT_APT_UPDATE')
    def test_a_stuck_tool_gets_sigterm_then_sigkill_after_the_wait(self):
        class Stuck:
            pid=4242
            def __init__(self):self.waits=[]
            def wait(self,timeout=None):
                self.waits.append(timeout)
                if timeout is not None:raise helper.subprocess.TimeoutExpired('x',timeout)
        stuck=Stuck();signals=[]
        with patch('helper.os.killpg',side_effect=lambda pid,sig:signals.append((pid,sig)),create=True),patch('helper.signal.SIGKILL',9,create=True),patch('helper.signal.SIGTERM',15,create=True):
            helper.stop_group(stuck)
        self.assertEqual([item[1] for item in signals],[15,9])
        self.assertEqual(stuck.waits,[helper.INSTALL_KILL_WAIT,None])
    def test_unexpected_errors_become_a_fixed_code_and_never_their_text(self):
        host=Host()
        patches=host.patches()+[patch('helper.verify_install',side_effect=OSError('/etc/secret token=abc123'))]
        for item in patches:item.start()
        try:
            with self.assertRaises(helper.InstallError) as caught:helper.install_package({'package':'nginx'})
        finally:
            for item in patches:item.stop()
        self.assertEqual(str(caught.exception),'GENERIC');self.assertNotIn('abc123',str(caught.exception))
    def test_every_error_the_helper_raises_is_a_known_code(self):
        import re
        source=pathlib.Path(helper.__file__).read_text()
        section=source[source.index('# ---- Install on server'):source.index('def place_tree(')]
        self.assertNotIn('ValueError(',section)
        codes=set(re.findall(r"InstallError\('([A-Z_0-9]+)'\)",section))|set(re.findall(r"return '([A-Z_0-9]{4,})'",section))|{'TIMEOUT_APT_UPDATE','TIMEOUT_APT_INSTALL','TIMEOUT_UPDATE','TIMEOUT_INSTALL'}
        plan=(pathlib.Path(helper.__file__).parent.parent/'src'/'install-plan.js').read_text()
        for code in codes:self.assertIn('  '+code+':',plan,code)
        self.assertGreater(len(codes),12)
    def test_candidate_versions_are_parsed_defensively(self):
        self.assertEqual(helper.version_head('5:27.5.1-1'),'27.5');self.assertEqual(helper.version_head('26.1.3+dfsg1-0ubuntu1'),'26.1')
        self.assertIsNone(helper.version_head('(none)'));self.assertIsNone(helper.version_head('x; rm -rf /'))
        with patch('helper.run_fixed',return_value=(0,'docker.io:\n  installed: (none)\n  candidate: 28.2.2-0ubuntu1\n')) as run:
            self.assertEqual(helper.install_candidates('apt'),{'docker':'28.2'});self.assertEqual(run.call_args[0][0],['apt-cache','policy','docker.io'])
        with patch('helper.run_fixed',return_value=(0,'name : moby-engine\nversion : 25.0.5\nrelease : 1.fc41\n')):
            self.assertEqual(helper.install_candidates('dnf'),{'docker':'25.0'})
        with patch('helper.run_fixed',return_value=(0,'candidate: (none)\n')):self.assertEqual(helper.install_candidates('apt'),{})
        with patch('helper.run_fixed',return_value=(100,'')):self.assertEqual(helper.install_candidates('apt'),{})
        self.assertEqual(helper.install_candidates(None),{})
    def test_support_matrix(self):
        cases=[('apt','ubuntu','24.04','compose',True),('apt','ubuntu','20.04','compose',False),('apt','debian','12','nginx',True),('apt','debian','12','compose',False),
            ('apt','linuxmint','21','nginx',False),('dnf','fedora','41','certbot',True),('dnf','rocky','9.4','nginx',True),('dnf','rocky','9.4','certbot',False),
            ('dnf','almalinux','9.4','docker',False),('dnf','fedora','41','compose',False),(None,'ubuntu','24.04','nginx',False)]
        for manager,os_id,version,name,expected in cases:
            self.assertEqual(helper.install_supported(manager,os_id,version,name),expected,(manager,os_id,version,name))
    def test_os_release_is_read_defensively(self):
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'os-release';path.write_text('NAME="Ubuntu"\nID=Ubuntu\nVERSION_ID="24.04"\nID_LIKE=debian\n')
            real=pathlib.Path
            with patch('helper.pathlib.Path',side_effect=lambda value:path if value=='/etc/os-release' else real(value)):
                self.assertEqual(helper.os_release(),{'id':'ubuntu','versionId':'24.04'})
            path.write_text('ID=$(reboot)\nVERSION_ID="x; y"\n')
            with patch('helper.pathlib.Path',side_effect=lambda value:path if value=='/etc/os-release' else real(value)):
                self.assertEqual(helper.os_release(),{'id':'','versionId':''})
    def test_source_never_uses_a_shell_or_string_commands(self):
        source=''.join(inspect.getsource(item) for item in [helper.run_fixed,helper.install_package,helper.install_locked,helper.verify_install,helper.install_status])
        self.assertNotIn('shell=True',source);self.assertNotIn('os.system',source);self.assertNotIn('check_output',source)
        self.assertIn('shell=False',source)

if __name__=='__main__':unittest.main()
