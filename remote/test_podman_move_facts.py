"""Move facts of a Podman app (docs/podman-rootless.md). Run: python3 remote/test_podman_move_facts.py
The move preview reads the app's facts through the app's own engine. The CPU architecture must come from that engine's own field:
Podman has no `{{.Architecture}}` (its `info` exits 125 for it), only `{{.Host.Arch}}`. Rootful Docker keeps its exact call. Fake engines."""
import pathlib, sys, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

RECORD = {'Id': 'a' * 64, 'Name': '/live-app', 'Config': {'Labels': {}, 'Image': 'registry.example.invalid/app:1'}, 'Mounts': [], 'NetworkSettings': {'Networks': {}, 'Ports': {}},
          'HostConfig': {'PortBindings': {}}, 'State': {'Running': True}}
CONFIG = {'containers': ['live-app'], 'kind': 'docker'}

class Engine:
    def __init__(self, answers): self.answers, self.calls = answers, []
    def docker(self, *args):
        self.calls.append(args)
        if args[:2] == ('info', '--format'):
            answer = self.answers.get(args[2])
            if answer is None: raise helper.subprocess.CalledProcessError(125, ['podman'])  # the field does not exist
            return answer.encode()
        return b'[]'

class MoveFactsTests(unittest.TestCase):
    def facts(self, engine, runtime=None):
        with patch.object(helper, 'inspect', lambda ids: [dict(RECORD)]), patch.object(helper, 'docker', engine.docker), patch.object(helper, 'port_bindings', lambda c: []), \
             patch.object(helper, 'hand_placed', lambda *a: []):
            if runtime is None: return helper.source_site_facts(CONFIG, [])
            with helper.using_runtime(runtime): return helper.source_site_facts(CONFIG, [])
    def test_podman_reads_its_own_architecture_field(self):
        for runtime in (helper.Runtime('podman'), helper.Runtime('podman', True, 'app', 1001, '/home/app')):
            engine = Engine({'{{.Host.Arch}}': 'amd64\n'})
            self.assertEqual(self.facts(engine, runtime)['architecture'], 'x86_64')
            self.assertIn(('info', '--format', '{{.Host.Arch}}'), engine.calls); self.assertNotIn(('info', '--format', '{{.Architecture}}'), engine.calls)
        self.assertEqual(self.facts(Engine({'{{.Host.Arch}}': 'arm64\n'}), helper.Runtime('podman'))['architecture'], 'aarch64')
    def test_rootful_docker_keeps_its_exact_call(self):
        engine = Engine({'{{.Architecture}}': 'x86_64\n'})
        self.assertEqual(self.facts(engine)['architecture'], 'x86_64')
        self.assertIn(('info', '--format', '{{.Architecture}}'), engine.calls); self.assertNotIn(('info', '--format', '{{.Host.Arch}}'), engine.calls)
    def test_rootless_docker_asks_docker_for_its_field(self):
        engine = Engine({'{{.Architecture}}': 'x86_64\n'})
        self.assertEqual(self.facts(engine, helper.Runtime('docker', True, 'app', 1001, '/home/app'))['architecture'], 'x86_64')

    def test_rootless_podman_modes_are_not_networks_to_inspect(self):
        # pasta and slirp4netns appear as network names in the record of a rootless Podman container; they are not networks.
        for mode in ('pasta', 'slirp4netns'):
            record = {**RECORD, 'NetworkSettings': {'Networks': {mode: {}}, 'Ports': {}}}
            engine = Engine({'{{.Host.Arch}}': 'amd64\n'})
            def inspect_network(*args, engine=engine):
                if args[0] == 'network': raise helper.subprocess.CalledProcessError(125, ['podman'], stderr=b'no such network')
                return engine.docker(*args)
            with patch.object(helper, 'inspect', lambda ids, record=record: [dict(record)]), patch.object(helper, 'docker', inspect_network), patch.object(helper, 'port_bindings', lambda c: []),                  patch.object(helper, 'hand_placed', lambda *a: []), helper.using_runtime(helper.Runtime('podman', True, 'app', 1001, '/home/app')):
                facts = helper.source_site_facts(CONFIG, [])
            self.assertEqual(facts['networks'], [], mode)
    def test_a_real_user_network_is_still_inspected(self):
        record = {**RECORD, 'NetworkSettings': {'Networks': {'shop_default': {}}, 'Ports': {}}}
        asked = []
        def docker(*args):
            asked.append(args)
            if args[:2] == ('network', 'inspect'): return b'[{"Driver": "bridge", "Internal": false, "EnableIPv6": false, "Labels": {}}]'
            return b'x86_64\n' if args[:2] == ('info', '--format') else b'[]'
        with patch.object(helper, 'inspect', lambda ids: [dict(record)]), patch.object(helper, 'docker', docker), patch.object(helper, 'port_bindings', lambda c: []), patch.object(helper, 'hand_placed', lambda *a: []):
            facts = helper.source_site_facts(CONFIG, [])
        self.assertIn(('network', 'inspect', 'shop_default'), asked); self.assertEqual([n['name'] for n in facts['networks']], ['shop_default']); self.assertEqual(facts['networks'][0]['driver'], 'bridge')

if __name__ == '__main__': unittest.main()
