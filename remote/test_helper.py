import unittest, tempfile, pathlib, tarfile, io, urllib.error
import json,zipfile
from export_zip import export_zip
from unittest.mock import patch
from helper import safe_extract, health, maintenance, configuration_paths, list_project_files, public_probe, OriginHTTPSConnection, readiness, restore_network_plan, temporary_mounts

class TemporaryMemoryTests(unittest.TestCase):
    def test_explicit_temporary_folder_preserves_options(self):
        c={'Id':'123','Name':'/app','HostConfig':{'Tmpfs':{'/tmp':'size=128m,mode=1777'}}}
        self.assertEqual(temporary_mounts(c,[{'container':'app','destination':'/tmp'}]),[('/tmp','size=128m,mode=1777')])
        with self.assertRaises(ValueError):temporary_mounts(c,[])
        c['HostConfig']['Tmpfs']={'/database':'size=128m'}
        with self.assertRaises(ValueError):temporary_mounts(c,[{'container':'app','destination':'/database'}])
        c['HostConfig']['Tmpfs']={'/tmp':'size=128m,unknown=1'}
        with self.assertRaises(ValueError):temporary_mounts(c,[{'container':'app','destination':'/tmp'}])

class FullZipTests(unittest.TestCase):
    def test_zip_includes_browsable_data_and_original_recovery_archives(self):
        with tempfile.TemporaryDirectory() as d:
            mount=io.BytesIO()
            with tarfile.open(fileobj=mount,mode='w') as t:
                m=tarfile.TarInfo('source/upload.png');m.size=5;t.addfile(m,io.BytesIO(b'image'))
            config=io.BytesIO()
            with tarfile.open(fileobj=config,mode='w') as t:
                m=tarfile.TarInfo('.env');m.size=8;t.addfile(m,io.BytesIO(b'KEY=test'))
            manifest={'formatVersion':1,'complete':True,'containers':[{'Name':'/wordpress','Mounts':[{'Destination':'/var/www/html'}]}],'configurationFiles':['/app/.env']}
            payload=pathlib.Path(d)/'payload.tar.gz'
            with tarfile.open(payload,'w:gz') as t:
                for name,content in [('manifest.json',json.dumps(manifest).encode()),('images.tar',b'images'),('restore-guide.md',b'guide'),('mount-0-0.tar',mount.getvalue()),('config-0.tar',config.getvalue())]:
                    m=tarfile.TarInfo(name);m.size=len(content);t.addfile(m,io.BytesIO(content))
            output=io.BytesIO();export_zip(payload,output)
            with zipfile.ZipFile(output) as z:
                self.assertIsNone(z.testzip())
                self.assertEqual(z.read('site-files/wordpress/var/www/html/upload.png'),b'image')
                self.assertEqual(z.read('configuration/app/.env'),b'KEY=test')
                self.assertEqual(z.read('recovery-originals/mount-0-0.tar'),mount.getvalue())
                self.assertEqual(z.read('recovery-originals/images.tar'),b'images')
    def test_unsafe_package_names_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            payload=pathlib.Path(d)/'bad.tar.gz'
            with tarfile.open(payload,'w:gz') as t:t.addfile(tarfile.TarInfo('../outside'))
            with self.assertRaises(ValueError):export_zip(payload,io.BytesIO())

class RestoreNetworkTests(unittest.TestCase):
    def container(self,name,networks,**host):return {'Name':'/'+name,'Config':{'Hostname':name},'HostConfig':host,'NetworkSettings':{'Networks':networks}}
    def test_network_membership_and_service_aliases_remain_separate(self):
        cs=[self.container('app',{'front':{'Aliases':['web']},'back':{'Aliases':['app']}}),self.container('db',{'back':{'Aliases':['database']}})]
        self.assertEqual(restore_network_plan(cs),[{'front':['app','web'],'back':['app']},{'back':['db','database']}])
        self.assertEqual(restore_network_plan(cs[:1]),[{}])
    def test_host_modes_static_ips_and_unsafe_aliases_are_rejected(self):
        for c in [self.container('app',{},Privileged=True),self.container('app',{},NetworkMode='container:production'),self.container('app',{},NetworkMode='host'),self.container('app',{'net':{'Aliases':['--unsafe']}}),self.container('app',{'net':{'IPAMConfig':{'IPv4Address':'172.20.0.2'}}})]:
            with self.assertRaises(ValueError):restore_network_plan([c,self.container('db',{})])
        with self.assertRaises(ValueError):restore_network_plan([])

class ConfigurationFileTests(unittest.TestCase):
    def test_detection_and_browsing_return_paths_and_names_without_file_contents(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'project';root.mkdir();(root/'nested').mkdir()
            (root/'docker-compose.yml').write_text('fixture definition')
            (root/'.env').write_text('DO_NOT_EXPOSE_THIS_VALUE')
            container={'Config':{'Labels':{'com.docker.compose.project':'fixture','com.docker.compose.project.working_dir':str(root),'com.docker.compose.project.config_files':str(root/'docker-compose.yml')}}}
            detected=configuration_paths(container)
            self.assertEqual(detected['composeFiles'],[str(root/'docker-compose.yml')])
            self.assertEqual(detected['configFiles'],[str(root/'.env')])
            with patch('helper.inspect',return_value=[container]):
                listing=list_project_files(['fixture'])
                self.assertIsNone(listing['parent'])
                self.assertEqual({entry['name'] for entry in listing['entries']},{'.env','docker-compose.yml','nested'})
                self.assertNotIn('DO_NOT_EXPOSE_THIS_VALUE',str(listing))
                nested=list_project_files(['fixture'],str(root/'nested'))
                self.assertEqual(nested['parent'],str(root))
                with self.assertRaises(ValueError):list_project_files(['fixture'],d)
                with self.assertRaises(ValueError):list_project_files(['fixture'],str(root/'..'))
    def test_standalone_containers_and_unsafe_ids_cannot_enable_arbitrary_browsing(self):
        with patch('helper.inspect',return_value=[{'Config':{'Labels':{}}}]):
            with self.assertRaises(ValueError):list_project_files(['fixture'],'/')
        with self.assertRaises(ValueError):list_project_files(['--unsafe'],'/')
class ArchiveSecurityTests(unittest.TestCase):
    def test_valid_archive_preserves_file(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);archive=base/'input.tar'
            with tarfile.open(archive,'w') as t:
                entry=tarfile.TarInfo('assets/photo.txt');content=b'owned fixture';entry.size=len(content);t.addfile(entry,io.BytesIO(content))
            safe_extract(archive,base/'output')
            self.assertEqual((base/'output/assets/photo.txt').read_bytes(),b'owned fixture')
    def test_escape_and_links_rejected_before_any_extraction(self):
        for kind in ['traversal','absolute','symlink','hardlink','device']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as d:
                base=pathlib.Path(d);archive=base/'bad.tar'
                with tarfile.open(archive,'w') as t:
                    good=tarfile.TarInfo('valid.txt');good.size=1;t.addfile(good,io.BytesIO(b'x'))
                    bad=tarfile.TarInfo('../outside' if kind=='traversal' else '/absolute' if kind=='absolute' else 'evil')
                    if kind=='symlink':bad.type=tarfile.SYMTYPE;bad.linkname='../../outside'
                    if kind=='hardlink':bad.type=tarfile.LNKTYPE;bad.linkname='../../outside'
                    if kind=='device':bad.type=tarfile.CHRTYPE
                    t.addfile(bad)
                with self.assertRaises(ValueError):safe_extract(archive,base/'output')
                self.assertFalse((base/'output/valid.txt').exists())
    def test_internal_links_are_preserved(self):
        import os
        if os.name!='posix':self.skipTest('Link ownership/preservation requires Linux tar')
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);archive=base/'links.tar'
            with tarfile.open(archive,'w') as t:
                entry=tarfile.TarInfo('assets/photo.txt');entry.size=1;t.addfile(entry,io.BytesIO(b'x'))
                soft=tarfile.TarInfo('assets/current');soft.type=tarfile.SYMTYPE;soft.linkname='photo.txt';t.addfile(soft)
                hard=tarfile.TarInfo('assets/copy');hard.type=tarfile.LNKTYPE;hard.linkname='assets/photo.txt';t.addfile(hard)
            safe_extract(archive,base/'output')
            self.assertTrue((base/'output/assets/current').is_symlink())
            self.assertEqual((base/'output/assets/current').read_bytes(),b'x')
            self.assertEqual(os.stat(base/'output/assets/copy').st_ino,os.stat(base/'output/assets/photo.txt').st_ino)
    def test_archive_cannot_write_through_declared_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);archive=base/'bad.tar'
            with tarfile.open(archive,'w') as t:
                link=tarfile.TarInfo('alias');link.type=tarfile.SYMTYPE;link.linkname='safe';t.addfile(link)
                entry=tarfile.TarInfo('alias/file');entry.size=1;t.addfile(entry,io.BytesIO(b'x'))
            with self.assertRaises(ValueError):safe_extract(archive,base/'output')
            self.assertFalse((base/'output/alias').exists())

class MaintenanceTests(unittest.TestCase):
    def test_origin_https_verifies_original_hostname_on_loopback(self):
        from unittest.mock import Mock
        context=Mock();sock=Mock()
        connection=OriginHTTPSConnection('www.example.org',443,timeout=10,context=context)
        with patch('helper.socket.create_connection',return_value=sock) as connect:
            connection.connect()
        connect.assert_called_once_with(('127.0.0.1',443),10)
        context.wrap_socket.assert_called_once_with(sock,server_hostname='www.example.org')
        context.wrap_socket.side_effect=__import__('ssl').SSLCertVerificationError('certificate mismatch')
        with patch('helper.socket.create_connection',return_value=sock):
            with self.assertRaises(__import__('ssl').SSLCertVerificationError):connection.connect()
        sock.close.assert_called_once()
    def test_origin_probe_preserves_host_and_query_without_following_redirects(self):
        from unittest.mock import Mock
        conn=Mock();response=Mock(status=301);response.read.return_value=b'redirect';conn.getresponse.return_value=response
        with patch('helper.http.client.HTTPConnection',return_value=conn) as connect:
            self.assertEqual(public_probe({'publicUrl':'http://example.invalid:8082/path?x=1','probeOrigin':True}),(301,b'redirect'))
        connect.assert_called_once_with('127.0.0.1',8082,timeout=10)
        conn.request.assert_called_once_with('GET','/path?x=1',headers={'Host':'example.invalid:8082','Cache-Control':'no-cache'})
        conn.close.assert_called_once()
        for url in ['file:///etc/passwd','https://user:secret@example.org/']:
            with self.assertRaises(ValueError):public_probe({'publicUrl':url,'probeOrigin':True})
    def test_readiness_reports_missing_setup_without_mutating_flags(self):
        with tempfile.TemporaryDirectory() as d:
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':d}}
            with patch('helper.preflight',side_effect=ValueError('Select Compose files')),patch('helper.health',return_value=True):result=readiness(cfg)
            self.assertFalse(result['ready']);self.assertTrue(result['readOnly']);self.assertFalse(result['maintenanceActivationTested'])
            self.assertEqual(result['checks'][0]['message'],'Select Compose files')
            self.assertTrue(result['checks'][1]['ok']);self.assertFalse(result['checks'][2]['ok'])
            self.assertEqual(list(pathlib.Path(d).iterdir()),[])
    def test_failed_activation_restores_previous_flag_state(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);(base/'ready').touch()
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':d,'publicUrl':'http://fixture/'}}
            with patch('helper.urllib.request.urlopen',side_effect=OSError('fixture offline')):
                with self.assertRaises(OSError):maintenance(cfg,True)
                self.assertFalse((base/'enabled').exists())
                (base/'enabled').touch()
                with self.assertRaises(OSError):maintenance(cfg,True)
                self.assertTrue((base/'enabled').exists(),'An existing manual maintenance flag is retained')
    def test_http_200_maintenance_page_is_not_application_health(self):
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return b'<meta content="dbm-maintenance-v1">'
        with patch('helper.inspect',return_value=[{'State':{'Running':True}}]),patch('helper.urllib.request.urlopen',return_value=Response()):
            self.assertFalse(health(['fixture'],'http://fixture/'))
    def test_health_failure_keeps_maintenance_enabled(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);(base/'ready').touch();(base/'enabled').touch()
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':d}}
            with patch('helper.health',return_value=False):
                with self.assertRaises(ValueError):maintenance(cfg,False)
                self.assertTrue((base/'enabled').exists())
if __name__=='__main__':unittest.main()
