import unittest, tempfile, pathlib, tarfile, io
from helper import safe_extract
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
                    if kind=='hardlink':bad.type=tarfile.LNKTYPE;bad.linkname='valid.txt'
                    if kind=='device':bad.type=tarfile.CHRTYPE
                    t.addfile(bad)
                with self.assertRaises(ValueError):safe_extract(archive,base/'output')
                self.assertFalse((base/'output/valid.txt').exists())
if __name__=='__main__':unittest.main()
