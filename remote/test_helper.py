import unittest, tempfile, pathlib, tarfile, io, urllib.error
import json,zipfile
from export_zip import export_zip
from unittest.mock import patch
from helper import safe_extract, health, maintenance, configuration_paths, list_project_files, public_probe, OriginHTTPSConnection, readiness, restore_network_plan, temporary_mounts, nginx_sites, web_hints, tree_digest, static_preflight
from helper import mount_table, classify_source, revalidate_sources, preflight
from helper import service_order, service_contracts, shutdown_evidence, restart_services, prepare_database_shutdown, validate_database_contracts, backup_plan
from helper import artifact_inventory, verify_artifacts, data_checks
from helper import recover, complete_recovery
from helper import database_query
from helper import create_staging_root, sync_directory, capture
from helper import ProbePolicyError, probe_policy_preflight
from boot_recovery import recover_jobs

class DatabaseSocketTests(unittest.TestCase):
    def test_container_socket_override_remains_private_and_default_config_is_preserved(self):
        with patch('helper.run',return_value=b'1\n') as command:
            self.assertEqual(database_query('db',{'engine':'mysql'},'SELECT 1'),'1')
            arguments=command.call_args.args[0]
            self.assertEqual(arguments[:4],['docker','exec','db','sh'])
            script=arguments[arguments.index('-c')+1]
            self.assertIn('--socket="$MYSQL_UNIX_PORT"',script)
            self.assertIn('--protocol=socket',script)
            self.assertNotIn('--host',script);self.assertNotIn('--port',script)
            self.assertNotIn('--password',script)
            self.assertIn('MYSQL_ROOT_PASSWORD_FILE',script)

    @unittest.skipUnless(__import__('os').name=='posix','Requires a POSIX container shell')
    def test_container_shell_applies_explicit_socket_and_rejects_unsupported_paths(self):
        import os,subprocess,secrets
        with patch('helper.run',return_value=b'1\n') as command:database_query('db',{'engine':'mysql'},'SELECT 1')
        arguments=command.call_args.args[0];script=arguments[arguments.index('-c')+1]
        with tempfile.TemporaryDirectory() as temporary:
            client=pathlib.Path(temporary)/'client';client.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n');client.chmod(0o700)
            password=secrets.token_urlsafe(24);password_file=pathlib.Path(temporary)/'password';password_file.write_text(password)
            environment={**os.environ,'MYSQL_ROOT_PASSWORD_FILE':str(password_file),'MYSQL_ROOT_PASSWORD':'','MARIADB_ROOT_PASSWORD_FILE':'','MARIADB_ROOT_PASSWORD':''}
            for socket in ['', '/tmp/mysql.sock']:
                result=subprocess.run(['sh','-c',script,'docknest',str(client),'root','SELECT 1'],env={**environment,'MYSQL_UNIX_PORT':socket},capture_output=True,text=True)
                self.assertEqual(result.returncode,0)
                self.assertNotIn(password,result.stdout+result.stderr)
                options=result.stdout.splitlines();self.assertIn('--protocol=socket',options)
                self.assertEqual([option for option in options if option.startswith('--socket=')],['--socket='+socket] if socket else [])
            for socket in ['relative.sock','@abstract','/tmp/bad\nsocket','/tmp/bad\rsocket']:
                result=subprocess.run(['sh','-c',script,'docknest',str(client),'root','SELECT 1'],env={**environment,'MYSQL_UNIX_PORT':socket},capture_output=True,text=True)
                self.assertEqual(result.returncode,64)
                self.assertEqual(result.stdout,'');self.assertNotIn(password,result.stderr)

class BootRecoveryTests(unittest.TestCase):
    def test_prior_boot_restarts_original_services_and_keeps_stopped_services_stopped(self):
        import uuid
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);root=base/str(uuid.uuid4());root.mkdir()
            record={'version':1,'bootId':'previous','running':['db','web'],'identities':{'db':'image-db','web':'image-web','idle':'image-idle'},'config':{'_serviceContracts':[],'maintenance':{}}}
            (root/'boot-recovery.json').write_text(json.dumps(record))
            states=[{'Id':cid,'Image':image,'State':{'Running':False}} for cid,image in record['identities'].items()]
            with patch('boot_recovery.private_path',side_effect=lambda p,*a:pathlib.Path(p)),patch('boot_recovery.os.geteuid',return_value=0,create=True),patch('boot_recovery.inspect',return_value=states),patch('boot_recovery.restart_services') as restart,patch('boot_recovery.health',return_value=True),patch('boot_recovery.maintenance') as flags,patch('boot_recovery.atomic_json') as write,patch('boot_recovery.complete_recovery'):
                result=recover_jobs([d],'current');self.assertEqual(result['recovered'],1)
                restart.assert_called_once_with(['db','web'],[]);flags.assert_called_once_with(record['config'],False)
                restart.reset_mock();self.assertEqual(recover_jobs([d],'previous')['ignored'],1);restart.assert_not_called()
                states[0]['Image']='replacement'
                self.assertEqual(recover_jobs([d],'current')['reviewRequired'],1);restart.assert_not_called()
    def test_completed_recovery_is_not_replayed_after_operator_stops_source(self):
        import uuid
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);root=base/str(uuid.uuid4());root.mkdir()
            record={'version':1,'bootId':'interrupted','running':['db'],'identities':{'db':'image-db'},'config':{'_serviceContracts':[],'maintenance':{}}}
            (root/'boot-recovery.json').write_text(json.dumps(record))
            states=[{'Id':'db','Image':'image-db','State':{'Running':False}}]
            # Emulate the atomic writer to exercise replay on Windows too; production
            # atomic_json fsyncs both the completion file and its parent directory.
            def write_journal(path,value):pathlib.Path(path).write_text(json.dumps(value))
            with patch('boot_recovery.private_path',side_effect=lambda p,*a:pathlib.Path(p)),patch('boot_recovery.os.geteuid',return_value=0,create=True),patch('boot_recovery.inspect',return_value=states) as inspect_source,patch('boot_recovery.restart_services') as restart,patch('boot_recovery.health',return_value=True),patch('boot_recovery.maintenance') as flags,patch('boot_recovery.atomic_json',side_effect=write_journal),patch('helper.atomic_json',side_effect=write_journal) as write:
                self.assertEqual(recover_jobs([d],'recovery-boot')['recovered'],1)
                completion=json.loads((root/'disarmed').read_text())
                self.assertTrue(completion['completed']);self.assertEqual(completion['bootId'],'recovery-boot')
                self.assertEqual(write.call_args_list[-1].args[0],root/'disarmed')
                # The source was stopped intentionally after recovery. A later boot
                # must leave it stopped and must not alter maintenance or inspect it.
                restart.reset_mock();flags.reset_mock();inspect_source.reset_mock();write.reset_mock()
                self.assertEqual(recover_jobs([d],'later-boot'),{'recovered':0,'reviewRequired':0,'ignored':1})
                restart.assert_not_called();flags.assert_not_called();inspect_source.assert_not_called();write.assert_not_called()
    def test_watchdog_success_durably_disarms_before_later_boot_after_operator_stop(self):
        import uuid
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/str(uuid.uuid4());root.mkdir()
            record={'version':1,'bootId':'interrupted','running':['db'],'identities':{'db':'image-db'},'config':{'containers':['db'],'_serviceContracts':[],'maintenance':{}}}
            (root/'boot-recovery.json').write_text(json.dumps(record))
            def write_journal(path,value):pathlib.Path(path).write_text(json.dumps(value))
            with patch('helper.os.getpgid',side_effect=ProcessLookupError,create=True),patch('helper.restart_services') as restart,patch('helper.health',return_value=True),patch('helper.maintenance') as flags,patch('helper.atomic_json',side_effect=write_journal):
                recover(root,['db'],record['config'],0,123)
                restart.assert_called_once();flags.assert_called_once_with(record['config'],False)
                self.assertTrue(json.loads((root/'disarmed').read_text())['completed'])
                self.assertTrue(json.loads((root/'recovery.json').read_text())['recovered'])
            # The operator stops the recovered database. A later host boot must
            # preserve that choice even though the interrupted job is retained.
            with patch('boot_recovery.private_path',side_effect=lambda p,*a:pathlib.Path(p)),patch('boot_recovery.os.geteuid',return_value=0,create=True),patch('boot_recovery.inspect') as inspect_source,patch('boot_recovery.restart_services') as restart:
                self.assertEqual(recover_jobs([d],'later-boot')['ignored'],1)
                inspect_source.assert_not_called();restart.assert_not_called()
    def test_failed_public_recovery_or_marker_sync_keeps_watchdog_armed(self):
        for failure in ['public-health','completion-sync']:
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as d:
                root=pathlib.Path(d)
                def write_journal(path,value):
                    pathlib.Path(path).write_text(json.dumps(value))
                    if failure=='completion-sync' and pathlib.Path(path).name=='disarmed':raise OSError('Simulated completion fsync failure')
                with patch('helper.os.getpgid',side_effect=ProcessLookupError,create=True),patch('helper.restart_services'),patch('helper.health',return_value=True),patch('helper.maintenance',side_effect=ValueError('Public access unavailable') if failure=='public-health' else None),patch('helper.atomic_json',side_effect=write_journal):
                    recover(root,['db'],{'containers':['db'],'maintenance':{}},0,123)
                self.assertFalse((root/'disarmed').exists())
                self.assertFalse(json.loads((root/'recovery.json').read_text())['recovered'])

class RecoveryEvidenceTests(unittest.TestCase):
    def test_missing_and_changed_artifacts_fail_before_restore(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);(root/'static-files.tar').write_bytes(b'fixture')
            manifest={'kind':'static','artifacts':artifact_inventory(root),'configurationFiles':[]}
            self.assertTrue(verify_artifacts(root,manifest))
            (root/'static-files.tar').write_bytes(b'changed')
            with self.assertRaises(ValueError):verify_artifacts(root,manifest)
            (root/'static-files.tar').unlink()
            with self.assertRaises(ValueError):verify_artifacts(root,manifest)
            self.assertFalse(verify_artifacts(root,{}))
    def test_checks_use_read_only_count_without_raw_data_in_evidence(self):
        service={'engine':'postgres','checks':[{'name':'orders available','table':'orders'}]}
        with patch('helper.database_query',return_value='BEGIN\n17\nCOMMIT') as query:
            result=data_checks('db',service)
            self.assertIn('READ ONLY',query.call_args.args[2]);self.assertEqual(len(result[0]['sha256']),64)
            self.assertNotIn('count',result[0]);self.assertNotIn('output',result[0]);self.assertNotIn('value',result[0])
        service['checks'][0]['table']='orders; DELETE'
        with self.assertRaises(ValueError):data_checks('db',service)

class ServiceContractTests(unittest.TestCase):
    def test_postgres_uses_active_native_data_directory_and_version(self):
        container={'Id':'db','Config':{'Env':['PGDATA=/stale']},'Mounts':[{'Destination':'/captured','RW':True}]}
        service={'container':'db','engine':'postgres','version':'16.13'}
        with patch('helper.database_query',side_effect=['16.13 (distribution build)','/captured/active','f','0']):
            validate_database_contracts([service],[container])
            self.assertEqual(service['dataDirectory'],'/captured/active')
        # A captured but inactive PGDATA must not certify an uncaptured live cluster.
        container['Config']['Env']=['PGDATA=/captured/inactive']
        with patch('helper.database_query',side_effect=['16.13','/outside/active']):
            with self.assertRaisesRegex(ValueError,'Active PostgreSQL data directory'):validate_database_contracts([service],[container])
        with patch('helper.database_query',return_value='16.12'):
            with self.assertRaisesRegex(ValueError,'version'):validate_database_contracts([service],[container])
    def test_fast_shutdown_is_prepared_only_for_capture_and_original_setting_recovers(self):
        service={'container':'db','engine':'mysql','version':'8.4.8'}
        container={'Id':'db','Mounts':[{'Destination':'/var/lib/mysql','RW':True}]}
        with patch('helper.database_query',return_value='8.4.8\t1\t/var/lib/mysql/') as query:
            validate_database_contracts([service],[container])
            self.assertEqual(service['originalFastShutdown'],1);self.assertFalse(service['slowShutdownVerified'])
            self.assertNotIn('SET ',query.call_args.args[2])
        with patch('helper.database_query',side_effect=['','0']) as query:
            prepare_database_shutdown(service);self.assertTrue(service['slowShutdownVerified'])
            self.assertEqual(query.call_args_list[0].args[2],'SET GLOBAL innodb_fast_shutdown=0;')
        with patch('helper.docker'),patch('helper.health',return_value=True),patch('helper.database_query',side_effect=['1','1','','1']) as query:
            restart_services(['db'],[service])
            self.assertIn('SET GLOBAL innodb_fast_shutdown=1;',[c.args[2] for c in query.call_args_list])
        with patch('helper.database_query',side_effect=['','1']):
            with self.assertRaises(ValueError):prepare_database_shutdown(service)
    def test_legacy_database_profile_cannot_bypass_writer_confirmation(self):
        with patch('helper.service_contracts',return_value=[{'engine':'generic'}]):
            with self.assertRaises(ValueError):backup_plan({'shutdownProfile':'postgres'},[])
    def test_dependency_order_and_cycles(self):
        services=[{'container':'web','dependsOn':['db']},{'container':'db','dependsOn':[]}]
        self.assertEqual(service_order(services),['db','web'])
        services[1]['dependsOn']=['web']
        with self.assertRaises(ValueError):service_order(services)
        with self.assertRaises(ValueError):service_order([{'container':'web','dependsOn':['outside']}])
    def test_native_version_and_declared_engine_mismatch(self):
        c={'Id':'db','Name':'/database','Config':{'Image':'custom:tag'},'State':{'Running':True}}
        with patch('helper.run',return_value=b'postgres (PostgreSQL) 16.13'):
            self.assertEqual(service_contracts({},[c])[0]['version'],'16.13')
            with self.assertRaises(ValueError):service_contracts({'services':[{'container':'database','engine':'mysql'}]},[c])
    def test_forced_exit_and_missing_current_shutdown_proof_fail(self):
        service={'container':'db','engine':'mysql','version':'8.4.0','slowShutdownVerified':True}
        for state in [{'Running':False,'ExitCode':137},{'Running':False,'ExitCode':0,'OOMKilled':True}]:
            with patch('helper.inspect',return_value=[{'Id':'db','State':state}]):
                with self.assertRaises(ValueError):shutdown_evidence([service],[{'Id':'db'}],123)
        from subprocess import CompletedProcess
        with patch('helper.inspect',return_value=[{'Id':'db','State':{'Running':False,'ExitCode':0}}]),patch('helper.subprocess.run',return_value=CompletedProcess([],0,b'old startup',b'')) as logs:
            with self.assertRaises(ValueError):shutdown_evidence([service],[{'Id':'db'}],123)
            self.assertIn('123',logs.call_args[0][0])
    def test_restart_waits_for_database_before_writer(self):
        with patch('helper.docker') as command,patch('helper.health',return_value=True),patch('helper.database_query',return_value='1'):
            restart_services(['db','web'],[{'container':'db','engine':'postgres'},{'container':'web','engine':'generic','dependsOn':['db']}])
            self.assertEqual([c.args for c in command.call_args_list],[('start','db'),('start','web')])
    def test_independent_peers_start_together_before_health_barrier(self):
        with patch('helper.docker') as command,patch('helper.health',return_value=True):
            restart_services(['web','peer'],[{'container':'web','engine':'generic'},{'container':'peer','engine':'generic'}])
            command.assert_called_once_with('start','web','peer')

class FilesystemPlanTests(unittest.TestCase):
    def test_new_staging_directory_syncs_all_ancestor_entries_before_use(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'new-base'/'new-job'
            with patch('helper.sync_directory') as sync:
                create_staging_root(root)
            self.assertTrue(root.is_dir())
            self.assertEqual([call.args[0] for call in sync.call_args_list],[root,*root.parents])
    def test_staging_sync_failure_prevents_journal_and_docker_stop(self):
        import uuid
        with tempfile.TemporaryDirectory() as d:
            job=str(uuid.uuid4());root=pathlib.Path(d)/job
            cfg={'stagingRoot':d,'containers':['db']}
            with patch('helper.preflight',return_value=[{'Mounts':[]}]),patch('helper.backup_plan',return_value={'fingerprint':'fixture'}),patch('helper.sync_directory',side_effect=OSError('Simulated directory fsync failure')),patch('helper.docker') as docker:
                with self.assertRaises(OSError):capture({'job':job,'config':cfg})
                docker.assert_not_called();self.assertFalse((root/'boot-recovery.json').exists())
    @unittest.skipUnless(__import__('os').name=='posix','Directory fsync requires Linux')
    def test_linux_staging_directory_fsyncs_real_new_parent_chain(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'new-base'/'new-job'
            with patch('helper.sync_directory',wraps=sync_directory) as sync:
                create_staging_root(root)
            self.assertEqual([call.args[0] for call in sync.call_args_list],[root,*root.parents])
    def test_mount_table_decodes_paths_and_rejects_incomplete_input(self):
        self.assertEqual(mount_table('12 1 8:1 / /data\\040files rw - ext4 /dev/sda rw')[0]['path'],'/data files')
        for value in ['', '12 1 incomplete']:
            with self.assertRaises(ValueError):mount_table(value)
    def test_unknown_remote_and_nested_mounts_are_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            root=str(pathlib.Path(d).resolve())
            table=[{'id':'1','path':root,'filesystem':'ext4'}]
            self.assertEqual(classify_source(root,table)['filesystem'],'ext4')
            for filesystem in ['nfs','nfs4','cifs','fuse.sshfs','tmpfs','unknown']:
                with self.assertRaises(ValueError):classify_source(root,[{**table[0],'filesystem':filesystem}])
            with self.assertRaises(ValueError):classify_source(root,table+[{'id':'2','path':root+'/nested','filesystem':'ext4'}])
            plan={'sources':[classify_source(root,table)]}
            with patch('helper.mount_table',return_value=[{**table[0],'id':'2'}]):
                with self.assertRaises(ValueError):revalidate_sources(plan)
    def test_unresolved_dependency_blocks_before_docker_access(self):
        with patch('helper.docker') as command:
            with self.assertRaises(ValueError):preflight({'unresolvedDependencies':['external writer']})
            command.assert_not_called()

class StaticSiteTests(unittest.TestCase):
    def test_cdn_probe_is_optional_only_for_static_capture(self):
        with patch('helper.preflight',return_value=[]),patch('helper.health',return_value=False):
            result=readiness({'kind':'static','containers':[],'healthUrl':'https://example.org'})
            self.assertTrue(result['ready']);self.assertFalse(result['checks'][1]['ok']);self.assertFalse(result['checks'][1]['required'])
            self.assertFalse(readiness({'containers':[],'healthUrl':'https://example.org','maintenance':{}})['ready'])
    def test_nginx_metadata_distinguishes_static_and_proxied_sites_without_secrets(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'website';root.mkdir();(root/'index.html').write_text('hello')
            config=pathlib.Path(d)/'nginx';config.mkdir()
            (config/'site').write_text('server { server_name static.example.org; root '+root.as_posix()+'; ssl_certificate_key /secret/key; location / { try_files $uri =404; } }\nserver { server_name app.example.org; location / { proxy_pass http://127.0.0.1:3200; } }')
            sites=nginx_sites([str(config)])
            self.assertEqual(len(sites),2);self.assertEqual(sites[0]['documentRoot'],str(root));self.assertNotIn('/secret/key',str(sites))
            c={'NetworkSettings':{'Ports':{'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3200'}]}}}
            self.assertEqual(web_hints(c,sites),{'healthUrls':['http://127.0.0.1:3200/'],'domains':['app.example.org']})
    def test_static_tree_detects_changes_and_rejects_escaping_links(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);(root/'index.html').write_text('first');before=tree_digest(root)
            (root/'index.html').write_text('other');self.assertNotEqual(tree_digest(root),before)
            with patch('helper.nginx_sites',return_value=[{'kind':'static','documentRoot':str(root)}]),patch('helper.os.geteuid',return_value=0,create=True),patch('helper.classify_source',return_value={}):
                cfg={'kind':'static','documentRoot':str(root),'containers':[],'configFiles':[],'externalReferencesConfirmed':True,'exclusiveSourcesConfirmed':True}
                self.assertEqual(static_preflight(cfg),root)
                with self.assertRaises(ValueError):static_preflight({**cfg,'exclusiveSourcesConfirmed':False})
                with self.assertRaises(ValueError):static_preflight({**cfg,'containers':['app']})
                with patch('helper.nginx_sites',return_value=[]):
                    with self.assertRaises(ValueError):static_preflight(cfg)

class TemporaryMemoryTests(unittest.TestCase):
    def test_explicit_temporary_folder_preserves_options(self):
        c={'Id':'123','Name':'/app','HostConfig':{'Tmpfs':{'/tmp':'size=128m,mode=1777'}}}
        self.assertEqual(temporary_mounts(c,[{'container':'app','destination':'/tmp'}]),[('/tmp','size=128m,mode=1777')])
        with self.assertRaises(ValueError):temporary_mounts(c,[])
        c['HostConfig']['Tmpfs']={'/database':'size=128m'}
        with self.assertRaises(ValueError):temporary_mounts(c,[{'container':'app','destination':'/database'}])
        c['HostConfig']['Tmpfs']={'/tmp':'size=128m,unknown=1'}
        with self.assertRaises(ValueError):temporary_mounts(c,[{'container':'app','destination':'/tmp'}])
        for destination in ['/var/cache/nginx','/app/.next/cache']:
            c['HostConfig']['Tmpfs']={destination:'size=8m,mode=0700'}
            self.assertEqual(temporary_mounts(c,[{'container':'app','destination':destination}]),[(destination,'size=8m,mode=0700')])

class FullZipTests(unittest.TestCase):
    def test_static_zip_contains_browsable_files_and_original_archive(self):
        with tempfile.TemporaryDirectory() as d:
            nested=io.BytesIO()
            with tarfile.open(fileobj=nested,mode='w') as t:
                entry=tarfile.TarInfo('website/index.html');entry.size=5;t.addfile(entry,io.BytesIO(b'hello'))
            payload=pathlib.Path(d)/'payload.tar.gz';manifest={'formatVersion':1,'kind':'static','complete':True,'documentRoot':'/var/www/website','configurationFiles':[]}
            with tarfile.open(payload,'w:gz') as t:
                for name,data in [('manifest.json',json.dumps(manifest).encode()),('static-files.tar',nested.getvalue())]:
                    entry=tarfile.TarInfo(name);entry.size=len(data);t.addfile(entry,io.BytesIO(data))
            output=io.BytesIO();export_zip(payload,output)
            with zipfile.ZipFile(output) as z:
                self.assertIsNone(z.testzip());self.assertEqual(z.read('site-files/website/index.html'),b'hello');self.assertEqual(z.read('recovery-originals/static-files.tar'),nested.getvalue());self.assertIn(b'static website',z.read('START-HERE.txt'))
    def test_zip_includes_browsable_data_and_original_recovery_archives(self):
        with tempfile.TemporaryDirectory() as d:
            mount=io.BytesIO()
            with tarfile.open(fileobj=mount,mode='w') as t:
                m=tarfile.TarInfo('source/upload.png');m.size=5;t.addfile(m,io.BytesIO(b'image'))
                m=tarfile.TarInfo('source/duplicate.png');m.type=tarfile.LNKTYPE;m.linkname='source/upload.png';t.addfile(m)
            config=io.BytesIO()
            with tarfile.open(fileobj=config,mode='w') as t:
                m=tarfile.TarInfo('.env');m.size=8;t.addfile(m,io.BytesIO(b'KEY=test'))
            manifest={'formatVersion':1,'complete':True,'containers':[{'Name':'/wordpress','Mounts':[{'Destination':'/var/www/html'}]}],'configurationFiles':['/app/.env']}
            payload=pathlib.Path(d)/'payload.tar.gz'
            with tarfile.open(payload,'w:gz') as t:
                for name,content in [('manifest.json',json.dumps(manifest).encode()),('images.tar',b'images'),('restore-guide.md',b'guide'),('mount-0-0.tar',mount.getvalue()),('config-0.tar',config.getvalue())]:
                    m=tarfile.TarInfo(name);m.size=len(content);t.addfile(m,io.BytesIO(content))
            class Pipe(io.BytesIO):
                def seek(self,*args):raise io.UnsupportedOperation('pipe')
                def tell(self):raise io.UnsupportedOperation('pipe')
            streamed=Pipe();export_zip(payload,streamed)
            output=io.BytesIO(streamed.getvalue())
            with zipfile.ZipFile(output) as z:
                self.assertIsNone(z.testzip())
                self.assertEqual(z.read('site-files/wordpress/var/www/html/upload.png'),b'image')
                self.assertEqual(z.read('site-files/wordpress/var/www/html/duplicate.png'),b'image')
                self.assertEqual(z.read('configuration/app/.env'),b'KEY=test')
                self.assertEqual(z.read('recovery-originals/mount-0-0.tar'),mount.getvalue())
                self.assertEqual(z.read('recovery-originals/images.tar'),b'images')
    def test_unsafe_package_names_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            payload=pathlib.Path(d)/'bad.tar.gz'
            with tarfile.open(payload,'w:gz') as t:t.addfile(tarfile.TarInfo('../outside'))
            with self.assertRaises(ValueError):export_zip(payload,io.BytesIO())

class RestoreNetworkTests(unittest.TestCase):
    def container(self,name,networks,**host):return {'Name':'/'+name,'Config':{'Hostname':name},'HostConfig':host,'NetworkSettings':{'Networks':networks}}
    def test_network_membership_and_service_aliases_remain_separate(self):
        cs=[self.container('app',{'front':{'Aliases':['web']},'back':{'Aliases':['app']}}),self.container('db',{'back':{'Aliases':['database']}})]
        self.assertEqual(restore_network_plan(cs),[{'front':['app','web'],'back':['app']},{'back':['db','database']}])
        self.assertEqual(restore_network_plan(cs[:1]),[{}])
    def test_host_modes_static_ips_and_unsafe_aliases_are_rejected(self):
        for c in [self.container('app',{},Privileged=True),self.container('app',{},NetworkMode='container:production'),self.container('app',{},NetworkMode='host'),self.container('app',{'net':{'Aliases':['--unsafe']}}),self.container('app',{'net':{'IPAMConfig':{'IPv4Address':'172.20.0.2'}}})]:
            with self.assertRaises(ValueError):restore_network_plan([c,self.container('db',{})])
        with self.assertRaises(ValueError):restore_network_plan([])

class ConfigurationFileTests(unittest.TestCase):
    def test_detection_and_browsing_return_paths_and_names_without_file_contents(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'project';root.mkdir();(root/'nested').mkdir()
            (root/'docker-compose.yml').write_text('fixture definition')
            (root/'.env').write_text('DO_NOT_EXPOSE_THIS_VALUE')
            container={'Config':{'Labels':{'com.docker.compose.project':'fixture','com.docker.compose.project.working_dir':str(root),'com.docker.compose.project.config_files':str(root/'docker-compose.yml')}}}
            detected=configuration_paths(container)
            self.assertEqual(detected['composeFiles'],[str(root/'docker-compose.yml')])
            self.assertEqual(detected['configFiles'],[str(root/'.env')])
            with patch('helper.inspect',return_value=[container]):
                listing=list_project_files(['fixture'])
                self.assertIsNone(listing['parent'])
                self.assertEqual({entry['name'] for entry in listing['entries']},{'.env','docker-compose.yml','nested'})
                self.assertNotIn('DO_NOT_EXPOSE_THIS_VALUE',str(listing))
                nested=list_project_files(['fixture'],str(root/'nested'))
                self.assertEqual(nested['parent'],str(root))
                with self.assertRaises(ValueError):list_project_files(['fixture'],d)
                with self.assertRaises(ValueError):list_project_files(['fixture'],str(root/'..'))
    def test_compose_environment_files_are_detected_without_values_or_escaping_paths(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d)/'project';root.mkdir();compose=root/'compose.yml'
            compose.write_text('services:\n  web:\n    env_file: [.env.production]\n  worker:\n    env_file:\n      - .env.worker\n      - ../outside.env\n')
            (root/'.env.production').write_text('PRIVATE=do-not-print');(root/'.env.worker').write_text('OTHER=private');(root.parent/'outside.env').write_text('OUTSIDE=private')
            c={'Config':{'Labels':{'com.docker.compose.project':'app','com.docker.compose.project.working_dir':str(root),'com.docker.compose.project.config_files':str(compose)}}}
            result=configuration_paths(c);self.assertEqual(set(result['configFiles']),{str(root/'.env.production'),str(root/'.env.worker')});self.assertNotIn('do-not-print',str(result))
    def test_standalone_containers_and_unsafe_ids_cannot_enable_arbitrary_browsing(self):
        with patch('helper.inspect',return_value=[{'Config':{'Labels':{}}}]):
            with self.assertRaises(ValueError):list_project_files(['fixture'],'/')
        with self.assertRaises(ValueError):list_project_files(['--unsafe'],'/')
class ArchiveSecurityTests(unittest.TestCase):
    def test_valid_archive_preserves_file(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);archive=base/'input.tar'
            with tarfile.open(archive,'w') as t:
                entry=tarfile.TarInfo('assets/photo.txt');content=b'owned fixture';entry.size=len(content);t.addfile(entry,io.BytesIO(content))
            safe_extract(archive,base/'output')
            self.assertEqual((base/'output/assets/photo.txt').read_bytes(),b'owned fixture')
    def test_escape_and_links_rejected_before_any_extraction(self):
        for kind in ['traversal','absolute','symlink','hardlink','device']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as d:
                base=pathlib.Path(d);archive=base/'bad.tar'
                with tarfile.open(archive,'w') as t:
                    good=tarfile.TarInfo('valid.txt');good.size=1;t.addfile(good,io.BytesIO(b'x'))
                    bad=tarfile.TarInfo('../outside' if kind=='traversal' else '/absolute' if kind=='absolute' else 'evil')
                    if kind=='symlink':bad.type=tarfile.SYMTYPE;bad.linkname='../../outside'
                    if kind=='hardlink':bad.type=tarfile.LNKTYPE;bad.linkname='../../outside'
                    if kind=='device':bad.type=tarfile.CHRTYPE
                    t.addfile(bad)
                with self.assertRaises(ValueError):safe_extract(archive,base/'output')
                self.assertFalse((base/'output/valid.txt').exists())
    def test_internal_links_are_preserved(self):
        import os
        if os.name!='posix':self.skipTest('Link ownership/preservation requires Linux tar')
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);archive=base/'links.tar'
            with tarfile.open(archive,'w') as t:
                entry=tarfile.TarInfo('assets/photo.txt');entry.size=1;t.addfile(entry,io.BytesIO(b'x'))
                soft=tarfile.TarInfo('assets/current');soft.type=tarfile.SYMTYPE;soft.linkname='photo.txt';t.addfile(soft)
                hard=tarfile.TarInfo('assets/copy');hard.type=tarfile.LNKTYPE;hard.linkname='assets/photo.txt';t.addfile(hard)
            safe_extract(archive,base/'output')
            self.assertTrue((base/'output/assets/current').is_symlink())
            self.assertEqual((base/'output/assets/current').read_bytes(),b'x')
            self.assertEqual(os.stat(base/'output/assets/copy').st_ino,os.stat(base/'output/assets/photo.txt').st_ino)
    def test_archive_cannot_write_through_declared_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);archive=base/'bad.tar'
            with tarfile.open(archive,'w') as t:
                link=tarfile.TarInfo('alias');link.type=tarfile.SYMTYPE;link.linkname='safe';t.addfile(link)
                entry=tarfile.TarInfo('alias/file');entry.size=1;t.addfile(entry,io.BytesIO(b'x'))
            with self.assertRaises(ValueError):safe_extract(archive,base/'output')
            self.assertFalse((base/'output/alias').exists())
    def test_chained_symlinks_cannot_escape_destination(self):
        # Each link alone stays inside lexically; followed together they leave the destination.
        for chain in [[('x/y/d','../..'),('x/y/l','d/../..')],[('m','.'),('l','m/m/..')],[('loop1','loop2'),('loop2','loop1')]]:
            with self.subTest(chain=chain), tempfile.TemporaryDirectory() as d:
                base=pathlib.Path(d);archive=base/'chain.tar'
                with tarfile.open(archive,'w') as t:
                    good=tarfile.TarInfo('valid.txt');good.size=1;t.addfile(good,io.BytesIO(b'x'))
                    for name,target in chain:
                        link=tarfile.TarInfo(name);link.type=tarfile.SYMTYPE;link.linkname=target;t.addfile(link)
                with self.assertRaises(ValueError):safe_extract(archive,base/'output')
                self.assertFalse((base/'output/valid.txt').exists())
    def test_extraction_is_refused_before_writing_when_declared_sizes_exceed_free_space(self):
        import collections
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);archive=base/'large.tar'
            with tarfile.open(archive,'w') as t:
                entry=tarfile.TarInfo('data.bin');entry.size=4096;t.addfile(entry,io.BytesIO(b'\0'*4096))
            usage=collections.namedtuple('Usage','total used free')
            with patch('helper.shutil.disk_usage',return_value=usage(1<<40,0,4096)):
                with self.assertRaisesRegex(ValueError,'capacity'):safe_extract(archive,base/'output')
            self.assertFalse((base/'output/data.bin').exists())
            with patch('helper.shutil.disk_usage',return_value=usage(1<<40,0,1<<30)):safe_extract(archive,base/'output')
            self.assertEqual((base/'output/data.bin').stat().st_size,4096)
    def test_contained_symlink_chains_are_accepted(self):
        from helper import archive_link_escapes
        links={('assets','current'):'v2',('assets','v2'):'releases/2',('assets','up'):'../assets'}
        self.assertFalse(archive_link_escapes(('assets',),'v2',links))
        self.assertFalse(archive_link_escapes(('assets',),'current/../photo.txt',links))
        self.assertFalse(archive_link_escapes(('assets',),'up/current',links))
        self.assertTrue(archive_link_escapes(('assets',),'up/../..',links))
        self.assertTrue(archive_link_escapes((),'..',{}))

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        directory_sync=patch('helper.sync_directory');directory_sync.start();self.addCleanup(directory_sync.stop)
    def test_maintenance_flag_is_synced_after_successful_public_probes(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);(base/'ready').touch()
            cfg={'containers':['fixture'],'domains':['fixture.example'],'maintenance':{'required':True,'directory':d,'publicUrl':'http://fixture/'}}
            events=[]
            def probe(m,domains=()):
                self.assertEqual(domains,['fixture.example'])
                events.append(('probe',(base/'enabled').exists()))
                return (503,b'dbm-maintenance-v1') if (base/'enabled').exists() else (200,b'healthy')
            with patch('helper.public_probe',side_effect=probe),patch('helper.health',return_value=True),patch('helper.sync_maintenance_flag',side_effect=lambda directory:events.append(('sync',(directory/'enabled').exists()))):
                maintenance(cfg,True);maintenance(cfg,False)
            self.assertEqual(events,[('probe',True),('sync',True),('probe',False),('sync',False)])
    def test_failed_clear_restores_and_syncs_maintenance_before_completion(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);(base/'ready').touch();(base/'enabled').touch()
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':d,'publicUrl':'http://fixture/'}}
            with patch('helper.health',return_value=True),patch('helper.public_probe',return_value=(503,b'dbm-maintenance-v1')),patch('helper.sync_maintenance_flag') as sync:
                with self.assertRaises(ValueError):maintenance(cfg,False)
                self.assertTrue((base/'enabled').exists());sync.assert_called_once_with(base)
    def test_planted_flag_and_page_links_are_never_followed(self):
        import os
        from helper import deploy_maintenance
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);site=base/'site';site.mkdir();(site/'ready').touch()
            outside=base/'outside.txt';outside.write_text('host file')
            try:os.symlink(outside,site/'enabled')
            except OSError:self.skipTest('Creating symbolic links is not permitted here')
            before=outside.stat().st_mode
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':str(site),'publicUrl':'http://fixture/','readableFlag':True}}
            with patch('helper.public_probe',return_value=(503,b'dbm-maintenance-v1')),patch('helper.sync_maintenance_flag'):
                with self.assertRaisesRegex(ValueError,'symbolic link'):maintenance(cfg,True)
            self.assertEqual(outside.stat().st_mode,before);self.assertEqual(outside.read_text(),'host file')
            (site/'enabled').unlink();os.symlink(outside,site/'maintenance.html.tmp')
            deploy_maintenance({'config':cfg,'html':__import__('base64').b64encode(b'<p>dbm-maintenance-v1</p>').decode()})
            self.assertEqual(outside.read_text(),'host file')
            self.assertEqual((site/'maintenance.html').read_bytes(),b'<p>dbm-maintenance-v1</p>')
            self.assertEqual([p.name for p in site.iterdir() if p.name.startswith('maintenance.html.tmp-')],[])
    def test_planted_fifo_flag_fails_at_once_instead_of_blocking(self):
        import os,threading
        if not hasattr(os,'mkfifo'):self.skipTest('FIFOs require POSIX')
        with tempfile.TemporaryDirectory() as d:
            site=pathlib.Path(d);(site/'ready').touch();os.mkfifo(site/'enabled')
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':d,'publicUrl':'http://fixture/'}}
            outcome=[]
            def attempt():
                with patch('helper.public_probe',return_value=(503,b'dbm-maintenance-v1')),patch('helper.sync_maintenance_flag'):
                    try:maintenance(cfg,True)
                    except ValueError as error:outcome.append(str(error))
            worker=threading.Thread(target=attempt,daemon=True);worker.start();worker.join(5)
            self.assertFalse(worker.is_alive(),'maintenance blocked on a FIFO flag')
            self.assertEqual(len(outcome),1);self.assertIn('regular file',outcome[0])
            # A FIFO with a reader attached opens, but is still not a regular file.
            reader=os.open(site/'enabled',os.O_RDONLY|os.O_NONBLOCK)
            try:
                outcome.clear();worker=threading.Thread(target=attempt,daemon=True);worker.start();worker.join(5)
                self.assertFalse(worker.is_alive());self.assertEqual(len(outcome),1);self.assertIn('regular file',outcome[0])
            finally:os.close(reader)
    def test_origin_https_verifies_original_hostname_on_loopback(self):
        from unittest.mock import Mock
        context=Mock();sock=Mock()
        connection=OriginHTTPSConnection('www.example.org',443,timeout=10,context=context)
        with patch('helper.socket.create_connection',return_value=sock) as connect:
            connection.connect()
        connect.assert_called_once_with(('127.0.0.1',443),10)
        context.wrap_socket.assert_called_once_with(sock,server_hostname='www.example.org')
        context.wrap_socket.side_effect=__import__('ssl').SSLCertVerificationError('certificate mismatch')
        with patch('helper.socket.create_connection',return_value=sock):
            with self.assertRaises(__import__('ssl').SSLCertVerificationError):connection.connect()
        sock.close.assert_called_once()
    def test_origin_probe_preserves_host_and_query_without_following_redirects(self):
        from unittest.mock import Mock
        conn=Mock();response=Mock(status=301);response.read.return_value=b'redirect';conn.getresponse.return_value=response
        with patch('helper.http.client.HTTPConnection',return_value=conn) as connect:
            self.assertEqual(public_probe({'publicUrl':'http://example.invalid:8082/path?x=1','probeOrigin':True}),(301,b'redirect'))
        connect.assert_called_once_with('127.0.0.1',8082,timeout=10)
        conn.request.assert_called_once_with('GET','/path?x=1',headers={'Host':'example.invalid:8082','Cache-Control':'no-cache'})
        conn.close.assert_called_once()
        for url in ['file:///etc/passwd','https://user:secret@example.org/']:
            with self.assertRaises(ValueError):public_probe({'publicUrl':url,'probeOrigin':True})
    def test_readiness_reports_missing_setup_without_mutating_flags(self):
        with tempfile.TemporaryDirectory() as d:
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':d}}
            with patch('helper.preflight',side_effect=ValueError('Select Compose files')),patch('helper.health',return_value=True):result=readiness(cfg)
            self.assertFalse(result['ready']);self.assertTrue(result['readOnly']);self.assertFalse(result['maintenanceActivationTested'])
            self.assertEqual(result['checks'][0]['message'],'Select Compose files')
            checks={item['name']:item for item in result['checks']}
            self.assertTrue(checks['Application health']['ok']);self.assertFalse(checks['Maintenance proxy and website']['ok'])
            self.assertFalse(checks['Per-service database consistency contracts']['ok'])
            self.assertEqual(list(pathlib.Path(d).iterdir()),[])
    def test_failed_activation_restores_previous_flag_state(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);(base/'ready').touch()
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':d,'publicUrl':'http://fixture/'}}
            with patch('helper.fetch',side_effect=OSError('fixture offline')):
                with self.assertRaises(OSError):maintenance(cfg,True)
                self.assertFalse((base/'enabled').exists())
                (base/'enabled').touch()
                with self.assertRaises(OSError):maintenance(cfg,True)
                self.assertTrue((base/'enabled').exists(),'An existing manual maintenance flag is retained')
    def test_http_200_maintenance_page_is_not_application_health(self):
        with patch('helper.inspect',return_value=[{'State':{'Running':True}}]),patch('helper.fetch',return_value=(200,b'<meta content="dbm-maintenance-v1">')):
            self.assertFalse(health(['fixture'],'http://fixture/'))
    def test_health_failure_keeps_maintenance_enabled(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);(base/'ready').touch();(base/'enabled').touch()
            cfg={'containers':['fixture'],'maintenance':{'required':True,'directory':d}}
            with patch('helper.health',return_value=False):
                with self.assertRaises(ValueError):maintenance(cfg,False)
                self.assertTrue((base/'enabled').exists())
class ProbeSsrfTests(unittest.TestCase):
    """Health and public probes run as root on the source host; they must not reach internal services."""
    @staticmethod
    def resolver(table,calls=None):
        import socket
        real=socket.getaddrinfo
        def resolve(host,port,*args,**kw):
            if calls is not None:calls.append(host)
            if host not in table:return real(host,port,*args,**kw)
            return [(socket.AF_INET6 if ':' in a else socket.AF_INET,socket.SOCK_STREAM,6,'',(a,port)) for a in table[host]]
        return resolve
    def serve(self,routes):
        import http.server,threading
        seen=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                seen.append((self.path,self.headers.get('Host')))
                status,headers,body=routes.get(self.path,(404,{},b'missing'))
                self.send_response(status)
                for key,value in headers.items():self.send_header(key,value)
                self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        return server.server_address[1],seen
    def test_metadata_link_local_multicast_unspecified_and_private_literals_are_refused(self):
        from helper import probe_addresses
        for address in ['169.254.169.254','169.254.170.2','fd00:ec2::254','::ffff:169.254.169.254','fe80::1','100.100.100.200','224.0.0.1','ff02::1','0.0.0.0','0.1.2.3','::','240.0.0.1','255.255.255.255','10.0.0.5','172.17.0.2','192.168.1.1','fd12::1','100.64.0.1']:
            with self.assertRaises(ValueError,msg=address):probe_addresses(address,80,['10.0.0.5','192.168.1.1'])
        for address in ['127.0.0.1','127.0.1.1','::1','::ffff:127.0.0.1','1.1.1.1','2606:2800:220:1::1']:self.assertEqual(probe_addresses(address,80),[address.replace('::ffff:','')])
    def test_names_are_resolved_on_the_host_and_every_answer_must_pass(self):
        from helper import probe_addresses
        table={'metadata.example':['169.254.169.254'],'mixed.example':['1.1.1.1','169.254.169.254'],'internal.example':['10.0.0.5'],'site.example':['10.0.0.5'],'loop.example':['127.0.0.1'],'dual.example':['2606:2800:220:1::1','1.1.1.1','1.1.1.1']}
        with patch('helper.socket.getaddrinfo',side_effect=self.resolver(table)):
            for host in ['metadata.example','mixed.example','internal.example']:
                with self.assertRaises(ValueError,msg=host):probe_addresses(host,443,['metadata.example','mixed.example'])
            self.assertEqual(probe_addresses('loop.example',443),['127.0.0.1'])
            self.assertEqual(probe_addresses('dual.example',443),['2606:2800:220:1::1','1.1.1.1'])
            with patch('helper.local_address',return_value=False):
                with self.assertRaises(ValueError):probe_addresses('site.example',443,['site.example'])
            with patch('helper.local_address',return_value=True) as local:
                self.assertEqual(probe_addresses('SITE.example.',443,['site.example']),['10.0.0.5'])
                with self.assertRaises(ValueError):probe_addresses('internal.example',443,['site.example'])
                with self.assertRaises(ValueError):probe_addresses('metadata.example',443,['metadata.example'])
            local.assert_called_once()
        with patch('helper.socket.getaddrinfo',side_effect=OSError('no such host')):
            with self.assertRaises(ValueError):probe_addresses('missing.example',443)
    def test_local_address_only_accepts_addresses_owned_by_this_host(self):
        import ipaddress
        from helper import local_address
        self.assertTrue(local_address(ipaddress.ip_address('127.0.0.1')))
        self.assertFalse(local_address(ipaddress.ip_address('203.0.113.9')))
    def test_connection_is_pinned_to_the_validated_address_with_original_host(self):
        from helper import fetch
        port,seen=self.serve({'/ok':(200,{},b'healthy')});calls=[]
        with patch('helper.socket.getaddrinfo',side_effect=self.resolver({'site.example':['127.0.0.1']},calls)):
            self.assertEqual(fetch('http://site.example:%d/ok'%port,5),(200,b'healthy'))
        self.assertEqual(calls.count('site.example'),1,'One resolution per hop leaves no rebinding window')
        self.assertEqual(seen,[('/ok','site.example:%d'%port)])
        from helper import PinnedHTTPConnection
        with patch('helper.socket.create_connection',side_effect=[OSError('no IPv6 route'),'socket']) as connect:
            connection=PinnedHTTPConnection('site.example',80,['2606:2800:220:1::1','1.1.1.1'],timeout=5);connection.connect()
        self.assertEqual([call.args[0] for call in connect.call_args_list],[('2606:2800:220:1::1',80),('1.1.1.1',80)])
    def test_redirects_stay_on_the_same_host_or_configured_domains_and_are_revalidated(self):
        from helper import fetch
        port,seen=self.serve({'/start':(302,{'Location':'/ok'},b''),'/ok':(200,{},b'healthy'),'/away':(302,{'Location':'http://169.254.169.254/latest/meta-data/'},b''),'/other':(301,{'Location':'http://other.example/ok'},b'moved'),'/rebind':(302,{'Location':'http://www.site.example/'},b''),'/loop':(302,{'Location':'/loop'},b'')})
        table={'site.example':['127.0.0.1'],'www.site.example':['169.254.169.254'],'other.example':['127.0.0.1']}
        with patch('helper.socket.getaddrinfo',side_effect=self.resolver(table)):
            base='http://site.example:%d'%port
            self.assertEqual(fetch(base+'/start',5),(200,b'healthy'))
            self.assertEqual(fetch(base+'/away',5)[0],302)
            self.assertEqual(fetch(base+'/other',5),(301,b'moved'))
            self.assertEqual(fetch(base+'/rebind',5,['site.example','www.site.example'])[0],302,'A refused redirect target fails the probe')
            self.assertEqual(fetch(base+'/loop',5)[0],302)
            with patch('helper.inspect',return_value=[]):
                self.assertFalse(health([],base+'/away'))
                self.assertFalse(health([],base+'/rebind',['www.site.example'],fallback=True))
                self.assertTrue(health([],base+'/start'))
        self.assertNotIn('/latest/meta-data/',[path for path,_ in seen])
        self.assertEqual(sum(path=='/loop' for path,_ in seen),6)
    def test_probe_body_is_capped_and_public_probe_is_validated(self):
        from helper import fetch
        port,_=self.serve({'/big':(200,{},b'x'*(300*1024))})
        self.assertEqual(len(fetch('http://127.0.0.1:%d/big'%port,5)[1]),256*1024)
        for url in ['http://169.254.169.254/','http://[fd00:ec2::254]/','http://10.1.2.3/','file:///etc/passwd','ftp://example.org/','https://user:secret@example.org/']:
            with self.assertRaises(ProbePolicyError,msg=url):public_probe({'publicUrl':url})
            with patch('helper.inspect',return_value=[]):
                with self.assertRaises(ProbePolicyError,msg=url):health([],url)
class ProbePolicyUpgradeTests(unittest.TestCase):
    """Sites saved before the probe policy keep getting backups; refused probe targets are never contacted."""
    def setUp(self):
        import helper
        helper.PROBE_POLICY_FALLBACKS.clear();self.addCleanup(helper.PROBE_POLICY_FALLBACKS.clear)
    def legacy(self,directory='/var/lib/docknest/maintenance/x'):
        return {'containers':['web'],'domains':['www.example.org'],'stagingRoot':'/var/lib/docknest','cleanShutdownConfirmed':True,'maintenance':{'required':True,'directory':directory,'publicUrl':'http://192.168.1.1/','healthUrl':'http://172.17.0.2:8080/'}}
    def test_capture_runs_with_refused_probes_skipped_and_never_contacts_them(self):
        import os,collections
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);maintenance_dir=base/'maintenance';maintenance_dir.mkdir();(maintenance_dir/'ready').touch()
            cfg=self.legacy(str(maintenance_dir));cfg['stagingRoot']=str(base/'staging')
            container={'Id':'web','Image':'image-web','State':{'Running':True},'Mounts':[],'SizeRw':0}
            plan={'fingerprint':'plan','services':[{'container':'web','engine':'generic'}],'restartOrder':['web']}
            events=[];flags=[]
            def docker(*args):
                events.append(args[0])
                return b'[]' if args[:2]==('image','inspect') else b'snapshot' if args[0]=='commit' else b''
            def staging(path):pathlib.Path(path).mkdir(parents=True)
            def journal(path,value):
                if pathlib.Path(path).name=='boot-recovery.json':flags.append(value['config']['_skippedProbes'])
            fetch=Mock();connect=Mock();emitted=Mock()
            with patch.multiple('helper',preflight=Mock(return_value=[container]),backup_plan=Mock(return_value=plan),online_sqlite_checks=Mock(),create_staging_root=Mock(side_effect=staging),docker=Mock(side_effect=docker),mount_exclusions=Mock(return_value={}),atomic_json=Mock(side_effect=journal),prepare_database_shutdown=Mock(),shutdown_evidence=Mock(return_value=[]),revalidate_sources=Mock(),restart_services=Mock(side_effect=lambda *a:events.append('restart')),inspect=Mock(return_value=[container]),complete_recovery=Mock(),sync_maintenance_flag=Mock(),artifact_inventory=Mock(return_value={}),run=Mock(),fetch=fetch,emit=emitted),\
                 patch('helper.socket.create_connection',connect),patch('helper.shutil.disk_usage',return_value=collections.namedtuple('Usage','total used free')(1,0,1<<50)),\
                 patch.object(pathlib.Path,'read_text',return_value='boot'),patch('helper.os.getpgrp',return_value=os.getpid(),create=True),patch('helper.os.fork',return_value=4242,create=True):
                capture({'config':cfg,'job':'00000000-0000-4000-8000-000000000000','planFingerprint':'plan'})
            fetch.assert_not_called();connect.assert_not_called()
            self.assertIn('stop',events);self.assertLess(events.index('stop'),events.index('restart'))
            self.assertEqual(flags,[['health','public']],'Watchdog and boot recovery inherit the skipped probes')
            self.assertFalse((maintenance_dir/'enabled').exists(),'Maintenance is released on container health')
            manifest=emitted.call_args.kwargs['result']['manifest']
            self.assertEqual(manifest['probePolicyFallback'],['health','public'])
    def test_preflight_lists_refused_probes_and_leaves_loopback_origin_and_dns_alone(self):
        from helper import skip_refused_probes,probe_url
        cfg=self.legacy()
        self.assertEqual(sorted(probe_policy_preflight(cfg)),['health','public'])
        for required in [None,1,'yes']:
            self.assertEqual(list(probe_policy_preflight({**cfg,'maintenance':{**cfg['maintenance'],'required':required}})),['health'],'Public probe needs required is True, as on the server')
        cfg['maintenance'].update(healthUrl='http://127.0.0.1:8080/',probeOrigin=True)
        self.assertEqual(probe_policy_preflight(cfg),{})
        cfg['maintenance'].update(probeOrigin=False,healthUrl='http://missing.example/')
        with patch('helper.socket.getaddrinfo',side_effect=OSError('no such host')):self.assertEqual(list(probe_policy_preflight(cfg)),['public'])
        cfg=self.legacy();self.assertEqual(sorted(skip_refused_probes(cfg)),['health','public'])
        self.assertIsNone(probe_url(cfg,'health'));self.assertIsNone(probe_url(cfg,'public'))
        self.assertNotIn('_skippedProbes',json.dumps({k:v for k,v in cfg.items() if not k.startswith('_')}),'Plan fingerprint ignores the skip marker')
    def test_manual_maintenance_enable_is_refused_but_release_never_contacts_refused_targets(self):
        from helper import main
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d)/'ready').touch()
            with patch('helper.emit'):
                with self.assertRaisesRegex(ValueError,r"^Probe URL policy: .*public maintenance URL before enabling maintenance\."):main({'operation':'maintenance','enabled':True,'config':self.legacy(d)})
                self.assertFalse((pathlib.Path(d)/'enabled').exists())
                (pathlib.Path(d)/'enabled').touch();fetch=Mock()
                with patch('helper.inspect',return_value=[{'State':{'Running':True}}]),patch('helper.sync_maintenance_flag'),patch('helper.fetch',fetch):
                    main({'operation':'maintenance','enabled':False,'config':self.legacy(d)})
                fetch.assert_not_called();self.assertFalse((pathlib.Path(d)/'enabled').exists())
    def test_mid_job_policy_refusal_falls_back_to_container_health(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d);(base/'ready').touch();(base/'enabled').touch()
            cfg=self.legacy(d)
            running=[{'State':{'Running':True}}]
            with patch('helper.inspect',return_value=running),patch('helper.sync_maintenance_flag'):
                with self.assertRaises(ProbePolicyError):health(['web'],cfg['maintenance']['healthUrl'],cfg['domains'])
                self.assertTrue(health(['web'],cfg['maintenance']['healthUrl'],cfg['domains'],fallback=True))
                with patch('helper.inspect',return_value=[{'State':{'Running':False}}]):self.assertFalse(health(['web'],cfg['maintenance']['healthUrl'],cfg['domains'],fallback=True))
                maintenance(cfg,False)
            self.assertFalse((base/'enabled').exists(),'A refused probe must not hold the site in maintenance')
            root=base/'job';root.mkdir()
            def write_journal(path,value):pathlib.Path(path).write_text(json.dumps(value))
            with patch('helper.os.getpgid',side_effect=ProcessLookupError,create=True),patch('helper.restart_services'),patch('helper.inspect',return_value=running),patch('helper.maintenance') as flags,patch('helper.atomic_json',side_effect=write_journal),patch('helper.time.sleep') as sleep:
                recover(root,['web'],cfg,0,123)
            flags.assert_called_once_with(cfg,False);sleep.assert_not_called()
            journal=json.loads((root/'recovery.json').read_text())
            self.assertTrue(journal['recovered']);self.assertEqual(journal['probePolicyFallback'],['health','public'])
    def test_readiness_still_names_the_policy_problem(self):
        with patch('helper.preflight',return_value=[]),patch('helper.backup_plan'),patch('helper.inspect',return_value=[]):
            result=readiness({'containers':['web'],'healthUrl':'http://169.254.169.254/','maintenance':{}})
        check={item['name']:item for item in result['checks']}['Application health']
        self.assertFalse(check['ok']);self.assertTrue(check['message'].startswith('Probe URL policy: the URL resolves to a link-local'))
class ProbeDeadlineTests(unittest.TestCase):
    """A probe has one total time budget; a drip-feeding server cannot hold restart or recovery loops."""
    def drip(self,prefix):
        import socket,threading
        listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(5);stop=threading.Event()
        def serve():
            while not stop.is_set():
                try:client,_=listener.accept()
                except OSError:return
                def feed(client=client):
                    try:
                        client.recv(4096);client.sendall(prefix)
                        while not stop.wait(0.2):client.sendall(b'x')
                    except OSError:pass
                    finally:client.close()
                threading.Thread(target=feed,daemon=True).start()
        threading.Thread(target=serve,daemon=True).start()
        self.addCleanup(listener.close);self.addCleanup(stop.set)
        return listener.getsockname()[1]
    def test_drip_fed_headers_and_body_fail_at_the_total_deadline(self):
        import time
        from helper import fetch
        for prefix in [b'HTTP/1.1 200 OK\r\nX-Slow: ',b'HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n']:
            port=self.drip(prefix);started=time.monotonic()
            with self.assertRaises(TimeoutError):fetch('http://127.0.0.1:%d/'%port,1)
            self.assertLess(time.monotonic()-started,3)
            started=time.monotonic()
            with patch('helper.inspect',return_value=[]):self.assertFalse(health([],'http://127.0.0.1:%d/'%port,fallback=True),'A slow probe is a failed probe, not a policy skip')
            self.assertLess(time.monotonic()-started,8)
            import helper;self.assertEqual(helper.PROBE_POLICY_FALLBACKS,[])
    def test_origin_probe_has_the_same_total_deadline(self):
        import time
        port=self.drip(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 100000\r\n\r\n')
        with patch('helper.time.monotonic',side_effect=[0,9.5]+[11]*50):
            with self.assertRaises(TimeoutError):public_probe({'publicUrl':'http://example.invalid:%d/'%port,'probeOrigin':True})
class ProbeRedirectPolicyTests(unittest.TestCase):
    """Redirect hops keep scheme and port, and a refused redirect fails the probe instead of skipping it."""
    def setUp(self):
        import helper
        helper.PROBE_POLICY_FALLBACKS.clear();self.addCleanup(helper.PROBE_POLICY_FALLBACKS.clear)
    def follow(self,start,location,domains=('site.example',),answers=None):
        from helper import fetch
        visited=[]
        def exchange(connection,path,headers,deadline):
            visited.append((type(connection).__name__,connection.host,connection.port))
            return (302,b'moved',location) if len(visited)==1 else (200,b'healthy',None)
        resolve=lambda host,port,domains=():(answers or {}).get(host) or ['127.0.0.1']
        def refuse(host,port,domains=()):
            if host in (answers or {}):raise __import__('helper').ProbePolicyError('the URL resolves to a link-local, cloud metadata or reserved address')
            return ['127.0.0.1']
        with patch('helper.exchange',side_effect=exchange),patch('helper.probe_addresses',side_effect=refuse):
            result=fetch(start,5,domains)
        return result,visited
    def test_scheme_and_port_rules(self):
        followed=[('http://site.example/a','https://site.example/b'),('http://site.example:8080/a','/b'),('https://site.example/a','https://site.example:443/b'),('http://site.example/a','http://www.site.example/'),('http://site.example:8080/a','https://www.site.example/'),('https://site.example:8443/a','https://site.example/')]
        for start,location in followed:
            result,visited=self.follow(start,location,('site.example','www.site.example'))
            self.assertEqual((result,len(visited)),((200,b'healthy'),2),(start,location))
        self.assertEqual(self.follow('http://site.example/a','https://site.example/b')[1][1][0],'PinnedHTTPSConnection')
        refused=[('https://site.example/a','http://site.example/b'),('http://site.example/a','http://site.example:2375/'),('http://site.example:8080/a','http://site.example:8081/'),('http://site.example:8080/a','https://site.example:8443/'),('https://127.0.0.1:8443/a','https://127.0.0.1/'),('http://site.example/a','http://other.example/')]
        for start,location in refused:
            result,visited=self.follow(start,location,('site.example','www.site.example'))
            self.assertEqual((result,len(visited)),((302,b'moved'),1),(start,location))
    def test_refused_redirect_target_fails_the_probe_and_is_not_a_policy_skip(self):
        for location in ['http://user:secret@site.example/ok','gopher://site.example/','http://cfg.example/','http://site.example:99999/']:
            result,visited=self.follow('http://site.example/a',location,('site.example','cfg.example'),{'cfg.example':True})
            self.assertEqual((result,len(visited)),((302,b'moved'),1),location)
            with patch('helper.exchange',side_effect=lambda *a:(302,b'moved',location)),patch('helper.probe_addresses',side_effect=lambda host,*a:(_ for _ in ()).throw(__import__('helper').ProbePolicyError('refused')) if host=='cfg.example' else ['127.0.0.1']),patch('helper.inspect',return_value=[]):
                self.assertFalse(health([],'http://site.example/a',['site.example','cfg.example'],fallback=True),location)
        import helper;self.assertEqual(helper.PROBE_POLICY_FALLBACKS,[],'Only a refused stored URL may be skipped')
        with patch('helper.inspect',return_value=[]):
            self.assertTrue(health([],'http://169.254.169.254/',fallback=True))
        self.assertEqual(helper.PROBE_POLICY_FALLBACKS,['health'])
class ProbeIpv6SpecialRangeTests(unittest.TestCase):
    """6to4 and NAT64 are judged by the IPv4 they carry; other special IPv6 ranges are refused on every Python."""
    def test_embedded_and_special_ipv6_ranges(self):
        from helper import probe_addresses
        for address in ['::a9fe:a9fe','::10.0.0.1','64:ff9b::a9fe:a9fe','64:ff9b::a00:1','64:ff9b::7f00:1','64:ff9b:1::1','2002:a9fe:a9fe::1','2002:a00:1::1','2002:7f00:1::1','2002:6464:64c8::1','2001::1','2001:0:4136:e378::1','2001:db8::1','100::1']:
            with self.assertRaises(ProbePolicyError,msg=address):probe_addresses(address,80,['site.example'])
        for address in ['64:ff9b::101:101','2002:101:101::1','::1']:self.assertEqual(probe_addresses(address,80),[address])
if __name__=='__main__':unittest.main()
