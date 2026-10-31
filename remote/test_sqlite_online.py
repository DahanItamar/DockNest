import unittest, tempfile, pathlib, sqlite3, os, shutil, json, tarfile, io
from unittest.mock import patch
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper
from helper import sqlite_checked_online, sqlite_file_proof, online_sqlite_checks

def make_db(path,wal,rows=500):
    connection=sqlite3.connect(path)
    if wal:connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('CREATE TABLE t(x)');connection.executemany('INSERT INTO t VALUES(?)',[(i,) for i in range(rows)]);connection.commit();connection.close()

class OnlineSqliteTests(unittest.TestCase):
    def setUp(self):
        self.root=pathlib.Path(os.path.realpath(tempfile.mkdtemp()))
        make_db(self.root/'big.db',True,20000);make_db(self.root/'rollback.db',False);make_db(self.root/'small.db',True)
        self.container={'Id':'c1','Mounts':[{'Destination':'/data','Source':str(self.root)}]}
    def tearDown(self):shutil.rmtree(self.root)

    def test_only_large_wal_databases_are_checked_online(self):
        self.assertFalse(sqlite_checked_online(self.root/'big.db'))
        with patch('helper.SQLITE_OFFLINE_CHECK_MAX_BYTES',1024):
            self.assertTrue(sqlite_checked_online(self.root/'big.db'))
            self.assertFalse(sqlite_checked_online(self.root/'rollback.db'))

    def test_large_wal_offline_proof_is_a_file_digest_that_matches_a_restored_copy(self):
        service={'sqliteFiles':['/data/big.db','/data/rollback.db']}
        with patch('helper.SQLITE_OFFLINE_CHECK_MAX_BYTES',1024):
            captured=sqlite_file_proof(service,self.container)
            restored_root=pathlib.Path(os.path.realpath(tempfile.mkdtemp()))
            try:
                for name in ['big.db','rollback.db']:shutil.copy2(self.root/name,restored_root/name)
                restored=sqlite_file_proof(service,{'Id':'r','Mounts':[{'Destination':'/data','Source':str(restored_root)}]})
            finally:shutil.rmtree(restored_root)
        self.assertEqual(captured,restored)
        self.assertIn('sha256',captured[0]);self.assertNotIn('integrity',captured[0])
        self.assertEqual(captured[1]['integrity'],'ok')

    def test_small_databases_keep_the_full_offline_check(self):
        proof=sqlite_file_proof({'sqliteFiles':['/data/small.db']},self.container)
        self.assertEqual(proof[0]['integrity'],'ok');self.assertIn('tableDigest',proof[0])

    def test_online_check_runs_once_per_shared_file_and_records_evidence(self):
        services=[{'container':'c1','sqliteFiles':['/data/big.db']},{'container':'c2','sqliteFiles':['/data/big.db','/data/small.db']},{'container':'c3'}]
        containers=[self.container,{**self.container,'Id':'c2'}]
        real=sqlite3.connect;calls=[]
        def counting(*args,**kwargs):calls.append(args[0]);return real(*args,**kwargs)
        with patch('helper.SQLITE_OFFLINE_CHECK_MAX_BYTES',1024*16),patch('helper.sqlite3.connect',side_effect=counting):
            online_sqlite_checks(services,containers,{})
        self.assertEqual(len(calls),1)
        self.assertEqual([c['path'] for c in services[0]['onlineSqliteChecks']],['/data/big.db'])
        self.assertEqual([c['path'] for c in services[1]['onlineSqliteChecks']],['/data/big.db'])
        self.assertEqual(services[1]['onlineSqliteChecks'][0]['integrity'],'ok')
        self.assertNotIn('onlineSqliteChecks',services[2])

    def test_online_check_timeout_reports_a_clear_error(self):
        class Slow:
            def execute(self,sql):
                if 'integrity_check' in sql:raise sqlite3.OperationalError('interrupted')
                return self
            def set_progress_handler(self,*args):pass
            def close(self):pass
        clock=iter([0,10**6,10**6,10**6])
        with patch('helper.SQLITE_OFFLINE_CHECK_MAX_BYTES',1024),patch('helper.sqlite3.connect',return_value=Slow()),patch('helper.time.monotonic',side_effect=lambda:next(clock)):
            with self.assertRaisesRegex(ValueError,'exceeded 7200 seconds'):
                online_sqlite_checks([{'container':'c1','sqliteFiles':['/data/big.db']}],[self.container],{})

    def test_online_check_timeout_bounds(self):
        with self.assertRaisesRegex(ValueError,'60..21600'):online_sqlite_checks([],[],{'sqliteOnlineCheckTimeout':5})

class UnchangedSqliteReuseTests(unittest.TestCase):
    def setUp(self):
        self.root=pathlib.Path(os.path.realpath(tempfile.mkdtemp()))
        make_db(self.root/'old.db',False,20000)
        self.container={'Id':'c1','Mounts':[{'Destination':'/data','Source':str(self.root)}]}
        self.service={'sqliteFiles':['/data/old.db']}
        self.patches=[patch('helper.SQLITE_OFFLINE_CHECK_MAX_BYTES',1024),patch('helper.SQLITE_PROOF_CACHE',self.root/'cache'/'proof.json')]
        for item in self.patches:item.start()
    def tearDown(self):
        for item in self.patches:item.stop()
        shutil.rmtree(self.root)

    def test_byte_identical_file_reuses_the_passed_check_with_identical_evidence(self):
        first=sqlite_file_proof(self.service,self.container,reuse=True)
        self.assertEqual(first[0]['integrity'],'ok')
        self.assertTrue((self.root/'cache'/'proof.json').exists())
        with patch('helper.sqlite3.connect',side_effect=AssertionError('must not recheck')):
            second=sqlite_file_proof(self.service,self.container,reuse=True)
        self.assertEqual(first,second)
        # Restore verification never reuses and still produces the same evidence.
        self.assertEqual(sqlite_file_proof(self.service,self.container),first)

    def test_changed_file_gets_a_full_check(self):
        sqlite_file_proof(self.service,self.container,reuse=True)
        connection=sqlite3.connect(self.root/'old.db');connection.execute('INSERT INTO t VALUES(1)');connection.commit();connection.close()
        real=sqlite3.connect;calls=[]
        def counting(*args,**kwargs):calls.append(1);return real(*args,**kwargs)
        with patch('helper.sqlite3.connect',side_effect=counting):proof=sqlite_file_proof(self.service,self.container,reuse=True)
        self.assertEqual(len(calls),1);self.assertEqual(proof[0]['integrity'],'ok')

    def test_same_metadata_but_different_bytes_is_not_reused(self):
        sqlite_file_proof(self.service,self.container,reuse=True)
        cache=json.loads((self.root/'cache'/'proof.json').read_text())
        for entry in cache['files'].values():entry['sha256']='0'*64
        (self.root/'cache'/'proof.json').write_text(json.dumps(cache))
        real=sqlite3.connect;calls=[]
        def counting(*args,**kwargs):calls.append(1);return real(*args,**kwargs)
        with patch('helper.sqlite3.connect',side_effect=counting):sqlite_file_proof(self.service,self.container,reuse=True)
        self.assertEqual(len(calls),1)

    def test_sqlite_version_change_forces_a_full_check(self):
        sqlite_file_proof(self.service,self.container,reuse=True)
        real=sqlite3.connect;calls=[]
        def counting(*args,**kwargs):calls.append(1);return real(*args,**kwargs)
        with patch('helper.sqlite3.sqlite_version','0.0.0'),patch('helper.sqlite3.connect',side_effect=counting):sqlite_file_proof(self.service,self.container,reuse=True)
        self.assertEqual(len(calls),1)

    def test_corrupt_cache_is_ignored(self):
        (self.root/'cache').mkdir();(self.root/'cache'/'proof.json').write_text('{not json')
        self.assertEqual(sqlite_file_proof(self.service,self.container,reuse=True)[0]['integrity'],'ok')

class SpooledArtifactTests(unittest.TestCase):
    def setUp(self):self.root=pathlib.Path(tempfile.mkdtemp())
    def tearDown(self):shutil.rmtree(self.root)
    unstable=['python3','-c','import os,sys;sys.stdout.buffer.write(os.urandom(300000))']
    stable=['python3','-c','import sys;sys.stdout.buffer.write(b"x"*1000)']

    def read_back(self,data):
        with tarfile.open(fileobj=io.BytesIO(data),mode='r|gz') as archive:
            return {member.name:(archive.extractfile(member).read() if member.isfile() else member.linkname) for member in archive}

    def test_non_deterministic_output_is_spooled_once_and_streamed_verbatim(self):
        output=io.BytesIO()
        with patch('helper.emit'),helper.open_stream_archive(output,1) as archive:
            inventory=helper.stream_artifacts(archive,[('images.tar',self.unstable,None),('mount.tar',self.stable,None),('copy.tar',None,'mount.tar')],self.root,{'images.tar'})
        members=self.read_back(output.getvalue())
        import hashlib
        self.assertEqual(hashlib.sha256(members['images.tar']).hexdigest(),inventory['images.tar']['sha256'])
        self.assertEqual(members['mount.tar'],b'x'*1000);self.assertEqual(members['copy.tar'],'mount.tar')
        self.assertEqual(list(self.root.iterdir()),[])

    def test_unspooled_non_deterministic_output_is_still_rejected(self):
        with patch('helper.emit'),tarfile.open(fileobj=io.BytesIO(),mode='w|gz') as archive:
            with self.assertRaisesRegex(ValueError,'changed during capture'):
                helper.stream_artifacts(archive,[('images.tar',self.unstable,None)])

    def test_spool_is_removed_when_streaming_fails(self):
        with patch('helper.emit'),tarfile.open(fileobj=io.BytesIO(),mode='w|gz') as archive:
            with self.assertRaises(ValueError):
                helper.stream_artifacts(archive,[('images.tar',self.stable,None),('bad.tar',self.unstable,None)],self.root,{'images.tar'})
        self.assertEqual(list(self.root.iterdir()),[])

class SqliteCheckModeTests(unittest.TestCase):
    def setUp(self):
        self.root=pathlib.Path(os.path.realpath(tempfile.mkdtemp()))
        make_db(self.root/'big.db',False,20000);make_db(self.root/'wal.db',True,20000);make_db(self.root/'small.db',False)
        self.container={'Id':'c1','Mounts':[{'Destination':'/data','Source':str(self.root)}]}
    def tearDown(self):shutil.rmtree(self.root)

    def test_off_skips_online_check(self):
        with patch('helper.SQLITE_OFFLINE_CHECK_MAX_BYTES',1024),patch('helper.sqlite3.connect',side_effect=AssertionError('no check')):
            services=[{'container':'c1','sqliteFiles':['/data/wal.db']}]
            online_sqlite_checks(services,[self.container],{'sqliteIntegrityCheck':'off'})
        self.assertNotIn('onlineSqliteChecks',services[0])

    def test_off_uses_digest_for_large_files_and_full_check_for_small_ones(self):
        service={'sqliteFiles':['/data/big.db','/data/wal.db','/data/small.db'],'sqliteCheckMode':'off'}
        with patch('helper.SQLITE_OFFLINE_CHECK_MAX_BYTES',16*1024):
            proof=sqlite_file_proof(service,self.container,reuse=True)
            again=sqlite_file_proof(service,self.container)
        self.assertIn('integrity check disabled',proof[0]['method']);self.assertIn('sha256',proof[0])
        self.assertIn('integrity check disabled',proof[1]['method'])
        self.assertEqual(proof[2]['integrity'],'ok')
        self.assertEqual(proof,again)

    def test_invalid_mode_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'full or off'):helper.sqlite_check_mode({'sqliteIntegrityCheck':'quick'})
        self.assertEqual(helper.sqlite_check_mode({}),'full')

class TransferProgressTests(unittest.TestCase):
    def test_progress_reports_exact_total_and_finishes_at_total(self):
        stable=['python3','-c','import sys;sys.stdout.buffer.write(b"x"*5000)']
        events=[]
        with patch('helper.emit',side_effect=lambda **kw:events.append(kw)),helper.open_stream_archive(io.BytesIO(),1) as archive:
            helper.stream_artifacts(archive,[('a.tar',stable,None),('b.tar',stable,None),('c.tar',None,'a.tar')])
        progress=[e['progress'] for e in events if 'progress' in e]
        self.assertEqual(progress[0],{'done':0,'total':10000})
        self.assertEqual(progress[-1],{'done':10000,'total':10000})
        self.assertIsNone(helper.TRANSFER)

if __name__=='__main__':unittest.main()
