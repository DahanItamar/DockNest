"""Move helper operations (docs/moving-sites.md) and the golden restore test that proves the shared
restore code paths did not change isolated restore. Run: python3 remote/test_moves.py"""
import unittest, tempfile, pathlib, json, io, hashlib, os, sys, tarfile, subprocess
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
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
    def __init__(self,root,manifest,archive_tags=()):
        self.root=pathlib.Path(root);self.manifest=manifest;self.calls=[];self.events=io.StringIO();self.existing=set()
        self.archive_tags=list(archive_tags);self.tags={}
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
        if args[:2]==('image','inspect'):
            if args[-1] in self.tags:return self.tags[args[-1]].encode()
            raise subprocess.CalledProcessError(1,['docker'])
        if args[0]=='load':
            for tag in self.archive_tags:self.tags[tag]='sha256:loaded'
        if args[0]=='tag':self.tags[args[2]]=args[1]
        return b''
    def safe_extract(self,archive,destination):
        destination=pathlib.Path(destination);destination.mkdir(parents=True,exist_ok=True)
        name=pathlib.Path(archive).name
        if name=='payload.tar.gz':
            (destination/'manifest.json').write_text(json.dumps(self.manifest))
            # A DockNest backup saves images by ID, so its archive names no tags; a forged one may.
            data=json.dumps([{'Config':'x.json','RepoTags':self.archive_tags or None,'Layers':[]}]).encode()
            with tarfile.open(destination/'images.tar','w') as tar:
                info=tarfile.TarInfo('manifest.json');info.size=len(data);tar.addfile(info,io.BytesIO(data))
            return
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
    def deploy(self,temporary,mode='test',manifest=None,archive_tags=(),tags=None):
        base=pathlib.Path(temporary)
        manifest=manifest or fixture_manifest()
        for c in manifest['containers']:
            for m in c['Mounts']:
                if m['Type']=='bind':m['Source']=str(base/'srv'/'shop'/'config.txt')
        root=base/'staging'/JOB;root.mkdir(parents=True);(root/'payload.tar.gz').write_bytes(b'payload')
        host=FakeHost(temporary,manifest,archive_tags);host.tags.update(tags or {});self.host=host
        # The test folders live below /tmp, which is not an application root (MoveSafetyTests covers the roots).
        with patch('helper.owned_job_root',return_value=root),patch('helper.MOVES_ROOT',base/'moves'),patch('helper.shutil.disk_usage',return_value=type('U',(),{'free':10**15})()),patch('helper.shutil.which',return_value=None),patch('helper.move_root_allowed',return_value=True):
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
            self.assertEqual(state['created']['volumes'],['shop_data0','shop_data1']);self.assertEqual(state['created']['networks'],['shop_default','dn-test-'+MOVE[:12]])
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
    def test_a_test_copy_never_joins_the_shared_default_bridge(self):
        manifest=fixture_manifest()
        for c in manifest['containers']:
            c['HostConfig']['NetworkMode']='bridge';c['NetworkSettings']['Networks']={'bridge':{'Aliases':None}}
        with tempfile.TemporaryDirectory() as temporary:
            host,_,_=self.deploy(temporary,manifest=manifest)
            creates=[c for c in host.calls if c[0]=='create']
            self.assertTrue(all(c[c.index('--network')+1]=='dn-test-'+MOVE[:12] for c in creates))
            self.assertFalse(any(c[:2]==['network','connect'] for c in host.calls))
            self.assertIn(['network','create','--driver','bridge','--label','docknest.move='+MOVE,'dn-test-'+MOVE[:12]],host.calls)
    def test_a_forged_network_key_never_reaches_docker_create(self):
        for network in ['host','container:0123456789ab']:
            manifest=fixture_manifest()
            for c in manifest['containers']:c['HostConfig']['NetworkMode']='bridge';c['NetworkSettings']['Networks']={network:{}}
            with tempfile.TemporaryDirectory() as temporary:
                with self.assertRaisesRegex(ValueError,'shared namespace'):self.deploy(temporary,mode='live',manifest=manifest)
                self.assertFalse(any(c[0] in ['create','load'] for c in self.host.calls),network)
    def test_a_dot_dot_configuration_file_never_reaches_the_settings_rewrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);other=base/'other'/'.env';other.parent.mkdir();other.write_text('DATABASE_URL=postgres://u:p@10.0.0.5/app')
            manifest=fixture_manifest();manifest['configurationFiles']=[str(base/'srv'/'shop'/'config.txt')+'/../../../other/.env']
            with self.assertRaisesRegex(ValueError,'Unsupported path for a move'):self.deploy(temporary,manifest=manifest)
            self.assertEqual(other.read_text(),'DATABASE_URL=postgres://u:p@10.0.0.5/app')
            self.assertFalse(any(c[0]=='load' for c in self.host.calls))
    def test_settings_are_rewritten_only_in_files_the_move_placed(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);link=base/'srv'/'shop'/'config.txt'
            other=base/'other.env';other.write_text('DATABASE_URL=postgres://u:p@10.0.0.5/app')
            self.assertFalse(helper.placed_by_move(str(other),[str(base/'srv'/'shop')]))
            self.assertTrue(helper.placed_by_move(str(base/'srv'/'shop'/'.env'),[str(base/'srv'/'shop')]))
            link.parent.mkdir(parents=True);link.symlink_to(other)
            self.assertFalse(helper.placed_by_move(str(link),[str(base/'srv'/'shop')]),'a link out of the placed folder is not followed')
    def test_a_tagged_image_archive_is_never_loaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError,'save images by ID only'):self.deploy(temporary,archive_tags=['nginx:latest'],tags={'nginx:latest':'sha256:owner'})
            self.assertFalse(any(c[0] in ['load','create'] for c in self.host.calls));self.assertEqual(self.host.tags['nginx:latest'],'sha256:owner')
    def test_a_protected_mount_is_never_written_by_a_move(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest=fixture_manifest();manifest['protectedMounts']=[{'container':'web','source':str(pathlib.Path(temporary)/'srv'/'shop'/'config.txt'),'destination':'/config.txt'}]
            with self.assertRaisesRegex(ValueError,'does not copy; move this site by hand'):self.deploy(temporary,manifest=manifest)
            self.assertFalse((pathlib.Path(temporary)/'srv'/'shop').exists())
            self.assertFalse(any(c[0] in ['load','create'] for c in self.host.calls))
    def test_configuration_file_spellings_are_normalised_before_the_containment_test(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);manifest=fixture_manifest()
            # Already inside a placed mount (trailing slash, '//', './'), and a new file spelt with '//' and './'.
            manifest['configurationFiles']=[str(base/'srv'/'shop'/'config.txt')+'/',str(base/'srv')+'//shop/./config.txt',str(base/'srv')+'//site/./app.env']
            host,_,_=self.deploy(temporary,manifest=manifest)
            self.assertTrue((base/'srv'/'site'/'app.env').exists());self.assertTrue((base/'srv'/'shop'/'config.txt').exists())
            state=json.loads((base/'moves'/MOVE/'resources.json').read_text())
            self.assertIn(str(base/'srv'/'site'/'app.env'),state['deployed']['test']['paths'])
            for bad in ['srv/shop/.env','./srv/x.env',str(base/'srv')+'/a/../b.env']:
                manifest['configurationFiles']=[bad]
                with tempfile.TemporaryDirectory() as again:
                    with self.assertRaisesRegex(ValueError,'Unsupported path for a move',msg=bad):self.deploy(again,manifest=manifest)
    def test_a_destination_through_a_symbolic_link_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);(base/'real').mkdir();(base/'link').symlink_to(base/'real')
            d,state=base/'moves',{'created':{'paths':[]}}
            with patch('helper.move_root_allowed',return_value=True),self.assertRaisesRegex(ValueError,'symbolic link'):helper.place_tree(base/'unused.tar',str(base/'link'/'app'),d,state,MOVE)
            self.assertEqual(list((base/'real').iterdir()),[])
    def test_a_finished_deploy_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.deploy(temporary)
            host=FakeHost(temporary,fixture_manifest())
            with patch('helper.MOVES_ROOT',pathlib.Path(temporary)/'moves'),patch('helper.docker',side_effect=host.docker),patch('helper.EVENT_STREAM',host.events):
                helper.deploy_restore({'moveId':MOVE,'job':JOB,'mode':'test'})
            self.assertEqual(host.calls,[]);self.assertEqual(host.result()[0]['result']['mode'],'test')

class ComposeOverrideTests(unittest.TestCase):
    def test_override_remaps_host_ports_only_and_never_restarts_the_test_copy(self):
        manifest=fixture_manifest();compose={'project':'shop','workingDir':'/srv/shop','files':['/srv/shop/compose.yaml'],'services':{'web':'web','db':'db'}}
        text,ports,rewritten=helper.compose_override(compose,MOVE,'test',manifest,[{'from':8080,'to':8081,'containerPort':8080,'protocol':'tcp'}],{'DATABASE_URL'},['10.0.0.5'],'10.0.0.9')
        self.assertIn('  "web":\n    image: "sha256:aaa"\n    pull_policy: never\n    ports: !override\n      - "127.0.0.1:8081:8080/tcp"\n    restart: "no"',text)
        self.assertIn('  "db":\n    image: "sha256:bbb"\n    pull_policy: never\n    ports: !override []',text)
        self.assertIn('docknest.move: "%s"'%MOVE,text);self.assertIn('"DATABASE_URL": "postgres://user:secret@10.0.0.9:5432/app"',text)
        self.assertEqual(rewritten,2);self.assertEqual(ports[0]['to'],8081)
        live,_,_=helper.compose_override(compose,MOVE,'live',manifest,[],set(),[],'')
        self.assertNotIn('restart',live);self.assertNotIn('environment',live);self.assertIn('"127.0.0.1:8080:8080/tcp"',live)
    def test_unknown_service_is_refused(self):
        with self.assertRaises(ValueError):helper.compose_override({'services':{}},MOVE,'test',fixture_manifest(),[],set(),[],'')

class SwitchBackAndRemovalTests(unittest.TestCase):
    def run_op(self,op,req,docker_outputs,temporary):
        calls=[];events=io.StringIO()
        def docker(*args):
            calls.append(list(args))
            for prefix,value in docker_outputs:
                if list(args[:len(prefix)])==prefix:return value(args) if callable(value) else value
            return b''
        with patch('helper.MOVES_ROOT',pathlib.Path(temporary)),patch('helper.docker',side_effect=docker),patch('helper.EVENT_STREAM',events),patch('helper.atomic_json',side_effect=lambda p,v:pathlib.Path(p).write_text(json.dumps(v))):
            op(req)
        return calls,json.loads(events.getvalue().splitlines()[-1])['result']
    def test_stop_target_keeps_the_copy_and_records_policies_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            (pathlib.Path(temporary)/MOVE).mkdir()
            inspected=[{'Id':'n1','Name':'/web','State':{'Running':True},'HostConfig':{'RestartPolicy':{'Name':'always'}}}]
            calls,result=self.run_op(helper.move_stop_target,{'moveId':MOVE},[(['ps'],b'n1'),(['inspect'],json.dumps(inspected).encode())],temporary)
            self.assertEqual(result['containers'][0]['restartPolicy'],'always');self.assertIn(['update','--restart=no','n1'],calls)
            self.assertFalse(any(call[0]=='rm' for call in calls),'switch back never deletes the new copy')
            again,_=self.run_op(helper.move_stop_target,{'moveId':MOVE},[],temporary);self.assertEqual(again,[])
    def test_remove_old_copy_keeps_data_unless_asked_and_refuses_a_running_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            d=pathlib.Path(temporary)/MOVE;d.mkdir()
            (d/'retired.json').write_text(json.dumps({'containers':[{'id':'o1','name':'web','restartPolicy':'always'}]}))
            old=[{'Id':'o1','State':{'Running':True},'Mounts':[{'Type':'volume','Name':'shop_data','Source':'/var/lib/docker/volumes/shop_data/_data'}]}]
            with self.assertRaises(ValueError):self.run_op(helper.move_remove_old,{'moveId':MOVE,'config':{}},[(['ps','-aq','--no-trunc'],b'o1'),(['inspect'],json.dumps(old).encode())],temporary)
            old[0]['State']['Running']=False
            calls,result=self.run_op(helper.move_remove_old,{'moveId':MOVE,'config':{}},[(['ps','-aq','--no-trunc'],b'o1'),(['inspect'],json.dumps(old).encode())],temporary)
            self.assertIn(['rm','o1'],calls);self.assertFalse(any(call[:2]==['volume','rm'] for call in calls));self.assertTrue(result['dataKept'])
            self.assertTrue((d/'removed.json').is_file());self.assertFalse((d/'retired.json').exists())
    def test_remove_old_copy_deletes_unshared_volumes_only_when_asked(self):
        with tempfile.TemporaryDirectory() as temporary:
            d=pathlib.Path(temporary)/MOVE;d.mkdir()
            (d/'retired.json').write_text(json.dumps({'containers':[{'id':'o1','name':'web','restartPolicy':'always'}]}))
            old=[{'Id':'o1','State':{'Running':False},'Mounts':[{'Type':'volume','Name':'shop_data','Source':'/x'},{'Type':'volume','Name':'shared','Source':'/y'}]}]
            other=[{'Id':'z','Mounts':[{'Type':'volume','Name':'shared','Source':'/y'}]}]
            outputs=[(['ps','-aq','--no-trunc'],b'o1'),(['ps','-aq'],b'z'),(['inspect','o1'],json.dumps(old).encode()),(['inspect','z'],json.dumps(other).encode())]
            calls,result=self.run_op(helper.move_remove_old,{'moveId':MOVE,'config':{},'deleteData':True},outputs,temporary)
            self.assertEqual(result['volumes'],['shop_data']);self.assertNotIn(['volume','rm','shared'],calls)
    @unittest.skipUnless(os.name=='posix','Removes real folders')
    def test_remove_old_copy_deletes_only_read_write_data_not_used_elsewhere(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);d=base/'moves'/MOVE;d.mkdir(parents=True)
            data=base/'srv'/'data';ro=base/'srv'/'certs';other=base/'srv'/'other-site';sysdir=pathlib.Path('/etc')
            for folder in [data,ro,other]:folder.mkdir(parents=True)
            (d/'retired.json').write_text(json.dumps({'containers':[{'id':'o1','name':'web','restartPolicy':'always'}]}))
            mounts=[{'Type':'bind','Source':str(data),'RW':True},{'Type':'bind','Source':str(ro),'RW':False},{'Type':'bind','Source':str(other),'RW':True},{'Type':'bind','Source':'/etc/letsencrypt','RW':True}]
            old=[{'Id':'o1','State':{'Running':False},'Mounts':mounts}]
            outputs=[(['ps','-aq','--no-trunc'],b'o1'),(['ps','-aq'],b''),(['inspect','o1'],json.dumps(old).encode())]
            with patch('helper.nginx_sites',return_value=[]):
                _,result=self.run_op(helper.move_remove_old,{'moveId':MOVE,'config':{},'deleteData':True,'keepPaths':[str(other)]},outputs,str(base/'moves'))
            self.assertFalse(data.exists());self.assertTrue(ro.exists(),'read-only mounts are not this site\'s data');self.assertTrue(other.exists(),'declared by another site')
            self.assertTrue(sysdir.exists());self.assertIn('/etc/letsencrypt',result['kept']);self.assertEqual(result['paths'],[str(data)])
    @unittest.skipUnless(os.name=='posix','Uses real symbolic links')
    def test_remove_old_copy_compares_real_paths_and_never_removes_a_home_folder(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);d=base/'moves'/MOVE;d.mkdir(parents=True)
            shared=base/'srv'/'shared';shared.mkdir(parents=True);link=base/'srv'/'alias';link.symlink_to(shared)
            (d/'retired.json').write_text(json.dumps({'containers':[{'id':'o1','name':'web','restartPolicy':'always'}]}))
            mounts=[{'Type':'bind','Source':str(link),'RW':True},{'Type':'bind','Source':'/home/alice','RW':True}]
            old=[{'Id':'o1','State':{'Running':False},'Mounts':mounts}]
            outputs=[(['ps','-aq','--no-trunc'],b'o1'),(['ps','-aq'],b''),(['inspect','o1'],json.dumps(old).encode())]
            with patch('helper.nginx_sites',return_value=[]):
                _,result=self.run_op(helper.move_remove_old,{'moveId':MOVE,'config':{},'deleteData':True,'keepPaths':[str(shared)]},outputs,str(base/'moves'))
            self.assertTrue(shared.exists(),'a path another site uses is kept even when reached through a symlink')
            self.assertIn('/home/alice',result['kept']);self.assertEqual(result['paths'],[])

class CertificateTests(unittest.TestCase):
    def test_without_certbot_the_owner_gets_one_exact_command(self):
        with tempfile.TemporaryDirectory() as temporary:
            d=pathlib.Path(temporary)/MOVE;d.mkdir();(d/'nginx.json').write_text(json.dumps({'siteId':SITE,'domains':['shop.example.com','www.shop.example.com']}))
            events=io.StringIO()
            with patch('helper.MOVES_ROOT',pathlib.Path(temporary)),patch('helper.shutil.which',return_value=None),patch('helper.EVENT_STREAM',events),patch('helper.run') as command:
                helper.move_certificate({'moveId':MOVE})
            result=json.loads(events.getvalue())['result']
            self.assertEqual(result['status'],'needs-owner');command.assert_not_called()
            self.assertEqual(result['command'],'certbot --nginx --cert-name docknest-%s -d shop.example.com -d www.shop.example.com'%SITE)

class MoveSafetyTests(unittest.TestCase):
    def test_moves_never_write_into_system_docker_or_protected_locations(self):
        for bad in ['/etc/cron.d/backdoor','/etc/sudoers.d/x','/root/.ssh/authorized_keys','/home/u/.ssh/authorized_keys','/etc/nginx/sites-enabled/x','/usr/local/bin/x','/var/lib/docker/volumes/x','/boot/x','/lib64/x','/var/lib/docknest/moves/x','/etc/shadow']:
            with self.assertRaises(ValueError,msg=bad):helper.move_path(bad)
        self.assertEqual(str(helper.move_path('/var/lib/docknest/moves/x',own=True)).replace('\\','/'),'/var/lib/docknest/moves/x')
        with self.assertRaises(ValueError):helper.move_path('/var/lib/docknest/moves',own=True)
        with self.assertRaises(ValueError):helper.move_path('/etc/x',own=True)
        for good in ['/srv/shop/data','/data','/opt/app/config.yaml','/var/www/site']:helper.move_path(good)
    def test_a_backup_names_new_paths_only_below_application_roots(self):
        for good in ['/srv/shop/data','/data','/opt/app/config.yaml','/var/www/site','/mnt/disk1/app','/media/usb/app','/home/alice/stacks/app','/home/alice/stacks/app/.env','/home/alice/bin2/x','/var/home/alice/app','/var/srv/app','/var/opt/app','/docker/app/data','/var/lib/myapp','/var/lib/gitea/data','/var/lib/grafana/grafana.db']:
            self.assertTrue(helper.move_root_allowed(good),good)
        for bad in ['/var/lib/cloud/scripts/per-boot/x.sh','/var/lib/sudo/ts/alice','/var/lib/dpkg/info/x.postinst','/var/lib/systemd/x','/var/lib/polkit-1/x','/var/lib/NetworkManager/x','/var/lib/private/x','/var/lib/.hidden/x','/home/alice/.bash_profile','/home/alice/.config/autostart/x.desktop','/home/alice/.local/bin/x','/home/alice/bin/x','/home/alice','/var/home/alice/.profile','/var/tmp/x','/tmp/x','/var/backups/x','/snap/bin/x','/efi/EFI/x','/nix/store/x','/gnu/store/x','/cdrom/x','/.hidden/x','/usr/local/lib/x','/etc/x','/']:
            self.assertFalse(helper.move_root_allowed(bad),bad)
            if bad!='/':
                with self.assertRaises(ValueError,msg=bad):helper.place_tree(pathlib.Path('unused.tar'),bad,None,None,MOVE)
        for name in ['cloud','docker','containerd','dpkg','apt','systemd','polkit-1','sudo','snapd','ucf','pam','NetworkManager','dhcp','lxcfs','private']:
            self.assertFalse(helper.move_root_allowed('/var/lib/%s/x'%name),name)
        with self.assertRaisesRegex(ValueError,'outside the folders a move may create'):helper.place_tree(pathlib.Path('unused.tar'),'/var/lib/cloud/scripts/per-boot/x.sh',None,None,MOVE)
        with self.assertRaises(ValueError):helper.place_tree(pathlib.Path('unused.tar'),'/var/lib/docker/volumes/x/_data',None,None,MOVE)
    def test_an_existing_var_lib_folder_of_another_program_is_never_written(self):
        real_is_dir,real_iterdir=pathlib.Path.is_dir,pathlib.Path.iterdir
        held={'/var/lib/gitea'}
        def is_dir(self):return self.as_posix() in held or real_is_dir(self)
        def iterdir(self):return iter([self/'data']) if self.as_posix() in held else real_iterdir(self)
        with patch.object(pathlib.Path,'is_dir',is_dir),patch.object(pathlib.Path,'iterdir',iterdir):
            self.assertEqual(helper.foreign_app_folder('/var/lib/gitea/repositories',{'created':{'paths':[]}}),'/var/lib/gitea')
            with self.assertRaisesRegex(ValueError,'belongs to another program'):helper.place_tree(pathlib.Path('unused.tar'),'/var/lib/gitea/repositories',None,{'created':{'paths':[]}},MOVE)
            # Made by this move (journalled), a second folder in it is fine; a new or empty folder is fine too.
            self.assertIsNone(helper.foreign_app_folder('/var/lib/gitea/repositories',{'created':{'paths':[{'path':'/var/lib/gitea','restoreEmpty':False}]}}))
            self.assertIsNone(helper.foreign_app_folder('/var/lib/myapp/data',{'created':{'paths':[]}}))
            # An empty pre-existing folder: after the first mount placed data/ (journalled), a second mount is fine,
            # but an entry the move did not journal still makes the folder foreign.
            self.assertIsNone(helper.foreign_app_folder('/var/lib/gitea/conf',{'created':{'paths':[{'path':'/var/lib/gitea/data','restoreEmpty':False}]}}))
            self.assertEqual(helper.foreign_app_folder('/var/lib/gitea/conf',{'created':{'paths':[{'path':'/var/lib/gitea/other','restoreEmpty':False}]}}),'/var/lib/gitea')
            self.assertIsNone(helper.foreign_app_folder('/srv/shop/data',{'created':{'paths':[]}}))
    def test_image_based_systems_keep_their_root_level_var_links_and_nothing_else(self):
        import types
        links={'/home':'var/home','/srv':'var/srv'};owners={'/home':0,'/srv':1000}
        def patched(var_links=()):
            return [patch('helper.os.path.islink',side_effect=lambda p:p in links or p in var_links),patch('helper.os.lstat',side_effect=lambda p:types.SimpleNamespace(st_uid=owners.get(p,0))),patch('helper.os.readlink',side_effect=lambda p:links[p])]
        def run(var_links=(),call=None):
            items=patched(var_links)
            for item in items:item.start()
            try:return call()
            finally:
                for item in items:item.stop()
        self.assertEqual(run(call=lambda:helper.image_based_form('/home/alice/app')),'/var/home/alice/app')
        self.assertEqual(run(call=lambda:helper.image_based_form('/srv/app')),'/srv/app','a link not owned by root is not rewritten')
        self.assertEqual(run(('/var',),lambda:helper.image_based_form('/home/alice/app')),'/home/alice/app','/var itself is a link')
        self.assertEqual(run(('/var/home',),lambda:helper.image_based_form('/home/alice/app')),'/home/alice/app','/var/home is a link')
        self.assertEqual(run(call=lambda:helper.image_based_form('/data/app')),'/data/app')
        links['/opt']='/var/opt'
        self.assertEqual(run(call=lambda:helper.image_based_form('/opt/app')),'/opt/app','only the relative var/<x> target is accepted')
        real={'/home/alice/app':'/var/home/alice/app','/home/alice/link/app':'/var/home/alice/real/app'}
        def place(target):
            with patch('helper.os.path.realpath',side_effect=lambda p:real.get(p.replace(chr(92),'/'),p)):return run(call=lambda:helper.place_tree(pathlib.Path('unused.tar'),target,None,{'created':{'paths':[]}},MOVE))
        with self.assertRaisesRegex(ValueError,'symbolic link'):place('/home/alice/link/app')
    def test_only_an_image_archive_saved_by_id_is_loaded(self):
        def archive(path,manifest=None,index=None):
            with tarfile.open(path,'w') as tar:
                for name,value in [('manifest.json',manifest),('index.json',index)]:
                    if value is None:continue
                    data=json.dumps(value).encode();info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
            return path
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary)
            byid=archive(base/'id.tar',[{'Config':'x.json','RepoTags':None,'Layers':[]}],{'schemaVersion':2,'manifests':[{'digest':'sha256:a','annotations':{}}]})
            host=FakeHost(temporary,{})
            with patch('helper.docker',side_effect=host.docker):helper.load_images_keeping_tags(byid)
            self.assertEqual(host.calls,[['load','-i',str(byid)]])
            for bad in [archive(base/'tag.tar',[{'Config':'x.json','RepoTags':['nginx:latest'],'Layers':[]}]),
                        archive(base/'oci.tar',None,{'manifests':[{'annotations':{'io.containerd.image.name':'docker.io/library/nginx:latest'}}]}),
                        archive(base/'ref.tar',None,{'manifests':[{'annotations':{'org.opencontainers.image.ref.name':'latest'}}]}),
                        archive(base/'raw.tar',[{'Config':'x.json','RepoTags':['not a valid tag'],'Layers':[]}]),
                        archive(base/'repos.tar',[{'Config':'x.json','RepoTags':None,'Layers':[]}])]:
                if bad.name=='repos.tar':
                    with tarfile.open(bad,'a') as tar:
                        data=json.dumps({'nginx':{'latest':'abc'}}).encode();info=tarfile.TarInfo('repositories');info.size=len(data);tar.addfile(info,io.BytesIO(data))
                host=FakeHost(temporary,{})
                with patch('helper.docker',side_effect=host.docker),self.assertRaisesRegex(ValueError,'save images by ID only',msg=bad.name):helper.load_images_keeping_tags(bad)
                self.assertEqual(host.calls,[],bad.name)
            broken=base/'broken.tar';broken.write_bytes(b'not a tar')
            host=FakeHost(temporary,{})
            with patch('helper.docker',side_effect=host.docker),self.assertRaisesRegex(ValueError,'cannot be read'):helper.load_images_keeping_tags(broken)
            self.assertEqual(host.calls,[])
    def test_compose_files_may_only_describe_what_the_backup_holds(self):
        manifest=fixture_manifest()
        ok={'services':{'web':{'volumes':[{'type':'volume','source':'data0'},{'type':'bind','source':'/srv/shop/config.txt'},{'type':'tmpfs','target':'/tmp'}]}},'volumes':{'data0':{'name':'shop_data0'}}}
        helper.check_compose_config(ok,['web'],manifest)
        for bad in [{'privileged':True},{'network_mode':'host'},{'pid':'host'},{'cap_add':['SYS_ADMIN']},{'devices':['/dev/sda']},{'volumes':[{'type':'bind','source':'/etc'}]},{'volumes':[{'type':'volume','source':'other'}]},{'volumes':[{'type':'npipe','source':'x'}]}]:
            with self.assertRaises(ValueError,msg=json.dumps(bad)):helper.check_compose_config({'services':{'web':bad},'volumes':{}},['web'],manifest)
        with self.assertRaises(ValueError):helper.check_compose_config({'services':{}},['web'],manifest)
    def test_a_typical_project_with_the_implicit_default_network_passes(self):
        # Shape of `docker compose config --format json` for a plain project (Compose 2.29), after the DockNest override.
        config={'name':'shop','services':{'web':{'image':'sha256:aaa','pull_policy':'never','restart':'no','command':None,'entrypoint':None,'labels':{'docknest.move':MOVE},
            'networks':{'default':None},'ports':[{'mode':'ingress','host_ip':'127.0.0.1','target':8080,'published':'8081','protocol':'tcp'}],
            'volumes':[{'type':'volume','source':'data0','target':'/data','volume':{}},{'type':'bind','source':'/srv/shop/config.txt','target':'/config.txt','read_only':True,'bind':{'create_host_path':True}}]}},
            'networks':{'default':{'name':'shop_default','ipam':{},'external':False}},'volumes':{'data0':{'name':'shop_data0','external':False}}}
        helper.check_compose_config(config,['web'],fixture_manifest())
        named={**config,'networks':{'default':{'name':'shop_default','driver':'bridge','labels':{'tier':'web'},'internal':False,'attachable':False,'enable_ipv6':False,'ipam':{'driver':'default'}}}}
        helper.check_compose_config(named,['web'],fixture_manifest())
        for bad in [{'external':True},{'driver':'overlay'},{'driver_opts':{'com.docker.network.bridge.name':'br0'}},{'ipam':{'config':[{'subnet':'172.30.0.0/16'}]}}]:
            with self.assertRaises(ValueError,msg=json.dumps(bad)):helper.check_compose_config({**config,'networks':{'default':{'name':'shop_default',**bad}}},['web'],fixture_manifest())
        # A network the moved services do not join is not their concern.
        helper.check_compose_config({**config,'networks':{**config['networks'],'other':{'name':'x','external':True}}},['web'],fixture_manifest())
    def test_compose_settings_outside_the_allow_list_are_refused(self):
        manifest=fixture_manifest()
        base=lambda **service:{'services':{'web':{'image':'x',**service}},'networks':{'default':{'name':'shop_default'}},'volumes':{}}
        helper.check_compose_config(base(networks={'default':{'aliases':['web']}}),['web'],manifest)
        cases=[base(security_opt=['seccomp:unconfined']),base(sysctls={'net.ipv4.ip_forward':'1'}),base(volumes_from=['db']),base(uts='host'),base(cgroup='host'),base(cgroup_parent='/x'),
            base(networks={'outside':None}),base(networks={'default':{'ipv4_address':'172.30.0.9'}}),
            {**base(),'secrets':{'key':{'file':'/root/key'}}},{**base(),'configs':{'c':{'file':'./c'}}},
            {**base(),'volumes':{'data0':{'name':'shop_data0','driver_opts':{'type':'nfs'}}}},{**base(),'networks':{'default':{'name':'shop_default','external':True}}},
            {**base(),'include':[{'path':'x.yaml'}]}]
        for config in cases:
            with self.assertRaises(ValueError,msg=json.dumps(config)):helper.check_compose_config(config,['web'],manifest)
    def test_the_maintenance_folder_on_the_new_server_is_always_dockNest_own(self):
        with tempfile.TemporaryDirectory() as temporary:
            state={'created':{'paths':[]},'deployed':{}}
            for bad in ['/var/www/shop','/srv/site','/var/lib/docknest/maintenance']:
                with self.assertRaises(ValueError,msg=bad):helper.deploy_maintenance_dir(pathlib.Path(temporary),state,{'maintenanceDirectory':bad})
    def test_mail_is_blocked_by_subnet_for_ipv4_and_ipv6(self):
        calls=[]
        with tempfile.TemporaryDirectory() as temporary:
            d=pathlib.Path(temporary);state={'created':{'firewall':[]},'deployed':{}}
            with patch('helper.firewall_ready',return_value=True),patch('helper.run',side_effect=lambda args,timeout=0:calls.append(args) or b''),patch('helper.atomic_json'):
                self.assertTrue(helper.block_mail(d,state,MOVE,['172.30.0.0/16','fd00:1::/64']))
        inserts=[call for call in calls if '-I' in call]
        self.assertEqual([call[0] for call in inserts],['iptables','ip6tables'])
        self.assertTrue(all(call[call.index('--dports')+1]=='25,465,587' and 'docknest-move-'+MOVE in call for call in inserts))
        self.assertEqual(state['created']['firewall'],['172.30.0.0/16','fd00:1::/64'])
        with patch('helper.firewall_ready',return_value=False):self.assertFalse(helper.block_mail(None,None,MOVE,['172.30.0.0/16']))

class StoppedStepTests(unittest.TestCase):
    def test_a_stopped_step_keeps_its_lock_until_docker_has_settled(self):
        snapshots=iter([['a restarting'],['a restarting'],['a running','b created'],['a running','b created']]);taken=[]
        def snapshot():value=next(snapshots);taken.append(value);return value
        class Exit(Exception):pass
        def exit_(code):raise Exit(code)
        with patch('helper.docker_snapshot',side_effect=snapshot),patch('helper.os.killpg',create=True),patch('helper.os.getpgrp',create=True,return_value=1),patch('helper.signal.signal'),patch('helper.time.sleep'),patch('helper.os._exit',side_effect=exit_):
            with self.assertRaises(Exit):helper.stop_after_stdin(read=lambda:'')
        self.assertEqual(len(taken),4,'waits while a container restarts and until two snapshots agree')
        self.assertTrue(helper.STOPPING);helper.STOPPING=False
        with self.assertRaises(ValueError):
            helper.STOPPING=True
            try:helper.run(['true'])
            finally:helper.STOPPING=False

class KeepStoppedTests(unittest.TestCase):
    def test_capture_documents_keep_stopped_only_after_a_complete_capture(self):
        source=pathlib.Path(helper.__file__).read_text()
        self.assertIn("keep_stopped=bool(req.get('keepStopped')) and captured is not None",source)

if __name__=='__main__':unittest.main()
