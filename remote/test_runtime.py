"""Container engine runtime (docs/podman-rootless.md). Run: python3 remote/test_runtime.py
Proves: rootful Docker keeps the exact argv it always had; rootless Docker and Podman build fixed argv with no shell;
bad users, units, volume answers and ID maps are refused; subuid parsing and ID translation hold their edges and never
produce host root. No real engine is called."""
import pathlib, subprocess, sys, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

R = helper.RuntimeRefused
SOURCE = {'uid': 1001, 'gid': 1001, 'subuid': [100000, 65536], 'subgid': [100000, 65536]}
TARGET = {'uid': 1500, 'gid': 1500, 'subuid': [300000, 65536], 'subgid': [300000, 65536]}

class ArgvTests(unittest.TestCase):
    def test_default_is_unchanged_rootful_docker(self):
        self.assertEqual(helper.current_runtime().argv('ps', '-a'), ['docker', 'ps', '-a'])
        with patch.object(helper, 'run', return_value=b'[]') as run:
            helper.docker('inspect', 'abc')
        run.assert_called_once_with(['docker', 'inspect', 'abc'])
        self.assertEqual(helper.Runtime().describe(), {'engine': 'docker', 'rootless': False})
    def test_other_engines(self):
        self.assertEqual(helper.Runtime('podman').argv('ps'), ['podman', 'ps'])
        self.assertEqual(helper.Runtime('docker', True, 'app', 1001, '/home/app').argv('ps'), ['docker', '--host', 'unix:///run/user/1001/docker.sock', 'ps'])
        self.assertEqual(helper.Runtime('podman', True, 'app', 1001, '/home/app').argv('ps', '-a'),
            ['runuser', '-u', 'app', '--', 'env', '-i', 'PATH=' + helper.RUNTIME_PATH, 'XDG_RUNTIME_DIR=/run/user/1001', 'HOME=/home/app', 'podman', 'ps', '-a'])
    def test_compose_goes_through_the_engine(self):
        with patch.object(helper, 'run', return_value=b'') as run:
            helper.Runtime('podman').compose('up', '-d')
        run.assert_called_once_with(['podman', 'compose', 'up', '-d'])
    def test_invalid_runtimes_refused(self):
        for args in (('lxc', False), ('docker', 'no'), ('docker', True, 'root', 0), ('docker', True, 'app', 999), ('docker', True, 'App', 1001),
                     ('docker', True, 'a;b', 1001), ('docker', True, '-x', 1001), ('docker', True, 'app', '1001'), ('docker', True, 'app', True),
                     ('podman', True, 'app', 1001, None), ('docker', True, 'app', 1001), ('docker', True, 'app', 1001, 'rel'), ('podman', True, 'app', 1001, 'relative'), ('podman', True, 'app', 1001, '/'),
                     ('podman', True, 'app', 1001, '/home/../root'), ('docker', False, 'app', 1001)):
            with self.assertRaises(R, msg=str(args)): helper.Runtime(*args)

class SubidTests(unittest.TestCase):
    def test_parse(self):
        text = '# c\nother:200000:65536\napp:100000:65536\n'
        self.assertEqual(helper.parse_subid(text, 'app', 1001), [100000, 65536])
        self.assertEqual(helper.parse_subid('1001:100000:65536', 'app', 1001), [100000, 65536])
    def test_refused(self):
        for text in ('', 'other:1:2', 'app:100000:65536\n1001:300000:65536', 'app:1:2:3', 'app:x:2', 'app:0:65536', 'app:100000:0', 'app:-1:5', 'app:4294967295:5', 'app:4294967295:1', 'app:00000000001:5', 'app:1:99999999999'):
            with self.assertRaises(R, msg=text): helper.parse_subid(text, 'app', 1001)

class TranslateTests(unittest.TestCase):
    def tr(self, v, kind='uid'): return helper.translate_id(v, SOURCE, TARGET, kind)
    def test_range_top_edge(self):
        self.assertEqual(helper.parse_subid('app:4294967295:1', 'app', 1001) if False else helper.id_range([4294967293, 1], 'x'), [4294967293, 1])
    def test_edges(self):
        self.assertEqual(self.tr(1001), 1500)
        self.assertEqual(self.tr(100000), 300000)
        self.assertEqual(self.tr(100000 + 65535), 300000 + 65535)
        self.assertEqual(self.tr(100005, 'gid'), 300005)
        self.assertEqual(self.tr(1001, 'gid'), 1500)
    def test_unmappable_refused(self):
        for v in (0, 1002, 99999, 165536, -1, True, '5', None, 1.0):
            with self.assertRaises(R, msg=str(v)): self.tr(v)
    def test_target_range_smaller(self):
        small = {**TARGET, 'subuid': [300000, 10]}
        self.assertEqual(helper.translate_id(100009, SOURCE, small), 300009)
        with self.assertRaisesRegex(R, 'cannot map'): helper.translate_id(100010, SOURCE, small)
    def test_never_host_root(self):
        for target in ({**TARGET, 'uid': 0}, {**TARGET, 'subuid': [0, 10]}, {**TARGET, 'uid': True}):
            with self.assertRaises(R): helper.translate_id(1001, SOURCE, target)
        with self.assertRaises(R): helper.translate_id(1001, {**SOURCE, 'uid': 0}, TARGET)
        for v in range(0, 5):
            with self.assertRaises(R): self.tr(v)
    def test_low_target_ids_refused(self):
        for kind in ('uid', 'gid'):
            with self.assertRaises(R): helper.translate_id(1001, SOURCE, {**TARGET, kind: 999}, kind)
    def test_missing_map_refused(self):
        with self.assertRaises(R): helper.translate_id(1001, {}, TARGET)
        with self.assertRaises(R): helper.translate_id(1001, SOURCE, None)
        with self.assertRaises(R): helper.translate_id(1001, SOURCE, TARGET, 'x')
    def test_id_map(self):
        self.assertEqual(helper.id_map(1001, [100000, 65536], [100000, 65536])['gid'], 1001)
        with self.assertRaises(R): helper.id_map(0, [1, 1], [1, 1])
        with self.assertRaises(R): helper.id_map(1001, [0, 1], [1, 1])

class UnitTests(unittest.TestCase):
    def test_unit_label(self):
        c = lambda u: {'Config': {'Labels': {'PODMAN_SYSTEMD_UNIT': u}}}
        self.assertEqual(helper.systemd_unit(c('web.service')), 'web.service')
        self.assertIsNone(helper.systemd_unit({'Config': {'Labels': {}}}))
        self.assertIsNone(helper.systemd_unit({}))
        for bad in ('--now.service', 'a b.service', 'x;y.service', 'web', '../x.service', 'a\nb.service', 5):
            with self.assertRaises(R, msg=str(bad)): helper.systemd_unit(c(bad))
    def test_argv(self):
        self.assertEqual(helper.Runtime().unit_argv('stop', 'web.service'), ['systemctl', 'stop', '--', 'web.service'])
        self.assertEqual(helper.Runtime('podman', True, 'app', 1001, '/home/app').unit_argv('start', 'web.service'),
            ['systemctl', '--user', '-M', 'app@', 'start', '--', 'web.service'])
        with self.assertRaises(R): helper.Runtime().unit_argv('disable', 'web.service')
        with self.assertRaises(R): helper.Runtime().unit_argv('stop', '-x.service')
    def test_stop_requires_inactive(self):
        runtime = helper.Runtime()
        with patch.object(helper, 'run', side_effect=[b'', b'active\n']):
            with self.assertRaisesRegex(R, 'did not stop'): runtime.stop_unit('web.service')
        with patch.object(helper, 'run', side_effect=[b'', subprocess.CalledProcessError(3, 'x', output=b'inactive\n')]):
            runtime.stop_unit('web.service')
        with patch.object(helper, 'run', side_effect=[b'', subprocess.CalledProcessError(4, 'x', output=b'')]):
            with self.assertRaises(R): runtime.stop_unit('web.service')

class ContainerStopTests(unittest.TestCase):
    def test_container_must_not_run(self):
        runtime = helper.Runtime()
        inactive = subprocess.CalledProcessError(3, 'x', output=b'inactive\n')
        for answer, ok in ((b'false\n', True), (b'true\n', False), (b'', False)):
            with patch.object(helper, 'run', side_effect=[b'', inactive, answer]):
                if ok: runtime.stop_unit('web.service', 'web')
                else:
                    with self.assertRaisesRegex(R, 'still running'): runtime.stop_unit('web.service', 'web')
        with patch.object(helper, 'run', side_effect=[b'', inactive, subprocess.CalledProcessError(1, 'x')]):
            with self.assertRaises(R): runtime.stop_unit('web.service', 'web')
        with patch.object(helper, 'run', side_effect=[b'', inactive]), self.assertRaises(R): runtime.stop_unit('web.service', '-x')

class UsingRuntimeTests(unittest.TestCase):
    def test_scoped_and_restored(self):
        podman = helper.Runtime('podman')
        before = helper.RUNTIME
        with helper.using_runtime(podman):
            self.assertEqual(helper.current_runtime().argv('ps'), ['podman', 'ps'])
        self.assertIs(helper.RUNTIME, before)
        with self.assertRaises(KeyError), helper.using_runtime(podman): raise KeyError()
        self.assertIs(helper.RUNTIME, before)
        with self.assertRaises(R): helper.using_runtime('podman')

class VolumeTests(unittest.TestCase):
    def test_volume_path(self):
        runtime = helper.Runtime('podman', True, 'app', 1001, '/home/app')
        good = b'/home/app/.local/share/containers/storage/volumes/data/_data\n'
        with patch.object(helper, 'run', return_value=good) as run:
            self.assertEqual(runtime.volume_path('data'), good.decode().strip())
        self.assertEqual(run.call_args[0][0][-5:], ['volume', 'inspect', '--format', '{{.Mountpoint}}', 'data'])
        for answer in (b'relative/x', b'/home/app/../root/x', b'/var/lib/x', b'/home/app2/x', b''):
            with patch.object(helper, 'run', return_value=answer), self.assertRaises(R, msg=str(answer)): runtime.volume_path('data')
        with self.assertRaises(R): runtime.volume_path('-v')

class ResolveTests(unittest.TestCase):
    passwd = staticmethod(lambda name: (1001, '/home/app') if name == 'app' else None)
    SUBUID = 'app:100000:65536\n'
    def resolve(self, spec, **kw):
        kw.setdefault('passwd', self.passwd); kw.setdefault('subuid_text', self.SUBUID); kw.setdefault('socket_owner', lambda p: 1001)
        return helper.resolve_runtime(spec, **kw)
    def test_missing_means_rootful_docker(self):
        self.assertEqual(helper.resolve_runtime(None).argv('ps'), ['docker', 'ps'])
        self.assertEqual(helper.resolve_runtime({'engine': 'docker', 'rootless': False}).argv('ps'), ['docker', 'ps'])
    def test_rootless_ok(self):
        self.assertEqual(self.resolve({'engine': 'podman', 'rootless': True, 'user': 'app', 'uid': 1001}).home, '/home/app')
        self.assertEqual(self.resolve({'engine': 'docker', 'rootless': True, 'user': 'app', 'uid': 1001}).uid, 1001)
    def test_refused(self):
        spec = {'engine': 'podman', 'rootless': True, 'user': 'app', 'uid': 1001}
        def missing(path): raise FileNotFoundError(path)
        cases = [({**spec, 'uid': 1002}, {}), ({**spec, 'user': 'ghost'}, {}), ({**spec, 'extra': 1}, {}), ('docker', {}),
                 (spec, {'subuid_text': ''}), (spec, {'subuid_text': 'other:1:2'}), ({**spec, 'uid': 'x'}, {}), ({**spec, 'user': 'a b'}, {}),
                 ({**spec, 'engine': 'docker'}, {'socket_owner': lambda p: 0}), ({**spec, 'engine': 'docker'}, {'socket_owner': missing})]
        for s, kw in cases:
            with self.assertRaises(R, msg=str(s)): self.resolve(s, **kw)
        with self.assertRaises(R): self.resolve({**spec, 'engine': 'docker'}, passwd=lambda n: (1001, ''))
        with self.assertRaises(R): helper.resolve_runtime({'engine': 'podman', 'rootless': True, 'user': 'root', 'uid': 0}, passwd=lambda n: (0, '/root'), subuid_text='root:1:2')

if __name__ == '__main__': unittest.main()
