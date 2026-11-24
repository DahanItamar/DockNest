"""Image archives for Podman and rootless engines (docs/podman-rootless.md). Run: python3 remote/test_podman_images.py
A rootless engine runs as its user, so it cannot open root's private folders: root opens the archive (no link followed, a
regular file only) and streams it to `load` on standard input, and `save` writes to standard output, which is a file root
creates (new, 0600). Rootful Docker keeps its exact `-i` and `-o` commands. The call is watched: a stopped step ends it,
the time allowed grows with the archive, and a failure keeps only a capped tail of the engine's error output.
Fake engines; data flows through descriptors."""
import os, pathlib, signal, stat, subprocess, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

R = helper.RuntimeRefused
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
FAKE_PID = 2 ** 31 - 2  # no real process or group has it, so a stray signal could never reach anything
def rootless(engine='podman'): return helper.Runtime(engine, True, 'app', 1001, '/home/app')

def popen(action=None, hang=0):
    """A fake subprocess.Popen: wait() times out `hang` times, then `action(process)` runs and its result is the exit code."""
    calls = []
    class Process:
        def __init__(self, argv, stdin=None, stdout=None, stderr=None, start_new_session=False, cwd=None):
            self.argv, self.stdin, self.stdout, self.stderr, self.new_session, self.pid, self.cwd = argv, stdin, stdout, stderr, start_new_session, FAKE_PID, cwd
            self.returncode = None; self.waits = 0; self.terminated = False; self.killed = False; self.timeouts = []
            calls.append(self)
        def wait(self, timeout=None):
            self.waits += 1; self.timeouts.append(timeout)
            if self.returncode is not None: return self.returncode  # already ended by terminate or kill
            if self.waits <= hang: raise subprocess.TimeoutExpired(self.argv, timeout)
            if self.returncode is None: self.returncode = action(self) if action else 0
            return self.returncode
        def poll(self): return self.returncode
        def terminate(self): self.terminated = True; self.returncode = -15
        def kill(self): self.killed = True; self.returncode = -9
    Process.calls = calls; Process.signals = []
    return Process

def group_signals(fake, ignore_term=False):
    """A stand-in for os.killpg that models the process: SIGTERM ends it unless it ignores the signal, SIGKILL always does.
    Patched in on every OS, so the tests never signal a real process or group."""
    def killpg(pid, sig):
        process = fake.calls[-1]; fake.signals.append((pid, sig))
        if sig == 9: process.killed = True; process.returncode = -9
        elif not ignore_term: process.terminated = True; process.returncode = -15
    return killpg

class DefaultPathTests(unittest.TestCase):
    def test_rootful_docker_commands_are_unchanged(self):
        with patch.object(helper, 'docker', return_value=b'') as docker:
            helper.engine_load('/r/unpacked/images.tar'); helper.engine_save(pathlib.PurePosixPath('/r/images.tar'), 'sha256:a', 'sha256:b')
        self.assertEqual([c.args for c in docker.call_args_list], [('load', '-i', '/r/unpacked/images.tar'), ('save', '-o', '/r/images.tar', 'sha256:a', 'sha256:b')])
    def test_rootful_podman_streams_too(self):
        fake = popen()
        with helper.using_runtime(helper.Runtime('podman')), patch.object(helper, 'docker', side_effect=AssertionError('no -i/-o')):
            with tempfile.TemporaryDirectory() as folder:
                archive = pathlib.Path(folder) / 'images.tar'; archive.write_bytes(b'x')
                with patch.object(subprocess, 'Popen', fake): helper.engine_load(archive)
        self.assertEqual(fake.calls[0].argv, ['podman', 'load'])

class LoadTests(unittest.TestCase):
    def test_load_streams_the_archive_on_stdin_and_never_names_it(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / 'images.tar'; archive.write_bytes(b'tar-bytes' * 1000)
            seen = {}
            def action(process): seen['data'] = os.read(process.stdin, 1 << 20); return 0
            fake = popen(action); runtime = rootless('docker')
            with patch.object(subprocess, 'Popen', fake), patch.object(runtime, 'check_socket') as socket_check, helper.using_runtime(runtime):
                helper.engine_load(archive)
        argv = fake.calls[0].argv
        self.assertEqual(argv[:5], ['runuser', '-u', 'app', '--', 'env']); self.assertEqual(argv[-2:], ['docker', 'load'])
        self.assertNotIn(str(archive), ' '.join(argv)); self.assertEqual(argv[-1], 'load')
        self.assertEqual(seen['data'], b'tar-bytes' * 1000); socket_check.assert_called_once()
    def test_descriptor_is_closed_and_the_open_never_follows_a_link(self):
        flags = []
        real = os.open
        def spy(path, mode, *rest): flags.append(mode); return real(path, mode, *rest)
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / 'images.tar'; archive.write_bytes(b'x')
            closed = []
            real_close = os.close
            def close(fd): closed.append(fd); real_close(fd)
            with patch.object(helper.os, 'open', spy), patch.object(helper.os, 'close', close), patch.object(subprocess, 'Popen', popen()), helper.using_runtime(rootless()):
                helper.engine_load(archive)
        self.assertEqual(flags[0] & NOFOLLOW, NOFOLLOW); self.assertGreaterEqual(len(closed), 1)
    @unittest.skipUnless(hasattr(os, 'symlink') and os.name == 'posix', 'needs Linux links')
    def test_a_link_in_place_of_the_archive_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'secret'; target.write_text('x'); link = pathlib.Path(folder) / 'images.tar'; os.symlink(target, link)
            fake = popen()
            with patch.object(subprocess, 'Popen', fake), helper.using_runtime(rootless()), self.assertRaises(OSError): helper.engine_load(link)
            self.assertEqual(fake.calls, [])
    @unittest.skipUnless(os.name == 'posix', 'opening a folder fails differently elsewhere')
    def test_a_folder_in_place_of_the_archive_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            fake = popen()
            with patch.object(subprocess, 'Popen', fake), helper.using_runtime(rootless()), self.assertRaises((R, OSError)): helper.engine_load(folder)
            self.assertEqual(fake.calls, [])
    def test_the_time_allowed_grows_with_the_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = pathlib.Path(folder) / 'images.tar'; archive.write_bytes(b'x')
            seen = []
            def stream(self, *args, **kw): seen.append(kw['timeout'])
            size = lambda n: type('S', (), {'st_mode': stat.S_IFREG, 'st_size': n})()
            with patch.object(helper.Runtime, 'stream', stream), helper.using_runtime(rootless()):
                helper.engine_load(archive)
                with patch.object(helper.os, 'fstat', return_value=size(200 * 10 ** 9)): helper.engine_load(archive)
                with patch.object(helper.os, 'fstat', return_value=size(10 ** 15)): helper.engine_load(archive)
        self.assertEqual(seen[0], helper.STREAM_MIN_SECONDS); self.assertEqual(seen[1], 200 * 10 ** 9 // helper.STREAM_BYTES_PER_SECOND + 600); self.assertEqual(seen[2], helper.STREAM_MAX_SECONDS)
        self.assertGreater(seen[1], helper.STREAM_MIN_SECONDS)

class WatchTests(unittest.TestCase):
    def stream(self, fake, ignore_term=False, **kw):
        with patch.object(subprocess, 'Popen', fake), patch.object(helper.os, 'killpg', group_signals(fake, ignore_term), create=True), \
             patch.object(signal, 'SIGKILL', 9, create=True), helper.using_runtime(rootless()):
            helper.current_runtime().stream('load', poll=0.01, **kw)
    def stop_after(self, fake, waits=2):
        real = fake.wait
        def wait(self, timeout=None):
            if self.waits == waits: helper.STOPPING = True
            return real(self, timeout)
        fake.wait = wait
    def test_a_failing_engine_keeps_only_a_capped_error_tail(self):
        def action(process):
            os.write(process.stderr.fileno(), b'x' * 5000 + b'the last words'); return 125
        with self.assertRaises(subprocess.CalledProcessError) as caught: self.stream(popen(action))
        error = caught.exception
        self.assertEqual(error.returncode, 125); self.assertLessEqual(len(error.stderr), helper.STREAM_ERROR_TAIL); self.assertTrue(error.stderr.endswith(b'the last words'))
        self.assertNotIn('the last words', str(error), 'the tail is never part of the message that gets printed or sent')
        self.assertEqual(error.cmd, ['runuser'], 'only the command name is kept, never its arguments')
    def test_the_engine_runs_in_its_own_group_and_a_stop_ends_the_whole_group(self):
        fake = popen(hang=10 ** 6); self.stop_after(fake)
        try:
            with self.assertRaisesRegex(ValueError, 'stopped'): self.stream(fake)
        finally: helper.STOPPING = False
        process = fake.calls[0]
        self.assertTrue(process.new_session, 'its own session, so its children share one group')
        self.assertEqual(fake.signals, [(FAKE_PID, signal.SIGTERM)]); self.assertTrue(process.terminated); self.assertFalse(process.killed)
    def test_a_group_that_ignores_terminate_gets_kill(self):
        fake = popen(hang=10 ** 6); self.stop_after(fake)
        try:
            with self.assertRaises(ValueError): self.stream(fake, ignore_term=True)
        finally: helper.STOPPING = False
        self.assertEqual([sig for _, sig in fake.signals], [signal.SIGTERM, 9]); self.assertTrue(fake.calls[0].killed)
    def test_a_run_longer_than_allowed_is_a_timeout_and_the_group_is_ended(self):
        fake = popen(hang=10 ** 6)
        with self.assertRaises(subprocess.TimeoutExpired): self.stream(fake, timeout=0.05)
        self.assertEqual(fake.signals, [(FAKE_PID, signal.SIGTERM)]); self.assertTrue(fake.calls[0].terminated)
    def test_a_group_already_gone_is_fine(self):
        fake = popen(hang=10 ** 6)
        def killpg(pid, sig): fake.calls[-1].returncode = -15; raise ProcessLookupError()
        with patch.object(subprocess, 'Popen', fake), patch.object(helper.os, 'killpg', killpg, create=True), helper.using_runtime(rootless()), self.assertRaises(subprocess.TimeoutExpired):
            helper.current_runtime().stream('load', poll=0.01, timeout=0.05)
    def test_without_process_groups_the_child_itself_is_ended(self):
        fake = popen(hang=10 ** 6); self.stop_after(fake)
        fake.terminate = lambda self: setattr(self, 'terminated', True)  # ignores the signal: still running
        real_wait = fake.wait
        def wait(self, timeout=None):
            if self.terminated and not self.killed and timeout == 10: raise subprocess.TimeoutExpired(self.argv, timeout)
            return real_wait(self, timeout)
        fake.wait = wait
        try:
            with patch.object(subprocess, 'Popen', fake), patch.object(helper.os, 'killpg', None, create=True), helper.using_runtime(rootless()), self.assertRaises(ValueError):
                helper.current_runtime().stream('load', poll=0.01)
        finally: helper.STOPPING = False
        self.assertTrue(fake.calls[0].terminated and fake.calls[0].killed)
    def test_a_step_already_stopped_never_starts_the_engine(self):
        fake = popen()
        with patch.object(helper, 'STOPPING', True), patch.object(subprocess, 'Popen', fake), helper.using_runtime(rootless()), self.assertRaises(ValueError):
            helper.current_runtime().stream('ps')
        self.assertEqual(fake.calls, [])
    def test_stdout_defaults_to_nowhere_and_stderr_is_never_a_pipe(self):
        fake = popen()
        self.stream(fake)
        process = fake.calls[0]
        self.assertEqual(process.stdout, subprocess.DEVNULL); self.assertNotEqual(process.stderr, subprocess.PIPE)

class SaveTests(unittest.TestCase):
    def test_save_streams_to_a_new_private_file_in_chunks(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'images.tar'
            def action(process):
                for _ in range(50): os.write(process.stdout, b'\0' * (1 << 20))  # 50 MB, one megabyte at a time
                return 0
            fake = popen(action)
            with patch.object(subprocess, 'Popen', fake), helper.using_runtime(rootless()):
                helper.engine_save(target, 'sha256:a', 'sha256:b')
            self.assertEqual(target.stat().st_size, 50 << 20)
            if os.name == 'posix': self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        process = fake.calls[0]
        self.assertEqual(process.argv[-6:], ['podman', 'save', '--format', 'docker-archive', 'sha256:a', 'sha256:b']); self.assertNotIn('-o', process.argv); self.assertNotIn(str(target), ' '.join(process.argv))
        self.assertIsInstance(process.stdout, int, 'a file descriptor, never a pipe held in memory')
    def test_an_existing_file_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'images.tar'; target.write_bytes(b'keep')
            fake = popen()
            with patch.object(subprocess, 'Popen', fake), helper.using_runtime(rootless()), self.assertRaises(FileExistsError): helper.engine_save(target, 'x')
            self.assertEqual(fake.calls, []); self.assertEqual(target.read_bytes(), b'keep')
    def test_a_failed_or_stopped_save_leaves_no_partial_file(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'images.tar'
            def action(process): os.write(process.stdout, b'partial'); return 1
            with patch.object(subprocess, 'Popen', popen(action)), helper.using_runtime(rootless()), self.assertRaises(subprocess.CalledProcessError): helper.engine_save(target, 'x')
            self.assertFalse(target.exists())
            with patch.object(helper, 'STOPPING', True), patch.object(subprocess, 'Popen', popen()), patch.object(helper.os, 'killpg', lambda *a: None, create=True), helper.using_runtime(rootless()), self.assertRaises(ValueError): helper.engine_save(target, 'x')
            self.assertFalse(target.exists())

class WiringTests(unittest.TestCase):
    def test_the_restore_paths_use_the_stream_helpers(self):
        for source in ('backup.py', 'restore_test.py', 'restore.py', 'move.py'):
            text = (pathlib.Path(__file__).parent / 'helper' / source).read_text()
            self.assertNotIn("docker('load','-i'", text, source); self.assertNotIn("docker('save','-o'", text, source)
    def test_stopping_is_read_at_call_time_not_copied_at_import(self):
        text = (pathlib.Path(__file__).parent / 'helper' / 'runtime.py').read_text()
        self.assertNotIn('import STOPPING', text); self.assertNotIn('STOPPING,', text.split('# </build:header>')[0])

class WorkdirTests(unittest.TestCase):
    def test_a_rootless_engine_never_starts_in_a_folder_closed_to_its_user(self):
        fake = popen()
        with patch.object(subprocess, 'Popen', fake), helper.using_runtime(rootless()): helper.current_runtime().stream('load', poll=0.01)
        self.assertEqual(fake.calls[0].cwd, '/')
        for engine in ('docker', 'podman'):
            runtime = rootless(engine)
            with patch.object(helper, 'run', return_value=b'') as run, patch.object(runtime, 'check_socket'): runtime.cli('ps')
            self.assertEqual(run.call_args.kwargs['cwd'], '/', engine)
    def test_rootful_engines_keep_their_folder(self):
        with patch.object(helper, 'run', return_value=b'') as run: helper.Runtime().cli('ps')
        self.assertNotIn('cwd', run.call_args.kwargs, 'rootful Docker is called exactly as before')
        self.assertIsNone(helper.Runtime('podman').workdir())
        with patch.object(helper, 'run', return_value=b'') as run: helper.Runtime('podman').cli('ps')
        self.assertNotIn('cwd', run.call_args.kwargs)
    def test_a_caller_can_still_choose_a_folder(self):
        runtime = rootless()
        with patch.object(helper, 'run', return_value=b'') as run: runtime.cli('ps', cwd='/tmp')
        self.assertEqual(run.call_args.kwargs['cwd'], '/tmp')

class SessionBusTests(unittest.TestCase):
    PATH = '/run/user/1001/bus'
    def lstat(self, mode, uid=1001):
        def lstat(path):
            assert path == self.PATH
            return type('S', (), {'st_mode': mode, 'st_uid': uid})()
        return lstat
    def test_only_rootless_podman_with_a_socket_of_its_user_gets_the_bus(self):
        podman = rootless('podman')
        self.assertEqual(podman.session_bus(self.lstat(stat.S_IFSOCK | 0o700)), 'unix:path=' + self.PATH)
        for bad in (self.lstat(stat.S_IFSOCK | 0o700, uid=0), self.lstat(stat.S_IFREG | 0o600), self.lstat(stat.S_IFLNK | 0o777)):
            self.assertIsNone(podman.session_bus(bad))
        def missing(path): raise FileNotFoundError(path)
        self.assertIsNone(podman.session_bus(missing))
        self.assertIsNone(rootless('docker').session_bus(self.lstat(stat.S_IFSOCK | 0o700)), 'rootless Docker needs no session bus')
        self.assertIsNone(helper.Runtime('podman').session_bus(self.lstat(stat.S_IFSOCK | 0o700)))
    def test_argv_carries_the_bus_only_for_the_users_own_path(self):
        podman = rootless('podman')
        self.assertNotIn('DBUS_SESSION_BUS_ADDRESS=unix:path=' + self.PATH, podman.argv('ps'))
        argv = podman.argv('ps', bus='unix:path=' + self.PATH)
        self.assertEqual(argv[argv.index('env') + 1:argv.index('podman')][-1], 'DBUS_SESSION_BUS_ADDRESS=unix:path=' + self.PATH)
        for other in ('unix:path=/run/user/0/bus', 'unix:path=/tmp/evil', 'tcp:host=x'):
            self.assertFalse(any(part.startswith('DBUS_SESSION_BUS_ADDRESS') for part in podman.argv('ps', bus=other)), other)
        self.assertFalse(any('DBUS' in part for part in rootless('docker').argv('ps', bus='unix:path=' + self.PATH)))
        self.assertEqual(helper.Runtime('podman').argv('ps', bus='unix:path=' + self.PATH), ['podman', 'ps'])
    def test_cli_and_stream_pass_the_checked_bus(self):
        runtime = rootless('podman')
        with patch.object(runtime, 'session_bus', return_value='unix:path=' + self.PATH), patch.object(helper, 'run', return_value=b'') as run:
            runtime.cli('ps')
        self.assertIn('DBUS_SESSION_BUS_ADDRESS=unix:path=' + self.PATH, run.call_args[0][0])
        fake = popen()
        with patch.object(runtime, 'session_bus', return_value='unix:path=' + self.PATH), patch.object(subprocess, 'Popen', fake): runtime.stream('load', poll=0.01)
        self.assertIn('DBUS_SESSION_BUS_ADDRESS=unix:path=' + self.PATH, fake.calls[0].argv)
        fake = popen()
        with patch.object(runtime, 'session_bus', return_value=None), patch.object(subprocess, 'Popen', fake): runtime.stream('load', poll=0.01)
        self.assertFalse(any('DBUS' in part for part in fake.calls[0].argv))

class RestartReasonTests(unittest.TestCase):
    def reason(self, *records):
        with patch.object(helper, 'inspect', return_value=list(records)): return helper.restart_reason(['x'])
    def record(self, name='shop', running=True, health=None):
        state = {'Running': running}
        if health is not None: state['Health'] = health
        return {'Id': 'a' * 64, 'Name': '/' + name, 'State': state}
    def test_a_health_check_that_never_started_is_named(self):
        text = self.reason(self.record(health={'Status': 'starting', 'Log': []}))
        self.assertIn('health check of shop never started', text); self.assertIn('rootless Podman', text); self.assertIn('watchdog remains armed', text)
    def test_other_stalls_have_their_own_sentence(self):
        self.assertIn('shop is not running', self.reason(self.record(running=False)))
        self.assertIn('shop reports unhealthy', self.reason(self.record(health={'Status': 'unhealthy', 'Log': [{}]})))
        self.assertIn('shop reports starting', self.reason(self.record(health={'Status': 'starting', 'Log': [{'ExitCode': 1}]})))
    def test_nothing_specific_gives_no_reason_so_the_old_text_stays(self):
        self.assertIsNone(self.reason(self.record(health={'Status': 'healthy'})))
        self.assertIsNone(self.reason(self.record()))
        with patch.object(helper, 'inspect', side_effect=RuntimeError('x')): self.assertIsNone(helper.restart_reason(['x']))
        self.assertIsNone(helper.restart_reason([]))
    def test_the_sentence_holds_names_only(self):
        record = self.record(health={'Status': 'starting', 'Log': []}); record['Config'] = {'Env': ['TOKEN=' + 'x' * 5]}; record['State']['Health']['Log'] = []
        self.assertNotIn('TOKEN', self.reason(record))

if __name__ == '__main__': unittest.main()
