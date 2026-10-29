"""Incremental backups (docs/incremental-backups.md): capture decisions, snapshot state, chain restore and ZIP export.
Tests that need GNU tar's --listed-incremental extraction run on Linux only and are skipped elsewhere."""
import unittest,tempfile,pathlib,tarfile,io,json,hashlib,os,sys,stat,shutil,time,subprocess,uuid,zipfile,collections
from unittest.mock import patch,Mock
import helper
from helper import incremental_request,dumpdir_problem,incremental_archive_check,chain_problem,unpack_verified,mount_archive,image_archives,snapshot_key
from export_zip import export_zip,scan_stream,IncrementalBackup

LINUX_GNU_TAR=sys.platform.startswith('linux') and shutil.which('tar') is not None and b'GNU tar' in subprocess.run(['tar','--version'],capture_output=True).stdout
JOB='00000000-0000-4000-8000-0000000000%02d'
SITE='site-1'
def sha(data):return hashlib.sha256(data).hexdigest()
def write_json(path,value):pathlib.Path(path).write_text(json.dumps(value))

class RequestTests(unittest.TestCase):
    def base(self,**changes):
        value={'mode':'incremental','siteKey':SITE,'chainId':'chain-a','fallbackChainId':'chain-b','position':2,'parentBackupId':'backup-1','parentSha256':'a'*64,'parentSnapshots':{'b'*64:'c'*64},'parentImageIds':['sha256:'+'d'*64]}
        value.update(changes);return {'config':{},'incremental':value}
    def test_absent_field_means_format_v1(self):
        self.assertIsNone(incremental_request({'config':{}}))
    def test_valid_requests(self):
        self.assertEqual(incremental_request(self.base())['position'],2)
        full=incremental_request({'config':{},'incremental':{'mode':'full','siteKey':SITE,'chainId':'c','position':0}})
        self.assertIsNone(full['parentBackupId']);self.assertEqual(full['parentSnapshots'],{})
    def test_unsafe_or_inconsistent_requests_are_refused(self):
        for change in [{'mode':'diff'},{'siteKey':'../x'},{'siteKey':'a/b'},{'siteKey':''},{'chainId':'a b'},{'position':0},{'position':31},{'position':True},
                       {'parentSha256':'x'},{'parentBackupId':None},{'fallbackChainId':'chain-a'},{'fallbackChainId':None},
                       {'parentSnapshots':{'../x':'c'*64}},{'parentSnapshots':{'b'*64:'nope'}},{'parentImageIds':['latest']}]:
            with self.subTest(change=change),self.assertRaises(ValueError):incremental_request(self.base(**change))
        with self.assertRaises(ValueError):incremental_request({'config':{},'incremental':{'mode':'full','siteKey':SITE,'chainId':'c','position':1}})

class CaptureHarness(unittest.TestCase):
    """Runs capture() with Docker and tar replaced by fakes that write files, so the package layout is real."""
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.base=pathlib.Path(directory.name)
        self.state=self.base/'state';self.staging=self.base/'staging';(self.base/'src').mkdir()
        patcher=patch('helper.INCREMENTAL_ROOT',self.state);patcher.start();self.addCleanup(patcher.stop)
        self.calls=[];self.saved=[];self.counter=0;self.dumpdir='Ya\0\0'
    def sources(self,*names):
        result=[]
        for name in names:
            path=self.base/'src'/name;path.mkdir(exist_ok=True);result.append(str(path))
        return result
    def containers(self,mounts):
        return [{'Id':'c%d'%i,'Name':'/app%d'%i,'Image':'sha256:'+str(i)*64,'State':{'Running':False},'SizeRw':0,'Config':{},'HostConfig':{},'Mounts':[{'Type':'bind','Source':s,'Destination':'/data%d'%j,'RW':True} for j,s in enumerate(sources)]} for i,sources in enumerate(mounts)]
    def fake_run(self,args,timeout=3600,input=None):
        args=[str(a) for a in args];self.calls.append(args)
        if args[0]=='du':return b'10\t/x'
        if args[0]=='tar' and '-cpf' in args:
            for option in args:
                if option.startswith('--listed-incremental='):
                    snar=pathlib.Path(option.split('=',1)[1]);previous=snar.read_bytes() if snar.exists() else b'level0'
                    snar.write_bytes(previous+b'+'+args[-1].encode())
            # A real (tiny) POSIX archive, so the rename scan reads what GNU tar would write.
            pathlib.Path(args[args.index('-cpf')+1]).write_bytes(mount_tar([(args[-1],'dir',None,{'GNU.dumpdir':self.dumpdir} if any(a.startswith('--listed') for a in args) else None)]))
        if args[0]=='tar' and '-czf' in args:
            root=pathlib.Path(args[args.index('-C')+1])
            with tarfile.open(args[args.index('-czf')+1],'w:gz') as tar:
                for name in args[args.index('-C')+2:]:tar.add(str(root/name),arcname=name)
        return b''
    def fake_docker(self,*args):
        if args[:2]==('image','inspect'):return json.dumps([{'Id':image,'Size':1} for image in args[2:]]).encode()
        if args[0]=='commit':self.counter+=1;return ('sha256:'+'e'*63+str(self.counter)).encode()
        if args[0]=='info':return b'x86_64'
        if args[0]=='save':pathlib.Path(args[2]).write_bytes(b'images');self.saved.append(list(args[3:]))
        return b''
    def capture(self,containers,incremental=None,job=1,output=None,exclusions=None):
        cfg={'containers':[c['Id'] for c in containers],'stagingRoot':str(self.staging),'cleanShutdownConfirmed':True}
        if exclusions:cfg['mountExclusions']=[{'source':source,'path':path,'reason':'cache'} for source,paths in exclusions.items() for path in paths]
        plan={'fingerprint':'plan','services':[{'container':c['Id'],'engine':'generic'} for c in containers],'restartOrder':[c['Id'] for c in containers]}
        emitted=Mock();request={'config':cfg,'job':JOB%job,'planFingerprint':'plan'}
        if incremental is not None:request['incremental']=incremental
        def staging(path):pathlib.Path(path).mkdir(parents=True)
        usage=collections.namedtuple('Usage','total used free')(1,0,1<<50)
        with patch.multiple('helper',preflight=Mock(return_value=containers),backup_plan=Mock(return_value=plan),online_sqlite_checks=Mock(),create_staging_root=Mock(side_effect=staging),docker=Mock(side_effect=self.fake_docker),mount_exclusions=Mock(return_value=exclusions or {}),atomic_json=Mock(side_effect=write_json),prepare_database_shutdown=Mock(),shutdown_evidence=Mock(return_value=[]),revalidate_sources=Mock(),restart_services=Mock(),inspect=Mock(return_value=[]),complete_recovery=Mock(),run=Mock(side_effect=self.fake_run),emit=emitted,warn=Mock()),\
             patch('helper.shutil.disk_usage',return_value=usage),patch('helper.os.getpgrp',return_value=os.getpid(),create=True),patch('helper.os.fork',return_value=4242,create=True),\
             patch('helper.pathlib.Path.read_text',side_effect=lambda self,*a,**k:'boot' if 'boot_id' in str(self) else self.read_bytes().decode('utf-8'),autospec=True):
            helper.capture(request,output)
        self.root=self.staging/(JOB%job)
        return emitted.call_args.kwargs['result']['manifest']
    def payload_names(self):
        with tarfile.open(self.root/'payload.tar.gz') as tar:return sorted(tar.getnames())
    def full_request(self,chain='chain-a'):return {'mode':'full','siteKey':SITE,'chainId':chain,'position':0}
    def increment_request(self,snapshots,position=1,images=()):
        return {'mode':'incremental','siteKey':SITE,'chainId':'chain-a','fallbackChainId':'chain-fresh','position':position,'parentBackupId':'backup-0','parentSha256':'f'*64,'parentSnapshots':snapshots,'parentImageIds':list(images)}
    def commit(self,job=1):
        with patch('helper.emit') as emitted,patch('helper.atomic_json',side_effect=write_json),patch('helper.sync_directory'):
            helper.incremental_commit({'job':JOB%job,'siteKey':SITE,'config':{'stagingRoot':str(self.staging)}})
        return emitted.call_args.kwargs['result']

class CaptureTests(CaptureHarness):
    def test_without_incremental_the_package_is_format_v1_exactly_as_before(self):
        source,=self.sources('data');manifest=self.capture(self.containers([[source]]))
        self.assertEqual(manifest['formatVersion'],1)
        for key in ['backupKind','chain','chainImages','snapshots','fallback']:self.assertNotIn(key,manifest)
        self.assertNotIn('incremental',manifest['containers'][0]['Mounts'][0])
        tar=[call for call in self.calls if call[0]=='tar' and '-cpf' in call]
        self.assertEqual(tar[0][:4],['tar','--xattrs','--acls','--numeric-owner'],'v1 archives keep the original flags')
        self.assertFalse(any(a.startswith('--listed-incremental') for call in self.calls for a in call))
        self.assertEqual(self.payload_names(),['images.tar','manifest.json','mount-0-0.tar','restore-guide.md'])
        self.assertEqual(self.saved,[['sha256:'+'0'*64,'sha256:'+'e'*63+'1']])
        self.assertFalse((self.root/'incremental').exists());self.assertFalse(self.state.exists())
        self.assertNotIn('Incremental backups',(self.root/'restore-guide.md').read_text())

    def test_full_backup_of_an_incremental_site_is_level_0_with_a_fresh_snapshot(self):
        source,=self.sources('data');manifest=self.capture(self.containers([[source]]),self.full_request())
        key=snapshot_key(source)
        self.assertEqual((manifest['formatVersion'],manifest['backupKind']),(2,'full'))
        self.assertEqual(manifest['chain'],{'id':'chain-a','position':0,'parentBackupId':None,'parentSha256':None})
        snar=(self.root/'incremental'/(key+'.snar')).read_bytes()
        self.assertTrue(snar.startswith(b'level0'),'tar starts a level-0 archive without a snapshot file')
        self.assertEqual(manifest['containers'][0]['Mounts'][0]['incremental'],{'snapshotKey':key,'level':0,'snapshotSha256':sha(snar),'renames':False})
        self.assertIs(manifest['renamesSeen'],False)
        self.assertEqual(manifest['snapshots'],{key:sha(snar)})
        self.assertIn('snapshot-%s.snar'%key,self.payload_names());self.assertIn('snapshot-%s.snar'%key,manifest['artifacts'])
        tar=next(call for call in self.calls if call[0]=='tar' and '-cpf' in call)
        self.assertIn('--format=posix',tar);self.assertIn('--listed-incremental='+str(self.root/'incremental'/(key+'.snar')),tar)
        self.assertEqual(manifest['chainImages'],[])
        self.assertIn('Incremental backups (format v2)',(self.root/'restore-guide.md').read_text())
        self.assertFalse((self.state/SITE).exists() and any((self.state/SITE).iterdir()),'Capture never writes the site state')
        self.assertEqual(json.loads((self.root/'incremental'/'ready.json').read_text())['snapshots'],{key:sha(snar)})

    def test_increment_uses_a_copy_of_the_committed_snapshot_and_skips_known_images(self):
        source,=self.sources('data');containers=self.containers([[source]]);key=snapshot_key(source)
        full=self.capture(containers,self.full_request(),job=1);self.commit(1)
        committed=(self.state/SITE/(key+'.snar')).read_bytes()
        manifest=self.capture(containers,self.increment_request(full['snapshots'],images=['sha256:'+'0'*64]),job=2)
        self.assertEqual(manifest['backupKind'],'incremental');self.assertNotIn('fallback',manifest)
        self.assertEqual(manifest['chain'],{'id':'chain-a','position':1,'parentBackupId':'backup-0','parentSha256':'f'*64})
        self.assertEqual(manifest['containers'][0]['Mounts'][0]['incremental']['level'],1)
        work=(self.root/'incremental'/(key+'.snar')).read_bytes()
        self.assertTrue(work.startswith(committed),'The increment continues from the committed snapshot')
        self.assertEqual((self.state/SITE/(key+'.snar')).read_bytes(),committed,'The state is unchanged until commit')
        self.assertEqual(self.saved[-1],['sha256:'+'e'*63+'2'],'Original images already in the chain are not saved again')
        self.assertEqual(manifest['chainImages'],['sha256:'+'0'*64])
        self.assertEqual(len(manifest['originalImages']),1,'The manifest still describes every original image')

    def test_an_increment_with_folder_renames_is_marked_so_the_next_backup_is_full(self):
        source,=self.sources('data');containers=self.containers([[source]])
        full=self.capture(containers,self.full_request(),job=1);self.commit(1)
        self.dumpdir='Dnew\0Rdata/old\0Tdata/new\0\0'
        manifest=self.capture(containers,self.increment_request(full['snapshots']),job=2)
        self.assertEqual(manifest['backupKind'],'incremental','The increment that first holds the rename stays valid')
        self.assertIs(manifest['renamesSeen'],True);self.assertIs(manifest['containers'][0]['Mounts'][0]['incremental']['renames'],True)
        self.dumpdir='Ya\0\0';self.commit(2)
        manifest=self.capture(containers,self.increment_request(manifest['snapshots'],position=2),job=3)
        self.assertIs(manifest['renamesSeen'],False)
    def test_missing_mismatched_or_changed_snapshots_make_a_full_backup_with_a_reason(self):
        a,b=self.sources('a','b');key=snapshot_key(a)
        full=self.capture(self.containers([[a]]),self.full_request(),job=1);self.commit(1)
        manifest=self.capture(self.containers([[a]]),self.increment_request({key:'0'*64}),job=2)
        self.assertEqual((manifest['backupKind'],manifest['fallback']),('full',{'reason':'snapshot-mismatch'}))
        self.assertEqual(manifest['chain'],{'id':'chain-fresh','position':0,'parentBackupId':None,'parentSha256':None})
        self.assertTrue((self.root/'incremental'/(key+'.snar')).read_bytes().startswith(b'level0'))
        manifest=self.capture(self.containers([[a,b]]),self.increment_request(full['snapshots']),job=3)
        self.assertEqual(manifest['fallback'],{'reason':'mount-set-changed'},'A new mount mid-chain starts a new chain')
        self.assertEqual(manifest['containers'][0]['Mounts'][1]['incremental']['level'],0)
        (self.state/SITE/(key+'.snar')).unlink()
        manifest=self.capture(self.containers([[a]]),self.increment_request(full['snapshots']),job=4)
        self.assertEqual(manifest['fallback'],{'reason':'snapshot-missing'})
        self.assertEqual(self.saved[-1][0],'sha256:'+'0'*64,'A fallback full saves every original image')

    def test_changed_exclusions_make_a_full_backup(self):
        source,=self.sources('data');containers=self.containers([[source]])
        full=self.capture(containers,self.full_request(),job=1);self.commit(1)
        self.assertEqual(json.loads((self.state/SITE/'state.json').read_text())['exclusions'],{snapshot_key(source):[]})
        manifest=self.capture(containers,self.increment_request(full['snapshots']),job=2,exclusions={source:[source+'/cache']})
        self.assertEqual(manifest['fallback'],{'reason':'mount-set-changed'})
        (self.state/SITE/'state.json').unlink()
        manifest=self.capture(containers,self.increment_request(full['snapshots']),job=3)
        self.assertEqual(manifest['fallback'],{'reason':'snapshot-missing'},'Snapshot files without a committed record are not trusted')
    def test_key_folders_inside_a_bind_mount_are_left_out_and_a_chain_that_held_them_restarts_full(self):
        source,=self.sources('home');containers=self.containers([[source]])
        full=self.capture(containers,self.full_request(),job=1);self.commit(1)
        self.assertNotIn('protectedPaths',full)
        tar=[call for call in self.calls if call[0]=='tar' and '-cpf' in call][-1]
        at=tar.index('--no-anchored')
        self.assertEqual(tar[at-1:at+3],['--no-wildcards','--no-anchored','--exclude=.ssh','--exclude=.gnupg'],'every bind mount archive leaves key folders out')
        # 2.12.0 chains hold ~/.ssh in their full backup: once one is found, the record changes and the chain restarts.
        (pathlib.Path(source)/'.ssh').mkdir();(pathlib.Path(source)/'app'/'.gnupg').mkdir(parents=True);(pathlib.Path(source)/'app'/'id.ssh').write_text('kept')
        manifest=self.capture(containers,self.increment_request(full['snapshots']),job=2)
        self.assertEqual((manifest['backupKind'],manifest['fallback']),('full',{'reason':'mount-set-changed'}))
        paths=[helper.lexical(source+'/.ssh'),helper.lexical(source+'/app/.gnupg')]
        self.assertEqual(manifest['protectedPaths'],[{'container':'app0','source':source,'path':path} for path in paths])
        self.assertIn('Key folders that were not copied',(self.root/'restore-guide.md').read_text())
        self.assertEqual(json.loads((self.root/'incremental'/'ready.json').read_text())['exclusions'],{snapshot_key(source):paths})
        tar=[call for call in self.calls if call[0]=='tar' and '-cpf' in call][-1]
        self.assertIn('--listed-incremental='+str(self.root/'incremental'/(snapshot_key(source)+'.snar')),tar);self.assertIn('--exclude=.ssh',tar)
        self.commit(2)
        manifest=self.capture(containers,self.increment_request(manifest['snapshots'],position=2),job=3)
        self.assertEqual(manifest['backupKind'],'incremental','the same key folders keep the chain going');self.assertNotIn('fallback',manifest)
    def test_volumes_and_protected_placeholders_are_archived_without_the_key_folder_filter(self):
        source,=self.sources('vol');containers=self.containers([[source]]);containers[0]['Mounts'][0]['Type']='volume'
        (pathlib.Path(source)/'.ssh').mkdir()
        manifest=self.capture(containers,self.full_request())
        self.assertNotIn('protectedPaths',manifest)
        self.assertFalse(any('--exclude=.ssh' in call for call in self.calls),'a volume is the container\'s own data')
    def test_shared_source_is_archived_once_with_one_snapshot(self):
        source,=self.sources('shared');manifest=self.capture(self.containers([[source],[source]]),self.full_request())
        tar=[call for call in self.calls if call[0]=='tar' and '-cpf' in call]
        self.assertEqual(len(tar),1)
        self.assertEqual(os.stat(self.root/'mount-0-0.tar').st_ino,os.stat(self.root/'mount-1-0.tar').st_ino)
        self.assertEqual(list(manifest['snapshots']),[snapshot_key(source)])
        self.assertEqual(manifest['containers'][1]['Mounts'][0]['incremental']['snapshotKey'],snapshot_key(source))

    @unittest.skipUnless(os.name=='posix','Holder names use POSIX paths')
    def test_protected_mounts_are_never_incremental(self):
        source,secret=self.sources('data','shadow')
        containers=self.containers([[source]]);containers[0]['Mounts'].append({'Type':'bind','Source':secret,'Destination':'/etc/shadow','RW':False})
        with patch('helper.protected_mount',side_effect=lambda s:s==secret):
            manifest=self.capture(containers,self.full_request())
        self.assertNotIn('incremental',manifest['containers'][0]['Mounts'][1])
        self.assertEqual(list(manifest['snapshots']),[snapshot_key(source)])
        holder=[call for call in self.calls if call[0]=='tar' and '-cpf' in call and call[-1]=='shadow']
        self.assertEqual(len(holder),1);self.assertFalse(any(a.startswith('--listed') for a in holder[0]))

    def test_failed_capture_leaves_the_state_alone(self):
        source,=self.sources('data');containers=self.containers([[source]]);key=snapshot_key(source)
        full=self.capture(containers,self.full_request(),job=1);self.commit(1)
        before=(self.state/SITE/(key+'.snar')).read_bytes()
        original=self.fake_run
        def failing(args,timeout=3600,input=None):
            if args[0]=='tar' and '-czf' in args:raise subprocess.CalledProcessError(2,'tar')
            return original(args,timeout,input)
        self.fake_run=failing
        with self.assertRaises(subprocess.CalledProcessError):self.capture(containers,self.increment_request(full['snapshots']),job=2)
        self.assertEqual((self.state/SITE/(key+'.snar')).read_bytes(),before)
        with self.assertRaisesRegex(ValueError,'no snapshot files to commit'):self.commit(2)
        self.assertEqual((self.state/SITE/(key+'.snar')).read_bytes(),before,'An uncommitted job never advances the chain')

class CommitTests(CaptureHarness):
    def test_commit_moves_snapshots_privately_and_is_idempotent(self):
        a,b=self.sources('a','b')
        self.capture(self.containers([[a,b]]),self.full_request(),job=1)
        result=self.commit(1);self.assertEqual(result,{'committed':True,'alreadyCommitted':False,'snapshots':2})
        for source in [a,b]:
            path=self.state/SITE/(snapshot_key(source)+'.snar')
            self.assertEqual(path.read_bytes(),(self.root/'incremental'/(snapshot_key(source)+'.snar')).read_bytes())
            if os.name=='posix':self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
        if os.name=='posix':self.assertEqual(stat.S_IMODE((self.state/SITE).stat().st_mode),0o700)
        self.assertTrue(self.commit(1)['alreadyCommitted'])
        # A later full without mount b drops b's snapshot; an older job can no longer overwrite the newer state.
        self.capture(self.containers([[a]]),self.full_request('chain-b'),job=2)
        record=json.loads((self.staging/(JOB%2)/'incremental'/'ready.json').read_text());record['capturedAt']=(record['capturedAt'] or 0)+10
        write_json(self.staging/(JOB%2)/'incremental'/'ready.json',record)
        self.commit(2)
        self.assertEqual(sorted(p.name for p in (self.state/SITE).glob('*.snar')),[snapshot_key(a)+'.snar'])
        with self.assertRaisesRegex(ValueError,'newer backup'):self.commit(1)
    def test_commit_refuses_other_sites_and_changed_copies(self):
        source,=self.sources('data');self.capture(self.containers([[source]]),self.full_request(),job=1)
        with patch('helper.emit'),self.assertRaisesRegex(ValueError,'another site'):
            helper.incremental_commit({'job':JOB%1,'siteKey':'site-2','config':{'stagingRoot':str(self.staging)}})
        (self.root/'incremental'/(snapshot_key(source)+'.snar')).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'missing or changed'):self.commit(1)
        self.assertFalse(any((self.state/SITE).glob('*.snar')))
        with patch('helper.emit'),self.assertRaises(ValueError):helper.incremental_commit({'job':'../x','siteKey':SITE,'config':{'stagingRoot':str(self.staging)}})
    def test_discard_forgets_the_site_and_is_idempotent(self):
        source,=self.sources('data');self.capture(self.containers([[source]]),self.full_request(),job=1);self.commit(1)
        with patch('helper.emit') as emitted,patch('helper.sync_directory'):
            self.state.mkdir(exist_ok=True);(self.state/('.lock-'+SITE)).write_text('')
            helper.incremental_discard({'siteKey':SITE});self.assertTrue(emitted.call_args.kwargs['result']['existed'])
            self.assertTrue((self.state/('.lock-'+SITE)).exists(),'The lock file stays so two processes never lock different files')
            helper.incremental_discard({'siteKey':SITE});self.assertFalse(emitted.call_args.kwargs['result']['existed'])
            with self.assertRaises(ValueError):helper.incremental_discard({'siteKey':'../etc'})
        self.assertFalse((self.state/SITE).exists())
    def test_main_routes_the_new_operations(self):
        with patch('helper.incremental_commit') as commit,patch('helper.incremental_discard') as discard:
            helper.main({'operation':'incremental-commit','job':JOB%1,'siteKey':SITE});helper.main({'operation':'incremental-discard','siteKey':SITE})
        commit.assert_called_once();discard.assert_called_once()

class ChainFingerprintTests(unittest.TestCase):
    def inspect(self,endpoint='e1',mac='02:42:ac:11:00:02',ip='172.17.0.2'):
        return [{'Id':'c0','Name':'/web','Image':'sha256:'+'1'*64,'State':{'Running':True,'StartedAt':endpoint},
                 'Mounts':[{'Type':'bind','Source':'/srv/data','Destination':'/data','RW':True,'Propagation':'rprivate'}],
                 'NetworkSettings':{'SandboxKey':'/var/run/docker/netns/'+endpoint,'IPAddress':ip,'Networks':{'site':{'Aliases':['web','c0'],'EndpointID':endpoint,'MacAddress':mac,'IPAddress':ip,'Gateway':'172.17.0.1','IPv6Gateway':'','GlobalIPv6Address':'','NetworkID':'n1'}}}}]
    def fingerprint(self,containers,cfg=None,exclusions=None):
        return helper.chain_fingerprint(cfg or {'composeFiles':['/srv/compose.yml']},containers,exclusions or {})
    def test_restart_fields_do_not_change_it(self):
        self.assertEqual(self.fingerprint(self.inspect()),self.fingerprint(self.inspect('e2','02:42:ac:11:00:09','172.17.0.9')))
    def test_structural_changes_do(self):
        base=self.fingerprint(self.inspect())
        changes=[]
        c=self.inspect();c[0]['Mounts'].append({'Type':'volume','Name':'v','Source':'/var/lib/docker/volumes/v/_data','Destination':'/v','RW':True});changes.append(c)
        c=self.inspect();c[0]['Mounts'][0]['RW']=False;changes.append(c)
        c=self.inspect();c[0]['Image']='sha256:'+'2'*64;changes.append(c)
        c=self.inspect();c.append({**self.inspect()[0],'Id':'c1','Name':'/worker'});changes.append(c)
        c=self.inspect();c[0]['NetworkSettings']['Networks']['other']={'Aliases':[]};changes.append(c)
        c=self.inspect();c[0]['NetworkSettings']['Networks']['site']['Aliases']=['web'];changes.append(c)
        for changed in changes:
            with self.subTest(changed=changed):self.assertNotEqual(self.fingerprint(changed),base)
        self.assertNotEqual(self.fingerprint(self.inspect(),{'composeFiles':['/srv/other.yml']}),base)
        self.assertNotEqual(self.fingerprint(self.inspect(),exclusions={'/srv/data':['/srv/data/cache']}),base)
    def test_v1_manifest_plan_stays_without_it(self):
        self.assertEqual(helper.v1_plan({'fingerprint':'f','chainFingerprint':'c'}),{'fingerprint':'f'})
        self.assertIn('chainFingerprint',helper.public_plan({'fingerprint':'f','chainFingerprint':'c','sources':[],'services':[]}))

class StreamRepeatTests(unittest.TestCase):
    def test_both_stream_passes_start_from_the_same_snapshot(self):
        """A direct capture runs each tar twice (inventory, then transfer); tar rewrites its snapshot each time."""
        with tempfile.TemporaryDirectory() as d:
            work=pathlib.Path(d);(work/'k.base').write_bytes(b'parent');state={'work':work,'level':1}
            script='import sys,pathlib;p=pathlib.Path(sys.argv[1]);data=p.read_bytes();p.write_bytes(data+b"+run");sys.stdout.buffer.write(data)'
            command=[sys.executable,'-c',script,str(work/'k.snar')]
            archive=tarfile.open(fileobj=io.BytesIO(),mode='w')
            with patch('helper.emit'):
                inventory=helper.stream_artifacts(archive,[('mount-0-0.tar',command,None)],before={'mount-0-0.tar':lambda:helper.reset_snapshot(state,'k')})
            self.assertEqual(inventory['mount-0-0.tar'],{'bytes':6,'sha256':sha(b'parent')})
            self.assertEqual((work/'k.snar').read_bytes(),b'parent+run')
            with patch('helper.emit'),self.assertRaisesRegex(ValueError,'(grew|changed) during capture'):
                helper.stream_artifacts(tarfile.open(fileobj=io.BytesIO(),mode='w'),[('mount-0-0.tar',command,None)])

# ---- Chain restore ----
def mount_tar(entries):
    """A POSIX archive with one top folder 'data'. entries: (name, kind, value, pax)."""
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w',format=tarfile.PAX_FORMAT) as tar:
        for name,kind,value,pax in entries:
            info=tarfile.TarInfo(name);info.pax_headers=dict(pax or {})
            if kind=='dir':info.type=tarfile.DIRTYPE;info.mode=0o755;tar.addfile(info)
            elif kind=='sym':info.type=tarfile.SYMTYPE;info.linkname=value;tar.addfile(info)
            elif kind=='lnk':info.type=tarfile.LNKTYPE;info.linkname=value;tar.addfile(info)
            else:data=value.encode();info.size=len(data);info.mode=0o644;tar.addfile(info,io.BytesIO(data))
    return buffer.getvalue()
def package(path,manifest,files):
    """A plaintext package as capture makes it: artifacts, manifest with inventory, guide."""
    manifest=dict(manifest);manifest['artifacts']={name:{'bytes':len(data),'sha256':sha(data)} for name,data in files.items()}
    files={**files,'manifest.json':json.dumps(manifest).encode(),'restore-guide.md':b'guide'}
    with tarfile.open(path,'w:gz') as tar:
        for name,data in files.items():
            info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o600;tar.addfile(info,io.BytesIO(data))
    return sha(pathlib.Path(path).read_bytes())
KEY=snapshot_key('/srv/data')
def chain_manifest(k,chain_id='chain-a',parent=None,level=None):
    snar=('snar-%d'%k).encode()
    return {'formatVersion':2,'complete':True,'kind':'docker','backupKind':'full' if k==0 else 'incremental','chain':{'id':chain_id,'position':k,'parentBackupId':parent[0] if parent else None,'parentSha256':parent[1] if parent else None},
            'containers':[{'Id':'c0','Name':'/app','Mounts':[{'Type':'bind','Source':'/srv/data','Destination':'/data','incremental':{'snapshotKey':KEY,'level':(0 if k==0 else 1) if level is None else level,'snapshotSha256':sha(snar)}}]}],
            'snapshotImages':['sha256:'+'e'*64],'originalImages':[],'configurationFiles':[]},snar
class ChainBuilder(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.root=pathlib.Path(directory.name)/'restore';self.root.mkdir()
        helper.CHAIN_LINKS.clear();self.addCleanup(helper.CHAIN_LINKS.clear)
    def build(self,archives,mutate=None):
        """archives: mount tar bytes per link. Returns the restore request chain."""
        chain=[];parent=None
        for k,data in enumerate(archives):
            manifest,snar=chain_manifest(k,parent=parent)
            if mutate:manifest=mutate(k,manifest) or manifest
            plaintext=package(self.root/('payload-%d.tar.gz'%k),manifest,{'images.tar':b'images-%d'%k,'mount-0-0.tar':data,'snapshot-%s.snar'%KEY:snar})
            ciphertext=sha(b'cipher-%d'%k)
            chain.append({'backupId':'backup-%d'%k,'sha256':ciphertext,'plaintextChecksum':plaintext});parent=('backup-%d'%k,ciphertext)
        return chain
    def assert_nothing_extracted(self):
        self.assertEqual(sorted(p.name for p in self.root.iterdir() if not p.name.startswith('payload-')),[],'Nothing is extracted before every link is verified')
SIMPLE=[mount_tar([('data','dir',None,None),('data/a','file','a',None)])]*3

class ChainVerificationTests(ChainBuilder):
    def test_valid_chain_unpacks_every_link_and_orders_archives_and_images(self):
        chain=self.build(SIMPLE)
        unpacked,manifest,verified=unpack_verified({'chain':chain},self.root)
        self.assertTrue(verified);self.assertEqual(manifest['chain']['position'],2);self.assertEqual(unpacked,self.root/'unpacked')
        self.assertEqual(mount_archive(unpacked,0,0),[self.root/'chain-0'/'mount-0-0.tar',self.root/'chain-1'/'mount-0-0.tar',self.root/'unpacked'/'mount-0-0.tar'])
        self.assertEqual(image_archives(unpacked),[self.root/'chain-0'/'images.tar',self.root/'chain-1'/'images.tar',self.root/'unpacked'/'images.tar'])
        self.assertEqual(helper.mount_bytes(unpacked),3*len(SIMPLE[0]))
    def test_tampered_link_is_refused_before_any_extraction(self):
        chain=self.build(SIMPLE)
        data=bytearray((self.root/'payload-1.tar.gz').read_bytes());data[-30]^=1;(self.root/'payload-1.tar.gz').write_bytes(bytes(data))
        with self.assertRaisesRegex(ValueError,'depends on backup backup-1, which is missing or damaged'):unpack_verified({'chain':chain},self.root)
        self.assert_nothing_extracted()
    def test_missing_link_is_refused(self):
        chain=self.build(SIMPLE);(self.root/'payload-0.tar.gz').unlink()
        with self.assertRaisesRegex(ValueError,'backup-0, which is missing or damaged'):unpack_verified({'chain':chain},self.root)
        self.assert_nothing_extracted()
    def test_reordered_links_are_refused(self):
        chain=self.build(SIMPLE)
        for a,b in [(0,1),(1,2)]:
            moved=[dict(link) for link in chain];moved[a],moved[b]=moved[b],moved[a]
            (self.root/('payload-%d.tar.gz'%a)).rename(self.root/'swap');(self.root/('payload-%d.tar.gz'%b)).rename(self.root/('payload-%d.tar.gz'%a));(self.root/'swap').rename(self.root/('payload-%d.tar.gz'%b))
            with self.subTest(swap=(a,b)),self.assertRaises(ValueError):unpack_verified({'chain':moved},self.root)
            (self.root/('payload-%d.tar.gz'%a)).rename(self.root/'swap');(self.root/('payload-%d.tar.gz'%b)).rename(self.root/('payload-%d.tar.gz'%a));(self.root/'swap').rename(self.root/('payload-%d.tar.gz'%b))
        self.assert_nothing_extracted()
    def test_swapped_parent_or_foreign_chain_is_refused(self):
        def wrong_parent(k,m):
            if k==2:m['chain']['parentSha256']='0'*64
        chain=self.build(SIMPLE,wrong_parent)
        with self.assertRaisesRegex(ValueError,'backup-1, which is missing or damaged'):unpack_verified({'chain':chain},self.root)
        def foreign(k,m):
            if k==1:m['chain']['id']='chain-other'
        chain=self.build(SIMPLE,foreign)
        with self.assertRaisesRegex(ValueError,'missing or damaged'):unpack_verified({'chain':chain},self.root)
        def level(k,m):
            if k==1:m['containers'][0]['Mounts'][0]['incremental']['level']=0
        chain=self.build(SIMPLE,level)
        with self.assertRaises(ValueError):unpack_verified({'chain':chain},self.root)
        self.assert_nothing_extracted()
    def test_chain_must_start_with_a_full_v2_package(self):
        chain=self.build(SIMPLE[:2])
        manifests=[helper.payload_manifest(self.root/('payload-%d.tar.gz'%k)) for k in range(2)]
        self.assertIsNone(chain_problem(manifests,chain))
        self.assertIn('not a full backup',chain_problem(manifests[1:],chain[1:]))
        self.assertEqual(chain_problem([{**manifests[0],'formatVersion':1}],chain[:1]),'The first backup of the chain is not a full backup.')
        self.assertEqual(chain_problem([{**manifests[0],'formatVersion':3}],chain[:1]),'Unsupported or incomplete backup')
        with self.assertRaises(ValueError):unpack_verified({'chain':chain+[dict(chain[0],backupId='x')]*31},self.root)
        with self.assertRaises(ValueError):unpack_verified({'chain':[{'backupId':'../x','sha256':'a'*64,'plaintextChecksum':'b'*64}]},self.root)
    def test_snapshot_file_must_match_the_manifest(self):
        def bad(k,m):
            if k==1:m['containers'][0]['Mounts'][0]['incremental']['snapshotSha256']='0'*64
        chain=self.build(SIMPLE,bad)
        with self.assertRaisesRegex(ValueError,'snapshot file differs'):unpack_verified({'chain':chain},self.root)
    def test_single_v2_increment_without_its_chain_is_refused_and_v2_full_restores_alone(self):
        manifest,snar=chain_manifest(1,parent=('backup-0','a'*64))
        plaintext=package(self.root/'payload.tar.gz',manifest,{'images.tar':b'i','mount-0-0.tar':SIMPLE[0],'snapshot-%s.snar'%KEY:snar})
        with self.assertRaisesRegex(ValueError,'incremental; restore it together with its chain'):unpack_verified({'plaintextChecksum':plaintext},self.root)
        root=self.root/'full';root.mkdir()
        manifest,snar=chain_manifest(0)
        plaintext=package(root/'payload.tar.gz',manifest,{'images.tar':b'i','mount-0-0.tar':SIMPLE[0],'snapshot-%s.snar'%KEY:snar})
        unpacked,manifest,verified=unpack_verified({'plaintextChecksum':plaintext},root)
        self.assertTrue(verified);self.assertEqual(mount_archive(unpacked,0,0),unpacked/'mount-0-0.tar');self.assertEqual(image_archives(unpacked),[unpacked/'images.tar'])
    def test_v1_packages_are_unchanged_and_unknown_formats_refused(self):
        manifest={'formatVersion':1,'complete':True,'kind':'docker','containers':[{'Mounts':[{'Type':'bind','Source':'/srv/data'}]}],'configurationFiles':[]}
        plaintext=package(self.root/'payload.tar.gz',manifest,{'images.tar':b'i','mount-0-0.tar':SIMPLE[0]})
        unpacked,_,verified=unpack_verified({'plaintextChecksum':plaintext},self.root)
        self.assertTrue(verified);self.assertEqual(mount_archive(unpacked,0,0),unpacked/'mount-0-0.tar')
        root=self.root/'v3';root.mkdir()
        plaintext=package(root/'payload.tar.gz',{**manifest,'formatVersion':3},{'images.tar':b'i','mount-0-0.tar':SIMPLE[0]})
        with self.assertRaisesRegex(ValueError,'Unsupported or incomplete backup'):unpack_verified({'plaintextChecksum':plaintext},root)
        root=self.root/'v1snar';root.mkdir()
        plaintext=package(root/'payload.tar.gz',manifest,{'images.tar':b'i','mount-0-0.tar':SIMPLE[0],'snapshot-%s.snar'%KEY:b'x'})
        with self.assertRaisesRegex(ValueError,'missing, changed or unexpected|does not cover'):unpack_verified({'plaintextChecksum':plaintext},root)
    def test_prepare_restore_returns_one_path_per_link(self):
        with patch('helper.owned_job_root',return_value=self.root/'job'),patch('helper.emit') as emitted:
            helper.prepare_restore({'job':JOB%1,'chainLength':3})
        self.assertEqual(emitted.call_args.kwargs['result']['remotePaths'],[str(self.root/'job'/('payload-%d.tar.gz'%k)) for k in range(3)])
        for bad in [0,32,True,'3']:
            with patch('helper.owned_job_root',return_value=self.root/('bad-%s'%bad)),patch('helper.emit'),self.assertRaises(ValueError):helper.prepare_restore({'job':JOB%1,'chainLength':bad})
            self.assertFalse((self.root/('bad-%s'%bad)).exists())

class DumpdirTests(unittest.TestCase):
    def test_dumpdir_names_stay_inside_the_archive(self):
        self.assertFalse(dumpdir_problem('Ya\0Nb\0Dsub\0\0','data'))
        self.assertFalse(dumpdir_problem('Dmoved\0Nx\0Rdata/sub\0Tdata/moved\0\0','data'))
        # A swap of a and b, as GNU tar 1.35 writes it: X names the temporary folder, empty R/T stand for it.
        self.assertFalse(dumpdir_problem('Da\0Db\0Xdata\0Rdata/b\0T\0Rdata/a\0Tdata/b\0R\0Tdata/a\0\0','data'))
        for value in ['Y../x\0\0','Ya/b\0\0','Y..\0\0','Q\0\0','Rdata/../..\0Tdata/x\0\0','R/etc\0Tdata/x\0\0','Rdata/a\0T../b\0\0','Rother/a\0Tdata/a\0\0','Xdata//a\0\0','Y\0\0','X\0\0','N\0\0','D\0\0','X../t\0\0','X.\0\0','R.\0Tdata/a\0\0',None]:
            with self.subTest(value=value):self.assertTrue(dumpdir_problem(value,'data'))
    def check(self,entries,destination=None):
        with tempfile.TemporaryDirectory() as d:
            archive=pathlib.Path(d)/'m.tar';archive.write_bytes(mount_tar(entries))
            root=pathlib.Path(d)/'out';root.mkdir()
            return incremental_archive_check(archive,root.resolve())
    def test_traversal_in_a_dumpdir_or_member_is_refused_before_extraction(self):
        self.assertEqual(self.check([('data','dir',None,{'GNU.dumpdir':'Ya\0\0'}),('data/a','file','a',None)]),'data')
        for entries in [[('data','dir',None,{'GNU.dumpdir':'Y../../etc\0\0'})],
                        [('data','dir',None,{'GNU.dumpdir':'Rdata/x\0T../../tmp/x\0\0'})],
                        [('data','dir',None,None),('data/a','file','a',{'GNU.dumpdir':'Yb\0\0'})],
                        [('data','dir',None,None),('data/../x','file','a',None)],
                        [('data','dir',None,None),('other','dir',None,None)],
                        [('data','dir',None,None),('data/l','sym','../../etc',None)],
                        [('data','dir',None,None),('data/l','sym','sub',None),('data/l/x','file','a',None)],
                        [('data','dir',None,None),('data/h','lnk','data/missing',None)]]:
            with self.subTest(entries=entries),self.assertRaises(ValueError):self.check(entries)
    def test_gnu_format_incremental_headers_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            buffer=io.BytesIO()
            with tarfile.open(fileobj=buffer,mode='w',format=tarfile.GNU_FORMAT) as tar:
                info=tarfile.TarInfo('data');info.type=tarfile.DIRTYPE;tar.addfile(info)
            archive=pathlib.Path(d)/'m.tar';archive.write_bytes(buffer.getvalue());(pathlib.Path(d)/'out').mkdir()
            with self.assertRaisesRegex(ValueError,'POSIX tar format'):incremental_archive_check(archive,(pathlib.Path(d)/'out').resolve())
    def test_renames_move_restored_symlinks_before_they_are_checked(self):
        links={('data','a','b','l'):'../../../x'}
        self.assertFalse(helper.archive_link_escapes(('data','a','b'),'../../../x',links),'Inside the destination where it was restored')
        moved=helper.rename_links(links,helper.dumpdir_renames('Da\0Db\0Rdata/a/b\0Tdata/b\0\0'))
        self.assertEqual(moved,{('data','b','l'):'../../../x'})
        self.assertTrue(helper.archive_link_escapes(('data','b'),'../../../x',moved),'After the rename the same link leaves the destination')
        cycle=helper.rename_links({('data','a','l'):'x'},helper.dumpdir_renames('Da\0Db\0Xdata\0Rdata/b\0T\0Rdata/a\0Tdata/b\0R\0Tdata/a\0\0'))
        self.assertEqual(cycle,{('data','b','l'):'x'})
        for value in ['Rdata/a\0\0','Tdata/a\0\0','Rdata/a\0Rdata/b\0Tdata/c\0\0']:
            with self.subTest(value=value),self.assertRaises(ValueError):helper.dumpdir_renames(value)
    @unittest.skipUnless(os.name=='posix','Needs symbolic links')
    def test_rename_that_carries_a_link_outside_the_destination_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'out';(root/'data'/'a'/'b').mkdir(parents=True);os.symlink('../../../x',root/'data'/'a'/'b'/'l')
            archive=pathlib.Path(d)/'m.tar'
            archive.write_bytes(mount_tar([('data','dir',None,{'GNU.dumpdir':'Da\0Db\0Rdata/a/b\0Tdata/b\0\0'}),('data/b','dir',None,{'GNU.dumpdir':'Yl\0\0'}),('data/b/l/evil','file','x',None)]))
            with self.assertRaisesRegex(ValueError,'write through|escapes'):incremental_archive_check(archive,root.resolve())
            archive.write_bytes(mount_tar([('data','dir',None,{'GNU.dumpdir':'Da\0Db\0Rdata/a/b\0Tdata/b\0\0'})]))
            with self.assertRaisesRegex(ValueError,'escapes'):incremental_archive_check(archive,root.resolve())
    @unittest.skipUnless(os.name=='posix','Needs symbolic links')
    def test_rename_through_a_restored_folder_link_is_refused(self):
        # renameat follows data/s -> real, so tar would move real/sub (and its link) to data/new.
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'out';(root/'data'/'real'/'sub').mkdir(parents=True);os.symlink('../../../x',root/'data'/'real'/'sub'/'l');os.symlink('real',root/'data'/'s')
            archive=pathlib.Path(d)/'m.tar'
            for entries in [[('data','dir',None,{'GNU.dumpdir':'Dnew\0Dreal\0Ns\0Rdata/s/sub\0Tdata/new\0\0'}),('data/new','dir',None,{'GNU.dumpdir':'Nl\0\0'}),('data/new/l/evil','file','x',None)],
                            [('data','dir',None,{'GNU.dumpdir':'Dreal\0Ns\0Rdata/real/sub\0Tdata/s/moved\0\0'})],
                            [('data','dir',None,{'GNU.dumpdir':'Dreal\0Ns\0Rdata/s\0Tdata/t\0\0'})]]:
                archive.write_bytes(mount_tar(entries))
                with self.subTest(entries=entries[0][3]),self.assertRaisesRegex(ValueError,'Unsafe directory listing'):incremental_archive_check(archive,root.resolve())
    @unittest.skipUnless(os.name=='posix','Needs symbolic links')
    def test_interleaved_renames_are_checked_in_archive_order(self):
        # Rename out, write through the moved link, rename back: the final layout looks harmless, the middle does not.
        for target,expected in [('../../../x','escapes'),('../c','write through')]:
            with self.subTest(target=target),tempfile.TemporaryDirectory() as d:
                root=pathlib.Path(d)/'out';(root/'data'/'a'/'b').mkdir(parents=True);(root/'data'/'c').mkdir();os.symlink(target,root/'data'/'a'/'b'/'l')
                archive=pathlib.Path(d)/'m.tar'
                archive.write_bytes(mount_tar([('data','dir',None,{'GNU.dumpdir':'Da\0Dc\0Rdata/a/b\0Tdata/b\0\0'}),('data/b/l/evil','file','x',None),('data/c','dir',None,{'GNU.dumpdir':'Rdata/b\0Tdata/a/b\0\0'})]))
                with self.assertRaisesRegex(ValueError,expected):incremental_archive_check(archive,root.resolve())
    @unittest.skipUnless(os.name=='posix','Needs symbolic links')
    def test_link_replaced_by_a_folder_next_to_a_swap_is_accepted(self):
        # Linux integration (points 4 and 5): lnk -> da, da and db swapped, then lnk becomes a real folder. GNU tar 1.35
        # repeats the swap's rename records in later increments; the swap never moves lnk, so the link is replaced.
        swap='Nasset.txt\0Dda\0Ndatabase.sqlite\0Ddb\0Dlnk\0Duploads\0X_data\0R_data/db\0T\0R_data/da\0T_data/db\0R\0T_data/da\0\0'
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'out'
            for name in ['da','db','uploads']:(root/'_data'/name).mkdir(parents=True)
            os.symlink('da',root/'_data'/'lnk')
            archive=pathlib.Path(d)/'m.tar'
            archive.write_bytes(mount_tar([('_data','dir',None,{'GNU.dumpdir':swap}),('_data/da','dir',None,{'GNU.dumpdir':'Ng.txt\0\0'}),('_data/db','dir',None,{'GNU.dumpdir':'Nf.txt\0\0'}),('_data/lnk','dir',None,{'GNU.dumpdir':'Yfile.txt\0\0'}),('_data/lnk/file.txt','file','real now',None),('_data/uploads','dir',None,{'GNU.dumpdir':'\0'})]))
            replace=[]
            self.assertEqual(incremental_archive_check(archive,root.resolve(),None,replace),'_data')
            self.assertEqual(replace,[pathlib.PurePosixPath('_data/lnk')])
            # A rename that moves the link, then a folder at its new place: still refused, naming the rule only.
            os.unlink(root/'_data'/'lnk');(root/'_data'/'x').mkdir();os.symlink('../da',root/'_data'/'x'/'l')
            archive.write_bytes(mount_tar([('_data','dir',None,{'GNU.dumpdir':'Dz\0R_data/x\0T_data/z\0\0'}),('_data/z','dir',None,{'GNU.dumpdir':'Dl\0\0'}),('_data/z/l','dir',None,{'GNU.dumpdir':'\0'})]))
            with self.assertRaisesRegex(ValueError,r'^Unsafe directory listing in incremental archive \(folder replaces a moved symlink\)$'):incremental_archive_check(archive,root.resolve())
    @unittest.skipUnless(os.name=='posix','Needs symbolic links')
    def test_rename_with_an_internal_link_is_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'out';(root/'data'/'a'/'b').mkdir(parents=True);(root/'data'/'a'/'c').mkdir();os.symlink('../c',root/'data'/'a'/'b'/'l')
            archive=pathlib.Path(d)/'m.tar'
            archive.write_bytes(mount_tar([('data','dir',None,{'GNU.dumpdir':'Da\0\0'}),('data/a','dir',None,{'GNU.dumpdir':'Dc\0Dd\0Rdata/a/b\0Tdata/a/d\0\0'}),('data/a/d','dir',None,{'GNU.dumpdir':'Nl\0Ynew\0\0'}),('data/a/d/new','file','n',None)]))
            self.assertEqual(incremental_archive_check(archive,root.resolve()),'data')
    def test_repeated_rename_records_in_consecutive_increments_are_refused_before_extraction(self):
        with tempfile.TemporaryDirectory() as d:
            def archive(name,dumpdir):
                path=pathlib.Path(d)/name;path.write_bytes(mount_tar([('data','dir',None,{'GNU.dumpdir':dumpdir})]));return path
            full=archive('0.tar','Da\0Db\0\0');swap='Da\0Db\0Xdata\0Rdata/b\0T\0Rdata/a\0Tdata/b\0R\0Tdata/a\0\0'
            first=archive('1.tar',swap);again=archive('2.tar',swap);plain=archive('3.tar','Da\0Db\0\0')
            self.assertIsNone(helper.chain_rename_problem([full,first]))
            self.assertIsNone(helper.chain_rename_problem([full,first,plain,first]))
            self.assertIn('(repeated rename records)',helper.chain_rename_problem([full,first,again]))
            junk=pathlib.Path(d)/'junk.tar';junk.write_bytes(b'not a tar')
            self.assertIn('(repeated rename records)',helper.chain_rename_problem([full,first,junk]),'An unreadable archive counts as renamed')
            if os.name=='posix':
                with self.assertRaisesRegex(ValueError,'repeated rename records'):helper.chain_extract([full,first,again],pathlib.Path(d)/'out')
                self.assertFalse((pathlib.Path(d)/'out').exists(),'Refused before anything is extracted')
    @unittest.skipUnless(os.name=='posix','Needs symbolic links')
    def test_link_in_place_under_a_renamed_parent_cannot_become_a_folder(self):
        # The parent is renamed away and back, so the model leaves the link where it was; tar's renames still touch it.
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'out';(root/'_data'/'p').mkdir(parents=True);os.symlink('../x',root/'_data'/'p'/'l')
            archive=pathlib.Path(d)/'m.tar'
            archive.write_bytes(mount_tar([('_data','dir',None,{'GNU.dumpdir':'Dp\0R_data/p\0T_data/t\0R_data/t\0T_data/p\0\0'}),('_data/p','dir',None,{'GNU.dumpdir':'Dl\0\0'}),('_data/p/l','dir',None,{'GNU.dumpdir':'\0'})]))
            with self.assertRaisesRegex(ValueError,r'\(folder replaces a moved symlink\)'):incremental_archive_check(archive,root.resolve())
    def test_global_pax_headers_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            buffer=io.BytesIO()
            with tarfile.open(fileobj=buffer,mode='w',format=tarfile.PAX_FORMAT,pax_headers={'path':'../escape'}) as tar:
                info=tarfile.TarInfo('data');info.type=tarfile.DIRTYPE;tar.addfile(info)
            archive=pathlib.Path(d)/'m.tar';archive.write_bytes(buffer.getvalue());(pathlib.Path(d)/'out').mkdir()
            with self.assertRaisesRegex(ValueError,'global tar headers'):incremental_archive_check(archive,(pathlib.Path(d)/'out').resolve())
    def test_increment_must_continue_the_same_top_folder(self):
        with tempfile.TemporaryDirectory() as d:
            archive=pathlib.Path(d)/'m.tar';archive.write_bytes(mount_tar([('other','dir',None,None)]));(pathlib.Path(d)/'out').mkdir()
            with self.assertRaisesRegex(ValueError,'one source entry'):incremental_archive_check(archive,(pathlib.Path(d)/'out').resolve(),'data')
    @unittest.skipUnless(os.name=='posix','Needs symbolic links')
    def test_symlink_left_by_an_earlier_link_cannot_be_written_through(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'out';(root/'data'/'real').mkdir(parents=True);os.symlink('real',root/'data'/'l')
            archive=pathlib.Path(d)/'m.tar';archive.write_bytes(mount_tar([('data','dir',None,None),('data/l/x','file','a',None)]))
            with self.assertRaisesRegex(ValueError,'write through'):incremental_archive_check(archive,root.resolve())
            # The kernel resolves l/.. through the link: data/l -> real, so l/../.. is the destination itself (allowed)
            # and l/../../.. is its parent (refused), although both look contained when read lexically.
            archive.write_bytes(mount_tar([('data','dir',None,None),('data/up','sym','l/../..',None)]))
            self.assertEqual(incremental_archive_check(archive,root.resolve()),'data')
            archive.write_bytes(mount_tar([('data','dir',None,None),('data/up','sym','l/../../..',None)]))
            with self.assertRaisesRegex(ValueError,'escapes'):incremental_archive_check(archive,root.resolve())
            archive.write_bytes(mount_tar([('data','dir',None,None),('data/up','sym','l/../../../etc',None)]))
            with self.assertRaisesRegex(ValueError,'escapes'):incremental_archive_check(archive,root.resolve())
            (root/'data'/'real'/'f').write_text('x')
            archive.write_bytes(mount_tar([('data','dir',None,None),('data/h','lnk','data/real/f',None)]))
            self.assertEqual(incremental_archive_check(archive,root.resolve()),'data','A hard link may target a file an earlier archive restored')
    def test_chain_extraction_needs_linux(self):
        if os.name=='posix':self.skipTest('Linux runs the real extraction tests')
        with tempfile.TemporaryDirectory() as d,self.assertRaisesRegex(ValueError,'GNU tar on Linux'):helper.chain_extract([pathlib.Path(d)/'m.tar'],pathlib.Path(d)/'out')

class ZipExportTests(unittest.TestCase):
    def test_full_v2_exports_with_snapshot_files_kept_as_originals(self):
        with tempfile.TemporaryDirectory() as d:
            manifest,snar=chain_manifest(0);manifest['containers'][0]['Name']='/app'
            path=pathlib.Path(d)/'payload.tar.gz';package(path,manifest,{'images.tar':b'i','mount-0-0.tar':mount_tar([('data','dir',None,{'GNU.dumpdir':'Ya\0\0'}),('data/a','file','hello',None)]),'snapshot-%s.snar'%KEY:snar})
            output=io.BytesIO();export_zip(str(path),output)
            names=zipfile.ZipFile(output).namelist()
            self.assertIn('recovery-originals/snapshot-%s.snar'%KEY,names);self.assertIn('site-files/app/data/a',names)
            scanned=io.BytesIO()
            with open(path,'rb') as stream:scan_stream(stream,scanned)
            self.assertEqual(json.loads(scanned.getvalue())['backupKind'],'full')
    def test_increment_is_refused_with_the_download_chain_message(self):
        with tempfile.TemporaryDirectory() as d:
            manifest,snar=chain_manifest(1,parent=('backup-0','a'*64))
            path=pathlib.Path(d)/'payload.tar.gz';package(path,manifest,{'images.tar':b'i','mount-0-0.tar':SIMPLE[0],'snapshot-%s.snar'%KEY:snar})
            with self.assertRaises(IncrementalBackup) as refused:export_zip(str(path),io.BytesIO())
            self.assertEqual(str(refused.exception),'This backup is incremental. Use Download chain.')
            with open(path,'rb') as stream,self.assertRaises(IncrementalBackup):scan_stream(stream,io.BytesIO())
            result=subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('export_zip.py')),str(path),str(pathlib.Path(d)/'out.zip')],capture_output=True,text=True)
            self.assertEqual(result.returncode,1);self.assertIn('This backup is incremental. Use Download chain.',result.stderr)
    def test_snapshot_entries_are_refused_in_v1_packages(self):
        with tempfile.TemporaryDirectory() as d:
            manifest={'formatVersion':1,'complete':True,'kind':'docker','containers':[],'configurationFiles':[]}
            path=pathlib.Path(d)/'payload.tar.gz';package(path,manifest,{'images.tar':b'i','snapshot-%s.snar'%KEY:b'x'})
            with self.assertRaisesRegex(ValueError,'Unexpected backup entry'):export_zip(str(path),io.BytesIO())

# ---- Real GNU tar (Linux) ----
def tree(root):
    """Everything a restore must keep: type, mode, content, link target, hard-link groups and user xattrs."""
    result={};groups={}
    for current,dirs,files in os.walk(root):
        for name in sorted(dirs+files)+([] if current!=str(root) else ['.']):
            path=os.path.join(current,name) if name!='.' else str(root);info=os.lstat(path);rel=os.path.relpath(path,root)
            if stat.S_ISLNK(info.st_mode):entry=('link',os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):entry=('dir',stat.S_IMODE(info.st_mode))
            else:
                entry=('file',stat.S_IMODE(info.st_mode),pathlib.Path(path).read_bytes(),groups.setdefault((info.st_dev,info.st_ino),rel) if info.st_nlink>1 else None)
            if not stat.S_ISLNK(info.st_mode) and hasattr(os,'listxattr'):
                try:entry+=(tuple(sorted((key,os.getxattr(path,key)) for key in os.listxattr(path) if key.startswith('user.'))),)
                except OSError:pass
            if os.geteuid()==0:entry+=(info.st_uid,info.st_gid)
            result[rel]=entry
    return result
@unittest.skipUnless(LINUX_GNU_TAR,'Needs GNU tar on Linux')
class GnuTarChainTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.base=pathlib.Path(directory.name);self.source=self.base/'src'/'data';self.source.mkdir(parents=True)
        self.work=self.base/'work';self.work.mkdir();self.snar=self.work/'s.snar';self.archives=[];self.trees=[]
    def dump(self):
        k=len(self.archives);target=self.work/('mount-%d.tar'%k)
        helper.source_archive(str(self.source),target,snapshot=self.snar)
        self.archives.append(target);self.trees.append(tree(self.source))
        time.sleep(1.1)  # the next change is clearly newer than this dump
        return target
    def restore(self,count):
        destination=self.base/('out-%d-%s'%(count,uuid.uuid4().hex[:6]))
        helper.chain_extract(self.archives[:count],destination)
        return destination/'data'
    def xattr(self,path,value):
        try:os.setxattr(path,'user.docknest',value);return True
        except (OSError,AttributeError):return False
    def test_full_and_three_increments_restore_every_point_exactly(self):
        s=self.source;(s/'keep').write_text('unchanged');(s/'edit').write_text('v1');(s/'gone').write_text('bye');(s/'dir'/'deep').mkdir(parents=True);(s/'dir'/'deep'/'f').write_text('f')
        os.symlink('keep',s/'link');os.chmod(s/'edit',0o640);self.xattr(s/'keep',b'one')
        self.dump()
        (s/'edit').write_text('v2');(s/'gone').unlink();(s/'dir').rename(s/'moved');(s/'new').write_text('new');os.chmod(s/'keep',0o600)
        increment=self.dump()
        with tarfile.open(increment) as tar:
            files={m.name for m in tar.getmembers() if m.isfile()}
        self.assertIn('data/edit',files);self.assertIn('data/new',files)
        self.assertFalse(any(name.endswith('/gone') for name in files))
        os.link(s/'new',s/'hard');os.unlink(s/'link');os.symlink('moved/deep/f',s/'link');self.xattr(s/'edit',b'two')
        self.dump()
        os.chmod(s/'moved',0o700);(s/'moved'/'deep'/'f').write_text('f2');(s/'keep').unlink();(s/'keep').mkdir();(s/'keep'/'inside').write_text('i')
        self.dump()
        for count in range(1,5):
            with self.subTest(point=count):self.assertEqual(tree(self.restore(count)),self.trees[count-1])
    def test_swapped_folders_restore(self):
        s=self.source;(s/'a').mkdir();(s/'b').mkdir();(s/'a'/'fa').write_text('a');(s/'b'/'fb').write_text('b')
        self.dump()
        os.rename(s/'a',s/'tmp');os.rename(s/'b',s/'a');os.rename(s/'tmp',s/'b')
        self.dump()
        self.assertEqual(tree(self.restore(2)),self.trees[1])
    def test_renamed_folder_with_an_internal_link_restores(self):
        s=self.source;(s/'a'/'b').mkdir(parents=True);(s/'a'/'c').mkdir();(s/'a'/'c'/'f').write_text('f');os.symlink('../c/f',s/'a'/'b'/'l')
        self.dump()
        os.rename(s/'a'/'b',s/'a'/'d');(s/'a'/'d'/'new').write_text('n')
        self.dump()
        restored=self.restore(2)
        self.assertEqual(tree(restored),self.trees[1]);self.assertEqual((restored/'a'/'d'/'l').read_text(),'f')
    def test_integration_sequence_swap_ends_the_chain_and_every_point_restores(self):
        # Points as in the Linux integration. An increment whose archive carries renames ends its chain (the engine
        # makes the next backup full, `folders-renamed`), so GNU tar's repeated rename records never reach a restore.
        s=self.source;chains=[[]];points=[]
        def renamed(path):
            with open(path,'rb') as handle:return helper.archive_renames_safely(handle)
        def point():
            if chains[-1] and renamed(self.archives[-1]):
                chains.append([]);self.snar.unlink()  # the next backup is full: a fresh snapshot, level 0
            archive=self.dump();chains[-1].append(archive);points.append(list(chains[-1]))
        for name in ['da','db']:(s/name).mkdir()
        (s/'da'/'f.txt').write_text('da');(s/'da'/'sub').mkdir();(s/'da'/'sub'/'s.txt').write_text('s');(s/'db'/'g.txt').write_text('db');os.symlink('da',s/'lnk')
        point()                                                                             # 0 full
        os.rename(s/'da',s/'swap-tmp');os.rename(s/'db',s/'da');os.rename(s/'swap-tmp',s/'db')
        point()                                                                             # 1 increment with renames
        self.assertTrue(renamed(self.archives[-1]),'GNU tar wrote the swap as rename records')
        os.unlink(s/'lnk');(s/'lnk').mkdir();(s/'lnk'/'file.txt').write_text('real now')
        point()                                                                             # 2 full (new chain)
        self.assertEqual(len(points[-1]),1)
        point()                                                                             # 3 no change
        (s/'da'/'g.txt').write_text('edited');(s/'db'/'sub'/'s.txt').write_text('edited too')
        point()                                                                             # 4 edits inside da and db
        shutil.rmtree(s/'db');(s/'db').write_text('db is a file now');os.chmod(s/'da'/'g.txt',0o600)
        point()                                                                             # 5 db becomes a file
        for index,archives in enumerate(points):
            with self.subTest(point=index):
                destination=self.base/('chain-%d-%s'%(index,uuid.uuid4().hex[:6]))
                helper.chain_extract(archives,destination)
                self.assertEqual(tree(destination/'data'),self.trees[index])
    def test_symlink_to_a_folder_replaced_by_a_real_folder(self):
        s=self.source;(s/'real').mkdir();(s/'real'/'kept').write_text('k');os.symlink('real',s/'a')
        self.dump()
        os.unlink(s/'a');(s/'a').mkdir();(s/'a'/'x').write_text('x')
        self.dump()
        restored=self.restore(2)
        self.assertEqual(tree(restored),self.trees[1])
        self.assertFalse((restored/'real'/'x').exists(),'Nothing was written through the old link')
    def test_increment_holds_only_changed_files(self):
        for i in range(20):(self.source/('f%d'%i)).write_text(str(i))
        self.dump();(self.source/'f3').write_text('changed');increment=self.dump()
        with tarfile.open(increment) as tar:
            self.assertEqual(sorted(m.name for m in tar.getmembers() if m.isfile()),['data/f3'])
            dumpdir=next(m for m in tar.getmembers() if m.name=='data').pax_headers['GNU.dumpdir']
        self.assertFalse(dumpdir_problem(dumpdir,'data'))
    def test_owners_survive_when_running_as_root(self):
        if os.geteuid()!=0:self.skipTest('Changing owners needs root')
        (self.source/'owned').write_text('x');os.chown(self.source/'owned',1234,2345);self.dump()
        os.chown(self.source/'owned',4321,5432);(self.source/'owned').write_text('y');self.dump()
        info=os.lstat(self.restore(2)/'owned');self.assertEqual((info.st_uid,info.st_gid),(4321,5432))
    def test_dumpdir_traversal_is_refused_before_tar_runs(self):
        (self.source/'a').write_text('a');self.dump()
        evil=self.work/'evil.tar';evil.write_bytes(mount_tar([('data','dir',None,{'GNU.dumpdir':'Rdata/a\0T../../escape\0\0'})]))
        self.archives.append(evil)
        with patch('helper.run',wraps=helper.run) as calls,self.assertRaisesRegex(ValueError,'Unsafe directory listing'):self.restore(2)
        self.assertEqual(len(calls.call_args_list),1,'Only the verified full archive was extracted')
        self.assertFalse((self.base/'escape').exists())

@unittest.skipUnless(LINUX_GNU_TAR,'Needs GNU tar on Linux')
class OfflineChainRestoreTests(ChainBuilder):
    """Recovery kit without DockNest: python3 helper.py restore-chain reads what decrypt-backup.js --chain wrote."""
    def kit_folder(self,archives):
        chain=self.build(archives);folder=self.root.parent/'decrypted';folder.mkdir()
        packages=[]
        for k,link in enumerate(chain):
            name='%02d-%s.tar.gz'%(k+1,link['backupId']);os.rename(self.root/('payload-%d.tar.gz'%k),folder/name)
            packages.append({'file':name,'backupId':link['backupId'],'kind':'full' if k==0 else 'incremental','sha256':link['sha256']})
        write_json(folder/'CHAIN.json',{'formatVersion':1,'chainId':'chain-a','packages':packages})
        return folder,packages
    def run_offline(self,folder,output):
        stream=io.StringIO()
        with patch('helper.EVENT_STREAM',stream):helper.restore_chain_offline(str(folder),str(output))
        return json.loads(stream.getvalue().strip().splitlines()[-1])['result']
    def test_rebuilds_every_mount_and_lists_images_in_order(self):
        archives=[mount_tar([('data','dir',None,None),('data/a','file','a%d'%k,None)]) for k in range(3)]
        folder,_=self.kit_folder(archives);output=self.root.parent/'restored'
        result=self.run_offline(folder,output)
        self.assertEqual(result['packages'],3)
        self.assertEqual(result['mounts'],[{'container':'/app','type':'bind','destination':'/data','path':str(output/'data-0-0'/'data')}])
        self.assertEqual((output/'data-0-0'/'data'/'a').read_text(),'a2')
        self.assertEqual([pathlib.Path(p).parent.name for p in result['images']],['chain-0','chain-1','unpacked'])
    def test_a_wrong_link_or_a_used_output_folder_is_refused_before_extraction(self):
        folder,packages=self.kit_folder(SIMPLE);output=self.root.parent/'restored'
        self.saved_sha=packages[0]['sha256'];packages[0]['sha256']='f'*64;write_json(folder/'CHAIN.json',{'formatVersion':1,'chainId':'chain-a','packages':packages})
        with self.assertRaisesRegex(ValueError,'depends on backup backup-0, which is missing or damaged'):self.run_offline(folder,output)
        self.assertFalse(output.exists(),'A refusal leaves nothing behind')
        damaged=self.root.parent/'damaged-out'
        packages[0]['sha256']=self.saved_sha;write_json(folder/'CHAIN.json',{'formatVersion':1,'chainId':'chain-a','packages':packages})
        with patch('helper.chain_extract',side_effect=ValueError('Unsafe archive member or link; use reviewed offline restore adapter')):
            with self.assertRaisesRegex(ValueError,'Unsafe archive member'):self.run_offline(folder,damaged)
        self.assertFalse(damaged.exists(),'A refusal during extraction removes what was unpacked')
        used=self.root.parent/'used-empty';used.mkdir()
        with patch('helper.chain_extract',side_effect=ValueError('refused')),self.assertRaises(ValueError):self.run_offline(folder,used)
        self.assertEqual(list(used.iterdir()),[],'An empty folder given by the owner stays, empty')
        used=self.root.parent/'used';used.mkdir();(used/'x').write_text('x')
        with self.assertRaisesRegex(ValueError,'new or empty'):self.run_offline(folder,used)
        packages[1]['file']='../escape.tar.gz';write_json(folder/'CHAIN.json',{'formatVersion':1,'chainId':'chain-a','packages':packages})
        with self.assertRaisesRegex(ValueError,'invalid entry'):self.run_offline(folder,self.root.parent/'other')
if __name__=='__main__':unittest.main()
