import unittest, tempfile, pathlib, os, io, sys, hashlib, base64
from unittest.mock import patch
import helper_path  # the built helper.py (one file, as servers run it)
from helper import stage_io_path, stage_read, stage_write

class FakeOut:
    def __init__(self):self.buffer=io.BytesIO()
def sha(data):return hashlib.sha256(data).hexdigest()
def lines(*chunks,end=None):
    data=b''.join(chunks)
    marker=end if end is not None else 'END %d %s'%(len(data),sha(data))
    return ''.join('D '+base64.b64encode(chunk).decode()+'\n' for chunk in chunks)+marker+'\n'

@unittest.skipUnless(os.name=='posix','POSIX only')
class StageIoTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=os.path.realpath(self.tmp.name)+'/docknest'
        os.mkdir(self.root,0o700)
        patcher=patch('helper.STAGE_IO_ROOTS',(self.root,));patcher.start();self.addCleanup(patcher.stop)
    def run_read(self,path,extra=None):
        events=[];out=FakeOut()
        with patch('sys.stdout',out),patch('helper.emit',lambda **kw:events.append(kw)):stage_read({'path':path,**({'stagingBase':extra} if extra else {})})
        return out.buffer.getvalue(),events
    def run_write(self,path,text):
        events=[]
        with patch('sys.stdin',io.StringIO(text)),patch('helper.emit',lambda **kw:events.append(kw)):stage_write({'path':path})
        return events

    def test_paths_are_confined_to_the_staging_folders(self):
        inside=self.root+'/job/payload.tar.gz';os.makedirs(self.root+'/job')
        self.assertEqual(stage_io_path(inside),inside)
        outside=os.path.realpath(self.tmp.name)+'/elsewhere/file';os.makedirs(os.path.dirname(outside))
        link=self.root+'/link';os.symlink(os.path.dirname(outside),link)
        linked_folder=self.root+'/job/folder-link';os.symlink(self.root+'/job',linked_folder)
        for bad in (None,5,'relative/file',self.root,self.root+'/',self.root+'/../elsewhere/file',self.root+'/./job/x',outside,'/etc/passwd',link+'/file',linked_folder+'/payload.tar.gz',inside+'\0','/'+'a'*1100,self.root+'//job/x'):
            with self.assertRaises(ValueError,msg=repr(bad)[:60]):stage_io_path(bad)
        # A staging folder given by the request must be a real folder inside a pool, never a system folder.
        for bad in ('/','/etc','/etc/docknest','/usr/lib/x','/var','relative','/mnt/tank/data','/mnt/tank/apps/app','/mnt/user/system'):
            with self.assertRaises(ValueError,msg=bad):stage_io_path(inside,bad)
        self.assertEqual(stage_io_path(inside,self.root),inside)
        from helper import stage_io_roots
        for name in ('/mnt/tank/.docknest','/volume1/@docknest','/mnt/cache/system/docknest'):self.assertIn(name,stage_io_roots(name))
    def test_read_streams_the_file_and_reports_its_size_and_checksum(self):
        path=self.root+'/payload';data=os.urandom(3*1024*1024+17);pathlib.Path(path).write_bytes(data)
        out,events=self.run_read(path)
        self.assertEqual(out,data)
        self.assertEqual(events,[{'total':len(data)},{'result':{'size':len(data),'sha256':sha(data)}}])
    def test_read_refuses_links_and_things_that_are_not_regular_files(self):
        target=self.root+'/real';pathlib.Path(target).write_bytes(b'x')
        os.symlink(target,self.root+'/alias')
        for bad in (self.root+'/alias',self.root+'/missing'):
            with self.assertRaises((ValueError,OSError)):self.run_read(bad)
        os.mkfifo(self.root+'/fifo')
        with self.assertRaises(ValueError):self.run_read(self.root+'/fifo')
        os.mkdir(self.root+'/folder')
        with self.assertRaises((ValueError,OSError)):self.run_read(self.root+'/folder')
    def test_write_stores_the_package_with_owner_only_access_and_checks_it(self):
        path=self.root+'/payload.tar.gz';one,two=os.urandom(1000),os.urandom(5000)
        events=self.run_write(path,lines(one,two))
        self.assertEqual(pathlib.Path(path).read_bytes(),one+two)
        self.assertEqual(os.stat(path).st_mode&0o777,0o600)
        self.assertEqual(events,[{'result':{'size':6000,'sha256':sha(one+two)}}])
        # A repeat of the same upload (a retried job) replaces the file.
        self.run_write(path,lines(b'second'));self.assertEqual(pathlib.Path(path).read_bytes(),b'second')
    def test_write_removes_a_package_that_did_not_arrive_intact(self):
        for name,text in (('hash',lines(b'abc',end='END 3 '+sha(b'other'))),('size',lines(b'abc',end='END 4 '+sha(b'abc'))),('no end','D '+base64.b64encode(b'abc').decode()+'\n'),
                          ('garbage','hello\n'),('bad base64','D ***\nEND 0 '+sha(b'')+'\n'),('end shape','END 3\n')):
            path=self.root+'/'+name.replace(' ','-')
            with self.assertRaises(Exception,msg=name):self.run_write(path,text)
            self.assertFalse(os.path.exists(path),name+' leaves nothing behind')
    def test_write_is_atomic_and_a_refused_rewrite_keeps_the_existing_package(self):
        path=self.root+'/payload';pathlib.Path(path).write_bytes(b'first')
        for text in (lines(b'abc',end='END 3 '+sha(b'other')),'garbage\n','D '+base64.b64encode(b'abc').decode()+'\n'):
            with self.assertRaises(Exception):self.run_write(path,text)
            self.assertEqual(pathlib.Path(path).read_bytes(),b'first','an existing package survives a refused rewrite')
            self.assertEqual([name for name in os.listdir(self.root) if name.endswith('.part')],[],'no partial file is left')
        # A stale .part from an interrupted upload is replaced, and the package appears only when complete.
        pathlib.Path(path+'.part').write_bytes(b'stale')
        self.run_write(path,lines(b'second'))
        self.assertEqual(pathlib.Path(path).read_bytes(),b'second');self.assertFalse(os.path.exists(path+'.part'))
        # A link where the package goes is refused and its target is untouched.
        target=self.root+'/real';pathlib.Path(target).write_bytes(b'keep');os.symlink(target,self.root+'/alias')
        with self.assertRaises(ValueError):self.run_write(self.root+'/alias',lines(b'new'))
        self.assertEqual(pathlib.Path(target).read_bytes(),b'keep')
    def test_write_refuses_links_and_paths_outside_the_staging_folders(self):
        target=self.root+'/real';pathlib.Path(target).write_bytes(b'keep')
        os.symlink(target,self.root+'/alias')
        with self.assertRaises((ValueError,OSError)):self.run_write(self.root+'/alias',lines(b'new'))
        self.assertEqual(pathlib.Path(target).read_bytes(),b'keep','a link is never written through')
        outside=os.path.realpath(self.tmp.name)+'/outside';os.mkdir(outside)
        folder_link=self.root+'/folder-link';os.symlink(outside,folder_link)
        for bad in (folder_link+'/file',outside+'/file','/etc/cron.d/docknest',self.root+'/../outside/file'):
            with self.assertRaises(ValueError,msg=bad):self.run_write(bad,lines(b'x'))
        self.assertEqual(os.listdir(outside),[])
        # A name that is a hard link of another file is replaced as a name; the other file's data is never touched.
        hard=self.root+'/hard';os.link(target,hard)
        self.run_write(hard,lines(b'x'))
        self.assertEqual(pathlib.Path(hard).read_bytes(),b'x');self.assertEqual(pathlib.Path(target).read_bytes(),b'keep')
if __name__=='__main__':unittest.main()
