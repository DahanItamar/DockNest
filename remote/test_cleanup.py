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
def protect(containers=(),volumes=()):return {'containers':set(containers),'volumes':set(volumes),'stagingRoots':['/var/lib/docknest']}
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
    def test_protection_lists_are_validated(self):
        for bad in [{'containers':'shop'},{'containers':['bad name']},{'volumes':[1]},{'stagingRoots':['relative']}]:
            with self.assertRaises(ValueError):helper.cleanup_protect({'protect':bad})

class FakeDocker:
    """A server whose state can change between the scan and the clean."""
    def __init__(self,containers=(),images=(),volumes=()):
        self.containers={c['Id']:c for c in containers};self.images={i['Id']:i for i in images};self.volumes={v['Name']:v for v in volumes};self.calls=[]
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
        with patch('helper.docker',side_effect=fake),patch('helper.EVENT_STREAM',events),patch('helper.run',return_value=builder) as run:
            fn(req);self.run_calls=run.call_args_list
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
        self.assertEqual([c.args[0] for c in self.run_calls],[['docker','builder','prune','--force','--filter','until=24h']],'build cache: unused only (no --all), older than a day')
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
        with self.assertRaisesRegex(ValueError,'backup is running'):self.run_op(helper.cleanup_apply,{'items':items},fake)
        self.assertIn('c1',fake.containers)
    @unittest.skipIf(sys.platform=='win32','fcntl locks exist only on the Linux servers')
    def test_two_cleans_never_run_at_once(self):
        fake=FakeDocker([container('c1','tmp')]);items=self.scan(fake)['items']
        held=helper.cleanup_lock()
        try:
            with self.assertRaisesRegex(ValueError,'already running'):self.run_op(helper.cleanup_apply,{'items':items},fake)
        finally:held.close()

if __name__=='__main__':unittest.main()
