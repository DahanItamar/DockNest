"""Image archives for Podman and rootless engines (docs/podman-rootless.md). Run: python3 remote/test_podman_images.py
A rootless engine runs as its user, so it cannot open root's private folders: root opens the archive (no link followed, a
regular file only) and streams it to `load` on standard input, and `save` writes to standard output, which is a file root
creates (new, 0600). Rootful Docker keeps its exact `-i` and `-o` commands. Fake engines; data flows through descriptors."""
import os, pathlib, stat, subprocess, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

R = helper.RuntimeRefused
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
def rootless(engine='podman'): return helper.Runtime(engine, True, 'app', 1001, '/home/app')

class DefaultPathTests(unittest.TestCase):
    def test_rootful_docker_commands_are_unchanged(self):
        with patch.object(helper, 'docker', return_value=b'') as docker:
            helper.engine_load('/r/unpacked/images.tar'); helper.engine_save(pathlib.PurePosixPath('/r/images.tar'), 'sha256:a', 'sha256:b')
        self.assertEqual([c.args for c in docker.call_args_list], [('load', '-i', '/r/unpacked/images.tar'), ('save', '-o', '/r/images.tar', 'sha256:a', 'sha256:b')])
    def test_rootful_podman_streams_too(self):
        with helper.using_runtime(helper.Runtime('podman')), patch.object(helper, 'docker', side_effect=AssertionError('no -i/-o')):
            with tempfile.TemporaryDirectory() as folder:
                archive = pathlib.Path(folder) / 'images.tar'; archive.write_bytes(b'x')
                with patch.object(subprocess, 'run') as run: helper.engine_load(archive)
        self.assertEqual(run.call_args[0][0], ['podman', 'load'])

class LoadTests(unittest.TestCase):
    def test_load_streams_the_archive_on_stdin_and_never_names_it(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / 'images.tar'; archive.write_bytes(b'tar-bytes' * 1000)
            seen = {}
            def fake(argv, stdin=None, stdout=None, stderr=None, timeout=None, check=None):
                seen.update(argv=argv, data=os.read(stdin, 1 << 20), timeout=timeout, check=check, stdout=stdout)
            runtime = rootless('docker')
            with patch.object(subprocess, 'run', fake), patch.object(runtime, 'check_socket') as socket_check, helper.using_runtime(runtime):
                helper.engine_load(archive)
        self.assertEqual(seen['argv'][:5], ['runuser', '-u', 'app', '--', 'env']); self.assertEqual(seen['argv'][-2:], ['docker', 'load'])
        self.assertNotIn(str(archive), ' '.join(seen['argv'])); self.assertEqual(seen['argv'][-1], 'load')
        self.assertEqual(seen['data'], b'tar-bytes' * 1000); self.assertTrue(seen['check']); socket_check.assert_called_once()
    def test_descriptor_is_closed_and_the_open_never_follows_a_link(self):
        flags = []
        real = os.open
        def spy(path, mode, *rest): flags.append(mode); return real(path, mode, *rest)
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / 'images.tar'; archive.write_bytes(b'x')
            closed = []
            real_close = os.close
            def close(fd): closed.append(fd); real_close(fd)
            with patch.object(helper.os, 'open', spy), patch.object(helper.os, 'close', close), patch.object(subprocess, 'run'), helper.using_runtime(rootless()):
                helper.engine_load(archive)
        self.assertEqual(flags[0] & NOFOLLOW, NOFOLLOW); self.assertEqual(len(closed), 1)
    @unittest.skipUnless(hasattr(os, 'symlink') and os.name == 'posix', 'needs Linux links')
    def test_a_link_in_place_of_the_archive_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'secret'; target.write_text('x'); link = pathlib.Path(folder) / 'images.tar'; os.symlink(target, link)
            with patch.object(subprocess, 'run') as run, helper.using_runtime(rootless()), self.assertRaises(OSError): helper.engine_load(link)
            run.assert_not_called()
    @unittest.skipUnless(os.name == 'posix', 'opening a folder fails differently elsewhere')
    def test_a_folder_in_place_of_the_archive_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(subprocess, 'run') as run, helper.using_runtime(rootless()), self.assertRaises((R, OSError)): helper.engine_load(folder)
            run.assert_not_called()
    def test_a_failing_engine_is_an_error(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / 'images.tar'; archive.write_bytes(b'x')
            with patch.object(subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['x'])), helper.using_runtime(rootless()), self.assertRaises(subprocess.CalledProcessError): helper.engine_load(archive)

class SaveTests(unittest.TestCase):
    def test_save_streams_to_a_new_private_file_in_chunks(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'images.tar'
            seen = {}
            def fake(argv, stdin=None, stdout=None, stderr=None, timeout=None, check=None):
                seen.update(argv=argv, stdout=stdout, check=check)
                for _ in range(50): os.write(stdout, b'\0' * (1 << 20))  # 50 MB, one megabyte at a time
            with patch.object(subprocess, 'run', fake), helper.using_runtime(rootless()):
                helper.engine_save(target, 'sha256:a', 'sha256:b')
            self.assertEqual(target.stat().st_size, 50 << 20)
            if os.name == 'posix': self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertEqual(seen['argv'][-4:], ['podman', 'save', 'sha256:a', 'sha256:b']); self.assertNotIn('-o', seen['argv']); self.assertNotIn(str(target), ' '.join(seen['argv']))
        self.assertIsInstance(seen['stdout'], int, 'a file descriptor, never a pipe held in memory'); self.assertTrue(seen['check'])
    def test_an_existing_file_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'images.tar'; target.write_bytes(b'keep')
            with patch.object(subprocess, 'run') as run, helper.using_runtime(rootless()), self.assertRaises(FileExistsError): helper.engine_save(target, 'x')
            run.assert_not_called(); self.assertEqual(target.read_bytes(), b'keep')
    def test_a_failed_save_leaves_no_partial_file(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'images.tar'
            def fake(argv, stdin=None, stdout=None, **kw): os.write(stdout, b'partial'); raise subprocess.CalledProcessError(1, argv)
            with patch.object(subprocess, 'run', fake), helper.using_runtime(rootless()), self.assertRaises(subprocess.CalledProcessError): helper.engine_save(target, 'x')
            self.assertFalse(target.exists())
    def test_a_stopped_step_does_not_start_the_engine(self):
        with patch.object(helper, 'STOPPING', True), patch.object(subprocess, 'run') as run, helper.using_runtime(rootless()), self.assertRaises(ValueError):
            helper.current_runtime().stream('ps')
        run.assert_not_called()

class WiringTests(unittest.TestCase):
    def test_the_restore_paths_use_the_stream_helpers(self):
        for source in ('backup.py', 'restore_test.py', 'restore.py', 'move.py'):
            text = (pathlib.Path(__file__).parent / 'helper' / source).read_text()
            self.assertNotIn("docker('load','-i'", text, source); self.assertNotIn("docker('save','-o'", text, source)

if __name__ == '__main__': unittest.main()
