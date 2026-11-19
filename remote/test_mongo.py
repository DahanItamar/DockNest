import hashlib, json, os, pathlib, secrets, shutil, subprocess, tempfile, unittest
from unittest.mock import patch
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
from helper import service_contracts, validate_database_contracts, data_checks, shutdown_evidence, restart_services, mongo_query, MONGO_SHELL_SCRIPT, MONGO_EVAL_SCRIPT

PASSWORD = secrets.token_urlsafe(24)


def fixture():
    container = {'Id': 'mongo-id', 'Image': 'sha256:fixture', 'Name': '/demo-shop-mongo', 'State': {'Running': True},
                 'Config': {'Image': 'mongo:7.0', 'Env': ['MONGO_INITDB_ROOT_USERNAME=demo', 'MONGO_INITDB_ROOT_PASSWORD=' + PASSWORD]},
                 'HostConfig': {'LogConfig': {'Type': 'json-file'}},
                 'Mounts': [{'Source': '/srv/demo-shop/db', 'Destination': '/data/db', 'RW': True}]}
    service = {'container': container['Id'], 'engine': 'mongo', 'version': '7.0.14', 'database': 'shop', 'user': None,
               'checks': [{'name': 'Orders', 'collection': 'orders'}]}
    reply = {'version': '7.0.14', 'storageEngine': 'wiredTiger', 'options': {'net': {'bindIp': '*'}, 'storage': {'dbPath': '/data/db'}},
             'hello': {'isWritablePrimary': True, 'ok': 1}}
    return container, service, reply


def mongod(version):
    """`docker exec <id> <binary> --version`: only mongod exists in the container."""
    def binary(args, **_):
        if args[-2] == 'mongod': return ('db version v' + version + '\nBuild Info: {\n    "version": "' + version + '"\n}').encode()
        raise subprocess.CalledProcessError(127, args)
    return binary


def log(*entries):
    return ('\n'.join(json.dumps(entry) for entry in entries) + '\n').encode()


CLEAN_STOP = log({'s': 'I', 'c': 'CONTROL', 'id': 23377, 'msg': 'Received signal', 'attr': {'signal': 15}},
                 {'s': 'I', 'c': 'STORAGE', 'id': 4795901, 'msg': 'WiredTiger closed', 'attr': {'durationMillis': 40}},
                 {'s': 'I', 'c': 'CONTROL', 'id': 23138, 'msg': 'Shutting down', 'attr': {'exitCode': 0}})


class MongoContracts(unittest.TestCase):
    def setUp(self):
        # The contract probes `docker logs --tail 0` before any stop; tests have no Docker daemon.
        real = subprocess.run
        def readable_logs(args, *rest, **kwargs):
            if list(args[:4]) == ['docker', 'logs', '--tail', '0']: return subprocess.CompletedProcess(args, 0, b'', b'')
            return real(args, *rest, **kwargs)
        patcher = patch('helper.subprocess.run', side_effect=readable_logs); patcher.start(); self.addCleanup(patcher.stop)

    def validate(self, container, service, reply, readlink=b'/data/db\n'):
        with patch('helper.mongo_query', return_value=reply) as query, patch('helper.run', return_value=readlink):
            validate_database_contracts([service], [container])
        return query

    def test_detects_tested_majors_and_refuses_others(self):
        container, *_ = fixture()
        for version, tested in [('6.0.19', True), ('7.0.14', True), ('8.0.4', True), ('5.0.31', False), ('4.4.29', False), ('8.2.1', False)]:
            with self.subTest(version=version), patch('helper.run', side_effect=mongod(version)):
                if tested:
                    contract = service_contracts({}, [container])[0]
                    self.assertEqual((contract['engine'], contract['version'], contract['role']), ('mongo', version, 'database'))
                else:
                    with self.assertRaisesRegex(ValueError, 'tested MongoDB 6.0, 7.0 and 8.0'): service_contracts({}, [container])
        with patch('helper.run', side_effect=mongod('7.0.14')):
            with self.assertRaisesRegex(ValueError, 'does not match'): service_contracts({'services': [{'container': 'demo-shop-mongo', 'engine': 'redis'}]}, [container])

    def test_data_checks_name_a_collection_only(self):
        container, *_ = fixture()
        with patch('helper.run', side_effect=mongod('7.0.14')):
            self.assertEqual(service_contracts({'services': [{'container': 'demo-shop-mongo', 'checks': [{'name': 'Orders', 'collection': 'orders', 'database': 'shop'}]}]}, [container])[0]['checks'][0]['collection'], 'orders')
            for check in [{'name': 'Orders', 'table': 'orders'}, {'name': 'Orders', 'key': 'orders'}, {'name': 'Orders', 'collection': 'orders', 'table': 'orders'}]:
                with self.subTest(check=check), self.assertRaisesRegex(ValueError, 'do not match'):
                    service_contracts({'services': [{'container': 'demo-shop-mongo', 'checks': [check]}]}, [container])

    def test_standalone_and_single_member_set_pass_and_record_db_path(self):
        for hello in [{'isWritablePrimary': True}, {'isWritablePrimary': True, 'setName': 'rs0', 'hosts': ['demo-shop-mongo:27017']}]:
            with self.subTest(hello=hello):
                container, service, reply = fixture(); reply['hello'] = hello
                query = self.validate(container, service, reply)
                query.assert_called_once_with('mongo-id', 'contract')
                self.assertEqual(service['dataDirectory'], '/data/db')
                self.assertNotIn(PASSWORD, json.dumps(service))

    def test_unsafe_topology_storage_tls_logging_and_paths_block_before_stop(self):
        changes = [
            ('hello', {'isWritablePrimary': True, 'setName': 'rs0', 'hosts': ['a:27017', 'b:27017']}, 'more than one member'),
            ('hello', {'isWritablePrimary': True, 'setName': 'rs0', 'hosts': ['a:27017'], 'arbiters': ['c:27017']}, 'more than one member'),
            ('hello', {'isWritablePrimary': False, 'secondary': True, 'setName': 'rs0', 'hosts': ['a:27017']}, 'secondaries and arbiters'),
            ('hello', {'isWritablePrimary': False, 'arbiterOnly': True, 'setName': 'rs0'}, 'secondaries and arbiters'),
            ('storageEngine', 'inMemory', 'WiredTiger'),
            ('version', '7.0.12', 'does not match'),
            ('options', {'net': {'tls': {'mode': 'requireTLS'}}}, 'TLS-only'),
            ('options', {'sharding': {'clusterRole': 'shardsvr'}}, 'sharded'),
            ('options', {'systemLog': {'destination': 'file', 'path': '/var/log/mongodb/mongod.log'}}, 'standard output'),
            ('options', {'storage': {'dbPath': '/srv/outside'}}, 'captured writable mount'),
            ('options', {'storage': {'dbPath': '/data/db/../etc'}}, 'captured writable mount'),
            ('options', 'not a document', 'incomplete'),
        ]
        for field, value, message in changes:
            with self.subTest(field=field, value=value):
                container, service, reply = fixture(); reply[field] = value
                with self.assertRaisesRegex(ValueError, message): self.validate(container, service, reply)
                self.assertNotIn('dataDirectory', service)

    def test_read_only_mount_symlinked_db_path_and_hidden_logs_block(self):
        container, service, reply = fixture(); container['Mounts'][0]['RW'] = False
        with self.assertRaisesRegex(ValueError, 'captured writable mount'): self.validate(container, service, reply)
        container, service, reply = fixture()
        with self.assertRaisesRegex(ValueError, 'symbolic links'): self.validate(container, service, reply, readlink=b'/elsewhere\n')
        container, service, reply = fixture(); container['HostConfig']['LogConfig']['Type'] = 'none'
        with self.assertRaisesRegex(ValueError, 'logging driver none'): self.validate(container, service, reply)

    def test_query_keeps_credentials_out_of_docker_arguments_and_errors(self):
        with patch('helper.run', return_value=b'{"ok":1}\n') as command:
            self.assertEqual(mongo_query('mongo-id', 'ping'), {'ok': 1})
        args = command.call_args.args[0]
        self.assertEqual(args[:5], ['docker', 'exec', 'mongo-id', 'sh', '-c'])
        self.assertNotIn(PASSWORD, json.dumps(args)); self.assertNotIn('-e', args); self.assertNotIn('--env', args)
        for name in ['MONGO_INITDB_ROOT_USERNAME', 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_INITDB_ROOT_USERNAME_FILE', 'MONGO_INITDB_ROOT_PASSWORD_FILE']:
            self.assertIn(name, MONGO_SHELL_SCRIPT)
        self.assertIn('process.env', MONGO_EVAL_SCRIPT); self.assertNotIn('@', MONGO_EVAL_SCRIPT, 'no credentials in the connection string')
        with patch('helper.run', side_effect=subprocess.CalledProcessError(1, ['unsafe'], output=PASSWORD.encode())):
            with self.assertRaises(ValueError) as caught: mongo_query('mongo-id', 'ping')
        self.assertNotIn(PASSWORD, str(caught.exception)); self.assertIsNone(caught.exception.__cause__); self.assertTrue(caught.exception.__suppress_context__)

    def test_missing_tools_and_credentials_fail_closed_with_plain_reasons(self):
        for code, message in [(69, 'mongosh\\) is missing'), (70, 'credentials in the container are incomplete'), (75, 'plain local connection'), (77, 'rejected the root credentials'), (78, 'requires authentication'), (76, 'query failed')]:
            with self.subTest(code=code), patch('helper.run', side_effect=subprocess.CalledProcessError(code, ['docker'])):
                with self.assertRaisesRegex(ValueError, message): mongo_query('mongo-id', 'contract')
        for output in [b'', b'MongoServerError: not json\n', b'[1]\n']:
            with self.subTest(output=output), patch('helper.run', return_value=output):
                with self.assertRaisesRegex(ValueError, 'incomplete'): mongo_query('mongo-id', 'contract')

    @unittest.skipUnless(os.name == 'posix' and shutil.which('sh'), 'Runs the static shell with a fake mongosh')
    def test_shell_hands_credentials_to_mongosh_only_through_its_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary); tools = base / 'bin'; tools.mkdir()
            fake = tools / 'mongosh'
            fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE.args"\nenv > "$CAPTURE.env"\necho \'{"ok":1}\'\n'); fake.chmod(0o755)
            secret_file = base / 'password'; secret_file.write_text(PASSWORD)
            def shell(env, path=str(tools) + ':/usr/bin:/bin'):
                return subprocess.run([shutil.which('sh'), '-c', MONGO_SHELL_SCRIPT, 'docknest', 'ping', '', '', MONGO_EVAL_SCRIPT], env={'PATH': path, 'CAPTURE': str(base / 'run'), **env}, capture_output=True)
            for env in [{'MONGO_INITDB_ROOT_USERNAME': 'demo', 'MONGO_INITDB_ROOT_PASSWORD': PASSWORD}, {'MONGO_INITDB_ROOT_USERNAME': 'demo', 'MONGO_INITDB_ROOT_PASSWORD_FILE': str(secret_file)}]:
                with self.subTest(env=sorted(env)):
                    result = shell(env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertNotIn(PASSWORD, (base / 'run.args').read_text())
                    self.assertIn('DOCKNEST_MONGO_PASSWORD=' + PASSWORD, (base / 'run.env').read_text().splitlines())
            self.assertEqual(shell({'MONGO_INITDB_ROOT_USERNAME': 'demo'}).returncode, 70)
            self.assertEqual(shell({'MONGO_INITDB_ROOT_USERNAME': 'demo', 'MONGO_INITDB_ROOT_PASSWORD_FILE': str(base / 'missing')}).returncode, 70)
            empty = base / 'empty'; empty.mkdir()
            self.assertEqual(shell({}, path=str(empty)).returncode, 69)

    def test_ready_pings_before_the_dependent_writer_starts(self):
        with patch('helper.docker') as command, patch('helper.health', return_value=True), patch('helper.mongo_query', return_value={'ok': 1}) as native:
            restart_services(['mongo-id', 'writer'], [{'container': 'mongo-id', 'engine': 'mongo'}, {'container': 'writer', 'engine': 'generic', 'dependsOn': ['mongo-id']}])
        self.assertEqual([call.args for call in command.call_args_list], [('start', 'mongo-id'), ('start', 'writer')])
        self.assertTrue(all(call.args[1] == 'ping' for call in native.call_args_list))

    def test_document_count_digest_is_read_only_and_names_are_checked(self):
        _, service, _ = fixture()
        with patch('helper.mongo_query', return_value={'count': 42}) as query:
            result = data_checks('restored', service)
        query.assert_called_once_with('restored', 'count', 'shop', 'orders')
        self.assertEqual(result, [{'name': 'Orders', 'database': 'shop', 'collection': 'orders', 'sha256': hashlib.sha256(b'42').hexdigest(), 'method': 'read-only MongoDB countDocuments'}])
        with patch('helper.mongo_query', return_value={'count': 1}) as query:
            data_checks('restored', {**service, 'checks': [{'name': 'Orders', 'collection': 'orders', 'database': 'archive'}]})
        self.assertEqual(query.call_args.args[2], 'archive')
        for check, database in [({'name': 'Users', 'collection': 'system.users'}, 'shop'), ({'name': 'Bad', 'collection': '$where'}, 'shop'), ({'name': 'Orders', 'collection': 'orders'}, None), ({'name': 'Orders', 'collection': 'orders', 'database': 'shop;drop'}, 'shop')]:
            with self.subTest(check=check), patch('helper.mongo_query') as query:
                with self.assertRaises(ValueError): data_checks('restored', {**service, 'database': database, 'checks': [check]})
                query.assert_not_called()
        for reply in [{}, {'count': '42'}, {'count': True}, {'count': -1}]:
            with self.subTest(reply=reply), patch('helper.mongo_query', return_value=reply):
                with self.assertRaisesRegex(ValueError, 'one count'): data_checks('restored', service)


@unittest.skipUnless(hasattr(os, 'O_NOFOLLOW'), 'Requires Linux file-open semantics')
class MongoCleanStop(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.data = pathlib.Path(temporary.name).resolve() / 'db'; self.data.mkdir()
        (self.data / 'mongod.lock').write_bytes(b'')
        self.container, self.service, _ = fixture()
        self.container['Mounts'][0]['Source'] = str(self.data)
        self.container['State'] = {'Running': False, 'ExitCode': 0}
        self.service['dataDirectory'] = '/data/db'
        patcher = patch('helper.time.sleep'); patcher.start(); self.addCleanup(patcher.stop)

    def evidence(self, logs=CLEAN_STOP):
        with patch('helper.inspect', return_value=[self.container]), patch('helper.subprocess.run', return_value=subprocess.CompletedProcess([], 0, logs, b'')) as reads, patch('helper.run') as native:
            try: return shutdown_evidence([self.service], [self.container], 123)[0]
            finally:
                self.assertTrue(all('123' in call.args[0] and '--since' in call.args[0] for call in reads.call_args_list))
                native.assert_not_called()

    def test_clean_stop_needs_this_stops_logs_and_an_empty_lock_file(self):
        evidence = self.evidence()
        self.assertTrue(evidence['zeroExitCodeVerified']); self.assertTrue(evidence['wiredTigerClosedVerified']); self.assertTrue(evidence['lockFileEmptyVerified'])
        self.assertNotIn(PASSWORD, json.dumps(evidence))

    def test_missing_or_failed_shutdown_log_proof_blocks(self):
        lines = CLEAN_STOP.decode().splitlines()
        for logs, message in [(b'old startup line\n', 'WiredTiger closed'), ('\n'.join(lines[::2]).encode(), 'WiredTiger closed'),
                              (CLEAN_STOP.replace(b'"exitCode": 0', b'"exitCode": 14'), 'exit code 0'),
                              (CLEAN_STOP + log({'s': 'F', 'msg': 'Fatal assertion'}), 'fatal')]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message): self.evidence(logs)

    def test_nonzero_exit_and_unclean_lock_file_block(self):
        self.container['State'] = {'Running': False, 'ExitCode': 137}
        with self.assertRaisesRegex(ValueError, 'nonzero exit'): self.evidence()
        self.container['State'] = {'Running': False, 'ExitCode': 0}
        (self.data / 'mongod.lock').write_bytes(b'1\n')
        with self.assertRaisesRegex(ValueError, 'not empty'): self.evidence()
        (self.data / 'mongod.lock').unlink()
        with self.assertRaisesRegex(ValueError, 'missing'): self.evidence()
        victim = self.data.parent / 'elsewhere.lock'; victim.write_bytes(b'')
        (self.data / 'mongod.lock').symlink_to(victim)
        with self.assertRaisesRegex(ValueError, 'regular file'): self.evidence()
        (self.data / 'mongod.lock').unlink(); (self.data / 'mongod.lock').write_bytes(b'')
        linked = self.data.parent / 'linked'; linked.symlink_to(self.data, target_is_directory=True)
        self.container['Mounts'][0]['Source'] = str(linked)
        with self.assertRaisesRegex(ValueError, 'symbolic links'): self.evidence()


if __name__ == '__main__': unittest.main()
