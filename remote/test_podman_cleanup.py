"""Cleanup and move facts for Podman and rootless engines (docs/podman-rootless.md, decision 10). Run: python3 remote/test_podman_cleanup.py
Proves, with fake engines and folders only: DockNest's copies in other engines are listed as kept (never removed here); a
rootless restore folder is offered for removal only when it is a real root-owned folder, old enough, with no copy left in
its engine, no running test and no protected job; removal looks again (same fingerprint, same engine, still eligible); and
the move facts carry the port floor, linger and the engine's own ID mode. No real engine runs."""
import json, pathlib, stat, sys, time, unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

JOB = '3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b'
JOB2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
alice = lambda: helper.Runtime('podman', True, 'alice', 1001, '/home/alice')
ENGINES = [(alice(), 'podman-alice-1001')]
OLD = time.time() - 10 * 3600

def folder(mode=0o711, uid=0, kind=stat.S_IFDIR, mtime=OLD, inode=7):
    return SimpleNamespace(st_mode=kind | mode, st_uid=uid, st_mtime_ns=int(mtime * 1e9), st_ino=inode)

class FolderTests(unittest.TestCase):
    def listing(self, entries, base_info=None, items=None):
        table = {'/b/1001': base_info or folder(), **{'/b/1001/' + name: info for name, info in (items or {}).items()}}
        def lstat(path):
            if path not in table: raise FileNotFoundError(path)
            return table[path]
        return helper.runtime_data_folders(alice(), '/b', lstat, lambda path: [SimpleNamespace(name=n) for n in entries])
    def test_only_real_root_owned_job_folders(self):
        good = {JOB: folder(), JOB2: folder(inode=8)}
        self.assertEqual([j for j, _, _ in self.listing([JOB, JOB2, 'notes', '.hidden'], items={**good, 'notes': folder()})], [JOB, JOB2])
        bad = {JOB: folder(kind=stat.S_IFLNK, mode=0o777), JOB2: folder(uid=1001)}
        self.assertEqual(self.listing([JOB, JOB2], items=bad), [])
        self.assertEqual(self.listing([JOB], items={JOB: folder(mode=0o777)}), [])
        for base in (folder(kind=stat.S_IFLNK), folder(uid=1001), folder(mode=0o777)):
            self.assertEqual(self.listing([JOB], base_info=base, items={JOB: folder()}), [])
        self.assertEqual(helper.runtime_data_folders(helper.Runtime('podman'), '/b'), [])

class ClassifyTests(unittest.TestCase):
    def classify(self, copies=None, folders=None, protected=(), journals=(), age=3600, now=None):
        engines = ENGINES
        return helper.runtime_cleanup_classify(engines, time.time() if now is None else now, age, set(protected), set(journals),
            containers=lambda runtime: copies or {}, folders=lambda runtime: folders if folders is not None else [(JOB, OLD * 1e9 / 1e9 * 0 + int(OLD * 1e9), 7)])
    def folders(self, mtime=OLD):
        return [(JOB, int(mtime * 1e9), 7)]
    def test_orphan_folder_is_offered_and_everything_else_is_kept(self):
        eligible, kept = self.classify(folders=self.folders())
        self.assertEqual([(i['kind'], i['id']) for i in eligible], [('runtimeData', 'podman-alice-1001/' + JOB)]); self.assertEqual(kept, [])
        reasons = lambda **kw: [i['reason'] for i in self.classify(folders=self.folders(), **kw)[1]]
        self.assertEqual(reasons(protected=[JOB]), ['inUse'])
        self.assertEqual(reasons(journals=[JOB]), ['restoreTest'])
        self.assertEqual(reasons(copies={('restoreCopy', JOB): ('restoreCopy', 'a' * 64, 'copy', None, False)}), ['restoreCopy', 'restoreCopy'])
        eligible, kept = self.classify(folders=self.folders(time.time()))
        self.assertEqual(eligible, []); self.assertEqual([i['reason'] for i in kept], ['tooNew'])
    def test_copies_are_listed_as_kept_never_offered(self):
        copies = {('restoreCopy', JOB): ('restoreCopy', 'a' * 64, 'dbm-restore-3f2b8a6e', None, False), ('restoreTest', JOB2): ('restoreTest', 'b' * 64, 'dbm-test', None, True)}
        eligible, kept = self.classify(copies=copies, folders=[])
        self.assertEqual(eligible, [])
        self.assertEqual([(i['kind'], i['reason'], i['id'].split('/')[0]) for i in kept], [('runtimeContainers', 'restoreCopy', 'podman-alice-1001'), ('runtimeContainers', 'restoreTest', 'podman-alice-1001')])
    def test_removal_looks_again(self):
        removed = []
        run = lambda item, **kw: helper.runtime_cleanup_remove(item, ENGINES, time.time(), 3600, set(kw.get('protected', ())), set(), containers=lambda r: kw.get('copies', {}), folders=lambda r: kw.get('folders', self.folders()))
        item = {'id': 'podman-alice-1001/' + JOB, 'fingerprint': self.classify(folders=self.folders())[0][0]['fingerprint']}
        with patch.object(helper, 'remove_rootless_data_root', lambda runtime, job: removed.append((runtime.user, job))):
            self.assertIsNone(run(item)); self.assertEqual(removed, [('alice', JOB)])
            self.assertEqual(run({**item, 'fingerprint': 'x'}), 'changed')
            self.assertEqual(run(item, protected=[JOB]), 'inUse')
            self.assertEqual(run(item, copies={('restoreCopy', JOB): ('restoreCopy', 'a' * 64, 'c', None, False)}), 'restoreCopy')
            self.assertEqual(run(item, folders=[]), 'gone')
            self.assertEqual(run({**item, 'id': 'podman-bob-1002/' + JOB}), 'gone')
            self.assertEqual(run({**item, 'id': 'podman-alice-1001/../x'}), 'gone')
        self.assertEqual(len(removed), 1)
    def test_protected_jobs_are_validated(self):
        self.assertEqual(helper.runtime_cleanup_protected({}), set())
        self.assertEqual(helper.runtime_cleanup_protected({'protect': {'jobs': [JOB]}}), {JOB})
        for bad in ('x', [JOB, 'nope'], [5], {'a': 1}):
            with self.assertRaises(ValueError): helper.runtime_cleanup_protected({'protect': {'jobs': bad}})

class ScanAndApplyTests(unittest.TestCase):
    def test_scan_merges_the_other_engines(self):
        emitted = []
        facts = {'now': time.time(), 'active': None}
        with patch.object(helper, 'cleanup_facts', return_value=facts), patch.object(helper, 'cleanup_classify', return_value=([], [])), patch.object(helper, 'runtime_cleanup_engines', return_value=ENGINES), \
             patch.object(helper, 'runtime_test_journals', return_value=set()), patch.object(helper, 'runtime_engine_containers', lambda r: {}), \
             patch.object(helper, 'runtime_data_folders', lambda r: [(JOB, int(OLD * 1e9), 7)]), patch.object(helper, 'emit', lambda **kw: emitted.append(kw)):
            helper.cleanup_scan({})
        items = emitted[0]['result']['items']
        self.assertEqual([(i['kind'], i['id']) for i in items], [('runtimeData', 'podman-alice-1001/' + JOB)])
        self.assertIn('fingerprint', items[0])
    def test_requests_may_name_the_new_kinds_only_with_a_plain_id(self):
        ok = {'items': [{'kind': 'runtimeData', 'id': 'podman-alice-1001/' + JOB, 'fingerprint': 'abc'}]}
        self.assertEqual(helper.cleanup_requested(ok)[0]['kind'], 'runtimeData')
        for bad in ({'kind': 'runtimeData', 'id': '../etc', 'fingerprint': 'a'}, {'kind': 'runtimeData', 'id': 'x y', 'fingerprint': 'a'}, {'kind': 'other', 'id': 'x', 'fingerprint': 'a'}):
            with self.assertRaises(ValueError): helper.cleanup_requested({'items': [bad]})

class MoveFactsTests(unittest.TestCase):
    def test_facts_never_raise_and_list_linger_per_rootless_user(self):
        with patch.object(helper, 'rootless_users', return_value=[('alice', 1001, '/home/alice')]):
            facts = helper.runtime_facts()
        self.assertEqual(set(facts), {'portFloor', 'linger'}); self.assertIn('alice', facts['linger'])
        with patch.object(helper, 'rootless_users', side_effect=RuntimeError('x')):
            self.assertEqual(helper.runtime_facts()['linger'], {})
    def test_ownership_mode_follows_the_engine(self):
        with patch.object(helper, 'engine_rootless', return_value='none') as rootful:
            self.assertEqual(helper.ownership_facts('target', {}, {})['engine'], {'mode': 'none'}); rootful.assert_called_once()
        with patch.object(helper, 'RUNTIME', alice()), patch.object(helper, 'engine_rootless', side_effect=AssertionError('rootful Docker must not be read')):
            self.assertEqual(helper.ownership_facts('target', {}, {})['engine'], {'mode': 'rootless'})
        with patch.object(helper, 'RUNTIME', helper.Runtime('podman')), patch.object(helper, 'engine_rootless', side_effect=AssertionError('no')):
            self.assertEqual(helper.ownership_facts('target', {}, {})['engine'], {'mode': 'none'})

if __name__ == '__main__': unittest.main()
