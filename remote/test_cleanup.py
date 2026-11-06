"""Server cleanup (docs/server-cleanup.md): what is protected, what may go, and that a clean removes only previewed,
still-eligible items one by one by ID. Docker is faked; real Docker runs in scripts/integration-cleanup.js.
Run: python3 remote/test_cleanup.py"""
import unittest, tempfile, pathlib, json, io, sys, subprocess
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

NOW=1_800_000_000
OLD='2020-01-01T00:00:00.123456789Z'
NEW=helper.time.strftime('%Y-%m-%dT%H:%M:%SZ',helper.time.gmtime(NOW-60))
ANON='a'*64
ANON2='b'*64

def container(cid,name,status='exited',image='sha256:img',labels=None,mounts=(),created=OLD):
    return {'Id':cid,'Name':'/'+name,'Created':created,'Image':image,'SizeRw':100,
        'State':{'Status':status,'Running':status=='running','Paused':False,'Restarting':False,'StartedAt':OLD,'FinishedAt':OLD},
        'Config':{'Image':'app:1','Labels':labels or {}},'Mounts':[{'Type':'volume','Name':m} for m in mounts]}
def image(iid,labels=None,created=OLD):return {'Id':iid,'RepoTags':[],'Created':created,'Size':1000,'Config':{'Labels':labels or {}}}
def volume(name,labels=None,created=OLD):return {'Name':name,'Labels':labels or {},'CreatedAt':created,'Mountpoint':'/nonexistent/'+name}
def facts(containers=(),images=(),volumes=(),snapshots=(),journals=None,build=None,active=None):
    j={'move':set(),'oldCopy':set(),'restoreTest':set()};j.update(journals or {})
    return {'containers':list(containers),'images':list(images),'volumes':list(volumes),'buildCacheBytes':build,'snapshotImages':set(snapshots),'journals':j,'active':active,'now':NOW}
def protect(containers=(),volumes=(),projects=()):return {'containers':set(containers),'volumes':set(volumes),'projects':set(projects),'stagingRoots':['/var/lib/docknest'],'minAge':3600}
def split(f,p):
    eligible,kept=helper.cleanup_classify(f,p)
    return {(i['kind'],i['id']) for i in eligible},{(i['kind'],i['id']):i['reason'] for i in kept}

class Protection(unittest.TestCase):
    def test_volume_shared_by_two_sites_is_never_offered(self):
        # Both sites' containers mount the same named volume; one site is stopped. The volume is in use, so it is not even dangling.
        f=facts([container('c1','shop',status='running',mounts=['shared']),container('c2','blog',mounts=['shared'])],volumes=[volume('shared')])
        eligible,kept=split(f,protect(['shop','blog']))
        self.assertNotIn(('volumes','shared'),eligible);self.assertEqual(kept[('volumes','shared')],'inUse')
        self.assertEqual(kept[('containers','c2')],'site')
    def test_anonymous_volume_of_a_site_project_is_kept_when_its_containers_are_gone(self):
        # `compose down` removed every container of the site; its backups name the project, so its anonymous volume stays.
        f=facts(volumes=[volume(ANON,{'com.docker.compose.project':'shop'}),volume(ANON2,{'com.docker.compose.project':'other'})])
        eligible,kept=split(f,protect(projects=['shop']))
        self.assertEqual(kept[('volumes',ANON)],'site');self.assertIn(('volumes',ANON2),eligible)
    def test_volume_sizing_stops_at_the_scan_deadline(self):
        with tempfile.TemporaryDirectory() as folder:
            pathlib.Path(folder,'f').write_bytes(b'x'*10)
            self.assertEqual(helper.volume_bytes(folder),10)
            self.assertIsNone(helper.volume_bytes(folder,helper.time.monotonic()-1),'after the overall deadline the size is unknown')
    def test_stopped_site_keeps_container_and_its_named_data_volume(self):
        # The site's container was removed by `compose down`; its named volume is now dangling but the site lists it.
        f=facts([container('c1','shop-db',labels={'com.docker.compose.project':'shop'})],volumes=[volume('shop_data',{'com.docker.compose.project':'shop'}),volume('orphan_data')])
        eligible,kept=split(f,protect(['shop-db'],['shop_data']))
        self.assertEqual(kept[('containers','c1')],'site')
        self.assertEqual(kept[('volumes','shop_data')],'site')
        self.assertEqual(kept[('volumes','orphan_data')],'named','an unlabelled named volume of unknown owner is kept (fail closed)')
        self.assertEqual(eligible,set())
    def test_other_services_of_a_site_compose_project_are_protected(self):
        f=facts([container('c1','shop-web',status='running',labels={'com.docker.compose.project':'shop'}),container('c2','shop-migrate',labels={'com.docker.compose.project':'shop'})])
        _,kept=split(f,protect(['shop-web']))
        self.assertEqual(kept[('containers','c2')],'site')
    def test_server_with_only_docknest_itself_offers_nothing(self):
        f=facts([container('d1','docknest-worker-1',labels={'com.docker.compose.project':'docknest','io.github.dahanitamar.docknest':'app'}),
                 container('d2','old-api',labels={'io.github.dahanitamar.docknest':'app'})],
            images=[image('sha256:build',{'io.github.dahanitamar.docknest':'build'})],volumes=[volume('docker-backup-manager_state'),volume('docknest_updater')])
        eligible,kept=split(f,protect())
        self.assertEqual(eligible,set())
        self.assertEqual(set(kept.values()),{'docknest'})
    def test_restore_test_copy_is_protected_by_label_and_journal(self):
        f=facts([container('t1','rt-web',labels={'docknest.restore-test':'x'}),container('t2','plain')],images=[image('sha256:snap0')],volumes=[volume(ANON,{'docknest.restore-test':'x'})],
            journals={'restoreTest':{'t2','sha256:snap0'}})
        eligible,kept=split(f,protect())
        self.assertEqual(kept[('containers','t1')],'restoreTest');self.assertEqual(kept[('containers','t2')],'restoreTest')
        self.assertEqual(kept[('images','sha256:snap0')],'restoreTest');self.assertEqual(kept[('volumes',ANON)],'restoreTest')
        self.assertEqual(eligible,set())
    def test_move_copy_and_its_volume_are_protected(self):
        f=facts([container('m1','move-app',labels={'docknest.move':'id','docknest.move.mode':'test'})],volumes=[volume(ANON,{'docknest.move':'id'})],images=[image('sha256:moved')],journals={'move':{'sha256:moved'}})
        eligible,kept=split(f,protect())
        self.assertEqual(kept[('containers','m1')],'move');self.assertEqual(kept[('volumes',ANON)],'move');self.assertEqual(kept[('images','sha256:moved')],'move')
        self.assertEqual(eligible,set())
    def test_kept_old_copy_after_a_move_is_protected(self):
        # After the switch the site row points at the new server; the old containers are listed only in retired.json.
        full='f'*64
        f=facts([container(full,'shop')],journals={'oldCopy':{full}})
        _,kept=split(f,protect())
        self.assertEqual(kept[('containers',full)],'oldCopy')
    def test_snapshot_images_of_a_running_backup_are_protected(self):
        f=facts(images=[image('sha256:committed'),image('sha256:junk')],snapshots={'sha256:committed'})
        eligible,kept=split(f,protect())
        self.assertEqual(kept[('images','sha256:committed')],'backup');self.assertIn(('images','sha256:junk'),eligible)
    def test_restore_copies_and_running_stacks_are_protected(self):
        f=facts([container('r1','copy',labels={'docker-backup-manager.restore':'job'}),container('s1','job-once',labels={'com.docker.compose.project':'other'}),
                 container('s2','other-web',status='running',labels={'com.docker.compose.project':'other'})])
        _,kept=split(f,protect())
        self.assertEqual(kept[('containers','r1')],'restoreCopy');self.assertEqual(kept[('containers','s1')],'runningStack')
    def test_images_in_use_and_new_items_are_kept(self):
        f=facts([container('c1','x',image='sha256:used')],images=[image('sha256:used'),image('sha256:fresh',created=NEW)],volumes=[volume(ANON2,created=NEW)])
        eligible,kept=split(f,protect())
        self.assertEqual(kept[('images','sha256:used')],'inUse');self.assertEqual(kept[('images','sha256:fresh')],'tooNew');self.assertEqual(kept[('volumes',ANON2)],'tooNew')
        self.assertIn(('containers','c1'),eligible,'an unowned stopped container may go')
    def test_short_id_in_site_list_matches_the_full_id(self):
        full='0123456789ab'+'c'*52
        _,kept=split(facts([container(full,'renamed')]),protect(['0123456789ab']))
        self.assertEqual(kept[('containers',full)],'site')
    def test_eligible_items_carry_size_and_fingerprint(self):
        f=facts([container('c9','tmp')],images=[image('sha256:junk')],volumes=[volume(ANON)],build=5_000_000)
        eligible,_=helper.cleanup_classify(f,protect())
        kinds={i['kind'] for i in eligible};self.assertEqual(kinds,{'containers','images','volumes','buildCache'})
        for item in eligible:self.assertTrue(item['fingerprint'])
    def test_parsers(self):
        self.assertEqual(helper.cleanup_size('1.5GB'),1_500_000_000);self.assertEqual(helper.cleanup_size('0B'),0);self.assertEqual(helper.cleanup_size('512kB (40%)'),512_000)
        self.assertIsNone(helper.cleanup_size('n/a'));self.assertIsNone(helper.cleanup_time('yesterday'))
        self.assertEqual(helper.cleanup_time('2020-01-01T00:00:00Z'),1577836800);self.assertEqual(helper.cleanup_time('2020-01-01T02:00:00+02:00'),1577836800)
    def test_build_cache_counts_only_what_the_prune_removes(self):
        day=lambda seconds:helper.time.strftime('%Y-%m-%d %H:%M:%S.123456789 +0000 UTC',helper.time.gmtime(NOW-seconds))
        rows=[{'InUse':'false','Shared':'false','Size':'1GB','LastUsedAt':day(2*86400),'CreatedAt':day(9*86400)},
            {'InUse':'false','Shared':'false','Size':'2MB','LastUsedAt':'','CreatedAt':day(3*86400)},
            {'InUse':'false','Shared':'false','Size':'5GB','LastUsedAt':day(3600),'CreatedAt':day(9*86400)},
            {'InUse':'true','Shared':'false','Size':'7GB','LastUsedAt':day(9*86400)},
            {'InUse':'false','Shared':'true','Size':'9GB','LastUsedAt':day(9*86400)},
            {'InUse':'false','Shared':'false','Size':'n/a','LastUsedAt':day(9*86400)},
            {'InUse':'false','Shared':'false','Size':'3GB','LastUsedAt':'soon'},'junk']
        self.assertEqual(helper.build_cache_bytes(rows,NOW),1_002_000_000,'old and unused only: not used within a day, not in use, not shared, nothing unreadable')
        self.assertEqual(helper.build_cache_bytes(None,NOW),0)
        self.assertEqual(helper.cleanup_cache_time('2020-01-01 02:00:00.5 +0200 +0200'),1577836800)
        self.assertIsNone(helper.cleanup_cache_time(''))
    def test_protection_lists_are_validated(self):
        for bad in [{'containers':'shop'},{'containers':['bad name']},{'volumes':[1]},{'stagingRoots':['relative']}]:
            with self.assertRaises(ValueError):helper.cleanup_protect({'protect':bad})
        for age in [-1,86401,'0',True]:
            with self.assertRaises(ValueError):helper.cleanup_protect({'minAgeSeconds':age})
        self.assertEqual(helper.cleanup_protect({})['minAge'],3600,'an hour unless the integration test says otherwise')

class FakeDocker:
    """A server whose state can change between the scan and the clean."""
    def __init__(self,containers=(),images=(),volumes=(),build_cache=None):
        self.containers={c['Id']:c for c in containers};self.images={i['Id']:i for i in images};self.volumes={v['Name']:v for v in volumes};self.calls=[]
        self.build_cache=build_cache
    def __call__(self,*args):
        self.calls.append(list(args))
        if args[:2]==('ps','-aq'):
            filters=[a for a in args if '=' in a]
            ids=list(self.containers)
            for f in filters:
                key,_,value=f.partition('=')
                if key=='ancestor':ids=[i for i in ids if self.containers[i]['Image']==value]
                if key=='volume':ids=[i for i in ids if any(m.get('Name')==value for m in self.containers[i]['Mounts'])]
            return '\n'.join(ids).encode()
        if args[:2]==('container','inspect'):return json.dumps([self.containers[i] for i in args if i in self.containers]).encode() if any(i in self.containers for i in args[2:]) else self.missing()
        if args[:2]==('image','ls'):return '\n'.join(i for i,v in self.images.items() if not v['RepoTags']).encode()
        if args[:2]==('image','inspect'):return json.dumps([self.images[i] for i in args[2:] if i in self.images]).encode() if any(i in self.images for i in args[2:]) else self.missing()
        if args[:2]==('volume','ls'):
            used={m.get('Name') for c in self.containers.values() for m in c['Mounts']}
            return '\n'.join(n for n in self.volumes if n not in used).encode()
        if args[:2]==('volume','inspect'):return json.dumps([self.volumes[n] for n in args[2:] if n in self.volumes]).encode() if any(n in self.volumes for n in args[2:]) else self.missing()
        if args[:3]==('system','df','-v'):return json.dumps({'BuildCache':self.build_cache}).encode() if self.build_cache is not None else self.missing()
        if args[:2]==('system','df'):return json.dumps({'Type':'Build Cache','Reclaimable':'2MB'}).encode()
        if args[0]=='rm':self.containers.pop(args[1]);return b''
        if args[:2]==('image','rm'):self.images.pop(args[2]);return b''
        if args[:2]==('volume','rm'):self.volumes.pop(args[2]);return b''
        raise AssertionError('unexpected docker call %r'%(args,))
    def missing(self):raise subprocess.CalledProcessError(1,['docker'])

class Clean(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();root=pathlib.Path(self.tmp.name)
        self.patches=[patch('helper.MOVES_ROOT',root/'moves'),patch('helper.RESTORE_TESTS_ROOT',root/'tests'),patch('helper.RESTORE_ROOT',root/'restore'),
            patch('helper.CLEANUP_LOCK',root/'cleanup.lock'),patch('helper.CLEANUP_DEFAULT_STAGING',str(root/'staging')),patch('helper.time.time',return_value=NOW)]
        try:import fcntl  # noqa: F401  (Linux servers; the lock is faked where it does not exist)
        except ImportError:self.patches.append(patch('helper.cleanup_lock',return_value=io.StringIO()))
        for p in self.patches:p.start()
        self.root=root
    def tearDown(self):
        for p in self.patches:p.stop()
        self.tmp.cleanup()
    def run_op(self,fn,req,fake,builder=b'Total reclaimed space: 2MB\n'):
        events=io.StringIO()
        def run(args,timeout=3600,**_):
            if args[:3]==['docker','builder','prune']:return builder
            return fake(*args[1:])
        with patch('helper.docker',side_effect=fake),patch('helper.EVENT_STREAM',events),patch('helper.run',side_effect=run) as mocked:
            fn(req);self.run_calls=[c for c in mocked.call_args_list if c.args[0][:3]==['docker','builder','prune']]
        return [json.loads(line) for line in events.getvalue().splitlines()][-1]['result']
    def scan(self,fake,req=None):return self.run_op(helper.cleanup_scan,req or {},fake)
    def test_scan_then_clean_removes_exactly_the_chosen_items_by_id(self):
        fake=FakeDocker([container('c1','tmp'),container('c2','site-db')],[image('sha256:junk'),image('sha256:keep')],[volume(ANON),volume('named')])
        result=self.scan(fake,{'protect':{'containers':['site-db']}})
        items={(i['kind'],i['id']):i for i in result['items']}
        self.assertEqual(set(items),{('containers','c1'),('images','sha256:junk'),('images','sha256:keep'),('volumes',ANON),('buildCache','build-cache')})
        chosen=[items[('containers','c1')],items[('images','sha256:junk')],items[('volumes',ANON)]]
        done=self.run_op(helper.cleanup_apply,{'protect':{'containers':['site-db']},'items':chosen},fake)
        self.assertEqual([r['status'] for r in done['results']],['removed']*3)
        self.assertIn('c2',fake.containers);self.assertIn('sha256:keep',fake.images);self.assertIn('named',fake.volumes)
        removals=[c for c in fake.calls if c[0]=='rm' or c[:2] in (['image','rm'],['volume','rm'])]
        self.assertEqual(removals,[['rm','c1'],['image','rm','sha256:junk'],['volume','rm',ANON]],'one item per call, by ID, never -f or -v')
        self.assertEqual(self.run_calls,[],'build cache was not chosen, so it was not pruned')
    def test_stale_preview_item_that_became_used_is_skipped(self):
        fake=FakeDocker([container('c1','tmp')],[image('sha256:junk')],[volume(ANON)])
        items={(i['kind'],i['id']):i for i in self.scan(fake)['items']}
        # Meanwhile a new container starts using the image and the volume, and c1 was started and stopped again.
        fake.containers['c3']=container('c3','new',status='running',image='sha256:junk',mounts=[ANON])
        fake.containers['c1']['State']['StartedAt']='2021-01-01T00:00:00Z'
        done=self.run_op(helper.cleanup_apply,{'items':list(items.values())},fake)
        by={(r['kind'],r['id']):r for r in done['results']}
        self.assertEqual(by[('images','sha256:junk')],{**by[('images','sha256:junk')],'status':'skipped','reason':'inUse'})
        self.assertEqual(by[('volumes',ANON)]['status'],'skipped')
        self.assertEqual(by[('containers','c1')]['reason'],'changed')
        self.assertEqual(by[('buildCache','build-cache')]['status'],'removed')
        self.assertIn('sha256:junk',fake.images);self.assertIn(ANON,fake.volumes);self.assertIn('c1',fake.containers)
        self.assertEqual([c.args[0] for c in self.run_calls],[['docker','builder','prune','--all','--force','--filter','until=24h']],'build cache: every unused record older than a day, not only dangling ones')
    def test_scan_sizes_build_cache_from_its_records_and_falls_back_to_the_docker_total(self):
        old=helper.time.strftime('%Y-%m-%d %H:%M:%S +0000 UTC',helper.time.gmtime(NOW-2*86400))
        new=helper.time.strftime('%Y-%m-%d %H:%M:%S +0000 UTC',helper.time.gmtime(NOW-60))
        fake=FakeDocker(build_cache=[{'InUse':'false','Shared':'false','Size':'3MB','LastUsedAt':old},{'InUse':'false','Shared':'false','Size':'8GB','LastUsedAt':new}])
        items={i['kind']:i for i in self.scan(fake)['items']}
        self.assertEqual(items['buildCache']['bytes'],3_000_000,'the scan shows what the clean frees, not cache used today')
        fresh=FakeDocker(build_cache=[{'InUse':'false','Shared':'false','Size':'8GB','LastUsedAt':new}])
        self.assertNotIn('buildCache',{i['kind'] for i in self.scan(fresh)['items']},'nothing a clean would remove, nothing offered')
        legacy=FakeDocker()
        self.assertEqual({i['kind']:i for i in self.scan(legacy)['items']}['buildCache']['bytes'],2_000_000,'older Docker: its reclaimable total')
    def test_item_that_became_protected_by_a_new_move_journal_is_skipped(self):
        fake=FakeDocker([container('c1','tmp')])
        items=[i for i in self.scan(fake)['items'] if i['kind']=='containers']
        move=self.root/'moves'/'m1';move.mkdir(parents=True);(move/'retired.json').write_text(json.dumps({'containers':[{'id':'c1'}]}))
        done=self.run_op(helper.cleanup_apply,{'items':items},fake)
        self.assertEqual(done['results'][0]['reason'],'oldCopy');self.assertIn('c1',fake.containers)
    def test_items_not_in_the_preview_shape_are_refused(self):
        fake=FakeDocker()
        for bad in [[],[{'kind':'networks','id':'x','fingerprint':'f'}],[{'kind':'containers','id':'$(rm)','fingerprint':'f'}],[{'kind':'images','id':'x'}]]:
            with self.assertRaises(ValueError):self.run_op(helper.cleanup_apply,{'items':bad},fake)
        self.assertEqual(fake.calls,[])
    def test_clean_refuses_while_a_backup_is_running(self):
        fake=FakeDocker([container('c1','tmp')])
        items=self.scan(fake)['items']
        job=self.root/'staging'/'0b5e8d3c-1f2a-4c3d-9e8f-123456789abc';job.mkdir(parents=True);(job/'snapshot-images.json').write_text('["sha256:x"]')
        helper.os.utime(job,(NOW-30,NOW-30));helper.os.utime(job/'snapshot-images.json',(NOW-30,NOW-30))
        self.assertEqual(self.scan(fake)['busy'],'backup')
        with self.assertRaisesRegex(ValueError,'unfinished backup job folder.*recovery finishes the job or the folder is removed'):self.run_op(helper.cleanup_apply,{'items':items},fake)
        self.assertIn('c1',fake.containers)
    def test_clean_stops_starting_removals_at_its_time_limit(self):
        fake=FakeDocker([container('c1','a'),container('c2','b')],[image('sha256:junk')])
        items=self.scan(fake)['items']
        clock=[0.0];removing=fake.__call__
        def slow(*args):
            if args[0]=='rm':clock[0]+=helper.CLEANUP_APPLY_SECONDS+1  # the first removal uses up the time
            return removing(*args)
        with patch('helper.time.monotonic',side_effect=lambda:clock[0]):done=self.run_op(helper.cleanup_apply,{'items':items},slow)
        by={r['id']:r for r in done['results']}
        removed=[r for r in done['results'] if r['status']=='removed']
        self.assertEqual(len(removed),1,'one removal ran, then the clean stopped')
        rest=[r for r in done['results'] if r['status']!='removed']
        self.assertTrue(rest and all(r['reason']=='timeLimit' for r in rest),rest)
        self.assertIn('sha256:junk',fake.images);self.assertEqual(by['build-cache']['reason'],'timeLimit')
        self.assertEqual(self.run_calls,[],'no build cache prune after the limit')
    def test_an_old_unfinished_job_folder_still_blocks(self):
        fake=FakeDocker([container('c1','tmp')]);items=self.scan(fake)['items']
        job=self.root/'staging'/'0b5e8d3c-1f2a-4c3d-9e8f-123456789abc';job.mkdir(parents=True)
        helper.os.utime(job,(NOW-30*86400,NOW-30*86400))
        with self.assertRaisesRegex(ValueError,'unfinished backup job folder'):self.run_op(helper.cleanup_apply,{'items':items},fake)
        (job/'disarmed').touch();(job/'watchdog.done').touch()
        self.assertEqual(self.scan(fake)['busy'],None,'a finished job folder does not block')
    def test_restore_staging_folder_blocks(self):
        fake=FakeDocker([container('c1','tmp')])
        (self.root/'restore'/'0b5e8d3c-1f2a-4c3d-9e8f-123456789abc').mkdir(parents=True)
        self.assertEqual(self.scan(fake)['busy'],'restore')
    def test_journal_written_between_check_and_removal_is_honoured(self):
        fake=FakeDocker([container('c1','tmp')]);items=[i for i in self.scan(fake)['items'] if i['kind']=='containers']
        calls=[]
        def journals():
            calls.append(1)
            found={'move':set(),'oldCopy':set(),'restoreTest':set()}
            if len(calls)>1:found['restoreTest'].add('c1')  # appears after the up-front scan, before the removal
            return found
        with patch('helper.cleanup_journals',side_effect=journals):done=self.run_op(helper.cleanup_apply,{'items':items},fake)
        self.assertEqual(done['results'][0]['status'],'skipped');self.assertIn('c1',fake.containers)
    @unittest.skipIf(sys.platform=='win32','fcntl locks exist only on the Linux servers')
    def test_clean_refuses_while_a_move_or_test_step_holds_its_lock(self):
        import fcntl
        fake=FakeDocker([container('c1','tmp')]);items=self.scan(fake)['items']
        for root in ['moves','tests']:
            d=self.root/root/'3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b';d.mkdir(parents=True)
            held=open(d/'.lock','a');fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
            try:
                with self.assertRaisesRegex(ValueError,'site move or restore test step'):self.run_op(helper.cleanup_apply,{'items':items},fake)
            finally:held.close()
        self.assertIn('c1',fake.containers)
    @unittest.skipIf(sys.platform=='win32','fcntl locks exist only on the Linux servers')
    def test_steps_and_clean_exclude_each_other(self):
        step=helper.cleanup_shared(0)
        try:
            with self.assertRaisesRegex(ValueError,'DockNest step is running'):helper.cleanup_lock()
        finally:step.close()
        clean=helper.cleanup_lock()
        try:
            with self.assertRaisesRegex(ValueError,'server cleanup is running'):helper.cleanup_shared(0)
        finally:clean.close()
        helper.cleanup_shared(0).close()
    def test_docker_steps_take_the_shared_lock_before_anything_else(self):
        seen=[]
        with patch('helper.cleanup_shared',side_effect=lambda:seen.append('shared') or io.StringIO()),patch('helper.capture',side_effect=lambda req,*a:seen.append('capture')),patch('helper.move_lock',side_effect=lambda *a,**k:seen.append('move') or io.StringIO()),patch('helper.move_test',side_effect=lambda req:seen.append('step')):
            helper.main({'operation':'capture'})
            helper.main({'operation':'move-test','moveId':'3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b'})
        self.assertEqual(seen,['shared','capture','shared','move','step'])
    @unittest.skipIf(sys.platform=='win32','fcntl locks exist only on the Linux servers')
    def test_two_cleans_never_run_at_once(self):
        fake=FakeDocker([container('c1','tmp')]);items=self.scan(fake)['items']
        held=helper.cleanup_lock()
        try:
            with self.assertRaisesRegex(ValueError,'Another cleanup or DockNest step is running'):self.run_op(helper.cleanup_apply,{'items':items},fake)
        finally:held.close()

if __name__=='__main__':unittest.main()
