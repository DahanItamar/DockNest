import collections, io, json, os, pathlib, subprocess, tarfile, tempfile, time, unittest
from unittest.mock import ANY, Mock
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

    def blocker(self, slots='0', databases='postgres\nshop', tools=True, tablespaces='2', skipped='0', template='0'):
        def query(cid, service, sql):
            if 'pg_replication_slots' in sql: return slots
            if 'pg_tablespace' in sql: return tablespaces
            if 'datistemplate OR NOT datallowconn' in sql: return skipped
            if 'pg_extension' in sql:
                assert service['database'] == 'template1'
                return template
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
            ({}, {'tablespaces': '3'}, 'its own tablespaces'),
            ({}, {'skipped': '1'}, 'template database or one that refuses connections'),
            ({}, {'template': '4'}, 'template1 database has objects'),
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
        with patch('helper.run', return_value=b'/usr/bin/mariadb-dump\n'), patch('helper.database_query', return_value='2') as query:
            self.assertIn('not InnoDB (2)', engine.dump_blocker({'container': 'db'}, {'Id': 'db'}, self.data))
        self.assertIn("COALESCE(engine,'')<>'InnoDB'", query.call_args.args[2], 'a table without an engine counts as not InnoDB')
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
        def dump(cid, service, directory, deadline):
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
        deadline = time.monotonic() + 60
        with patch('helper.database_query', return_value='0'):
            with patch('helper.dump_command', side_effect=writes('CREATE TABLE t (id int);\n-- Dump completed on 2026-11-21 10:00:00\n')):
                self.assertEqual(engine.dump('db', {}, self.root, deadline)['format'], engine.dump_format)
            (self.root / 'all-databases.sql').unlink()
            with patch('helper.dump_command', side_effect=writes('CREATE TABLE t (id int);\nINSERT INTO t VALUES')), self.assertRaisesRegex(ValueError, 'did not finish'):
                engine.dump('db', {}, self.root, deadline)
        # A MyISAM table created after planning: checked again right before the dump, which then never runs.
        with patch('helper.database_query', return_value='1'), patch('helper.dump_command', side_effect=AssertionError('no dump')), self.assertRaisesRegex(ValueError, 'not InnoDB'):
            engine.dump('db', {}, self.root, deadline)

    def test_every_command_of_a_dump_shares_one_deadline(self):
        engine = ENGINES['postgres']; timeouts = []
        def command(args, timeout, stdin=None, stdout=None):
            timeouts.append(timeout)
            if stdout: pathlib.Path(stdout).write_bytes(b'x')
            return 0, ''
        with patch('helper.database_query', return_value='postgres\nshop'), patch('helper.dump_command', side_effect=command):
            engine.dump('db', {}, self.root, time.monotonic() + 30)
        self.assertEqual(len(timeouts), 5); self.assertTrue(all(0 < t <= 30 for t in timeouts)); self.assertEqual(timeouts, sorted(timeouts, reverse=True))
        with patch('helper.database_query', return_value='postgres'), patch('helper.dump_command', side_effect=command), self.assertRaises(subprocess.TimeoutExpired):
            engine.dump('db', {}, self.root, time.monotonic() - 1)

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


class Capture(unittest.TestCase):
    """capture() with one PostgreSQL service: a dump keeps it running; a failed dump stops it for the file copy."""

    def run_capture(self, dump):
        with tempfile.TemporaryDirectory() as d:
            base = pathlib.Path(d); data = base / 'pgdata'; data.mkdir()
            cfg = {'containers': ['db'], 'stagingRoot': str(base / 'staging'), 'maintenance': {}}
            mounts = [{'Type': 'volume', 'Name': 'pg', 'Source': str(data), 'Destination': '/var/lib/postgresql/data', 'RW': True}]
            c = {'Id': 'db', 'Name': '/shop-db', 'Image': 'image-db', 'State': {'Running': True}, 'Mounts': mounts, 'SizeRw': 0, 'Config': {'Entrypoint': ['docker-entrypoint.sh']}}
            plan = {'fingerprint': 'plan', 'services': [{'container': 'db', 'engine': 'postgres', 'version': '16.4', 'role': 'database', 'checks': []}], 'restartOrder': ['db']}
            tars = []; emitted = Mock(); calls = []; maintenance = Mock()
            def run(args, **_):
                if args[0] == 'tar': tars.append(list(args))
                return b'0\tx' if args[0] == 'du' else b''
            def docker(*args):
                calls.append(args)
                if args[0] == 'stop': time.sleep(0.05)  # a stop takes time; coarse clocks would read it as zero
                return b'[]' if args[:2] == ('image', 'inspect') else b'snapshot' if args[0] == 'commit' else b''
            shutdown = Mock(side_effect=lambda services, *_: [{'container': s['container']} for s in services])
            mocks = dict(preflight=Mock(return_value=[c]), backup_plan=Mock(return_value=plan), online_sqlite_checks=Mock(),
                         create_staging_root=Mock(side_effect=lambda p: pathlib.Path(p).mkdir(parents=True)), docker=Mock(side_effect=docker),
                         mount_exclusions=Mock(return_value={}), atomic_json=Mock(), prepare_database_shutdown=Mock(), shutdown_evidence=shutdown,
                         revalidate_sources=Mock(), restart_services=Mock(), inspect=Mock(return_value=[c]), complete_recovery=Mock(),
                         artifact_inventory=Mock(return_value={}), run=Mock(side_effect=run), maintenance=maintenance, health=Mock(return_value=True),
                         emit=emitted, data_checks=Mock(return_value=[]), dump_candidates=Mock(return_value=({'db': ('/var/lib/postgresql/data', data)}, [])),
                         take_dump=Mock(side_effect=dump))
            usage = collections.namedtuple('Usage', 'total used free')(1, 0, 1 << 50)
            with patch.multiple('helper', **mocks), patch('helper.shutil.disk_usage', return_value=usage), patch.object(pathlib.Path, 'read_text', return_value='boot'), \
                    patch('helper.os.getpgrp', return_value=os.getpid(), create=True), patch('helper.os.fork', return_value=4242, create=True), patch('helper.os.path.commonpath', return_value='/'):
                helper.capture({'config': cfg, 'job': '00000000-0000-4000-8000-000000000000', 'planFingerprint': 'plan', 'onlineDumps': True})
            manifest = emitted.call_args.kwargs['result']['manifest']
            return manifest, calls, maintenance, [t for t in tars if 'mount-' in ' '.join(t)]

    def test_a_dump_keeps_the_database_running_with_no_downtime(self):
        record = {'method': 'online logical dump', 'format': 'pg_dump custom', 'databases': ['shop'], 'artifact': 'database-0.tar', 'bytes': 1, 'sha256': '0' * 64}
        manifest, calls, maintenance, tars = self.run_capture(lambda *args: record)
        self.assertFalse(any(call[0] == 'stop' for call in calls), 'the database never stops')
        self.assertNotIn(True, [call.args[1] for call in maintenance.call_args_list], 'no maintenance page when nothing stops')
        self.assertEqual((manifest['downtimeSeconds'], manifest['visitorDowntimeSeconds']), (0, 0))
        self.assertEqual(manifest['backupPlan']['services'][0]['dump'], record)
        self.assertIn('online native logical dumps', manifest['consistency']['method']); self.assertNotIn('onlineDumpFallbacks', manifest)
        self.assertIn('--no-recursion', tars[0], 'the data folder is archived empty')

    def test_a_failed_dump_stops_the_database_for_the_file_copy(self):
        def fail(*args): raise ValueError('pg_dump failed')
        manifest, calls, maintenance, tars = self.run_capture(fail)
        self.assertIn(('stop', '--time', '60', 'db'), calls)
        maintenance.assert_any_call(ANY, True)
        self.assertEqual(manifest['onlineDumpFallbacks'], [{'container': 'shop-db', 'engine': 'postgres', 'reason': 'pg_dump failed'}])
        self.assertGreater(manifest['downtimeSeconds'], 0); self.assertNotIn('dump', manifest['backupPlan']['services'][0])
        self.assertEqual(manifest['consistency']['method'], 'offline native shutdown evidence plus declared writer quiescence')
        self.assertNotIn('--no-recursion', tars[0], 'the stopped copy archives the whole data folder')


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
