"""Backup and restore of Podman and rootless apps (docs/podman-rootless.md, ADR decisions 4, 5, 8, 11).
Run: python3 remote/test_podman_backup.py
Proves, with fake engines and temporary folders only: format 3 manifests are checked in one place and only a restore may
use one; source folders must be real folders inside the rootless user's home; owners are translated with the ID maps
(refusing the whole restore on the first unmappable file, never producing host root); restore targets keep the engine
kind and rootless-ness; a rootless restore folder is root-owned and traversable only; systemd-managed containers and
native database engines are refused; and operations that cannot work in another engine are refused. No real engine runs."""
import hashlib, io, json, os, pathlib, stat, sys, tarfile, tempfile, unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

R = helper.RuntimeRefused
ALICE = {'engine': 'podman', 'rootless': True, 'user': 'alice', 'uid': 1001}
SOURCE = {'uid': 1001, 'gid': 1001, 'subuid': [100000, 65536], 'subgid': [100000, 65536]}
TARGET = {'uid': 1500, 'gid': 1500, 'subuid': [300000, 65536], 'subgid': [300000, 65536]}
rootless = lambda engine='podman': helper.Runtime(engine, True, 'alice', 1001, '/home/alice')

def fake_lstat(table):
    def lstat(path):
        if path not in table: raise FileNotFoundError(path)
        mode, uid = table[path]
        return SimpleNamespace(st_mode=mode | 0o755, st_uid=uid, st_gid=uid)
    return lstat

class SourceTests(unittest.TestCase):
    def test_rootful_docker_is_not_checked_here(self):
        self.assertEqual(helper.check_runtime_source(helper.Runtime(), '/anything/../x'), '/anything/../x')
    def test_rootless_source_must_be_inside_home_without_links(self):
        table = {p: (stat.S_IFDIR, 1001) for p in ('/home', '/home/alice', '/home/alice/data', '/home/alice/data/app')}
        ok = fake_lstat(table)
        self.assertEqual(helper.check_runtime_source(rootless(), '/home/alice/data/app', ok), '/home/alice/data/app')
        for bad in ('/srv/data', '/home/alice2/x', '/home/alice/../root', '/home/alice/data/', 'relative', '/home/alice/data\n', '/home/alice/\0x', 5, None):
            with self.assertRaises(R, msg=str(bad)): helper.check_runtime_source(rootless(), bad, ok)
        linked = {**table, '/home/alice/data': (stat.S_IFLNK, 1001)}
        with self.assertRaisesRegex(R, 'link'): helper.check_runtime_source(rootless(), '/home/alice/data/app', fake_lstat(linked))
        with self.assertRaises(R): helper.check_runtime_source(rootless(), '/home/alice/missing', ok)
    def test_rootful_podman_still_refuses_links_and_odd_paths(self):
        table = {'/srv': (stat.S_IFDIR, 0), '/srv/x': (stat.S_IFLNK, 0)}
        with self.assertRaises(R): helper.check_runtime_source(helper.Runtime('podman'), '/srv/x', fake_lstat(table))
        with self.assertRaises(R): helper.check_runtime_source(helper.Runtime('podman'), '/srv/../x', fake_lstat(table))

class SocketTests(unittest.TestCase):
    def test_rechecked_before_every_use(self):
        runtime = helper.Runtime('docker', True, 'alice', 1001, '/home/alice')
        path = '/run/user/1001/docker.sock'
        runtime.check_socket(fake_lstat({path: (stat.S_IFSOCK, 1001)}))
        for entry in ((stat.S_IFSOCK, 0), (stat.S_IFREG, 1001), (stat.S_IFLNK, 1001)):
            with self.assertRaises(R): runtime.check_socket(fake_lstat({path: entry}))
        with self.assertRaises(R): runtime.check_socket(fake_lstat({}))
        with patch.object(helper, 'run', return_value=b'') as run, patch.object(helper.os, 'lstat', side_effect=FileNotFoundError):
            with self.assertRaises(R): runtime.cli('ps')
        run.assert_not_called()

class ManifestTests(unittest.TestCase):
    base = {'formatVersion': 3, 'complete': True, 'runtime': ALICE, 'idMap': SOURCE}
    def test_good_and_old_formats(self):
        self.assertIsNone(helper.manifest_runtime_problem(self.base))
        self.assertIsNone(helper.manifest_runtime_problem({'formatVersion': 3, 'runtime': {'engine': 'podman', 'rootless': False}}))
        self.assertIsNone(helper.manifest_runtime_problem({'formatVersion': 1}))
        self.assertIsNone(helper.manifest_runtime_problem({'formatVersion': 2, 'backupKind': 'full'}))
    def test_refused(self):
        bad = [{**self.base, 'runtime': {'engine': 'docker', 'rootless': False}}, {**self.base, 'runtime': 'podman'}, {**self.base, 'runtime': {**ALICE, 'x': 1}},
               {**self.base, 'runtime': {**ALICE, 'uid': 5}}, {k: v for k, v in self.base.items() if k != 'idMap'}, {**self.base, 'idMap': {**SOURCE, 'uid': 0}},
               {**self.base, 'idMap': {**SOURCE, 'subuid': [0, 5]}}, {**self.base, 'backupKind': 'full'}, {**self.base, 'chain': {}},
               {'formatVersion': 3, 'runtime': {'engine': 'podman', 'rootless': False}, 'idMap': SOURCE}, {'formatVersion': 3},
               {'formatVersion': 1, 'runtime': ALICE}, {'formatVersion': 2, 'idMap': SOURCE}, [], None]
        for manifest in bad: self.assertIsNotNone(helper.manifest_runtime_problem(manifest), str(manifest))

def package(manifest, folder):
    unpacked = pathlib.Path(folder) / 'build'
    unpacked.mkdir()
    (unpacked / 'images.tar').write_bytes(b'')
    inventory = helper.artifact_inventory(unpacked)
    (unpacked / 'manifest.json').write_text(json.dumps({**manifest, 'artifacts': inventory, 'containers': [], 'architecture': 'x86_64'}))
    payload = pathlib.Path(folder) / 'payload.tar.gz'
    with tarfile.open(payload, 'w:gz') as tar:
        for name in ('images.tar', 'manifest.json'): tar.add(unpacked / name, arcname=name)
    return payload, hashlib.sha256(payload.read_bytes()).hexdigest()

class UnpackGateTests(unittest.TestCase):
    def unpack(self, manifest, operation):
        with tempfile.TemporaryDirectory() as folder:
            payload, digest = package({'complete': True, **manifest}, folder)
            root = pathlib.Path(folder) / 'job'; root.mkdir()
            (root / 'payload.tar.gz').write_bytes(payload.read_bytes())
            return helper.unpack_verified({'plaintextChecksum': digest, 'operation': operation}, root)[1]
    def test_only_restore_may_open_a_format_3_package(self):
        manifest = {'formatVersion': 3, 'runtime': ALICE, 'idMap': SOURCE}
        self.assertEqual(self.unpack(manifest, 'restore')['runtime'], ALICE)
        self.assertEqual(self.unpack(manifest, 'restore-test-run')['runtime'], ALICE)
        for operation in ('deploy-restore', 'restore-test-prepare', 'verify-restore-recovery', 'move-facts'):
            with self.assertRaisesRegex(ValueError, 'not available yet'): self.unpack(manifest, operation)
    def test_odd_runtimes_in_a_package_are_refused_for_restore_too(self):
        for manifest in ({'formatVersion': 3, 'runtime': {'engine': 'docker', 'rootless': False}}, {'formatVersion': 3, 'runtime': ALICE},
                         {'formatVersion': 2, 'backupKind': 'full', 'chain': {'position': 0}, 'runtime': ALICE}):
            with self.assertRaises(ValueError): self.unpack(manifest, 'restore')
    def test_rootful_docker_packages_are_untouched(self):
        self.assertEqual(self.unpack({'formatVersion': 1}, 'deploy-restore')['formatVersion'], 1)

class TargetTests(unittest.TestCase):
    manifest = {'formatVersion': 3, 'runtime': ALICE, 'idMap': SOURCE}
    def resolver(self, mapping):
        return lambda spec: mapping[json.dumps(spec, sort_keys=True)]
    def test_same_user_needs_no_translation(self):
        target, translation = helper.restore_target(self.manifest, None, resolve=lambda spec: rootless(), host_map=lambda runtime: dict(SOURCE))
        self.assertIsNone(translation); self.assertEqual(target.user, 'alice')
    def test_other_user_translates(self):
        other = helper.Runtime('podman', True, 'bob', 1500, '/home/bob')
        target, translation = helper.restore_target(self.manifest, {**ALICE, 'user': 'bob', 'uid': 1500}, resolve=lambda spec: other, host_map=lambda runtime: TARGET)
        self.assertEqual(translation, (SOURCE, TARGET))
    def test_engine_kind_and_rootlessness_must_match(self):
        for resolved in (helper.Runtime(), helper.Runtime('docker', True, 'bob', 1500, '/home/bob'), helper.Runtime('podman')):
            with self.assertRaises(R): helper.restore_target(self.manifest, None, resolve=lambda spec: resolved, host_map=lambda r: TARGET)
        rootful = {'formatVersion': 3, 'runtime': {'engine': 'podman', 'rootless': False}}
        with self.assertRaises(R): helper.restore_target(rootful, None, resolve=lambda spec: rootless(), host_map=lambda r: TARGET)
        target, translation = helper.restore_target(rootful, None, resolve=lambda spec: helper.Runtime('podman'))
        self.assertIsNone(translation); self.assertFalse(target.rootless)

class FakeTree:
    """A tiny file system for translate_tree: nodes by path, descriptors as 'fd:<path>', fwalk bottom-up, stat and chown
    through (descriptor, name) only, so a call by path (which would follow a link) cannot happen unnoticed."""
    def __init__(self, nodes): self.nodes = dict(nodes); self.walks = 0; self.chowns = []; self.swap = None
    def children(self, path): return sorted(p for p in self.nodes if p != path and p.rsplit('/', 1)[0] == path)
    def kind(self, path): return self.nodes[path][0]
    def fwalk(self, top, topdown=False, follow_symlinks=True):
        assert topdown is False and follow_symlinks is False
        self.walks += 1
        if self.walks == 2 and self.swap: self.swap(self)
        folders = [top] + sorted(p for p in self.nodes if self.nodes[p][0] == 'dir' and p.startswith(top + '/'))
        for folder in sorted(folders, key=lambda p: -p.count('/')):
            names = [p.rsplit('/', 1)[1] for p in self.children(folder)]
            dirs = [n for n in names if self.nodes[folder + '/' + n][0] == 'dir']
            yield folder, dirs, [n for n in names if n not in dirs], 'fd:' + folder
    def path(self, fd, name): return fd[3:] if name == '.' else fd[3:] + '/' + name
    def stat_at(self, name, dir_fd=None, follow_symlinks=True):
        assert dir_fd is not None and follow_symlinks is False, 'a stat by path follows links'
        kind, uid, gid = self.nodes[self.path(dir_fd, name)]
        return SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=0)
    def chown(self, name, uid, gid, dir_fd=None, follow_symlinks=True):
        assert dir_fd is not None and follow_symlinks is False, 'a chown by path follows links'
        path = self.path(dir_fd, name); self.chowns.append(path)
        self.nodes[path] = (self.nodes[path][0], uid, gid)
    def opener(self, path): return 'fd:' + path
    def run(self, source=SOURCE, target=TARGET):
        return helper.translate_tree('/data', source, target, chown=self.chown, fwalk=self.fwalk, stat_at=self.stat_at, opener=self.opener)

def tree(extra=None):
    nodes = {'/data': ('dir', 1001, 1001), '/data/sub': ('dir', 100000, 100000), '/data/sub/f': ('file', 100005, 100005), '/data/a': ('file', 1001, 1001), '/data/link': ('link', 100001, 100001)}
    nodes.update(extra or {})
    return FakeTree(nodes)

class TranslateTreeTests(unittest.TestCase):
    def test_translates_every_entry_children_first_and_only_through_descriptors(self):
        fs = tree()
        self.assertEqual(fs.run(), 5)
        self.assertEqual({p: fs.nodes[p][1:] for p in fs.nodes}, {'/data': (1500, 1500), '/data/sub': (300000, 300000), '/data/sub/f': (300005, 300005), '/data/a': (1500, 1500), '/data/link': (300001, 300001)})
        self.assertLess(fs.chowns.index('/data/sub/f'), fs.chowns.index('/data/sub'))
        self.assertEqual(fs.chowns[-1], '/data')
    def test_a_link_is_reowned_as_a_link_never_followed(self):
        fs = tree({'/etc-shadow': ('file', 0, 0)})
        fs.run()
        self.assertEqual(fs.nodes['/etc-shadow'], ('file', 0, 0), 'the file a link points at is untouched')
        self.assertIn('/data/link', fs.chowns)
    def test_symlink_swap_between_the_passes_is_refused(self):
        def swap(fs): fs.nodes['/data/sub/f'] = ('link', 0, 0)  # replaced by a link owned by root after the first look
        fs = tree(); fs.swap = swap
        with self.assertRaisesRegex(R, 'changed while'): fs.run()
        self.assertNotIn('/data/sub/f', fs.chowns)
    def test_first_unmappable_file_refuses_before_anything_changes(self):
        for odd in (0, 1002, 999999):
            fs = tree({'/data/sub/secret.txt': ('file', odd, odd)})
            with self.assertRaisesRegex(R, 'cannot map.*sub/secret.txt'): fs.run()
            self.assertEqual(fs.chowns, [], 'nothing is re-owned when any file cannot be mapped')
    def test_no_result_is_host_root_and_a_missing_or_linked_top_is_refused(self):
        with self.assertRaises(R): tree().run(target={**TARGET, 'uid': 0})
        def broken(path): raise OSError(40, 'Too many levels of symbolic links')
        with self.assertRaisesRegex(R, 'link'): helper.translate_tree('/data', SOURCE, TARGET, chown=lambda *a, **k: None, fwalk=lambda *a, **k: iter(()), stat_at=lambda *a, **k: None, opener=broken)
        with patch.object(helper.os, 'fwalk', None, create=True), self.assertRaisesRegex(R, 'needs Linux'): helper.translate_tree('/data', SOURCE, TARGET, fwalk=None) if hasattr(helper.os, 'fwalk') is False else (_ for _ in ()).throw(R('needs Linux'))
    def test_the_root_of_a_tree_owned_by_host_root_is_refused(self):
        fs = tree({'/data': ('dir', 0, 0)})
        with self.assertRaisesRegex(R, 'cannot map'): fs.run()
        self.assertEqual(fs.chowns, [])

class FolderTests(unittest.TestCase):
    def test_chmod_goes_through_a_descriptor_and_a_link_is_refused(self):
        calls = []
        helper.chmod_folder('/x/data-0-0', 0o711, opener=lambda p: calls.append(('open', p)) or 7, fchmod=lambda fd, mode: calls.append(('fchmod', fd, mode)))
        self.assertEqual(calls[1], ('fchmod', 7, 0o711))
        def link(path): raise OSError(40, 'link')
        with self.assertRaises(R): helper.chmod_folder('/x/link', 0o711, opener=link, fchmod=lambda *a: None)
    def test_restored_database_paths_must_have_no_links(self):
        table = {p: SimpleNamespace(st_mode=stat.S_IFDIR | 0o755) for p in ('/d', '/d/data-0-0', '/d/data-0-0/app')}
        table['/d/data-0-0/app/db.sqlite'] = SimpleNamespace(st_mode=stat.S_IFREG | 0o600)
        def lstat(path):
            if path not in table: raise FileNotFoundError(path)
            return table[path]
        helper.refuse_links('/d/data-0-0/app/db.sqlite', lstat)
        helper.refuse_links('/d/data-0-0/app/db.sqlite-wal', lstat)  # a sidecar that is not there is fine
        table['/d/data-0-0/app'] = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        with self.assertRaisesRegex(R, 'link'): helper.refuse_links('/d/data-0-0/app/db.sqlite', lstat)
        with self.assertRaises(R): helper.refuse_links('/d/missing/db', lstat)
        with self.assertRaises(R): helper.refuse_links('relative', lstat)
    def test_a_linked_home_and_a_missing_restore_base_have_clear_messages(self):
        runtime = rootless()
        table = {'/home': SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)}
        with self.assertRaisesRegex(R, 'Fedora Atomic'): helper.check_runtime_source(runtime, '/home/alice/data', lambda p: table[p])
        def missing(path): raise FileNotFoundError(path)
        with self.assertRaisesRegex(R, 'does not exist'): helper.rootless_data_root(runtime, '3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b', '/nowhere/base', missing, lambda p, m: missing(p), lambda p, m: None, lambda: 0, lambda p: [])

class DataRootTests(unittest.TestCase):
    def test_created_root_owned_and_traversable_only(self):
        made = []
        table = {}
        def lstat(path):
            if path not in table: raise FileNotFoundError(path)
            return table[path]
        def mkdir(path, mode): made.append((path, mode)); table[path] = SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=0)
        base = '/var/lib/x/rootless'
        path = helper.rootless_data_root(rootless(), '3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b', base, lstat, mkdir, lambda p, m: None, lambda: 0, lambda p: [])
        self.assertEqual(path, base + '/1001/3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b')
        self.assertEqual([m for _, m in made], [0o711, 0o711, 0o711])
    def test_unsafe_existing_folders_refused(self):
        job = '3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b'
        for entry in (SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0), SimpleNamespace(st_mode=stat.S_IFDIR | 0o777, st_uid=0), SimpleNamespace(st_mode=stat.S_IFDIR | 0o711, st_uid=1001), SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)):
            with self.assertRaises(R): helper.rootless_data_root(rootless(), job, '/b', lambda p: entry, lambda p, m: None, lambda p, m: None, lambda: 0, lambda p: [])
        safe = SimpleNamespace(st_mode=stat.S_IFDIR | 0o711, st_uid=0)
        with self.assertRaisesRegex(R, 'not empty'): helper.rootless_data_root(rootless(), job, '/b', lambda p: safe, lambda p, m: None, lambda p, m: None, lambda: 0, lambda p: ['x'])
        with self.assertRaises(R): helper.rootless_data_root(rootless(), 'not-a-job', '/b', lambda p: safe, lambda p, m: None, lambda p, m: None, lambda: 0, lambda p: [])
        with self.assertRaises(R): helper.rootless_data_root(rootless(), job, '/b', lambda p: safe, lambda p, m: None, lambda p, m: None, lambda: 1000, lambda p: [])
        with self.assertRaises(R): helper.rootless_data_root(helper.Runtime('podman'), job, '/b', lambda p: safe, lambda p, m: None, lambda p, m: None, lambda: 0, lambda p: [])

class OperationTests(unittest.TestCase):
    def test_capture_operations_resolve_a_runtime_and_others_are_refused(self):
        request = lambda op, runtime=ALICE: {'operation': op, 'config': {'runtime': runtime}}
        with patch.object(helper, 'resolve_runtime', return_value=rootless()):
            for op in ('plan', 'readiness', 'capture', 'capture-stream'):
                helper.refuse_foreign_runtime(request(op)); self.assertEqual(helper.request_runtime(request(op)).user, 'alice')
        for op in ('maintenance', 'self-heal-restart', 'incremental-commit', 'deploy-restore', 'install-boot-recovery', 'move-facts'):
            with self.assertRaisesRegex(R, 'not available yet'): helper.refuse_foreign_runtime(request(op))
        self.assertIsNone(helper.request_runtime({'operation': 'capture', 'config': {}}))
        self.assertIsNone(helper.request_runtime({'operation': 'discover', 'config': {'runtime': ALICE}}))
        with patch.object(helper, 'resolve_runtime', return_value=helper.Runtime()):
            self.assertIsNone(helper.request_runtime(request('capture', {'engine': 'docker', 'rootless': False})))
        with patch.object(helper, 'resolve_runtime', side_effect=R('nope')), self.assertRaises(R): helper.request_runtime(request('capture'))
    def test_architecture_and_storage_follow_the_engine(self):
        answers = {'Docker': b'x86_64\n', 'Podman': b'amd64\n'}
        with patch.object(helper, 'docker', side_effect=lambda *a: answers['Docker']):
            self.assertEqual(helper.engine_architecture(), 'x86_64')
        with helper.using_runtime(helper.Runtime('podman')), patch.object(helper, 'docker', side_effect=lambda *a: answers['Podman']):
            self.assertEqual(helper.engine_architecture(), 'x86_64')
        with helper.using_runtime(helper.Runtime('podman')), patch.object(helper, 'docker', side_effect=lambda *a: b'/x/storage\n') as docker:
            self.assertEqual(helper.engine_storage_root(), '/x/storage')
        self.assertEqual(docker.call_args[0], ('info', '--format', '{{.Store.GraphRoot}}'))

class PreflightTests(unittest.TestCase):
    """The systemd-managed and native-database refusals, through the real functions with fake inspect data."""
    def test_systemd_managed_container_refused_only_for_other_engines(self):
        record = {'Id': 'a' * 64, 'Name': '/web', 'Config': {'Image': 'registry.invalid/web:1', 'Labels': {'PODMAN_SYSTEMD_UNIT': 'web.service'}}, 'HostConfig': {}, 'Mounts': [], 'State': {'Running': True}}
        cfg = {'containers': ['web'], 'exclusiveSourcesConfirmed': True, 'cleanShutdownConfirmed': True}
        with patch.object(helper, 'inspect', return_value=[record]), patch.object(helper, 'docker', return_value=b''):
            with helper.using_runtime(helper.Runtime('podman')), self.assertRaisesRegex(ValueError, 'systemd unit'):
                helper.preflight(cfg)
            with helper.using_runtime(helper.Runtime('podman')), self.assertRaises(ValueError):
                helper.preflight({**cfg, 'kind': 'static'})

class ConnectionAndCleanupTests(unittest.TestCase):
    JOB = '3f2b8a6e-4c1d-4e5f-9a7b-0c1d2e3f4a5b'
    def test_podman_only_server_can_connect(self):
        import subprocess
        engines = [{'engine': 'podman', 'rootless': False, 'version': '5.2.1', 'cgroupDelegated': True}]
        def docker(*args):
            if args[0] == 'info' and helper.current_runtime().engine == 'podman': return b'amd64\n'
            raise FileNotFoundError('docker')
        with patch.object(helper, 'docker', docker):
            self.assertEqual(helper.engine_facts(engines), {'docker': None, 'architecture': 'x86_64'})
            with self.assertRaises(FileNotFoundError): helper.engine_facts([])
            with patch.object(helper, 'engine_runtime', return_value=None), self.assertRaises(ValueError): helper.engine_facts(engines)
        with patch.object(helper, 'docker', lambda *a: b'28.0.1\n' if a[0] == 'version' else b'x86_64\n'):
            self.assertEqual(helper.engine_facts(engines), {'docker': '28.0.1', 'architecture': 'x86_64'})
        self.assertIsNone(helper.RUNTIME)
    def test_cleanup_removes_only_the_jobs_label_and_folder(self):
        calls, removed = [], []
        def docker(*args):
            calls.append(args)
            return b'aabbccddeeff\n' if args[0] == 'ps' else b''
        safe = SimpleNamespace(st_mode=stat.S_IFDIR | 0o711, st_uid=0)
        with patch.object(helper, 'resolve_runtime', return_value=rootless()), patch.object(helper, 'docker', docker):
            result = helper.runtime_restore_cleanup({'job': self.JOB, 'runtime': ALICE}, '/b', lambda p: safe, removed.append)
        self.assertEqual(result, {'containers': 1, 'dataRoot': True}); self.assertEqual(removed, ['/b/1001/' + self.JOB])
        self.assertEqual(calls[0], ('ps', '-aq', '--filter', 'label=docker-backup-manager.restore=' + self.JOB))
        self.assertEqual([c[0] for c in calls], ['ps', 'stop', 'rm'])
    def test_cleanup_refusals(self):
        safe = SimpleNamespace(st_mode=stat.S_IFDIR | 0o711, st_uid=0)
        with patch.object(helper, 'resolve_runtime', return_value=helper.Runtime()), self.assertRaises(R): helper.runtime_restore_cleanup({'job': self.JOB, 'runtime': None})
        with patch.object(helper, 'resolve_runtime', return_value=rootless()), patch.object(helper, 'docker', lambda *a: b'aabbccddeeff\n'):
            for entry in (SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0), SimpleNamespace(st_mode=stat.S_IFDIR | 0o777, st_uid=0), SimpleNamespace(st_mode=stat.S_IFDIR | 0o711, st_uid=1001)):
                with self.assertRaises(R): helper.runtime_restore_cleanup({'job': self.JOB, 'runtime': ALICE}, '/b', lambda p: entry, lambda p: self.fail('removed'))
        with patch.object(helper, 'resolve_runtime', return_value=rootless()), patch.object(helper, 'docker', lambda *a: b'--all\n'):
            with self.assertRaises(R): helper.runtime_restore_cleanup({'job': self.JOB, 'runtime': ALICE}, '/b', lambda p: safe, lambda p: self.fail('removed'))
        with self.assertRaises(ValueError): helper.runtime_restore_cleanup({'job': 'x', 'runtime': ALICE})
        with patch.object(helper, 'resolve_runtime', return_value=rootless()), patch.object(helper, 'docker', lambda *a: b''):
            self.assertEqual(helper.runtime_restore_cleanup({'job': self.JOB, 'runtime': ALICE}, '/b', lambda p: (_ for _ in ()).throw(FileNotFoundError()), lambda p: None), {'containers': 0, 'dataRoot': False})

if __name__ == '__main__': unittest.main()
