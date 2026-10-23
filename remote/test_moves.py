"""Move helper operations (docs/moving-sites.md) and the golden restore test that proves the shared
restore code paths did not change isolated restore. Run: python3 remote/test_moves.py"""
import unittest, tempfile, pathlib, json, io, hashlib, os, sys
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper

GOLDEN=pathlib.Path(__file__).parent/'fixtures'/'restore-golden.json'
JOB='0b5e8d3c-1f2a-4c3d-9e8f-123456789abc'

def fixture_manifest():
    def container(i,name,running,ports=None):
        return {'Id':'c%d'%i,'Name':'/'+name,'State':{'Running':running},'Config':{'Hostname':name,'Image':'img','Env':['DATABASE_URL=postgres://user:secret@10.0.0.5:5432/app','PLAIN=1'],'Labels':{'com.docker.compose.project':'shop'}},
            'HostConfig':{'NetworkMode':'shop_default','RestartPolicy':{'Name':'unless-stopped'},'PortBindings':ports or {},'Tmpfs':{}},
            'NetworkSettings':{'Networks':{'shop_default':{'Aliases':[name]}},'Ports':{}},
            'Mounts':[{'Type':'volume','Name':'shop_data%d'%i,'Source':'/var/lib/docker/volumes/shop_data%d/_data'%i,'Destination':'/data','RW':True},{'Type':'bind','Source':'/srv/shop/config.txt','Destination':'/config.txt','RW':False}]}
    return {'formatVersion':1,'complete':True,'architecture':'x86_64','containers':[container(0,'web',True,{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'8080'}]}),container(1,'db',True)],
        'snapshotImages':['sha256:aaa','sha256:bbb'],'backupPlan':{'services':[],'restartOrder':['c1','c0']},'configurationFiles':[],'temporaryMemoryFolders':[]}

class FakeHost:
    """Records docker invocations and fakes their output; safe_extract creates the one entry a mount archive holds."""
    def __init__(self,root,manifest):
        self.root=pathlib.Path(root);self.manifest=manifest;self.calls=[];self.events=io.StringIO();self.existing=set()
    def docker(self,*args):
        self.calls.append(list(args))
        if args[:2]==('info','--format'):return b'x86_64\n'
        if args[:2]==('version','--format'):return b'29.0.0\n'
        if args[:2]==('network','inspect'):return json.dumps([{'Internal':True,'Options':{'com.docker.network.bridge.gateway_mode_ipv4':'isolated'},'Labels':{}}]).encode()
        if args[:2]==('volume','create'):
            mount=self.root/'volumes'/args[-1]/'_data';mount.mkdir(parents=True);return (args[-1]+'\n').encode()
        if args[:2]==('volume','inspect'):return json.dumps([{'Mountpoint':str(self.root/'volumes'/args[-1]/'_data')}]).encode()
        if args[0]=='create':return (args[args.index('--name')+1]+'-id\n').encode()
        if args[0]=='inspect':return json.dumps([{'Id':a,'State':{'Running':True},'NetworkSettings':{'Networks':{'shop_default':{'IPAddress':'172.18.0.2'}}}} for a in args[1:]]).encode()
        if args[0]=='ps':return b''
        return b''
    def safe_extract(self,archive,destination):
        destination=pathlib.Path(destination);destination.mkdir(parents=True,exist_ok=True)
        name=pathlib.Path(archive).name
        if name=='payload.tar.gz':(destination/'manifest.json').write_text(json.dumps(self.manifest));return
        if name.startswith('mount-') and name.endswith('-1.tar'):(destination/'config.txt').write_text('DATABASE_URL=postgres://u:p@10.0.0.5/app\n');return
        (destination/'entry').mkdir()
    def patches(self):
        return [patch('helper.docker',side_effect=self.docker),patch('helper.safe_extract',side_effect=self.safe_extract),patch('helper.verify_artifacts',return_value=True),
            patch('helper.health',return_value=True),patch('helper.restart_services',return_value=None),patch('helper.EVENT_STREAM',self.events),patch('helper.time.sleep',return_value=None)]
    def result(self):
        return [json.loads(line) for line in self.events.getvalue().splitlines() if line.strip()]

def normalise(value,root):
    text=json.dumps(value,sort_keys=True).replace(json.dumps(str(root))[1:-1],'<ROOT>')
    return json.loads(text.replace('\\\\','/'))

def run_restore(temporary):
    root=pathlib.Path(temporary)/JOB;root.mkdir()
    payload=root/'payload.tar.gz';payload.write_bytes(b'payload')
    host=FakeHost(temporary,fixture_manifest())
    with patch('helper.owned_job_root',return_value=root),patch('helper.shutil.disk_usage',return_value=type('U',(),{'free':10**15})()):
        patches=host.patches()
        for item in patches:item.start()
        try:helper.restore({'job':JOB,'plaintextChecksum':hashlib.sha256(b'payload').hexdigest()})
        finally:
            for item in patches:item.stop()
    return normalise({'docker':host.calls,'events':host.result()},temporary)

class RestoreGoldenTests(unittest.TestCase):
    def test_isolated_restore_commands_and_result_are_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:actual=run_restore(temporary)
        if os.environ.get('DOCKNEST_WRITE_GOLDEN')=='1':GOLDEN.write_text(json.dumps(actual,indent=1,sort_keys=True)+'\n')
        self.assertEqual(actual,json.loads(GOLDEN.read_text()))
        creates=[call for call in actual['docker'] if call[0]=='create']
        self.assertTrue(all(call[call.index('--network')+1].startswith('dbm-restore-') for call in creates))
        self.assertTrue(all('-p' not in call for call in creates),'isolated restore never publishes ports')

MOVE='7c9e6679-7425-40de-944b-e07fc1f90ae7';SITE='1b4e28ba-2fa1-11d2-883f-0016d3cca427'

class MoveFactTests(unittest.TestCase):
    def test_masked_values_keep_scheme_host_and_port_only(self):
        self.assertEqual(helper.mask_value('postgres://user:secret@10.0.0.5:5432/app?sslmode=require','10.0.0.5'),'postgres://10.0.0.5:5432')
        self.assertEqual(helper.mask_value('s3cret-10.0.0.5:6379','10.0.0.5'),'10.0.0.5:6379')
        self.assertEqual(helper.mask_value('10.0.0.5','10.0.0.5'),'10.0.0.5')
    def test_env_findings_name_keys_and_never_return_values(self):
        containers=[{'Name':'/web','Config':{'Env':['DATABASE_URL=postgres://u:topsecret@old.example.com:5432/db','OTHER=old.example.community','PASSWORD=hunter2']}}]
        with tempfile.TemporaryDirectory() as temporary:
            env=pathlib.Path(temporary)/'.env';env.write_text('REDIS_URL="redis://:pw@10.0.0.5:6379/0"\nNAME=x\n')
            findings=helper.env_findings(containers,[str(env)],['old.example.com','10.0.0.5'])
        self.assertEqual([(f['key'],f['kind'],f['masked']) for f in findings],[('DATABASE_URL','host','postgres://old.example.com:5432'),('REDIS_URL','ip','redis://10.0.0.5:6379')])
        self.assertNotIn('topsecret',json.dumps(findings));self.assertNotIn('pw@',json.dumps(findings))
    def test_rewrite_replaces_whole_host_tokens_only(self):
        self.assertEqual(helper.rewrite_value('http://10.0.0.5:80/x','10.0.0.50'.split()+['10.0.0.5'],'10.0.0.9'),'http://10.0.0.9:80/x')
        self.assertEqual(helper.rewrite_value('http://10.0.0.50/','x 10.0.0.5'.split(),'10.0.0.9'),'http://10.0.0.50/')
    def test_paths_a_move_may_create_exclude_system_folders(self):
        for bad in ['/','/etc','/var/lib/docker','relative/path','/srv/../etc/x','/proc/1/x','/srv']:
            with self.assertRaises(ValueError,msg=bad):helper.move_path(bad)
        self.assertEqual(str(helper.move_path('/srv/shop/data')).replace('\\','/'),'/srv/shop/data')
    def test_port_mapping_keeps_container_port_and_binds_tests_to_loopback(self):
        binding={'hostIp':'0.0.0.0','hostPort':8080,'containerPort':80,'protocol':'tcp'}
        plan=[{'from':8080,'to':8081,'containerPort':80,'protocol':'tcp'}]
        self.assertEqual(helper.mapped_port(plan,binding,'test'),('127.0.0.1:8081:80/tcp',8081))
        self.assertEqual(helper.mapped_port(plan,binding,'live'),('8081:80/tcp',8081))
        self.assertEqual(helper.mapped_port([],{**binding,'hostIp':'127.0.0.1'},'live'),('127.0.0.1:8080:80/tcp',8080))
    def test_nginx_file_is_owned_and_proxies_to_the_remapped_port(self):
        conf=helper.nginx_site_conf(MOVE,{'siteId':SITE,'domains':['shop.example.com','www.shop.example.com'],'upstreamPort':8081,'maintenanceDirectory':'/var/lib/docknest/maintenance/'+SITE})
        self.assertTrue(conf.startswith('# Managed by DockNest move '+MOVE+';'))
        self.assertIn('server_name shop.example.com www.shop.example.com;',conf);self.assertIn('proxy_pass http://127.0.0.1:8081;',conf)
        self.assertIn('/.well-known/acme-challenge/',conf);self.assertNotIn('443',conf)
        with self.assertRaises(ValueError):helper.nginx_site_conf(MOVE,{'siteId':SITE,'domains':['bad domain;'],'upstreamPort':80,'maintenanceDirectory':'/var/lib/docknest/m/x'})
        with self.assertRaises(ValueError):helper.nginx_site_conf(MOVE,{'siteId':SITE,'domains':['a.example.com'],'upstreamPort':80,'maintenanceDirectory':'/var/lib/docknest/m/x;evil'})
    def test_target_probe_reports_conflicts_and_non_empty_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            full=pathlib.Path(temporary)/'full';full.mkdir();(full/'x').write_text('1');empty=pathlib.Path(temporary)/'empty';empty.mkdir()
            outputs={'ps':b'web\nother\n','volume':b'shop_data\n','network':b'bridge\nshop_default\n'}
            with patch('helper.docker',side_effect=lambda *a:outputs[a[0]]):
                probe=helper.target_probe({'paths':[str(full),str(empty),str(pathlib.Path(temporary)/'absent')],'names':{'containers':['web','db'],'volumes':['shop_data'],'networks':['shop_net']}})
        self.assertEqual([(pathlib.Path(p['path']).name,p['empty']) for p in probe['existingPaths']],[('full',False),('empty',True)])
        self.assertEqual(probe['conflicts'],{'containers':['web'],'volumes':['shop_data'],'networks':[]})
    def test_teardown_refuses_after_finalize_and_is_a_no_op_without_a_move(self):
        with tempfile.TemporaryDirectory() as temporary,patch('helper.MOVES_ROOT',pathlib.Path(temporary)),patch('helper.EVENT_STREAM',io.StringIO()) as events:
            helper.deploy_teardown({'moveId':MOVE});self.assertIn('nothingToDo',events.getvalue())
            (pathlib.Path(temporary)/MOVE).mkdir();(pathlib.Path(temporary)/MOVE/'finalized').write_text('{}')
            with self.assertRaises(ValueError):helper.deploy_teardown({'moveId':MOVE})
        with self.assertRaises(ValueError):helper.deploy_teardown({'moveId':'../etc'})

@unittest.skipUnless(os.name=='posix','Deploy places files at absolute POSIX paths')
class DeployRestoreTests(unittest.TestCase):
    def deploy(self,temporary,mode='test',manifest=None):
        base=pathlib.Path(temporary)
        manifest=manifest or fixture_manifest()
        for c in manifest['containers']:
            for m in c['Mounts']:
                if m['Type']=='bind':m['Source']=str(base/'srv'/'shop'/'config.txt')
        root=base/'staging'/JOB;root.mkdir(parents=True);(root/'payload.tar.gz').write_bytes(b'payload')
        host=FakeHost(temporary,manifest)
        with patch('helper.owned_job_root',return_value=root),patch('helper.MOVES_ROOT',base/'moves'),patch('helper.shutil.disk_usage',return_value=type('U',(),{'free':10**15})()),patch('helper.shutil.which',return_value=None):
            patches=host.patches()
            for item in patches:item.start()
            try:helper.deploy_restore({'moveId':MOVE,'job':JOB,'mode':mode,'plaintextChecksum':hashlib.sha256(b'payload').hexdigest(),'portMap':[{'from':8080,'to':8081,'containerPort':8080,'protocol':'tcp'}],
                'networks':[{'name':'shop_default','driver':'bridge','labels':{'com.docker.compose.project':'shop'}}],'envRewrite':{'keys':['DATABASE_URL'],'from':['10.0.0.5'],'to':'10.0.0.9'}})
            finally:
                for item in patches:item.stop()
        return host,root,base
    def test_test_deploy_publishes_loopback_ports_without_restart_and_journals_first(self):
        with tempfile.TemporaryDirectory() as temporary:
            host,root,base=self.deploy(temporary)
            creates=[c for c in host.calls if c[0]=='create']
            self.assertEqual(len(creates),2)
            web=creates[0]
            self.assertEqual(web[web.index('--restart')+1],'no');self.assertIn('127.0.0.1:8081:8080/tcp',web);self.assertIn('docknest.move='+MOVE,web)
            self.assertEqual(web[web.index('--network')+1],'shop_default');self.assertIn('-e',web)
            self.assertIn('DATABASE_URL=postgres://user:secret@10.0.0.9:5432/app',web)
            self.assertTrue((base/'srv'/'shop'/'config.txt').exists());self.assertFalse(root.exists(),'plaintext staging is removed')
            state=json.loads((base/'moves'/MOVE/'resources.json').read_text())
            self.assertEqual(state['created']['volumes'],['shop_data0','shop_data1']);self.assertEqual(state['created']['networks'],['shop_default'])
            self.assertEqual(state['created']['containers'],['web','db']);self.assertIn('test',state['deployed'])
            self.assertEqual(state['deployed']['test']['ports'][0]['to'],8081)
    def test_deploy_refuses_existing_folders_and_teardown_removes_only_created_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);keep=base/'srv'/'keep.txt';keep.parent.mkdir(parents=True);keep.write_text('owner data')
            host,root,base=self.deploy(temporary)
            calls=[]
            def docker(*args):
                calls.append(list(args))
                if args[:2]==('ps','-aq'):return b'cid1 cid2'
                if args[:2]==('volume','ls'):return b'shop_data0\nshop_data1\n'
                if args[:2]==('network','ls'):return b'netid\n'
                return b''
            with patch('helper.MOVES_ROOT',base/'moves'),patch('helper.docker',side_effect=docker),patch('helper.EVENT_STREAM',io.StringIO()),patch('helper.shutil.which',return_value=None):helper.deploy_teardown({'moveId':MOVE})
            self.assertIn(['rm','-f','cid1','cid2'],calls);self.assertIn(['volume','rm','shop_data0'],calls);self.assertIn(['network','rm','netid'],calls)
            self.assertFalse((base/'srv'/'shop').exists());self.assertEqual(keep.read_text(),'owner data');self.assertFalse((base/'moves'/MOVE).exists())
            __import__('shutil').rmtree(base/'volumes');(base/'srv'/'shop').mkdir();(base/'srv'/'shop'/'config.txt').write_text('existing')
            with self.assertRaises(ValueError) as refused:self.deploy(temporary)
            self.assertIn('never overwrites',str(refused.exception))
    def test_a_finished_deploy_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.deploy(temporary)
            host=FakeHost(temporary,fixture_manifest())
            with patch('helper.MOVES_ROOT',pathlib.Path(temporary)/'moves'),patch('helper.docker',side_effect=host.docker),patch('helper.EVENT_STREAM',host.events):
                helper.deploy_restore({'moveId':MOVE,'job':JOB,'mode':'test'})
            self.assertEqual(host.calls,[]);self.assertEqual(host.result()[0]['result']['mode'],'test')

class KeepStoppedTests(unittest.TestCase):
    def test_capture_documents_keep_stopped_only_after_a_complete_capture(self):
        source=pathlib.Path(helper.__file__).read_text()
        self.assertIn("keep_stopped=bool(req.get('keepStopped')) and captured is not None",source)

if __name__=='__main__':unittest.main()
