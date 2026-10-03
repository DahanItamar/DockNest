import hashlib, json, secrets, subprocess, unittest
from unittest.mock import patch
from helper import service_contracts, validate_database_contracts, redis_query, data_checks, shutdown_evidence, restart_services


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

    def test_clean_current_stop_requires_read_only_native_rdb_and_aof_validation(self):
        container,service,_,infos,_,_,query=fixture()
        with patch('helper.redis_query',side_effect=query),patch('helper.redis_info',side_effect=lambda _c,_s,section:infos[section]),patch('helper.run',return_value=b'/data\n'):validate_database_contracts([service],[container])
        container['State']={'Running':False,'ExitCode':0}
        def proof(args,**_):return b'RDB looks OK!' if 'redis-check-rdb' in args else b'All AOF files and manifest are valid'
        valid_log=b'1:M # Calling fsync() on the AOF file.\n1:M * Saving the final RDB snapshot before exiting.\n1:M * DB saved on disk\n1:M # Redis is now ready to exit, bye bye...\n'
        log=subprocess.CompletedProcess([],0,valid_log,b'')
        with patch('helper.inspect',return_value=[container]),patch('helper.subprocess.run',return_value=log) as logs,patch('helper.run',side_effect=proof) as native:
            evidence=shutdown_evidence([service],[container],123)[0]
            self.assertTrue(evidence['rdbOfflineVerified']);self.assertTrue(evidence['aofOfflineVerified'])
            self.assertIn('123',logs.call_args.args[0])
            self.assertEqual(len(native.call_args_list),2)
            for call in native.call_args_list:
                args=call.args[0]
                self.assertIn('--read-only',args);self.assertIn('ALL',args);self.assertIn('redis',args);self.assertIn('none',args)
                self.assertNotIn('--fix',args);self.assertIn(container['Image'],args)
            self.assertEqual(native.call_args_list[1].args[0][-1],'/data/appendonlydir/appendonly.aof.manifest')
        with patch('helper.inspect',return_value=[container]),patch('helper.subprocess.run',return_value=log),patch('helper.run',side_effect=subprocess.CalledProcessError(1,['redis-check-aof'])):
            with self.assertRaises(subprocess.CalledProcessError):shutdown_evidence([service],[container],123)
        for invalid in [valid_log.replace(b'DB saved on disk',b'old RDB remains'),valid_log.replace(b'Saving the final RDB snapshot before exiting.',b'No current RDB save'),valid_log.replace(b'Calling fsync() on the AOF file.',b'Calling fsync() on the AOF file.\nFail to fsync the AOF file: disk error')]:
            with patch('helper.inspect',return_value=[container]),patch('helper.subprocess.run',return_value=subprocess.CompletedProcess([],0,invalid,b'')),patch('helper.run') as native:
                with self.assertRaises(ValueError):shutdown_evidence([service],[container],123)
                native.assert_not_called()

    def test_restart_requires_redis_ping_before_starting_dependent_writer(self):
        with patch('helper.docker') as command,patch('helper.health',return_value=True),patch('helper.redis_query',return_value='PONG') as native,patch('helper.database_query') as sql:
            restart_services(['redis-id','writer'],[{'container':'redis-id','engine':'redis'},{'container':'writer','engine':'generic','dependsOn':['redis-id']}])
            self.assertEqual([call.args for call in command.call_args_list],[('start','redis-id'),('start','writer')])
            self.assertTrue(all(call.args[2]==['PING'] for call in native.call_args_list));sql.assert_not_called()


if __name__=='__main__':unittest.main()
