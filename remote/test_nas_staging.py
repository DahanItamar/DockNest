import unittest, tempfile, pathlib, os
from unittest.mock import patch
import helper_path  # the built helper.py (one file, as servers run it)
from helper import nas_staging_facts, staging_base

@unittest.skipUnless(os.name=='posix','POSIX only')
class NasStagingTests(unittest.TestCase):
    def test_free_space_is_read_from_the_chosen_folder_on_persistent_storage(self):
        with tempfile.TemporaryDirectory() as pool:
            base=pathlib.Path(pool)/'system'/'docknest'
            with patch('helper.filesystem_type',return_value='xfs'):
                facts=nas_staging_facts(str(base))
            self.assertEqual(facts['stagingBase'],str(base.resolve()) if base.resolve()==base else str(base))
            self.assertTrue(base.is_dir());self.assertEqual(base.stat().st_mode&0o077,0)
            self.assertGreater(facts['freeBytes'],0);self.assertTrue(facts['stagingWritable']);self.assertEqual(facts['stagingFilesystem'],'xfs')
    def test_unknown_filesystem_is_refused_and_octal_escapes_are_read(self):
        from helper import filesystem_type
        import io
        with tempfile.TemporaryDirectory() as pool,patch('helper.filesystem_type',return_value=''),self.assertRaises(ValueError):nas_staging_facts(str(pathlib.Path(pool)/'a'/'b'))
        table='x /mnt/my\040pool xfs rw 0 0
'
        with patch('builtins.open',lambda *a,**k:io.StringIO(table)):self.assertEqual(filesystem_type('/mnt/my pool/x'),'xfs')
    def test_memory_filesystems_links_and_shallow_or_relative_folders_are_refused(self):
        with tempfile.TemporaryDirectory() as pool:
            for kind in ('tmpfs','ramfs','rootfs'):
                with patch('helper.filesystem_type',return_value=kind),self.assertRaises(ValueError):nas_staging_facts(str(pathlib.Path(pool)/'a'/'b'))
            real=pathlib.Path(pool)/'real';real.mkdir();link=pathlib.Path(pool)/'link';link.symlink_to(real)
            with patch('helper.filesystem_type',return_value='xfs'),self.assertRaises(ValueError):nas_staging_facts(str(link/'x'))
        for bad in ('/','/mnt','/mnt/docknest','/var/docknest','relative/x','/mnt/tank/../etc'):
            with patch('helper.filesystem_type',return_value='xfs'),self.assertRaises(ValueError,msg=bad):nas_staging_facts(bad)
if __name__=='__main__':unittest.main()
