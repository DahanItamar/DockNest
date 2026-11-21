"""Stack managers (docs/site-setup.md, since 3.0.0): Portainer and Dockge stacks found through the manager's mounts.
Run: python3 remote/test_stack_managers.py
Proves that a stack's Compose folder as the manager container names it maps to the host, that the app is marked with
its manager, that label paths escaping the stacks folder map to nothing, that no environment value leaves the helper,
and that browsing a Portainer stack's folder stays inside it."""
import json, pathlib, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

FIXTURE = pathlib.Path(__file__).parent / 'fixtures' / 'stack-managers-inspect.json'

def fixture(root):
    """The fixture's `docker inspect` records with {root} replaced by a temporary host folder."""
    def swap(value):
        if isinstance(value, str): return value.replace('{root}', str(root))
        if isinstance(value, list): return [swap(item) for item in value]
        if isinstance(value, dict): return {key: swap(item) for key, item in value.items()}
        return value
    return swap(json.loads(FIXTURE.read_text()))

class StackManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = pathlib.Path(self.temp.name)
        self.portainer = self.root / 'volumes' / 'portainer_data' / '_data' / 'compose' / '12'
        self.dockge = self.root / 'srv' / 'stacks' / 'notes'
        for folder, name in ((self.portainer, 'docker-compose.yml'), (self.dockge, 'compose.yaml')):
            folder.mkdir(parents=True); (folder / name).write_text('services: {}\n'); (folder / '.env').write_text('TOKEN=do-not-print')
        self.containers = fixture(self.root)
    def tearDown(self): self.temp.cleanup()
    def by_name(self, name): return next(c for c in self.containers if c['Name'] == '/' + name)

    def test_managers_are_found_by_image_with_their_stacks_folder(self):
        managers = helper.stack_managers(self.containers)
        self.assertEqual([(m['kind'], m['stacks']) for m in managers], [('portainer', '/data/compose'), ('dockge', '/opt/stacks')])
        self.assertNotIn('do-not-print', json.dumps(managers), 'only the stacks setting is read from the environment')
        for image, kind in [('portainer/portainer-ee:latest', 'portainer'), ('docker.io/portainer/portainer-ce@sha256:' + 'a' * 64, 'portainer'),
                            ('louislam/dockge', 'dockge'), ('example/portainer-ce:1', None), ('louislam/dockge-fork:1', None), ('', None)]:
            self.assertEqual(helper.stack_manager_kind(image), kind, image)
        custom = [{'Config': {'Image': 'portainer/portainer-ce:2', 'Cmd': ['--data', '/srv/portainer']}, 'Mounts': []},
                  {'Config': {'Image': 'louislam/dockge:1', 'Env': ['DOCKGE_STACKS_DIR=/srv/../etc']}, 'Mounts': []}]
        self.assertEqual([(m['kind'], m['stacks']) for m in helper.stack_managers(custom)], [('portainer', '/srv/portainer/compose')])

    def test_portainer_stack_maps_to_the_data_volume_on_the_host(self):
        managers = helper.stack_managers(self.containers)
        found = helper.configuration_paths(self.by_name('wiki-web-1'), managers)
        self.assertEqual(found['manager'], 'portainer')
        self.assertEqual(found['directory'], str(self.portainer))
        self.assertEqual(found['composeFiles'], [str(self.portainer / 'docker-compose.yml')])
        self.assertEqual(found['configFiles'], [str(self.portainer / '.env')])
        self.assertNotIn('do-not-print', json.dumps(found))

    def test_dockge_stack_maps_through_its_stacks_mount(self):
        found = helper.configuration_paths(self.by_name('notes-app-1'), helper.stack_managers(self.containers))
        self.assertEqual((found['manager'], found['directory']), ('dockge', str(self.dockge)))
        self.assertEqual(found['composeFiles'], [str(self.dockge / 'compose.yaml')])

    def test_without_a_manager_the_labels_are_read_as_before(self):
        for name in ('wiki-web-1', 'notes-app-1'):
            found = helper.configuration_paths(self.by_name(name))
            self.assertEqual((found['composeFiles'], found['directory']), ([], ''), name)
            self.assertNotIn('manager', found)
        # The manager's own Compose project is not one of its stacks.
        self.assertNotIn('manager', helper.configuration_paths(self.by_name('dockge'), helper.stack_managers(self.containers)))

    def test_label_paths_that_leave_the_stacks_folder_map_to_nothing(self):
        managers = helper.stack_managers(self.containers)
        for value in ['/opt/stacks/../../etc', '/opt/stacks', 'opt/stacks/notes', '/opt/stacksx/notes', '', None]:
            self.assertIsNone(helper.managed_path(value, managers), value)
        found = helper.configuration_paths(self.by_name('escape-app-1'), managers)
        self.assertEqual((found['composeFiles'], found['directory']), ([], ''))
        self.assertNotIn('manager', found)

    def test_browsing_a_portainer_stack_stays_inside_its_host_folder(self):
        wiki, managers = self.by_name('wiki-web-1'), [self.by_name('portainer'), self.by_name('dockge')]
        with patch('helper.inspect', return_value=[wiki]), patch('helper.manager_containers', return_value=managers):
            listing = helper.list_project_files(['wiki-web-1'])
            self.assertEqual(listing['directory'], str(self.portainer))
            self.assertEqual({entry['name'] for entry in listing['entries']}, {'docker-compose.yml', '.env'})
            self.assertNotIn('do-not-print', json.dumps(listing))
            with self.assertRaises(ValueError): helper.list_project_files(['wiki-web-1'], str(self.portainer.parent))

    def test_manager_containers_inspects_only_manager_images(self):
        listing = ('a' * 64 + ' portainer/portainer-ce:2\n' + 'b' * 64 + ' example/wiki:1\n' + 'c' * 64 + ' louislam/dockge:1\n').encode()
        with patch('helper.docker', return_value=listing), patch('helper.inspect', side_effect=lambda ids: [{'Id': i} for i in ids]) as inspected:
            self.assertEqual([c['Id'] for c in helper.manager_containers()], ['a' * 64, 'c' * 64])
        with patch('helper.docker', return_value=b''), patch('helper.inspect') as inspected:
            self.assertEqual(helper.manager_containers(), []); inspected.assert_not_called()
        with patch('helper.docker', side_effect=helper.subprocess.CalledProcessError(1, ['docker'])):
            self.assertEqual(helper.manager_containers(), [], 'a listing that fails reads as no managers')

if __name__ == '__main__':
    unittest.main()
