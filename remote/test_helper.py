import unittest, tempfile, pathlib, tarfile, io, urllib.error
from unittest.mock import patch
from helper import safe_extract, health, maintenance, configuration_paths, list_project_files

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
