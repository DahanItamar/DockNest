import hashlib, json, secrets, subprocess, unittest, tempfile, pathlib, os
from types import SimpleNamespace
from unittest.mock import patch
from helper import service_contracts, validate_database_contracts, redis_query, redis_info, data_checks, shutdown_evidence, restart_services, redis_aof_check


def fixture():
    container={'Id':'redis-id','Image':'sha256:fixture','Name':'/redis-fixture','State':{'Running':True},'Config':{'Image':'redis:7.4','Cmd':['redis-server']},'Mounts':[{'Destination':'/data','RW':True}]}
    service={'container':container['Id'],'engine':'redis','version':'7.4.7','database':'0','user':None,'checks':[{'name':'Fixture value','key':'fixture:key'}]}
    options={'dir':'/data','dbfilename':'dump.rdb','appendonly':'yes','appenddirname':'appendonlydir','appendfilename':'appendonly.aof','save':'3600 1 300 100 60 10000','port':'6379','tls-port':'0','cluster-enabled':'no','aclfile':'','shutdown-on-sigterm':'default','shutdown-on-sigint':'default'}
    infos={'server':{'redis_version':'7.4.7','redis_mode':'standalone'},'replication':{'role':'master','connected_slaves':'0'},'persistence':{'loading':'0','async_loading':'0','rdb_bgsave_in_progress':'0','aof_rewrite_in_progress':'0','aof_rewrite_scheduled':'0','rdb_last_bgsave_status':'ok','aof_enabled':'1','aof_last_write_status':'ok','aof_last_bgrewrite_status':'ok'}}
    acl={'flags':['on'],'commands':'+@all','keys':'~*','channels':'&*','selectors':[]}
    replies={'users':['default'],'modules':[]}
    def query(_container,_service,command,raw=False):
        if command[:2]==['CONFIG','GET']:return [part for pair in options.items() for part in pair]
        if command==['ACL','USERS']:return replies['users']
        if command==['MODULE','LIST']:return replies['modules']
        if command==['ACL','GETUSER','default']:return [part for pair in acl.items() for part in pair]
        raise AssertionError('Unexpected native query')
    return container,service,options,infos,acl,replies,query


class RedisContracts(unittest.TestCase):
    def test_info_verbatim_reply_is_parsed_without_assuming_json(self):
        with patch('helper.redis_query',return_value=b'# Server\r\nredis_version:7.4.7\r\nredis_mode:standalone\r\n') as query:
            self.assertEqual(redis_info('redis',{},'server'),{'redis_version':'7.4.7','redis_mode':'standalone'})
            query.assert_called_once_with('redis',{},['INFO','server'],raw=True)
    def test_auto_detects_native_version_and_rejects_untested_or_mismatched_engines(self):
        container,*_=fixture()
        def binary(args,**_):
            if args[-2]=='redis-server':return b'Redis server v=7.4.7 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=fixture'
            raise subprocess.CalledProcessError(127,args)
        with patch('helper.run',side_effect=binary):
            contract=service_contracts({},[container])[0]
            self.assertEqual((contract['engine'],contract['version']),('redis','7.4.7'))
            with self.assertRaises(ValueError):service_contracts({'services':[{'container':'redis-fixture','engine':'postgres'}]},[container])
        def older(args,**kwargs):return binary(args,**kwargs).replace(b'7.4.7',b'7.2.8')
        with patch('helper.run',side_effect=older):
            with self.assertRaisesRegex(ValueError,'7.4'):service_contracts({},[container])

    def test_primary_persistence_contract_tracks_rdb_and_multipart_aof_paths(self):
        container,service,options,infos,_,_,query=fixture()
        with patch('helper.redis_query',side_effect=query),patch('helper.redis_info',side_effect=lambda _c,_s,section:infos[section]),patch('helper.run',return_value=b'/data\n'):
            validate_database_contracts([service],[container])
        self.assertTrue(service['rdbEnabled']);self.assertTrue(service['aofEnabled'])
        self.assertEqual(service['aofDirectory'],'appendonlydir')
        self.assertNotIn('password',json.dumps(service).lower())

    def test_unhealthy_external_replica_cluster_acl_tls_and_cache_configurations_block(self):
        changes=[('info','replication','role','slave'),('info','replication','connected_slaves','1'),('info','server','redis_mode','sentinel'),('info','persistence','loading','1'),('info','persistence','rdb_last_bgsave_status','err'),('info','persistence','aof_last_write_status','err'),('info','persistence','aof_rewrite_in_progress','1'),('option','dir','/outside'),('option','dbfilename','../outside.rdb'),('option','appenddirname','../outside'),('option','port','6380'),('option','tls-port','6380'),('option','cluster-enabled','yes'),('option','aclfile','users.acl'),('acl','commands','+get'),('reply','users',['default','operator']),('reply','modules',[['name','module']]),('cache',)]
        for change in changes:
            with self.subTest(change=change):
                container,service,options,infos,acl,replies,query=fixture()
                if change[0]=='info':infos[change[1]][change[2]]=change[3]
                elif change[0]=='option':options[change[1]]=change[2]
                elif change[0]=='acl':acl[change[1]]=change[2]
                elif change[0]=='reply':replies[change[1]]=change[2]
                else:options.update({'appendonly':'no','save':''})
                with patch('helper.redis_query',side_effect=query),patch('helper.redis_info',side_effect=lambda _c,_s,section:infos[section]),patch('helper.run',return_value=b'/data\n'):
                    with self.assertRaises(ValueError):validate_database_contracts([service],[container])

    def test_persistence_directory_symlinks_and_read_only_mounts_block(self):
        for read_only in [False,True]:
            container,service,_,infos,_,_,query=fixture()
            if read_only:container['Mounts'][0]['RW']=False
            with patch('helper.redis_query',side_effect=query),patch('helper.redis_info',side_effect=lambda _c,_s,section:infos[section]),patch('helper.run',return_value=b'/other\n'):
                with self.assertRaises(ValueError):validate_database_contracts([service],[container])

    def test_stop_signal_and_persistence_bypass_flags_block_before_stop(self):
        for signal,term,int_flags in [('SIGKILL','default','default'),('SIGQUIT','default','default'),('SIGTERM','nosave','default'),('SIGTERM','force','default'),('SIGINT','default','nosave'),('SIGTERM','save force','default')]:
            with self.subTest(signal=signal,term=term,int_flags=int_flags):
                container,service,options,infos,_,_,query=fixture()
                container['Config']['StopSignal']=signal
                options.update({'shutdown-on-sigterm':term,'shutdown-on-sigint':int_flags})
                with patch('helper.redis_query',side_effect=query),patch('helper.redis_info',side_effect=lambda _c,_s,section:infos[section]),patch('helper.run',return_value=b'/data\n'):
                    with self.assertRaisesRegex(ValueError,'persistence-preserving'):validate_database_contracts([service],[container])

    def test_password_uses_stdin_or_in_container_environment_and_failures_are_redacted(self):
        container,service,*_=fixture();password=secrets.token_urlsafe(24)
        container['Config']['Cmd']=['redis-server','--requirepass',password]
        with patch('helper.inspect',return_value=[container]),patch('helper.run',return_value=b'"PONG"\n') as command:
            self.assertEqual(redis_query(container['Id'],service,['PING']),'PONG')
            args=command.call_args.args[0];self.assertNotIn(password,json.dumps(args))
            self.assertEqual(command.call_args.kwargs['input'],(password+'\n').encode())
            self.assertNotIn('--pass',args);self.assertNotIn('-a',args)
            for name in ['REDISCLI_AUTH','REDIS_PASSWORD','REDIS_PASSWORD_FILE']:self.assertIn(name,args[args.index('-c')+1])
        with patch('helper.inspect',return_value=[container]),patch('helper.run',side_effect=subprocess.CalledProcessError(1,['unsafe'],output=password.encode())):
            with self.assertRaises(ValueError) as caught:redis_query(container['Id'],service,['PING'])
            self.assertNotIn(password,str(caught.exception))

    def test_named_string_binary_digest_is_read_only_and_contains_no_value_or_key(self):
        _,service,*_=fixture();value=b'private value\x00\xff\n'
        with patch('helper.redis_query',side_effect=lambda _c,_s,args,raw=False:value if args[0]=='GET' else 'string') as query:
            result=data_checks('restored',service)
        self.assertEqual([call.args[2][0] for call in query.call_args_list],['TYPE','GET','TYPE'])
        self.assertEqual(result[0]['sha256'],hashlib.sha256(b'string\x00'+value).hexdigest())
        self.assertNotIn('fixture:key',json.dumps(result));self.assertNotIn('private value',json.dumps(result))
        with patch('helper.redis_query',return_value='none'):
            with self.assertRaises(ValueError):data_checks('restored',service)
        with patch('helper.redis_query',side_effect=['string',b'', 'string']):
            self.assertTrue(data_checks('restored',service)[0]['sha256'],'Empty persisted strings remain valid')

    def test_sigkill_nonzero_exit_and_missing_current_log_reject_before_offline_probes(self):
        container,service,*_=fixture();service.update({'rdbEnabled':True,'aofEnabled':True})
        for state in [{'Running':False,'ExitCode':137},{'Running':False,'ExitCode':0,'OOMKilled':True}]:
            with patch('helper.inspect',return_value=[{**container,'State':state}]),patch('helper.run') as native:
                with self.assertRaises(ValueError):shutdown_evidence([service],[container],123)
                native.assert_not_called()
        container['State']={'Running':False,'ExitCode':0}
        with patch('helper.inspect',return_value=[container]),patch('helper.subprocess.run',return_value=subprocess.CompletedProcess([],0,b'Old shutdown evidence',b'')),patch('helper.run') as native:
            with self.assertRaises(ValueError):shutdown_evidence([service],[container],123)
            native.assert_not_called()

    def test_clean_current_stop_requires_read_only_rdb_and_disposable_aof_validation(self):
        container,service,_,infos,_,_,query=fixture()
        with patch('helper.redis_query',side_effect=query),patch('helper.redis_info',side_effect=lambda _c,_s,section:infos[section]),patch('helper.run',return_value=b'/data\n'):validate_database_contracts([service],[container])
        container['State']={'Running':False,'ExitCode':0}
        def proof(args,**_):return b'RDB looks OK!' if 'redis-check-rdb' in args else b'All AOF files and manifest are valid'
        valid_log=b'1:M # Calling fsync() on the AOF file.\n1:M * Saving the final RDB snapshot before exiting.\n1:M * DB saved on disk\n1:M # Redis is now ready to exit, bye bye...\n'
        log=subprocess.CompletedProcess([],0,valid_log,b'')
        with patch('helper.inspect',return_value=[container]),patch('helper.subprocess.run',return_value=log) as logs,patch('helper.run',side_effect=proof) as native,patch('helper.redis_aof_check',return_value={'aofValidationCopyVerified':True,'aofSourceUnchangedVerified':True}) as aof:
            evidence=shutdown_evidence([service],[container],123,'/private-job')[0]
            self.assertTrue(evidence['rdbOfflineVerified']);self.assertTrue(evidence['aofOfflineVerified'])
            self.assertTrue(evidence['aofValidationCopyVerified']);self.assertTrue(evidence['aofSourceUnchangedVerified'])
            self.assertIn('123',logs.call_args.args[0])
            self.assertEqual(len(native.call_args_list),1)
            for call in native.call_args_list:
                args=call.args[0]
                self.assertIn('--read-only',args);self.assertIn('ALL',args);self.assertIn('redis',args);self.assertIn('none',args)
                self.assertNotIn('--fix',args);self.assertIn(container['Image'],args)
            aof.assert_called_once_with(service,container,container,'/private-job')
        with patch('helper.inspect',return_value=[container]),patch('helper.subprocess.run',return_value=log),patch('helper.run',side_effect=subprocess.CalledProcessError(1,['redis-check-aof'])):
            with self.assertRaises(subprocess.CalledProcessError):shutdown_evidence([service],[container],123)
        for invalid in [valid_log.replace(b'DB saved on disk',b'old RDB remains'),valid_log.replace(b'Saving the final RDB snapshot before exiting.',b'No current RDB save'),valid_log.replace(b'Calling fsync() on the AOF file.',b'Calling fsync() on the AOF file.\nFail to fsync the AOF file: disk error')]:
            with patch('helper.inspect',return_value=[container]),patch('helper.subprocess.run',return_value=subprocess.CompletedProcess([],0,invalid,b'')),patch('helper.run') as native:
                with self.assertRaises(ValueError):shutdown_evidence([service],[container],123)
                native.assert_not_called()

    @unittest.skipUnless(hasattr(os,'O_NOFOLLOW'),'Requires Linux file-open semantics')
    def test_aof_native_checker_writes_only_a_disposable_exact_copy(self):
        self.check_aof_copy()

    @unittest.skipUnless(hasattr(os,'O_NOFOLLOW'),'Requires Linux file-open semantics')
    def test_aof_changed_source_copy_and_native_failure_block_and_remove_copy(self):
        for failure in ['source-change','copy-change','native-failure','missing-proof']:
            with self.subTest(failure=failure):self.check_aof_copy(failure)

    def check_aof_copy(self,failure=None):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);source=base/'data';aof=source/'appendonlydir';aof.mkdir(parents=True)
            staging=base/'private-job';staging.mkdir(mode=0o700)
            originals={'appendonly.aof.manifest':b'file appendonly.aof.1.base.rdb seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\n','appendonly.aof.1.base.rdb':b'fixture-rdb','appendonly.aof.1.incr.aof':b'*1\r\n$4\r\nPING\r\n'}
            for name,value in originals.items():(aof/name).write_bytes(value)
            container={'Id':'redis-id','Image':'sha256:fixture','Mounts':[{'Source':str(source),'Destination':'/data','RW':True}]}
            service={'dataDirectory':'/data','aofDirectory':'appendonlydir','aofFilename':'appendonly.aof'}
            def native(args,**kwargs):
                self.assertEqual(kwargs['timeout'],120)
                self.assertNotIn('--volumes-from',args);self.assertNotIn('--fix',args);self.assertNotIn('--truncate-to-timestamp',args)
                for expected in ['none','--read-only','ALL','--memory','--pids-limit','redis-check-aof']:self.assertIn(expected,args)
                mount=args[args.index('--mount')+1]
                self.assertTrue(mount.endswith(',dst=/check'));copy=pathlib.Path(mount[len('type=bind,src='):-len(',dst=/check')])
                self.assertEqual(copy.parent,staging)
                self.assertNotEqual(copy,aof)
                self.assertEqual(args[-1],'/check/appendonly.aof.manifest')
                self.assertEqual({p.name:p.read_bytes() for p in copy.iterdir()},originals)
                # Models Redis 7.4 fopen(r+) and proves that it receives writable files.
                with (copy/'appendonly.aof.1.incr.aof').open('r+b') as stream:self.assertEqual(stream.read(),originals['appendonly.aof.1.incr.aof'])
                if failure=='source-change':(aof/'appendonly.aof.1.incr.aof').write_bytes(b'changed-source')
                if failure=='copy-change':(copy/'appendonly.aof.1.incr.aof').write_bytes(b'changed-copy')
                if failure=='native-failure':raise subprocess.CalledProcessError(1,args)
                return b'no success marker' if failure=='missing-proof' else b'All AOF files and manifest are valid'
            with patch('helper.run',side_effect=native),patch('helper.os.chown',create=True),patch('helper.os.fchown',create=True):
                if failure:
                    with self.assertRaises((ValueError,subprocess.CalledProcessError)):redis_aof_check(service,container,container,staging)
                else:self.assertTrue(redis_aof_check(service,container,container,staging)['aofSourceUnchangedVerified'])
            self.assertEqual(list(staging.iterdir()),[])
            if failure!='source-change':self.assertEqual({p.name:p.read_bytes() for p in aof.iterdir()},originals)

    @unittest.skipUnless(hasattr(os,'O_NOFOLLOW'),'Requires Linux file-open semantics')
    def test_aof_source_replaced_by_symlink_during_copy_never_changes_link_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);source=base/'data';aof=source/'appendonlydir';aof.mkdir(parents=True)
            staging=base/'private-job';staging.mkdir(mode=0o700)
            (aof/'appendonly.aof.manifest').write_bytes(b'manifest')
            member=aof/'appendonly.aof.1.incr.aof';member.write_bytes(b'original-aof')
            victim=base/'unrelated-private-file';victim.write_bytes(b'unchanged-private-bytes');victim.chmod(0o640)
            metadata=victim.stat();before=(victim.read_bytes(),metadata.st_mode,metadata.st_uid,metadata.st_gid)
            container={'Id':'redis-id','Image':'sha256:fixture','Mounts':[{'Source':str(source),'Destination':'/data','RW':True}]}
            service={'dataDirectory':'/data','aofDirectory':'appendonlydir','aofFilename':'appendonly.aof'}
            real_open=os.open;opens=0
            def raced_open(path,flags,*args,**kwargs):
                nonlocal opens
                if pathlib.Path(path)==member:
                    opens+=1
                    if opens==2:
                        # Initial source inventory passed; race occurs at the copy open.
                        member.unlink();member.symlink_to(victim)
                        self.assertTrue(flags&os.O_NOFOLLOW);self.assertTrue(flags&os.O_NONBLOCK)
                return real_open(path,flags,*args,**kwargs)
            with patch('helper.os.open',side_effect=raced_open),patch('helper.run') as native,patch('helper.os.chmod') as chmod,patch('helper.os.chown',create=True) as chown,patch('helper.os.fchmod',create=True) as fchmod,patch('helper.os.fchown',create=True) as fchown:
                with self.assertRaises(OSError):redis_aof_check(service,container,container,staging)
                native.assert_not_called();chmod.assert_not_called();chown.assert_not_called()
                fchmod.assert_not_called();fchown.assert_not_called()
            metadata=victim.stat()
            self.assertEqual((victim.read_bytes(),metadata.st_mode,metadata.st_uid,metadata.st_gid),before)
            self.assertEqual(list(staging.iterdir()),[])

    @unittest.skipUnless(hasattr(os,'O_NOFOLLOW'),'Requires Linux file-open semantics')
    def test_aof_private_staging_source_mapping_and_links_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=pathlib.Path(temporary);source=base/'data';aof=source/'appendonlydir';aof.mkdir(parents=True)
            staging=base/'private-job';staging.mkdir(mode=0o700)
            container={'Id':'redis-id','Image':'sha256:fixture','Mounts':[{'Source':str(source),'Destination':'/data','RW':True}]}
            service={'dataDirectory':'/data','aofDirectory':'appendonlydir','aofFilename':'appendonly.aof'}
            (aof/'appendonly.aof.manifest').write_bytes(b'manifest')
            with patch('helper.run') as native:
                with self.assertRaises(ValueError):redis_aof_check(service,container,container,None)
                staging.chmod(0o755)
                with self.assertRaises(ValueError):redis_aof_check(service,container,container,staging)
                staging.chmod(0o700)
                with self.assertRaises(ValueError):redis_aof_check(service,container,container,source)
                service['dataDirectory']='/outside'
                with self.assertRaises(ValueError):redis_aof_check(service,container,container,staging)
                service['dataDirectory']='/data'
                with patch('helper.shutil.disk_usage',return_value=SimpleNamespace(free=0)):
                    with self.assertRaises(ValueError):redis_aof_check(service,container,container,staging)
                (aof/'nested').mkdir()
                with self.assertRaises(ValueError):redis_aof_check(service,container,container,staging)
                (aof/'nested').rmdir()
                (aof/'link').symlink_to(aof/'appendonly.aof.manifest')
                with self.assertRaises((ValueError,OSError)):redis_aof_check(service,container,container,staging)
                (aof/'link').unlink()
                aof.rename(source/'real-aof');aof.symlink_to(source/'real-aof',target_is_directory=True)
                with self.assertRaises(ValueError):redis_aof_check(service,container,container,staging)
                native.assert_not_called()

    def test_restart_requires_redis_ping_before_starting_dependent_writer(self):
        with patch('helper.docker') as command,patch('helper.health',return_value=True),patch('helper.redis_query',return_value='PONG') as native,patch('helper.database_query') as sql:
            restart_services(['redis-id','writer'],[{'container':'redis-id','engine':'redis'},{'container':'writer','engine':'generic','dependsOn':['redis-id']}])
            self.assertEqual([call.args for call in command.call_args_list],[('start','redis-id'),('start','writer')])
            self.assertTrue(all(call.args[2]==['PING'] for call in native.call_args_list));sql.assert_not_called()


if __name__=='__main__':unittest.main()
