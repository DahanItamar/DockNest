"""Engine discovery (docs/podman-rootless.md). Run: python3 remote/test_engines.py
Proves: users come only from /etc/subuid with one valid range; a link, file or missing storage folder and a socket owned
by another user are skipped; versions are validated; one broken engine never fails the probe; other engines' containers
are tagged with their runtime and carry no hardening or configuration facts; and an app that names Podman or rootless
is refused by every operation that would run it through rootful Docker. No real engine is called."""
import pathlib, stat, subprocess, sys, unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

SUBUID = 'alice:100000:65536\nbob:200000:65536\n# note\nghost:300000:65536\nroot:1:65536\nlow:400000:65536\ntwo:500000:10\ntwo:600000:10\nbad name:1:2\nweird:1:2:3\n'
USERS = {'alice': ('alice', 1001, '/home/alice'), 'bob': ('bob', 1002, '/home/bob'), 'root': ('root', 0, '/root'),
         'low': ('low', 999, '/home/low'), 'two': ('two', 1005, '/home/two'), 'bad name': ('bad name', 1006, '/home/x')}
lookup = lambda key: USERS.get(key)
DIR, LINK, FILE = stat.S_IFDIR, stat.S_IFLNK, stat.S_IFREG

def fake_lstat(table):
    def lstat(path):
        if path not in table: raise FileNotFoundError(path)
        mode, uid = table[path]
        return SimpleNamespace(st_mode=mode | 0o700, st_uid=uid)
    return lstat

def tree(home, docker=True, podman=True, mode=DIR):
    table = {}
    if docker: table.update({home + '/.local': (DIR, 0), home + '/.local/share': (DIR, 0), home + '/.local/share/docker': (mode, 0)})
    if podman: table.update({home + '/.local': (DIR, 0), home + '/.local/share': (DIR, 0), home + '/.local/share/containers': (DIR, 0), home + '/.local/share/containers/storage': (mode, 0)})
    return table

class UserTests(unittest.TestCase):
    def test_only_valid_single_range_users(self):
        self.assertEqual(helper.rootless_users(SUBUID, lookup), [('alice', 1001, '/home/alice'), ('bob', 1002, '/home/bob')])
    def test_missing_file_and_odd_homes(self):
        self.assertEqual(helper.rootless_users('', lookup), [])
        odd = {'a': ('a', 1001, 'relative'), 'b': ('b', 1002, '/'), 'c': ('c', 1003, '/home/../x')}
        self.assertEqual(helper.rootless_users('a:1:2\nb:1:2\nc:1:2\n', odd.get), [])
    def test_numeric_entry_and_double_range(self):
        one = lambda k: USERS['alice'] if k in ('1001', 'alice') else None
        self.assertEqual(helper.rootless_users('1001:100000:65536\n', one), [('alice', 1001, '/home/alice')])
        self.assertEqual(helper.rootless_users('1001:100000:65536\nalice:200000:65536\n', one), [])  # two ranges: ambiguous, refused

class StorageTests(unittest.TestCase):
    def test_links_files_and_missing_are_not_storage(self):
        self.assertTrue(helper.storage_folder('/home/alice', '.local', 'share', 'docker', lstat=fake_lstat(tree('/home/alice'))))
        self.assertFalse(helper.storage_folder('/home/alice', '.local', 'share', 'docker', lstat=fake_lstat(tree('/home/alice', mode=LINK))))
        self.assertFalse(helper.storage_folder('/home/alice', '.local', 'share', 'docker', lstat=fake_lstat(tree('/home/alice', mode=FILE))))
        self.assertFalse(helper.storage_folder('/home/alice', '.local', 'share', 'docker', lstat=fake_lstat({})))
    def test_socket_owner(self):
        path = '/run/user/1001/docker.sock'
        self.assertTrue(helper.socket_owned_by(path, 1001, fake_lstat({path: (stat.S_IFSOCK, 1001)})))
        self.assertFalse(helper.socket_owned_by(path, 1001, fake_lstat({path: (stat.S_IFSOCK, 0)})))
        self.assertFalse(helper.socket_owned_by(path, 1001, fake_lstat({path: (FILE, 1001)})))
        self.assertFalse(helper.socket_owned_by(path, 1001, fake_lstat({path: (LINK, 1001)})))
        self.assertFalse(helper.socket_owned_by(path, 1001, fake_lstat({})))
    def test_cgroup_delegation(self):
        self.assertTrue(helper.cgroup_delegated(1001, lambda p: 'cpuset cpu io memory pids\n'))
        self.assertFalse(helper.cgroup_delegated(1001, lambda p: 'cpuset pids\n'))
        def gone(p): raise FileNotFoundError(p)
        self.assertFalse(helper.cgroup_delegated(1001, gone))

class ProbeTests(unittest.TestCase):
    def probe(self, table, version=None, which=lambda name: '/usr/bin/' + name, **kw):
        version = version or (lambda runtime, format: '5.2.1' if runtime.engine == 'podman' else '28.0.1')
        return helper.engine_probe(SUBUID, lookup, fake_lstat(table), which, kw.get('delegated', lambda uid: uid == 1001), version)
    def test_finds_all_engines(self):
        table = {**tree('/home/alice'), **tree('/home/bob', docker=False), '/run/user/1001/docker.sock': (stat.S_IFSOCK, 1001), '/run/user/1002/docker.sock': (stat.S_IFSOCK, 1002)}
        found = self.probe(table)
        self.assertEqual([(e['engine'], e['rootless'], e.get('user')) for e in found],
            [('docker', False, None), ('podman', False, None), ('docker', True, 'alice'), ('podman', True, 'alice'), ('podman', True, 'bob')])
        self.assertEqual([e['cgroupDelegated'] for e in found], [True, True, True, True, False])
        self.assertTrue(all('home' not in e for e in found))
    def test_user_without_storage_or_with_foreign_socket_is_skipped(self):
        table = {'/run/user/1001/docker.sock': (stat.S_IFSOCK, 0), **tree('/home/alice', podman=False)}
        found = self.probe(table, which=lambda name: None)
        self.assertEqual([(e['engine'], e['rootless']) for e in found], [('docker', False)])
    def test_bad_versions_and_failures_never_raise(self):
        self.assertEqual(self.probe({}, version=lambda r, f: None), [])
        def boom(r, f): raise RuntimeError('x')
        self.assertEqual(self.probe({}, version=boom), [])
        found = self.probe({}, version=lambda r, f: '28.0.1')
        self.assertEqual(found[0]['version'], '28.0.1')
    def test_version_validation(self):
        runtime = helper.Runtime()
        for answer, expected in ((b'28.0.1\n', '28.0.1'), (b'$(x)', None), (b'', None), (b'1' * 40, None), (b'28.0.1\nextra', None)):
            with patch.object(helper, 'run', return_value=answer): self.assertEqual(helper.engine_version(runtime, '{{.Version}}'), expected)
        with patch.object(helper, 'run', side_effect=subprocess.CalledProcessError(1, 'x')): self.assertIsNone(helper.engine_version(runtime, 'f'))

class ContainerTests(unittest.TestCase):
    RECORD = {'Id': 'c1', 'Name': '/shop', 'Config': {'Image': 'registry.invalid/shop:1', 'Labels': {'a': 'b'}}, 'State': {'Status': 'running', 'Running': True},
              'Mounts': [], 'HostConfig': {'Tmpfs': {'/tmp': ''}}, 'NetworkSettings': {'Ports': None}}
    def test_entry_tagged_and_without_host_facts(self):
        entry = helper.foreign_container(helper.Runtime('podman', True, 'alice', 1001, '/home/alice'), self.RECORD)
        self.assertEqual(entry['runtime'], {'engine': 'podman', 'rootless': True, 'user': 'alice', 'uid': 1001})
        self.assertIsNone(entry['hardening']); self.assertEqual(entry['ports'], {}); self.assertEqual(entry['temporaryMemoryFolders'], ['/tmp'])
        self.assertEqual(helper.foreign_container(helper.Runtime('podman'), {'Id': 'c2'})['name'], '')
    def test_other_engines_listed_per_runtime_and_broken_ones_skipped(self):
        engines = [{'engine': 'docker', 'rootless': False}, {'engine': 'podman', 'rootless': False}, {'engine': 'podman', 'rootless': True, 'user': 'alice', 'uid': 1001},
                   {'engine': 'podman', 'rootless': True, 'user': 'ghost', 'uid': 1009}, {'engine': 'lxc', 'rootless': False}]
        calls = []
        def fake_run(argv, **kw):
            calls.append(argv)
            self.assertLessEqual(kw.get('timeout', 3600), 60)
            if argv[-2:] == ['ps', '-aq']: return b'aabbccddeeff\n'
            if argv[-2:] == ['inspect', 'aabbccddeeff']: return helper.json.dumps([self.RECORD]).encode()
            raise AssertionError(argv)
        with patch.object(helper, 'run', fake_run):
            found = helper.other_engine_containers(engines, {'alice': '/home/alice'})
        self.assertEqual([r.describe() for r, c in found], [{'engine': 'podman', 'rootless': False}, {'engine': 'podman', 'rootless': True, 'user': 'alice', 'uid': 1001}])
        self.assertEqual(calls[0], ['podman', 'ps', '-aq'])
        self.assertEqual(calls[2][:7], ['runuser', '-u', 'alice', '--', 'env', '-i', 'PATH=' + helper.RUNTIME_PATH])
        self.assertIsNone(helper.RUNTIME)  # scoped: nothing leaks out
    def test_oversized_slow_or_odd_answers_add_nothing(self):
        engines = [{'engine': 'podman', 'rootless': False}]
        for listing in (b'x' * (helper.ENGINE_OUTPUT_LIMIT + 1), b'not-an-id\n', b'../../etc\n', b'', b'aabbccddeeff --all\n'):
            with patch.object(helper, 'run', return_value=listing): self.assertEqual(helper.other_engine_containers(engines, {}), [], listing[:20])
        def run(argv, **kw):
            return b'aabbccddeeff\n' if argv[-1] == '-aq' else b'{"not": "a list"}'
        with patch.object(helper, 'run', run): self.assertEqual(helper.other_engine_containers(engines, {}), [])
        with patch.object(helper, 'run', side_effect=subprocess.TimeoutExpired('x', 30)): self.assertEqual(helper.other_engine_containers(engines, {}), [])
    def test_counts_are_capped(self):
        ids = ' '.join('%012x' % n for n in range(500)).encode()
        records = [{**self.RECORD, 'Id': '%012x' % n} for n in range(500)]
        def run(argv, **kw): return ids if argv[-1] == '-aq' else helper.json.dumps(records).encode()
        with patch.object(helper, 'run', run):
            self.assertEqual(len(helper.other_engine_containers([{'engine': 'podman', 'rootless': False}], {})), helper.ENGINE_CONTAINER_LIMIT)
    def test_failing_engine_adds_nothing(self):
        with patch.object(helper, 'run', side_effect=subprocess.CalledProcessError(1, 'x')):
            self.assertEqual(helper.other_engine_containers([{'engine': 'podman', 'rootless': False}], {}), [])
        self.assertIsNone(helper.RUNTIME)

class RefusalTests(unittest.TestCase):
    def test_foreign_runtime_refused_for_running_operations(self):
        for runtime in ({'engine': 'podman', 'rootless': False}, {'engine': 'docker', 'rootless': True, 'user': 'alice', 'uid': 1001}, 'junk', {}):
            for op in ('restore', 'maintenance', 'deploy-teardown', 'self-heal-restart', 'deploy-restore', 'restore-test-prepare', 'incremental-commit'):
                with self.assertRaisesRegex(helper.RuntimeRefused, 'not available yet'): helper.refuse_foreign_runtime({'operation': op, 'config': {'runtime': runtime}})
    def test_allowed_cases(self):
        helper.refuse_foreign_runtime({'operation': 'capture', 'config': {}})
        helper.refuse_foreign_runtime({'operation': 'capture', 'config': {'runtime': None}})
        helper.refuse_foreign_runtime({'operation': 'capture', 'config': {'runtime': {'engine': 'docker', 'rootless': False}}})
        helper.refuse_foreign_runtime({'operation': 'capture'})
        for op in ('discover', 'test', 'domain-routes'):
            helper.refuse_foreign_runtime({'operation': op, 'config': {'runtime': {'engine': 'podman', 'rootless': False}}})

class EngineErrorTests(unittest.TestCase):
    ENGINES = [{'engine': 'podman', 'rootless': True, 'user': 'alice', 'uid': 1001}]
    def collect(self, run):
        errors = []
        with patch.object(helper, 'run', run):
            found = helper.other_engine_containers(self.ENGINES, {'alice': '/home/alice'}, errors)
        return found, errors
    def test_a_failing_engine_is_an_error_not_an_empty_list(self):
        secret = 'secret' + 'value'
        def failing(argv, **kw): raise subprocess.CalledProcessError(125, argv, stderr=secret.encode())
        found, errors = self.collect(failing)
        self.assertEqual(found, []); self.assertEqual(errors, [{'runtime': {'engine': 'podman', 'rootless': True, 'user': 'alice', 'uid': 1001}, 'reason': 'failed'}])
        self.assertNotIn(secret, str(errors), 'no engine text in the error')
    def test_each_failure_has_a_fixed_reason(self):
        def timeout(argv, **kw): raise subprocess.TimeoutExpired(argv, 30)
        def missing(argv, **kw): raise OSError('no runuser')
        cases = [(timeout, 'timeout'), (lambda argv, **kw: b'x' * (helper.ENGINE_OUTPUT_LIMIT + 1), 'too-large'), (lambda argv, **kw: b'not-an-id\n', 'unreadable'), (missing, 'failed')]
        for run, reason in cases:
            self.assertEqual([e['reason'] for e in self.collect(run)[1]], [reason])
        def garbled(argv, **kw): return b'aabbccddeeff\n' if argv[-2:] == ['ps', '-aq'] else b'{not json'
        self.assertEqual([e['reason'] for e in self.collect(garbled)[1]], ['unreadable'])
        def wrong(argv, **kw): return b'aabbccddeeff\n' if argv[-2:] == ['ps', '-aq'] else b'{"a": 1}'
        self.assertEqual([e['reason'] for e in self.collect(wrong)[1]], ['unreadable'])
        self.assertEqual(set(helper.ENGINE_ERRORS), {'timeout', 'failed', 'too-large', 'unreadable'})
    def test_an_engine_with_no_containers_is_not_an_error(self):
        found, errors = self.collect(lambda argv, **kw: b'')
        self.assertEqual((found, errors), ([], []))
    def test_the_error_list_is_optional_and_capped(self):
        with patch.object(helper, 'run', side_effect=subprocess.CalledProcessError(1, 'x')):
            self.assertEqual(helper.other_engine_containers(self.ENGINES, {'alice': '/home/alice'}), [])
            many = [{'engine': 'podman', 'rootless': True, 'user': 'u%d' % n, 'uid': 2000 + n} for n in range(40)]
            errors = []
            helper.other_engine_containers(many, {'u%d' % n: '/home/u%d' % n for n in range(40)}, errors)
        self.assertEqual(len(errors), helper.ENGINE_LIST_LIMIT)

if __name__ == '__main__': unittest.main()
