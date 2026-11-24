"""Image health checks of Podman containers (docs/podman-rootless.md). Run: python3 remote/test_podman_health.py
Podman runs a health check from a systemd timer that a container DockNest stops and starts does not get, so DockNest runs the check
itself with `podman healthcheck run <id>` through the same user path as every other engine call. Fake engines only: the container
state lives in a dictionary that the fake `healthcheck run` updates, as the real one does. Docker is untouched."""
import pathlib, subprocess, sys, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

ID = 'a' * 64
def rootless(): return helper.Runtime('podman', True, 'app', 1001, '/home/app')

class Engine:
    """One container whose health starts at `status` and becomes `after` once `healthcheck run` ran."""
    def __init__(self, status='starting', after='healthy', running=True, health=True, exit_code=0, error=None):
        self.status, self.after, self.running, self.has_health, self.exit_code, self.error, self.runs = status, after, running, health, exit_code, error, []
    def record(self, cid=ID):
        state = {'Running': self.running}
        if self.has_health: state['Health'] = {'Status': self.status, 'Log': []}
        return {'Id': cid, 'Name': '/shop', 'State': state}
    def inspect(self, ids): return [self.record(ID) for _ in ids]  # the engine answers with the full id
    def cli(self, runtime):
        def call(*args, **options):
            self.runs.append((args, options))
            if self.error: raise self.error
            self.status = self.after
            if self.exit_code: raise subprocess.CalledProcessError(self.exit_code, ['podman'])
            return b''
        return call

class HealthTests(unittest.TestCase):
    def run_health(self, engine, runtime=None, containers=(ID,)):
        runtime = runtime or rootless()
        with patch.object(helper, 'inspect', engine.inspect), patch.object(runtime, 'cli', engine.cli(runtime)), helper.using_runtime(runtime):
            return helper.health(list(containers))
    def test_a_check_that_never_started_is_run_and_the_container_becomes_healthy(self):
        engine = Engine()
        self.assertTrue(self.run_health(engine))
        self.assertEqual(engine.runs, [(('healthcheck', 'run', ID), {'timeout': helper.HEALTHCHECK_SECONDS})])
    def test_an_unhealthy_answer_is_read_not_raised(self):
        engine = Engine(after='unhealthy', exit_code=1)
        self.assertFalse(self.run_health(engine))
        self.assertEqual(len(engine.runs), 1)
    def test_healthy_unhealthy_and_stopped_containers_are_left_alone(self):
        for engine in (Engine(status='healthy'), Engine(status='unhealthy'), Engine(running=False), Engine(health=False)):
            self.run_health(engine)
            self.assertEqual(engine.runs, [])
        self.assertTrue(self.run_health(Engine(health=False)), 'a container without a health check is as healthy as before')
    def test_slow_or_failing_engines_change_nothing(self):
        for error in (subprocess.TimeoutExpired(['podman'], 30), OSError('no runuser'), ValueError('stopped')):
            engine = Engine(error=error)
            self.assertFalse(self.run_health(engine), 'still starting, so not healthy: the caller timeout decides')
    def test_only_engine_ids_are_used(self):
        engine = Engine()
        runtime = rootless()
        for odd in ('--all', '../x', 'name with spaces', 'A' * 64, 'abc', '', 5, None):
            with patch.object(helper, 'inspect', engine.inspect), patch.object(runtime, 'cli', engine.cli(runtime)), helper.using_runtime(runtime):
                helper.drive_podman_healthchecks([odd])
            self.assertEqual(engine.runs, [], repr(odd))
        short = Engine()
        self.run_health(short, containers=('a' * 12,))  # a short id is looked up, but the run uses the full id the engine reported
        self.assertEqual(short.runs[0][0], ('healthcheck', 'run', ID))
    def test_a_record_with_an_odd_id_is_skipped(self):
        engine = Engine()
        engine.record = lambda cid=ID: {'Id': '--all', 'State': {'Running': True, 'Health': {'Status': 'starting'}}}
        self.run_health(engine)
        self.assertEqual(engine.runs, [])
    def test_rootful_podman_does_it_too_and_rootful_docker_never(self):
        engine = Engine()
        self.assertTrue(self.run_health(engine, helper.Runtime('podman')))
        self.assertEqual(len(engine.runs), 1)
        docker = Engine()
        with patch.object(helper, 'inspect', docker.inspect), patch.object(helper, 'run', side_effect=AssertionError('Docker must not run a health check by hand')):
            self.assertFalse(helper.health([ID]))  # starting and not healthy, exactly as before
        self.assertEqual(docker.runs, [])
    def test_the_number_of_containers_is_capped_and_none_is_fine(self):
        seen = []
        engine = Engine()
        with patch.object(helper, 'inspect', lambda ids: seen.append(len(ids)) or []), helper.using_runtime(rootless()):
            helper.drive_podman_healthchecks(['%064x' % n for n in range(100)])
            helper.drive_podman_healthchecks([]); helper.drive_podman_healthchecks(None)
        self.assertEqual(seen, [helper.HEALTHCHECK_LIMIT])
        def boom(ids): raise RuntimeError('x')
        with patch.object(helper, 'inspect', boom), helper.using_runtime(rootless()): helper.drive_podman_healthchecks([ID])
    def test_the_command_goes_through_the_user_path(self):
        runtime = rootless()
        engine = Engine()
        with patch.object(helper, 'inspect', engine.inspect), patch.object(helper, 'run', return_value=b'') as run, patch.object(runtime, 'session_bus', return_value=None), helper.using_runtime(runtime):
            helper.drive_podman_healthchecks([ID])
        argv = run.call_args[0][0]
        self.assertEqual(argv[:6], ['runuser', '-u', 'app', '--', 'env', '-i']); self.assertEqual(argv[-3:], ['healthcheck', 'run', ID])
        self.assertEqual(run.call_args.kwargs['cwd'], '/')

if __name__ == '__main__': unittest.main()
