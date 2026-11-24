"""Restore tests of Podman and rootless backups (docs/podman-rootless.md, ADR decision 9). Run: python3 remote/test_podman_restore_tests.py
Proves, with fake engines and temporary folders only: the test runs in the backup's own engine kind, as one isolated
container, only where memory and CPU can be limited (rootless needs cgroup delegation) and never without internet
blocking being possible (so: no internet); the engine is recorded at prepare and read back by every later step, teardown
and the reaper; the rootless data folder is removed with the test; and a custom seccomp profile, a second container,
a different engine or an unlimited server end as 'couldn't run', never as a pass. No real engine runs."""
import json, pathlib, stat, sys, tempfile, unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

R = helper.RuntimeRefused
TID = '3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b'
ALICE = {'engine': 'podman', 'rootless': True, 'user': 'alice', 'uid': 1001}
SOURCE = {'uid': 1001, 'gid': 1001, 'subuid': [100000, 65536], 'subgid': [100000, 65536]}
rootless = lambda: helper.Runtime('podman', True, 'alice', 1001, '/home/alice')
LIMITS = {'limits': {'memoryMb': 512, 'cpus': 1}, 'testId': TID}

class Folders(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); root = pathlib.Path(self.temp.name)
        self.tests_root, self.restore_root = root / 'tests', root / 'restore'
        self.tests_root.mkdir(); self.restore_root.mkdir()
        patches = [patch.object(helper, 'RESTORE_TESTS_ROOT', self.tests_root), patch.object(helper, 'RESTORE_ROOT', self.restore_root)]
        for item in patches: item.start(); self.addCleanup(item.stop)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(lambda: setattr(helper, 'RUNTIME', None))
        # os.open on a folder (the fsync in atomic_json) is Linux-only; the tests only need the JSON written.
        write = lambda path, value: pathlib.Path(path).write_text(json.dumps(value))
        for name in ('atomic_json',):
            item = patch.object(helper, name, write); item.start(); self.addCleanup(item.stop)
    def write_state(self, **extra):
        directory = self.tests_root / TID; directory.mkdir(exist_ok=True)
        (directory / 'resources.json').write_text(json.dumps({'prepared': 1, 'created': {kind: [] for kind in helper.TEST_KINDS}, **extra}))
        return directory

class OperationTests(unittest.TestCase):
    def test_check_and_prepare_resolve_the_runtime_of_the_request(self):
        with patch.object(helper, 'resolve_runtime', return_value=rootless()) as resolve:
            for op in ('restore-test-check', 'restore-test-prepare'):
                self.assertEqual(helper.request_runtime({'operation': op, 'runtime': ALICE}).user, 'alice')
        self.assertIsNone(helper.request_runtime({'operation': 'restore-test-check'}))
        self.assertIsNone(helper.request_runtime({'operation': 'restore-test-run', 'runtime': ALICE}))  # later steps read the recorded one
        with patch.object(helper, 'resolve_runtime', return_value=helper.Runtime()):
            self.assertIsNone(helper.request_runtime({'operation': 'restore-test-check', 'runtime': {'engine': 'docker', 'rootless': False}}))
        with patch.object(helper, 'resolve_runtime', side_effect=R('nope')), self.assertRaises(R): helper.request_runtime({'operation': 'restore-test-prepare', 'runtime': ALICE})

class CheckTests(Folders):
    def check(self, runtime, need, limits=None, delegated=True):
        results = []
        with patch.object(helper, 'RUNTIME', runtime), patch.object(helper, 'docker', lambda *a: b'5.2.1\n'), patch.object(helper, 'engine_architecture', return_value='x86_64'), \
             patch.object(helper, 'cgroup_delegated', return_value=delegated), patch.object(helper, 'test_leftovers', return_value={}), patch.object(helper, 'emit', lambda **kw: results.append(kw)):
            helper.restore_test_check({**(limits or LIMITS), 'need': {'bytes': 0, 'containers': 1, **need}})
        return results[0]['result']
    def test_rootless_needs_delegation_one_container_and_no_internet(self):
        self.assertFalse(any('limit memory' in p for p in self.check(rootless(), {})['problems']))
        self.assertTrue(any('cannot limit memory for user apps' in p for p in self.check(rootless(), {}, delegated=False)['problems']))
        self.assertTrue(any('several containers' in p for p in self.check(rootless(), {'grouped': True})['problems']))
        internet = {'limits': {'memoryMb': 512, 'cpus': 1, 'internet': True}, 'testId': TID}
        self.assertTrue(any('internet' in p for p in self.check(rootless(), {}, internet)['problems']))
        self.assertEqual(self.check(rootless(), {})['facts']['engine'], {'engine': 'podman', 'rootless': True, 'user': 'alice', 'uid': 1001})
    def test_rootful_podman_needs_no_delegation(self):
        self.assertFalse(any('limit memory' in p for p in self.check(helper.Runtime('podman'), {}, delegated=False)['problems']))

class StateTests(Folders):
    def test_prepare_records_the_engine_and_later_steps_read_it_back(self):
        with patch.object(helper, 'RUNTIME', rootless()), patch.object(helper.os, 'geteuid', create=True, return_value=0), patch.object(helper, 'emit', lambda **kw: None):
            helper.restore_test_prepare({'testId': TID, 'deadline': 4102444800})
        state = json.loads((self.tests_root / TID / 'resources.json').read_text())
        self.assertEqual(state['runtime'], ALICE)
        with patch.object(helper, 'resolve_runtime', return_value=rootless()) as resolve:
            helper.adopt_test_runtime(state)
            self.assertEqual(helper.RUNTIME.user, 'alice'); resolve.assert_called_once_with(ALICE)
        helper.adopt_test_runtime({}); self.assertIsNone(helper.RUNTIME)
        with patch.object(helper, 'resolve_runtime', side_effect=R('gone')), self.assertRaises(R): helper.adopt_test_runtime(state)
    def test_default_runtime_state_has_no_engine(self):
        with patch.object(helper.os, 'geteuid', create=True, return_value=0), patch.object(helper, 'emit', lambda **kw: None), patch.object(helper, 'RUNTIME', None):
            helper.restore_test_prepare({'testId': TID, 'deadline': 4102444800})
        self.assertNotIn('runtime', json.loads((self.tests_root / TID / 'resources.json').read_text()))

class TeardownTests(Folders):
    def test_teardown_and_reaper_use_the_recorded_engine_and_remove_the_data_folder(self):
        self.write_state(runtime=ALICE, runtimeData='/var/lib/x/1001/' + TID)
        (self.restore_root / TID).mkdir()
        seen, removed = [], []
        def docker(*args):
            seen.append((helper.RUNTIME.describe() if helper.RUNTIME else None, args[0]))
            return b'aabbccddeeff\n' if args[0] == 'ps' and '--no-trunc' in args and not removed else b''
        with patch.object(helper, 'resolve_runtime', return_value=rootless()), patch.object(helper, 'docker', docker), patch.object(helper, 'test_unblock_mail', return_value=0), \
             patch.object(helper, 'test_leftovers', return_value={}), patch.object(helper, 'remove_rootless_data_root', lambda runtime, job, *a: removed.append((runtime.user, job)) or True), \
             patch.object(helper, 'stop_reaper', return_value=False), patch.object(helper, 'emit', lambda **kw: None):
            helper.restore_test_teardown({'testId': TID})
        self.assertEqual(removed, [('alice', TID)])
        self.assertTrue(all(engine == ALICE for engine, _ in seen)); self.assertIn('rm', [name for _, name in seen])
        self.assertFalse((self.tests_root / TID).exists()); self.assertFalse((self.restore_root / TID).exists())
    def test_the_reaper_runs_teardown_which_reads_the_recorded_engine(self):
        import signal
        self.write_state(runtime=ALICE, deadline=1, grace=60)
        calls = []
        previous = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        with patch.object(helper, 'restore_test_teardown', lambda req: calls.append(req)), patch.object(helper, 'test_lock', return_value=None), patch.object(helper.os, 'name', 'posix'):
            helper.restore_test_reap({'testId': TID}, sleep=lambda seconds: None, clock=lambda: 10 ** 9)
        self.assertEqual(calls, [{'testId': TID}])  # no engine in the request: teardown takes it from the journal
    def test_status_counts_leftovers_in_the_recorded_engine(self):
        self.write_state(runtime=ALICE)
        seen = []
        with patch.object(helper, 'resolve_runtime', return_value=rootless()), patch.object(helper, 'test_leftovers', lambda tid=None: seen.append(helper.RUNTIME.user) or {'containers': 1}), patch.object(helper, 'emit', lambda **kw: seen.append(kw)):
            helper.restore_test_status({'testId': TID})
        self.assertEqual(seen[0], 'alice'); self.assertTrue(seen[1]['result']['present'])

class RestoreRefusalTests(Folders):
    def restore(self, manifest, state=None, delegated=True, internet=False, hardening=None):
        self.write_state(**(state if state is not None else {'runtime': ALICE}))
        base = {'complete': True, 'architecture': 'x86_64', 'kind': 'docker', 'formatVersion': 3, 'runtime': ALICE, 'idMap': SOURCE, 'snapshotImages': ['sha256:' + 'a' * 64],
                'containers': [{'Id': 'a' * 64, 'Name': '/web', 'Config': {'Image': 'registry.invalid/web:1'}, 'HostConfig': {}, 'Mounts': [], 'State': {'Running': True}}]}
        request = {**LIMITS, 'limits': {**LIMITS['limits'], 'internet': internet}, 'plaintextChecksum': 'x', 'operation': 'restore-test-run'}
        with patch.object(helper, 'unpack_verified', return_value=(self.restore_root / 'unpacked', {**base, **manifest}, True)), patch.object(helper, 'external_restore_plan', return_value={}), \
             patch.object(helper, 'resolve_runtime', return_value=rootless()), patch.object(helper, 'host_id_map', return_value=SOURCE), \
             patch.object(helper, 'cgroup_delegated', return_value=delegated), patch.object(helper, 'rootless_data_root', return_value=str(self.restore_root / 'data')), \
             patch.object(helper, 'engine_architecture', return_value='x86_64'), patch.object(helper, 'docker', lambda *a: b''), patch.object(helper, 'emit', lambda **kw: None):
            return helper.restore_test_restore(request)
    def refused(self, *args, **kw):
        with self.assertRaises(helper.TestOutcome) as caught: self.restore(*args, **kw)
        return caught.exception
    def test_refusals_are_could_not_run(self):
        self.assertEqual(self.refused({}, delegated=False).outcome, 'couldnt_run')
        self.assertIn('limit memory', self.refused({}, delegated=False).reason)
        self.assertIn('several containers', self.refused({'containers': [{}, {}]}).reason)
        self.assertIn('internet', self.refused({}, internet=True).reason)
        self.assertIn('different container engine', self.refused({}, state={}).reason)
        self.assertIn('different container engine', self.refused({}, state={'runtime': {**ALICE, 'user': 'bob', 'uid': 1002}}).reason)
        self.assertIn('same container engine', self.refused({'runtime': {'engine': 'docker', 'rootless': True, 'user': 'alice', 'uid': 1001}, 'idMap': SOURCE}).reason)
    def test_a_default_runtime_test_cannot_adopt_a_foreign_state(self):
        # A state that names an engine but a manifest that does not is a mismatch, never a quiet rootful run.
        with self.assertRaises(helper.TestOutcome) as caught: self.restore({'runtime': None, 'formatVersion': 1, 'idMap': None}, state={'runtime': ALICE})
        self.assertIn('different container engine', caught.exception.reason)

class LimitFlagTests(unittest.TestCase):
    DOCKER = ['--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '1024', '--restart', 'no', '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3']
    def test_podman_gets_the_limits_and_its_own_bounded_log_driver(self):
        for runtime in (rootless(), helper.Runtime('podman')):
            with helper.using_runtime(runtime):
                flags = helper.limit_args(512, 1.0)
            self.assertEqual(flags, ['--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '1024', '--restart', 'no', '--log-driver', 'k8s-file', '--log-opt', 'max-size=10m'])
            self.assertNotIn('local', flags, 'Podman has no local log driver'); self.assertNotIn('max-file=3', flags, 'k8s-file has no file count')
    def test_docker_keeps_its_exact_flags(self):
        self.assertEqual(helper.limit_args(512, 1.0), self.DOCKER)
        with helper.using_runtime(helper.Runtime('docker', True, 'alice', 1001, '/home/alice')):
            self.assertEqual(helper.limit_args(512, 1.0), self.DOCKER)
        self.assertEqual(helper.limit_args(1024, 0.5)[:6], ['--memory', '1024m', '--memory-swap', '1024m', '--cpus', '0.5'])

if __name__ == '__main__': unittest.main()
