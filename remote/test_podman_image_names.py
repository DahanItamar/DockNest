"""Image archive names from Podman (docs/podman-rootless.md). Run: python3 remote/test_podman_image_names.py
A DockNest backup saves images by ID, and a restore refuses an archive that names any image. Podman's `save` writes an image that has no
name as localhost/<id>:latest. Only that exact form, with the ID of the image the archive's own manifest holds, is accepted; every
near miss and every real tag is still refused before anything is loaded. Fake archives; no engine runs."""
import io, json, pathlib, sys, tarfile, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it)
import helper

ID = 'ab12' * 16
OTHER = 'cd34' * 16
def archive(folder, tags, config=None, extra=None, name='images.tar'):
    path = pathlib.Path(folder) / name
    members = {'manifest.json': json.dumps([{'Config': config or ID + '.json', 'RepoTags': tags, 'Layers': []}]), **(extra or {})}
    with tarfile.open(path, 'w') as tar:
        for member, text in members.items():
            data = text.encode(); info = tarfile.TarInfo(member); info.size = len(data); tar.addfile(info, io.BytesIO(data))
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
        error, loaded = self.load(['localhost/%s:latest' % ID], config=OTHER + '.json')
        self.assertIsNotNone(error, 'the ID in the name must be the ID in the manifest'); self.assertFalse(loaded)
        error, loaded = self.load(['localhost/%s:latest' % ID], config='blobs/sha256/' + ID)
        self.assertIsNone(error, 'an OCI-style config path with the same ID is the same image')
        for config in ('../%s.json' % ID, ID[:63] + '.json', 'config.json', None):
            if config is None: continue
            self.assertIsNotNone(self.load(['localhost/%s:latest' % ID], config=config)[0], config)
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

if __name__ == '__main__': unittest.main()
