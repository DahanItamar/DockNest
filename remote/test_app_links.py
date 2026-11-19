"""Linked apps facts (docs/linked-apps.md): what discovery reads from `docker inspect` to show how apps depend on each
other, and what never leaves the server. Run: python3 remote/test_app_links.py"""
import io, json, pathlib, unittest
from unittest.mock import patch
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper
from helper import container_link_facts, link_report, depends_on_services, image_looks_like_database

IMAGES = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'database-images.json').read_text())


def container(**overrides):
    base = {'Id': 'c' * 64, 'Name': '/demo-shop-web-1', 'State': {'Status': 'running', 'Running': True},
            'Config': {'Image': 'demo/shop:1.4', 'Env': ['DB_PASSWORD=hunter2-secret'], 'Cmd': ['serve', '--token=cmd-secret'],
                       'Labels': {'com.docker.compose.project': 'demo-shop', 'com.docker.compose.service': 'web',
                                  'com.docker.compose.depends_on': 'db:service_healthy:false,cache:service_started:true',
                                  'com.docker.compose.project.working_dir': '/srv/demo-shop', 'secret.label': 'label-secret'}},
            'HostConfig': {'Links': ['/legacy-db:/demo-shop-web-1/db'], 'Tmpfs': {}},
            'NetworkSettings': {'Ports': {}, 'Networks': {
                'bridge': {'Aliases': None}, 'demo-shop_default': {'Aliases': ['web', 'demo-shop-web-1', 'web']},
                'shared-data': {'Aliases': None}, 'host': {}, 'none': {}}},
            'Mounts': [{'Type': 'volume', 'Name': 'shop-uploads', 'Source': '/var/lib/docker/volumes/shop-uploads/_data', 'Destination': '/uploads'},
                       {'Type': 'bind', 'Source': '/srv/media', 'Destination': '/media'},
                       {'Type': 'tmpfs', 'Destination': '/tmp'}]}
    base.update(overrides)
    return base


class LinkFactTests(unittest.TestCase):
    def test_facts_hold_only_what_links_need(self):
        facts = container_link_facts(container())
        self.assertEqual(facts, {'format': 1, 'project': 'demo-shop', 'service': 'web',
                                 'networks': [{'name': 'demo-shop_default', 'aliases': ['demo-shop-web-1', 'web']}, {'name': 'shared-data', 'aliases': []}],
                                 'volumes': ['shop-uploads'], 'binds': ['/srv/media'], 'links': ['legacy-db'], 'dependsOn': ['cache', 'db']})
        text = json.dumps(facts)
        for secret in ['hunter2', 'DB_PASSWORD', 'cmd-secret', 'label-secret', '/srv/demo-shop', '/var/lib/docker/volumes']: self.assertNotIn(secret, text)

    def test_default_networks_are_left_out(self):
        facts = container_link_facts(container(NetworkSettings={'Networks': {'bridge': {}, 'host': {}, 'none': {}}}))
        self.assertEqual(facts['networks'], [])

    def test_plain_container_without_compose_labels_or_mounts(self):
        facts = container_link_facts({'Id': 'd' * 64, 'Name': '/solo', 'Config': {'Labels': None}, 'HostConfig': {'Links': None}, 'NetworkSettings': {'Networks': None}, 'Mounts': None})
        self.assertEqual(facts, {'format': 1, 'project': None, 'service': None, 'networks': [], 'volumes': [], 'binds': [], 'links': [], 'dependsOn': []})

    def test_depends_on_label_forms(self):
        self.assertEqual(depends_on_services('db:service_started:false'), ['db'])
        self.assertEqual(depends_on_services(' db , cache:service_healthy:true,db:service_started:false'), ['cache', 'db'])
        self.assertEqual(depends_on_services(''), []); self.assertEqual(depends_on_services(None), []); self.assertEqual(depends_on_services(',:x'), [])

    def test_unreadable_container_gives_none_and_never_fails_the_report(self):
        self.assertEqual(link_report([container(), {'Config': 'broken'}]), [container_link_facts(container()), None])
        self.assertEqual(link_report([]), [])

    def test_discover_carries_links_per_container(self):
        out = io.StringIO()
        with patch('helper.docker', return_value=b'cccc\n'), patch('helper.inspect', return_value=[container()]), \
             patch('helper.nginx_sites', return_value=[]), patch('helper.certbot_certificates', return_value=[]), \
             patch('helper.hardening_report', return_value=None), patch('helper.EVENT_STREAM', out):
            helper.main({'operation': 'discover'})
        result = json.loads(out.getvalue().splitlines()[-1])['result']
        self.assertEqual(result['containers'][0]['links'], container_link_facts(container()))

    def test_database_image_names_match_the_shared_fixture(self):
        for image in IMAGES['databases']: self.assertTrue(image_looks_like_database(image), image)
        for image in IMAGES['notDatabases']: self.assertFalse(image_looks_like_database(image), image)


if __name__ == '__main__': unittest.main()
