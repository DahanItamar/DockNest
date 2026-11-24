"""Image archive names from Podman (docs/podman-rootless.md). Run: python3 remote/test_podman_image_names.py
A DockNest backup saves images by ID, and a restore refuses an archive that names any image. Podman's `save` writes an image that has no
name as localhost/<id>:latest. Only that exact form, with the ID of the image the archive's own manifest holds, is accepted; every
near miss and every real tag is still refused before anything is loaded. Fake archives; no engine runs."""
import hashlib, io, json, pathlib, sys, tarfile, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

CONFIG = b'{"architecture":"amd64","os":"linux","config":{}}'
OTHER_CONFIG = b'{"architecture":"arm64","os":"linux","config":{}}'
ID = hashlib.sha256(CONFIG).hexdigest()        # the ID of an image is the SHA-256 of its config file
OTHER = hashlib.sha256(OTHER_CONFIG).hexdigest()
def archive(folder, tags, config=None, extra=None, name='images.tar', content=CONFIG):
    """A docker-archive with one image: its config file (named config, holding `content`) and a manifest naming `tags`."""
    path = pathlib.Path(folder) / name
    config = config or ID + '.json'
    members = {'manifest.json': json.dumps([{'Config': config, 'RepoTags': tags, 'Layers': []}]).encode(), config: content, **{k: v.encode() for k, v in (extra or {}).items()}}
    with tarfile.open(path, 'w') as tar:
        for member, data in members.items():
            info = tarfile.TarInfo(member); info.size = len(data); tar.addfile(info, io.BytesIO(data))
    return path

class NameTests(unittest.TestCase):
    def load(self, tags, **kw):
        with tempfile.TemporaryDirectory() as folder:
            path = archive(folder, tags, **kw)
            with patch.object(helper, 'engine_load') as load, patch.object(helper, 'restore_test_tags'):
                try: helper.load_images_keeping_tags(path)
                except ValueError as error: return str(error), load.called
                return None, load.called
    def test_podmans_name_made_of_the_id_is_not_a_name(self):
        for tags in (['localhost/%s:latest' % ID], ['%s:latest' % ID], ['localhost/%s' % ID], ['%s' % ID], [], None):
            error, loaded = self.load(tags)
            self.assertIsNone(error, repr(tags)); self.assertTrue(loaded, repr(tags))
    def test_near_misses_are_refused_and_nothing_is_loaded(self):
        near = ['localhost/%s:latest' % ID[:63], 'localhost/%s:latest' % (ID + 'a'), 'docker.io/%s:latest' % ID, 'registry.example.invalid/%s:latest' % ID,
                'localhost/%s:v1' % ID, 'localhost/%s:latest ' % ID, 'localhost/%s:LATEST' % ID, 'LOCALHOST/%s:latest' % ID, 'localhost/%s:latest' % ID.upper(),
                'localhost/library/%s:latest' % ID, 'localhost/%s:latest:latest' % ID, 'nginx:latest', 'localhost/%s:latest' % OTHER, '%s:latest' % OTHER, 'sha256:%s' % ID]
        for tag in near:
            error, loaded = self.load([tag])
            self.assertIsNotNone(error, tag); self.assertIn('names images', error); self.assertFalse(loaded, tag)
    def test_a_name_made_of_another_images_id_is_refused(self):
        error, loaded = self.load(['localhost/%s:latest' % OTHER])
        self.assertIsNotNone(error); self.assertFalse(loaded)
        error, loaded = self.load(['localhost/%s:latest' % ID], config=OTHER + '.json', content=OTHER_CONFIG)
        self.assertIsNotNone(error, 'the ID in the name must be the ID in the manifest'); self.assertFalse(loaded)
        error, loaded = self.load(['localhost/%s:latest' % ID], config='blobs/sha256/' + ID)
        self.assertIsNone(error, 'an OCI-style config path with the same ID is the same image')
        for config in ('../%s.json' % ID, ID[:63] + '.json', 'config.json'):
            self.assertIsNotNone(self.load(['localhost/%s:latest' % ID], config=config)[0], config)
    def test_the_config_file_must_hash_to_the_id_in_the_name(self):
        # A config file only called <id>.json is not enough: its bytes must hash to that ID.
        error, loaded = self.load(['localhost/%s:latest' % ID], content=OTHER_CONFIG)
        self.assertIsNotNone(error, 'the file is named for ID but holds another config'); self.assertFalse(loaded)
        error, loaded = self.load(['localhost/%s:latest' % ID], content=CONFIG + b' ')
        self.assertIsNotNone(error, 'one extra byte changes the hash'); self.assertFalse(loaded)
        error, loaded = self.load(['localhost/%s:latest' % ID], content=b'')
        self.assertIsNotNone(error); self.assertFalse(loaded)
    def test_a_config_hex_that_differs_from_the_tag_hex_is_refused(self):
        # The config file hashes to OTHER and is named for OTHER, while the tag carries ID.
        error, loaded = self.load(['localhost/%s:latest' % ID], config=OTHER + '.json', content=OTHER_CONFIG)
        self.assertIsNotNone(error); self.assertFalse(loaded)
        # The reverse: the tag carries OTHER while the config (named and hashing to ID) belongs to another image.
        error, loaded = self.load(['localhost/%s:latest' % OTHER])
        self.assertIsNotNone(error); self.assertFalse(loaded)
    def test_a_missing_or_oversized_config_member_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'a.tar'
            with tarfile.open(path, 'w') as tar:
                data = json.dumps([{'Config': ID + '.json', 'RepoTags': ['localhost/%s:latest' % ID]}]).encode(); info = tarfile.TarInfo('manifest.json'); info.size = len(data); tar.addfile(info, io.BytesIO(data))
            self.assertEqual(helper.image_archive_id_names(path), set(), 'no config file in the archive')
            big = pathlib.Path(folder) / 'b.tar'
            with tarfile.open(big, 'w') as tar:
                data = json.dumps([{'Config': ID + '.json', 'RepoTags': ['localhost/%s:latest' % ID]}]).encode(); info = tarfile.TarInfo('manifest.json'); info.size = len(data); tar.addfile(info, io.BytesIO(data))
                info = tarfile.TarInfo(ID + '.json'); info.size = helper.IMAGE_CONFIG_LIMIT + 1; tar.addfile(info, io.BytesIO(b'x' * info.size))
            self.assertEqual(helper.image_archive_id_names(big), set(), 'a config over the size cap is never read')
            link = pathlib.Path(folder) / 'c.tar'
            with tarfile.open(link, 'w') as tar:
                data = json.dumps([{'Config': ID + '.json', 'RepoTags': ['localhost/%s:latest' % ID]}]).encode(); info = tarfile.TarInfo('manifest.json'); info.size = len(data); tar.addfile(info, io.BytesIO(data))
                info = tarfile.TarInfo(ID + '.json'); info.type = tarfile.SYMTYPE; info.linkname = '/etc/hostname'; tar.addfile(info)
            self.assertEqual(helper.image_archive_id_names(link), set(), 'a link in place of the config file is not a file')
    def test_one_real_tag_next_to_an_id_name_still_refuses_the_archive(self):
        error, loaded = self.load(['localhost/%s:latest' % ID, 'nginx:latest'])
        self.assertIn('nginx:latest', error); self.assertNotIn(ID, error); self.assertFalse(loaded)
    def test_other_records_that_name_images_are_still_refused(self):
        repositories = json.dumps({'nginx': {'latest': ID}})
        error, loaded = self.load([], extra={'repositories': repositories})
        self.assertIn('nginx:latest', error); self.assertFalse(loaded)
        index = json.dumps({'manifests': [{'annotations': {'io.containerd.image.name': 'docker.io/library/nginx:latest'}}]})
        error, loaded = self.load([], extra={'index.json': index})
        self.assertIn('nginx', error); self.assertFalse(loaded)
    def test_the_helper_finds_exactly_the_allowed_names(self):
        with tempfile.TemporaryDirectory() as folder:
            path = archive(folder, ['localhost/%s:latest' % ID, 'nginx:latest', 'localhost/%s:latest' % OTHER])
            self.assertEqual(helper.image_archive_id_names(path), {'localhost/%s:latest' % ID})
            self.assertEqual(helper.image_archive_id_names(archive(folder, [], name='b.tar')), set())
            bad = pathlib.Path(folder) / 'c.tar'
            with tarfile.open(bad, 'w') as tar:
                data = b'not json'; info = tarfile.TarInfo('manifest.json'); info.size = len(data); tar.addfile(info, io.BytesIO(data))
            with self.assertRaises(ValueError): helper.image_archive_id_names(bad)
            empty = pathlib.Path(folder) / 'd.tar'
            with tarfile.open(empty, 'w'): pass
            self.assertEqual(helper.image_archive_id_names(empty), set())
    def test_an_unreadable_archive_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'broken.tar'; path.write_bytes(b'not a tar')
            with patch.object(helper, 'engine_load') as load, self.assertRaisesRegex(ValueError, 'cannot be read'): helper.load_images_keeping_tags(path)
            self.assertFalse(load.called)

class FormatTests(unittest.TestCase):
    def test_podman_saves_a_docker_archive_and_docker_is_unchanged(self):
        self.assertEqual(helper.Runtime('podman').save_arguments(), ['save', '--format', 'docker-archive'])
        self.assertEqual(helper.Runtime('podman', True, 'app', 1001, '/home/app').save_arguments(), ['save', '--format', 'docker-archive'])
        self.assertEqual(helper.Runtime('docker', True, 'app', 1001, '/home/app').save_arguments(), ['save'])
        self.assertEqual(helper.Runtime().save_arguments(), ['save'])
        self.assertEqual(helper.Runtime().argv(*helper.Runtime().save_arguments(), 'sha256:a'), ['docker', 'save', 'sha256:a'])
    def test_the_streamed_backup_uses_the_same_arguments(self):
        text = (pathlib.Path(__file__).parent / 'helper' / 'backup.py').read_text()
        self.assertIn('save_arguments()', text); self.assertNotIn(".argv('save'", text)

if __name__ == '__main__': unittest.main()
