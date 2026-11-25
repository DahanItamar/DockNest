"""A container record whose Labels (or Config) is null (docs/podman-rootless.md). Run: python3 remote/test_podman_null_labels.py
Podman reports `"Labels": null` for a container from an image without labels, where Docker reports {}. The key exists with a null value,
so a `.get('Labels', {})` default is not used and the next `.get` crashed the backup check with a Python AttributeError instead of the
plain answer. Fake records only."""
import pathlib, sys, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

def record(labels, config=True):
    return {'Id': 'a' * 64, 'Name': '/pg-app', 'State': {'Running': True}, 'HostConfig': {}, 'Mounts': [], 'NetworkSettings': {'Networks': {}},
            **({'Config': {'Image': 'registry.example.invalid/pg:1', 'Labels': labels}} if config else {'Config': None})}
CFG = {'containers': ['pg-app'], 'exclusiveSourcesConfirmed': True, 'cleanShutdownConfirmed': True, 'shutdownProfile': 'generic'}

class PreflightTests(unittest.TestCase):
    def preflight(self, rec, cfg=None):
        with patch.object(helper, 'inspect', lambda ids: [rec]), patch.object(helper, 'docker', lambda *a: b''), patch.object(helper.os, 'geteuid', lambda: 0, create=True), \
             patch.object(helper, 'refuse_protected_sources', lambda cfg: None):
            return helper.preflight(cfg or CFG)
    def test_null_labels_are_no_labels(self):
        for labels in (None, {}):
            self.assertEqual(self.preflight(record(labels))[0]['Id'], 'a' * 64, repr(labels))
    def test_a_compose_label_still_asks_for_the_project_files(self):
        with self.assertRaisesRegex(ValueError, 'Compose project files'): self.preflight(record({'com.docker.compose.project': 'shop'}))

if __name__ == '__main__': unittest.main()
