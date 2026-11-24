import unittest, tempfile, pathlib, tarfile, os, io
import helper_path  # the built helper.py (one file, as servers run it)
from helper import parse_template, unraid_templates, nas_version_facts, truenas_supported, nas_app, attach_nas, put_back_template, TRUENAS_TOO_OLD, TEMPLATE_LIMIT

def template(name='fakeapp',icon='https://example.invalid/icon.png',web='http://[IP]:[PORT:8080]/'):
    return ('<?xml version="1.0"?><Container version="2"><Name>%s</Name><Repository>example/fakeapp</Repository><WebUI>%s</WebUI><Icon>%s</Icon></Container>'%(name,web,icon)).encode()

class NasAppTests(unittest.TestCase):
    def test_template_parsing_is_strict_and_never_fetches(self):
        facts=parse_template(template())
        self.assertEqual((facts['name'],facts['icon']),('fakeapp','https://example.invalid/icon.png'))
        self.assertIsNone(parse_template(template(icon='javascript:alert(1)'))['icon'])
        self.assertIsNone(parse_template(template(icon='file:///etc/passwd'))['icon'])
        bomb=b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]><Container><Name>&b;</Name></Container>'
        self.assertIsNone(parse_template(bomb))
        self.assertIsNone(parse_template(b'<!DOCTYPE Container SYSTEM "http://example.invalid/x.dtd"><Container><Name>a</Name></Container>'))
        self.assertIsNone(parse_template(b'<Other><Name>a</Name></Other>'))
        self.assertIsNone(parse_template(b'<Container><Name>'+b'a'*200+b'</Name></Container>'))
        self.assertIsNone(parse_template(b'<Container><Name>a</Name>'+b' '*(TEMPLATE_LIMIT+1)+b'</Container>'))
        self.assertIsNone(parse_template(b'<Container><Name>a&#1;b</Name></Container>'))
        self.assertIsNone(parse_template(b'not xml'))
    def test_hidden_encodings_and_formats(self):
        for data in (template().decode().encode('utf-16'),template().decode().encode('utf-32'),b'<Container><Name>a</Name>\x00</Container>',b'\xff\xfe<Container><Name>a</Name></Container>'):self.assertIsNone(parse_template(data))
        evil='<!DOCTYPE x [<!ENTITY a "b">]><Container><Name>a</Name></Container>'
        self.assertIsNone(parse_template(evil.encode('utf-16-le')))
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);(root/'etc').mkdir();(root/'usr/bin').mkdir(parents=True);(root/'usr/bin/midclt').write_text('')
            for text,expect in (('TrueNAS-SCALE-24.10.2','24.10.2'),('TrueNAS-SCALE 25.04','25.04'),('TrueNAS-25.10.0\n','25.10.0'),('25.04.1','25.04.1'),('TrueNAS-SCALE-garbage',None)):
                (root/'etc/version').write_text(text)
                facts=nas_version_facts(str(root));self.assertEqual(facts,{'kind':'truenas','version':expect},text)
                if expect is None:
                    with self.assertRaises(ValueError):attach_nas({'containers':[]},[],str(root))
            (root/'etc/version').write_text('TrueNAS-SCALE-24.04.2')
            with self.assertRaises(ValueError):attach_nas({'containers':[]},[],str(root))
            (root/'etc/version').write_text('Debian 12.5')
            self.assertIsNone(nas_version_facts(str(root)))
    def test_put_back_keeps_a_file_that_appears_and_leaves_no_temporary(self):
        with tempfile.TemporaryDirectory() as work:
            work=pathlib.Path(work);folder=work/'templates';folder.mkdir();posix=folder.as_posix()
            source=work/'my-fakeapp.xml';source.write_bytes(template())
            archive=work/'config-0.tar'
            with tarfile.open(archive,'w') as tar:tar.add(source,arcname='my-fakeapp.xml')
            self.assertEqual(put_back_template(archive,posix+'/my-fakeapp.xml',work/'s1',posix)['status'],'restored')
            self.assertEqual([item.name for item in folder.iterdir()],['my-fakeapp.xml'])
    def test_unraid_templates_are_matched_by_name_and_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            pathlib.Path(folder,'my-fakeapp.xml').write_bytes(template())
            pathlib.Path(folder,'my-bad.xml').write_bytes(b'<!DOCTYPE x><Container><Name>bad</Name></Container>')
            pathlib.Path(folder,'other.xml').write_bytes(template('skipped'))
            found=unraid_templates(folder)
            self.assertEqual(list(found),['fakeapp'])
            app=nas_app({'Name':'/fakeapp','Config':{'Labels':{}}},'unraid',found)
            self.assertEqual((app['manager'],app['displayName']),('unraid-template','fakeapp'))
            self.assertIsNone(nas_app({'Name':'/unknown','Config':{}},'unraid',found))
            self.assertEqual(unraid_templates(folder+'/missing'),{})
    def test_synology_and_truenas_projects_come_from_compose_labels_only(self):
        label=lambda folder:{'Name':'/c','Config':{'Labels':{'com.docker.compose.project.working_dir':folder}}}
        self.assertEqual(nas_app(label('/volume1/docker/fakeproject'),'synology',{})['project'],'fakeproject')
        self.assertIsNone(nas_app(label('/volume1/docker/../etc'),'synology',{}))
        self.assertIsNone(nas_app(label('/home/docker/fakeproject'),'synology',{}))
        app=nas_app(label('/mnt/.ix-apps/app_configs/ix-fakeapp/versions/1.0'),'truenas',{})
        self.assertEqual((app['manager'],app['displayName']),('truenas-app','fakeapp'))
        self.assertIsNone(nas_app(label('/mnt/tank/other'),'truenas',{}))
        self.assertIsNone(nas_app(label('/volume1/docker/x'),'truenas',{}))
    def test_nas_detection_versions_and_the_old_truenas_refusal(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);(root/'etc').mkdir();(root/'usr/bin').mkdir(parents=True)
            self.assertIsNone(nas_version_facts(str(root)))
            self.assertEqual(attach_nas({'containers':[]},[],str(root)),{'containers':[]},'a server that is not a NAS gets nothing added')
            (root/'etc/version').write_text('TrueNAS-SCALE 24.04.2');(root/'usr/bin/midclt').write_text('')
            self.assertEqual(nas_version_facts(str(root)),{'kind':'truenas','version':'24.04.2'})
            with self.assertRaises(ValueError) as caught:attach_nas({'containers':[]},[],str(root))
            self.assertEqual(str(caught.exception),TRUENAS_TOO_OLD)
            (root/'etc/version').write_text('TrueNAS-SCALE 25.10.0')
            self.assertEqual(attach_nas({'containers':[]},[],str(root))['nas']['kind'],'truenas')
        for good in ('24.10','24.10.2','25.04.1'):self.assertTrue(truenas_supported(good))
        for bad in ('24.04.2','22.12.4','','x',None,'24.9'):self.assertFalse(truenas_supported(bad))
    def test_discovery_adds_the_template_as_a_configuration_file(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);(root/'etc').mkdir();(root/'etc/unraid-version').write_text('version="6.12.10"\n')
            folder=root/'templates';folder.mkdir();(folder/'my-fakeapp.xml').write_bytes(template())
            result={'containers':[{'name':'fakeapp','backupConfiguration':{'composeFiles':[],'configFiles':[]}},{'name':'plain'}]}
            out=attach_nas(result,[{'Name':'/fakeapp','Config':{}},{'Name':'/plain','Config':{}}],str(root),folder.as_posix())
            self.assertEqual(out['nas']['kind'],'unraid')
            self.assertEqual(out['containers'][0]['backupConfiguration']['configFiles'],[folder.as_posix()+'/my-fakeapp.xml'])
            self.assertNotIn('nasApp',out['containers'][1])
    def test_put_back_restores_once_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as work:
            work=pathlib.Path(work);folder=work/'templates';folder.mkdir();posix=folder.as_posix()
            source=work/'my-fakeapp.xml';source.write_bytes(template())
            archive=work/'config-0.tar'
            with tarfile.open(archive,'w') as tar:tar.add(source,arcname='my-fakeapp.xml')
            original=posix+'/my-fakeapp.xml'
            self.assertEqual(put_back_template(archive,original,work/'s1',posix)['status'],'restored')
            self.assertEqual((folder/'my-fakeapp.xml').read_bytes(),template())
            self.assertEqual(put_back_template(archive,original,work/'s2',posix)['status'],'unchanged')
            (folder/'my-fakeapp.xml').write_bytes(template(web='http://changed.invalid/'))
            self.assertEqual(put_back_template(archive,original,work/'s3',posix)['status'],'kept-existing')
            self.assertIn(b'changed.invalid',(folder/'my-fakeapp.xml').read_bytes())
            for bad in (posix+'/../x.xml',posix+'/sub/my-a.xml',posix+'/notmy.xml','/etc/cron.d/my-x.xml'):
                with self.assertRaises(ValueError,msg=bad):put_back_template(archive,bad,work/'s4',posix)
            hostile=work/'hostile.tar'
            with tarfile.open(hostile,'w') as tar:
                info=tarfile.TarInfo('../my-escape.xml');info.size=3;tar.addfile(info,io.BytesIO(b'abc'))
            with self.assertRaises(Exception):put_back_template(hostile,posix+'/my-escape.xml',work/'s5',posix)
            self.assertFalse((work/'my-escape.xml').exists())
            invalid=work/'invalid.tar';(work/'my-bad.xml').write_bytes(b'<!DOCTYPE x><Container><Name>a</Name></Container>')
            with tarfile.open(invalid,'w') as tar:tar.add(work/'my-bad.xml',arcname='my-bad.xml')
            with self.assertRaises(ValueError):put_back_template(invalid,posix+'/my-bad.xml',work/'s6',posix)
            self.assertFalse((folder/'my-bad.xml').exists())
if __name__=='__main__':unittest.main()
