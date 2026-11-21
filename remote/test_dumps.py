import io, json, os, pathlib, subprocess, tarfile, tempfile, unittest
from unittest.mock import patch
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper
from helper import (ENGINES, MYSQL_CLIENT_SCRIPT, POSTGRES_DATA_ENTRIES, artifact_inventory, dump_artifacts, dump_candidates,
                    dump_failure, read_dump, shutdown_evidence, take_dump, verify_artifacts)


def container(cid, name, engine_mount, entrypoint=('docker-entrypoint.sh',), image='postgres:16'):
    return {'Id': cid, 'Name': '/' + name, 'State': {'Running': True},
            'Config': {'Image': image, 'Entrypoint': list(entrypoint), 'Env': []},
            'Mounts': [{'Type': 'volume', 'Source': engine_mount, 'Destination': '/var/lib/postgresql/data', 'RW': True}]}


def plan(*services):
    return {'services': list(services)}


def database(cid, engine='postgres', data='/var/lib/postgresql/data'):
    return {'container': cid, 'engine': engine, 'version': '16.4', 'role': 'database', 'dataDirectory': data, 'user': None, 'database': 'shop'}


class Candidates(unittest.TestCase):
    """Which databases take an online dump: opt-in, fail closed, a reason for every other one."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.addCleanup(self.folder.cleanup)
        self.data = pathlib.Path(self.folder.name).resolve() / 'pgdata'; self.data.mkdir()
        for entry in ['PG_VERSION', 'postgresql.conf', 'pg_hba.conf']: (self.data / entry).write_text('x')
        (self.data / 'base').mkdir()

    def blocker(self, slots='0', databases='postgres\nshop', tools=True):
        def query(cid, service, sql):
            if 'pg_replication_slots' in sql: return slots
            if 'pg_database' in sql: return databases
            raise AssertionError(sql)
        def run(args, **_):
            if not tools: raise subprocess.CalledProcessError(1, args)
            return b'/usr/bin/pg_dump\n'
        return patch('helper.database_query', side_effect=query), patch('helper.run', side_effect=run)

    def candidates(self, cs, services, request=None, **blocker):
        query, run = self.blocker(**blocker)
        with query, run:
            return dump_candidates({'onlineDumps': True} if request is None else request, {}, plan(*services), cs, [c['Id'] for c in cs])

    def test_off_unless_requested(self):
        cs = [container('db', 'shop-db', str(self.data))]
        self.assertEqual(self.candidates(cs, [database('db')], request={}), ({}, []))

    def test_postgres_with_only_its_own_files_is_chosen(self):
        cs = [container('db', 'shop-db', str(self.data))]
        chosen, fallbacks = self.candidates(cs, [database('db')])
        self.assertEqual(fallbacks, []); self.assertEqual(chosen, {'db': ('/var/lib/postgresql/data', self.data)})

    def test_every_other_case_keeps_the_stopped_copy_with_a_reason(self):
        cases = [
            ({'entrypoint': ('/opt/bitnami/scripts/postgresql/entrypoint.sh',)}, {}, 'official entrypoint'),
            ({}, {'slots': '1'}, 'replication slots'),
            ({}, {'databases': 'shop\n-x'}, 'cannot be passed to pg_dump'),
            ({}, {'tools': False}, 'has no pg_dump'),
        ]
        for options, blocker, reason in cases:
            with self.subTest(reason=reason):
                cs = [container('db', 'shop-db', str(self.data), **options)]
                chosen, fallbacks = self.candidates(cs, [database('db')], **blocker)
                self.assertEqual(chosen, {}); self.assertEqual(len(fallbacks), 1)
                self.assertEqual(fallbacks[0]['container'], 'shop-db'); self.assertIn(reason, fallbacks[0]['reason'])

    def test_unknown_files_in_the_data_folder_are_named(self):
        (self.data / 'server.crt').write_text('certificate')
        _, fallbacks = self.candidates([container('db', 'shop-db', str(self.data))], [database('db')])
        self.assertIn('server.crt', fallbacks[0]['reason'])
        self.assertNotIn('server.crt', POSTGRES_DATA_ENTRIES)

    def test_engines_without_a_dump_and_shared_data_folders_fall_back(self):
        redis = container('cache', 'shop-cache', str(self.data), image='redis:7.4')
        mongo = container('docs', 'shop-docs', str(self.data), image='mongo:7.0')
        _, fallbacks = self.candidates([redis, mongo], [database('cache', 'redis', '/data'), database('docs', 'mongo', '/data/db')])
        self.assertEqual([item['reason'] for item in fallbacks], ['Redis has no online dump yet', 'MongoDB has no online dump yet'])
        shared = [container('db', 'shop-db', str(self.data)), {**container('side', 'shop-side', str(self.data)), 'Mounts': [{'Type': 'volume', 'Source': str(self.data), 'Destination': '/backup', 'RW': False}]}]
        _, fallbacks = self.candidates(shared, [database('db')])
        self.assertIn('another container in this app mounts its data folder', fallbacks[0]['reason'])

    def test_stopped_databases_and_writers_are_not_considered(self):
        cs = [container('db', 'shop-db', str(self.data)), container('app', 'shop-app', str(self.data))]
        with self.blocker()[0], self.blocker()[1]:
            chosen, fallbacks = dump_candidates({'onlineDumps': True}, {}, plan(database('db'), {**database('app'), 'engine': 'generic', 'role': 'writer'}), cs, [])
        self.assertEqual((chosen, fallbacks), ({}, []))

    def test_mysql_refuses_tables_that_are_not_innodb(self):
        engine = ENGINES['mariadb']
        with patch('helper.run', return_value=b'/usr/bin/mariadb-dump\n'), patch('helper.database_query', return_value='2'):
            self.assertIn('not InnoDB (2)', engine.dump_blocker({'container': 'db'}, {'Id': 'db'}, self.data))
        with patch('helper.run', return_value=b''), patch('helper.database_query', return_value='0'):
            self.assertIsNone(engine.dump_blocker({'container': 'db'}, {'Id': 'db'}, self.data))
        self.assertEqual((ENGINES['mariadb'].dumper, ENGINES['mysql'].dumper), ('mariadb-dump', 'mysqldump'))
        self.assertIn('--set-gtid-purged=OFF', ENGINES['mysql'].dump_options); self.assertNotIn('--set-gtid-purged=OFF', ENGINES['mariadb'].dump_options)
        self.assertIn('--single-transaction', ENGINES['mysql'].dump_options)


class Dump(unittest.TestCase):
    """The dump artifact: only after a whole, checked dump; nothing left behind on failure; settings files carried."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.addCleanup(self.folder.cleanup)
        self.root = pathlib.Path(self.folder.name); self.data = self.root / 'data'; self.data.mkdir()
        (self.data / 'pg_hba.conf').write_text('local all all trust\n'); (self.data / 'PG_VERSION').write_text('16\n')

    def fake(self, fail=False):
        def dump(cid, service, directory, timeout):
            (directory / 'globals.sql').write_text('CREATE ROLE app;\n'); (directory / 'database-0.pgdump').write_bytes(b'PGDMP')
            if fail: raise ValueError('pg_dump failed')
            return {'format': 'pg_dump custom', 'databases': ['shop']}
        return patch.object(ENGINES['postgres'], 'dump', side_effect=dump)

    def test_artifact_holds_the_dump_listing_and_settings(self):
        with self.fake(), patch('helper.run', return_value=b'4096\t/data\n'):
            record = take_dump(database('db'), {'Id': 'db'}, '/var/lib/postgresql/data', self.data, self.root, 0, 60)
        self.assertEqual((record['artifact'], record['method'], record['databases'], record['config'], record['dataBytes']), ('database-0.tar', 'online logical dump', ['shop'], ['pg_hba.conf'], 4096))
        with tarfile.open(self.root / 'database-0.tar') as archive:
            self.assertEqual(sorted(archive.getnames()), ['config/pg_hba.conf', 'database-0.pgdump', 'globals.sql', 'listing.json'])
            self.assertTrue(all(member.isfile() and member.mode == 0o600 for member in archive.getmembers()))
        self.assertFalse((self.root / 'database-0').exists(), 'the work folder is removed')
        self.assertEqual(artifact_inventory(self.root)['database-0.tar']['sha256'], record['sha256'])
        listing = read_dump(self.root / 'database-0.tar', self.root / 'unpacked')
        self.assertEqual(listing['dataDirectory'], '/var/lib/postgresql/data')
        self.assertEqual((self.root / 'unpacked' / 'config' / 'pg_hba.conf').read_text(), 'local all all trust\n')

    def test_a_failed_dump_leaves_nothing(self):
        with self.fake(fail=True), self.assertRaisesRegex(ValueError, 'pg_dump failed'):
            take_dump(database('db'), {'Id': 'db'}, '/var/lib/postgresql/data', self.data, self.root, 0, 60)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['data'])

    @unittest.skipUnless(hasattr(os, 'symlink') and os.name == 'posix', 'needs POSIX symlinks')
    def test_a_linked_settings_file_is_refused(self):
        (self.data / 'pg_hba.conf').unlink(); os.symlink('/etc/passwd', self.data / 'pg_hba.conf')
        with self.fake(), patch('helper.run', return_value=b'1\t/\n'), self.assertRaisesRegex(ValueError, 'not a regular file'):
            take_dump(database('db'), {'Id': 'db'}, '/var/lib/postgresql/data', self.data, self.root, 0, 60)
        self.assertFalse((self.root / 'database-0.tar').exists())

    def test_reasons_never_carry_tool_output(self):
        self.assertEqual(dump_failure(subprocess.CalledProcessError(1, ['pg_dump'], output=b'secret rows')), 'the dump command failed')
        self.assertEqual(dump_failure(subprocess.TimeoutExpired(['pg_dump'], 5)), 'the dump did not finish in time')

    def test_mysql_dump_must_end_with_the_completion_line(self):
        engine = ENGINES['mysql']
        def writes(text):
            def command(args, timeout, stdin=None, stdout=None):
                pathlib.Path(stdout).write_text(text); return 0, ''
            return command
        with patch('helper.dump_command', side_effect=writes('CREATE TABLE t (id int);\n-- Dump completed on 2026-11-21 10:00:00\n')):
            self.assertEqual(engine.dump('db', {}, self.root, 60)['format'], engine.dump_format)
        (self.root / 'all-databases.sql').unlink()
        with patch('helper.dump_command', side_effect=writes('CREATE TABLE t (id int);\nINSERT INTO t VALUES')), self.assertRaisesRegex(ValueError, 'did not finish'):
            engine.dump('db', {}, self.root, 60)

    def test_mysql_credentials_stay_inside_the_container(self):
        argv = ENGINES['mysql'].tool('db', {'user': None}, 'mysqldump')
        self.assertEqual(argv[:6], ['docker', 'exec', 'db', 'sh', '-c', MYSQL_CLIENT_SCRIPT])
        self.assertIn('MYSQL_PWD="${MYSQL_ROOT_PASSWORD', MYSQL_CLIENT_SCRIPT)
        self.assertNotIn('--password', ' '.join(argv))

    def test_postgres_load_accepts_only_existing_role_errors(self):
        engine = ENGINES['postgres']; directory = self.root
        (directory / 'globals.sql').write_text(''); (directory / 'database-0.pgdump').write_bytes(b'')
        calls = []
        def command(errors):
            def run(args, timeout, stdin=None, stdout=None):
                calls.append(args)
                return (0, errors) if 'psql' in args else (0, '')
            return run
        with patch('helper.dump_command', side_effect=command('psql:<stdin>:6: ERROR:  role "postgres" already exists\n')), patch('helper.database_query', return_value='postgres\nshop'):
            engine.load_dump('db', {'user': None}, directory, {'databases': ['shop', 'reports']}, 60)
        restores = [args for args in calls if 'pg_restore' in args]
        self.assertIn('--clean', restores[0]); self.assertIn('--dbname=shop', restores[0])
        self.assertIn('--create', restores[1]); self.assertIn('--dbname=postgres', restores[1])
        with patch('helper.dump_command', side_effect=command('psql:<stdin>:9: ERROR:  permission denied\n')), patch('helper.database_query', return_value='postgres'):
            with self.assertRaisesRegex(ValueError, 'roles could not be loaded'):engine.load_dump('db', {'user': None}, directory, {'databases': []}, 60)


class Package(unittest.TestCase):
    """A package with a dump verifies only with its dump; restores refuse anything unexpected."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.addCleanup(self.folder.cleanup)
        self.root = pathlib.Path(self.folder.name)

    def manifest(self, artifact='database-0.tar'):
        for name in ['images.tar', 'mount-0-0.tar']: (self.root / name).write_bytes(b'x')
        with tarfile.open(self.root / 'database-0.tar', 'w') as archive:
            data = json.dumps({'config': [], 'databases': [], 'dataDirectory': '/var/lib/mysql'}).encode()
            info = tarfile.TarInfo('listing.json'); info.size = len(data); archive.addfile(info, io.BytesIO(data))
        return {'containers': [{'Mounts': [{}]}], 'artifacts': artifact_inventory(self.root), 'backupPlan': {'services': [{'container': 'db', 'dump': {'artifact': artifact}}]}}

    def test_verification_needs_the_named_dump(self):
        manifest = self.manifest()
        self.assertTrue(verify_artifacts(self.root, manifest))
        self.assertEqual(dump_artifacts(manifest), ['database-0.tar'])
        without = {**manifest, 'backupPlan': {'services': [{'container': 'db'}]}}
        with self.assertRaisesRegex(ValueError, 'does not cover'):verify_artifacts(self.root, without)
        for bad in ['../database-0.tar', 'database-0.tar.gz', 'images.tar']:
            with self.subTest(name=bad), self.assertRaisesRegex(ValueError, 'invalid database dump'):dump_artifacts(self.manifest(bad))

    def test_read_dump_refuses_links_and_unknown_names(self):
        for member in [tarfile.TarInfo('../escape.sql'), tarfile.TarInfo('notes.txt')]:
            with self.subTest(name=member.name):
                path = self.root / 'bad.tar'
                with tarfile.open(path, 'w') as archive: archive.addfile(member, io.BytesIO(b''))
                with self.assertRaisesRegex(ValueError, 'unexpected entry'):read_dump(path, self.root / ('out-' + str(len(list(self.root.iterdir())))))
        link = tarfile.TarInfo('globals.sql'); link.type = tarfile.SYMTYPE; link.linkname = '/etc/passwd'
        with tarfile.open(self.root / 'link.tar', 'w') as archive: archive.addfile(link)
        with self.assertRaisesRegex(ValueError, 'unexpected entry'):read_dump(self.root / 'link.tar', self.root / 'out-link')

    def test_dump_evidence_replaces_the_stop_proof(self):
        service = {**database('db'), 'dump': {'method': 'online logical dump', 'format': 'pg_dump custom', 'databases': ['shop'], 'bytes': 10, 'sha256': '0' * 64, 'artifact': 'database-0.tar'}}
        with patch('helper.inspect', side_effect=AssertionError('a dumped database is never inspected for a stop')):
            evidence = shutdown_evidence([service], [], 0)
        self.assertEqual(evidence, [{'container': 'db', 'engine': 'postgres', 'version': '16.4', 'method': 'online logical dump', 'format': 'pg_dump custom', 'databases': ['shop'], 'bytes': 10, 'sha256': '0' * 64}])


@unittest.skipUnless(os.name == 'posix', 'needs GNU tar')
class FolderOnly(unittest.TestCase):
    def test_folder_only_archive_holds_just_the_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            source = pathlib.Path(folder) / 'pgdata'; source.mkdir(mode=0o700); (source / 'PG_VERSION').write_text('16')
            target = pathlib.Path(folder) / 'mount.tar'
            helper.source_archive(str(source), target, folder_only=True)
            with tarfile.open(target) as archive:self.assertEqual([(m.name, m.isdir()) for m in archive.getmembers()], [('pgdata', True)])
            command = helper.source_archive_command(str(source), folder_only=True)
            self.assertIn('--no-recursion', command)


if __name__ == '__main__':
    unittest.main()
