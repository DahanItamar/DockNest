"""Run spec of plain containers (remote/helper/runspec.py): the spec, docker create flags, the Compose file and its
YAML writer, env files, describe-containers, the backup run-definition/ files and discovery hints.
Run: python3 remote/test_runspec.py"""
import unittest, pathlib, json, io, sys, tempfile, importlib.util
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

SECRET='s3cret-value-never-shown'
def shop(**changes):
    """docker run -dit --name shop --hostname shop-host --network shopnet --network-alias store -m 256m --cpus 1.5
    --ulimit nofile=1024:2048 --log-opt max-size=10m --dns 192.0.2.53 --sysctl net.core.somaxconn=1024 --group-add 101
    -p 127.0.0.1:8080:80 -P --stop-timeout 30 --tmpfs /tmp:size=1m --init --cap-drop NET_RAW ... shop:1.2"""
    c={'Id':'0123456789abcdef','Name':'/shop','State':{'Running':True},
        'Config':{'Image':'shop:1.2','Hostname':'shop-host','Domainname':'','Tty':True,'OpenStdin':True,'StopTimeout':30,'ExposedPorts':{'80/tcp':{},'9000/tcp':{}},
            'Env':['PASSWORD='+SECRET,'PATH=/usr/bin','QUOTED=it\'s','MULTI=a\nb'],'Labels':{}},
        'HostConfig':{'NetworkMode':'shopnet','RestartPolicy':{'Name':'on-failure','MaximumRetryCount':3},'PortBindings':{'80/tcp':[{'HostIp':'127.0.0.1','HostPort':'8080'}]},
            'PublishAllPorts':True,'Tmpfs':{'/tmp':'size=1m'},'Memory':268435456,'MemoryReservation':134217728,'MemorySwap':536870912,'NanoCpus':1500000000,
            'CpuShares':512,'CpusetCpus':'0-1','PidsLimit':100,'Ulimits':[{'Name':'nofile','Soft':1024,'Hard':2048}],
            'LogConfig':{'Type':'json-file','Config':{'max-size':'10m'}},'Dns':['192.0.2.53'],'DnsSearch':['example.internal'],'DnsOptions':['ndots:2'],
            'ShmSize':134217728,'Sysctls':{'net.core.somaxconn':'1024'},'GroupAdd':['101'],'ExtraHosts':['db.local:192.0.2.5'],'Init':True,
            'CapDrop':['NET_RAW'],'SecurityOpt':['no-new-privileges:true'],'Runtime':'runc'},
        'NetworkSettings':{'Networks':{'shopnet':{'Aliases':['store','0123456789ab']}}},
        'Mounts':[{'Type':'volume','Name':'shop_data','Source':'/var/lib/docker/volumes/shop_data/_data','Destination':'/data','RW':True},
            {'Type':'bind','Source':'/srv/shop/config','Destination':'/config','RW':False}]}
    for key,value in changes.items():c[key]={**c[key],**value} if isinstance(value,dict) else value
    return c

def parse_yaml(text):
    """Test-only reader for the writer's subset: block maps and lists, JSON-quoted keys and scalars, inline {} and []."""
    lines=[[len(l)-len(l.lstrip(' ')),l.strip()] for l in text.splitlines() if l.strip() and not l.lstrip().startswith('#')]
    decoder=json.JSONDecoder()
    def scalar(value):return {} if value=='{}' else [] if value=='[]' else json.loads(value)
    def key_of(value):
        key,end=decoder.raw_decode(value)
        assert value[end]==':',value
        return key,value[end+1:].strip()
    def block(i,indent):
        if lines[i][1].startswith('-'):
            result=[]
            while i<len(lines) and lines[i][0]==indent and lines[i][1].startswith('-'):
                rest=lines[i][1][1:].strip()
                if not rest:value,i=block(i+1,indent+2)
                elif rest.startswith('"') and ':' in rest[decoder.raw_decode(rest)[1]:][:1]:lines[i]=[indent+2,rest];value,i=block(i,indent+2)
                else:value,i=scalar(rest),i+1
                result.append(value)
            return result,i
        result={}
        while i<len(lines) and lines[i][0]==indent:
            key,rest=key_of(lines[i][1])
            if rest:result[key]=scalar(rest);i+=1
            else:result[key],i=block(i+1,indent+2)
        return result,i
    value,end=block(0,0)
    assert end==len(lines),'unread lines'
    return value

class RunSpecTests(unittest.TestCase):
    def test_the_spec_keeps_every_setting_move_used_to_drop_and_holds_no_env_values(self):
        spec=helper.run_spec(shop())
        self.assertEqual((spec['hostname'],spec['tty'],spec['stdinOpen'],spec['memory'],spec['memoryReservation'],spec['memorySwap']),('shop-host',True,True,268435456,134217728,536870912))
        self.assertEqual((spec['cpus'],spec['cpuShares'],spec['cpusetCpus'],spec['pidsLimit'],spec['shmSize'],spec['stopTimeout']),('1.5',512,'0-1',100,134217728,30))
        self.assertEqual(spec['ulimits'],[{'name':'nofile','soft':1024,'hard':2048}])
        self.assertEqual(spec['logging'],{'driver':'json-file','options':{'max-size':'10m'}})
        self.assertEqual((spec['dns'],spec['dnsSearch'],spec['dnsOptions'],spec['sysctls'],spec['groupAdd']),(['192.0.2.53'],['example.internal'],['ndots:2'],{'net.core.somaxconn':'1024'},['101']))
        self.assertEqual((spec['restart'],spec['network'],spec['networks'],spec['publishAll'],spec['init']),('on-failure:3','shopnet',{'shopnet':['store']},True,True))
        self.assertEqual(spec['tmpfs'],[['/tmp','size=1m']]);self.assertEqual(spec['extraHosts'],['db.local:192.0.2.5'])
        self.assertEqual(spec['mounts'],[{'type':'volume','source':'shop_data','target':'/data','readOnly':False},{'type':'bind','source':'/srv/shop/config','target':'/config','readOnly':True}])
        self.assertEqual(spec['hardening']['capDrop'],['NET_RAW']);self.assertTrue(spec['hardening']['noNewPrivileges'])
        self.assertEqual(spec['environment'],['PASSWORD','PATH','QUOTED','MULTI']);self.assertEqual(spec['unsupported'],[])
        self.assertNotIn(SECRET,json.dumps(spec))
    def test_docker_defaults_are_left_out(self):
        spec=helper.run_spec(shop(Config={'Hostname':'0123456789ab','Tty':False,'OpenStdin':False,'StopTimeout':None},HostConfig={'ShmSize':64*1024*1024,'PidsLimit':-1,'Memory':0,'MemorySwap':0,'NanoCpus':0,'RestartPolicy':{'Name':'no'}}))
        for key in ['hostname','shmSize','pidsLimit','memory','memorySwap','cpus','stopTimeout']:self.assertIsNone(spec[key],key)
        self.assertEqual(spec['restart'],'no');self.assertFalse(spec['tty'])
    def test_settings_it_cannot_recreate_are_named_in_plain_words(self):
        spec=helper.run_spec(shop(HostConfig={'Privileged':True,'Devices':[{'PathOnHost':'/dev/fuse'}],'DeviceRequests':[{'Driver':'nvidia'}],'Runtime':'nvidia','CgroupParent':'/custom',
            'PidMode':'host','IpcMode':'container:other','UTSMode':'host','VolumesFrom':['other'],'LogConfig':{'Type':'syslog','Config':{'syslog-address':'udp://'+SECRET}}}))
        self.assertEqual(spec['unsupported'],['privileged mode','devices','GPUs and other device requests','a custom cgroup parent','volumes from other containers','the nvidia runtime',
            "the host's process namespace","another container's IPC namespace","the host's host name namespace",'the syslog log driver'])
        self.assertIsNone(spec['logging'],'an unsupported log driver keeps Docker\'s default');self.assertNotIn(SECRET,json.dumps(spec))
    def test_unreadable_security_options_and_ram_folders_never_fail_the_spec(self):
        spec=helper.run_spec(shop(HostConfig={'SecurityOpt':['unknown-option=1'],'Tmpfs':{'/weird path':''},'CapAdd':['SYS_ADMIN']}))
        self.assertIn('security options DockNest cannot copy',spec['unsupported']);self.assertIn('RAM folders DockNest cannot recreate',spec['unsupported'])
        self.assertEqual(spec['tmpfs'],[]);self.assertIsNone(spec['hardening'])
        self.assertIn('extra capabilities',helper.run_spec(shop(HostConfig={'CapAdd':['SYS_ADMIN']}))['unsupported'])
        with self.assertRaises(ValueError,msg='a copy refuses the RAM folder with the reason') as refused:helper.create_args(spec,'no','shopnet',[],False)
        self.assertIn('/weird path',str(refused.exception))
    def test_journald_and_tmpfs_mounts(self):
        spec=helper.run_spec(shop(HostConfig={'LogConfig':{'Type':'journald','Config':{}}},Mounts=[{'Type':'tmpfs','Destination':'/run'}]))
        self.assertEqual(spec['unsupported'],['the journald log driver'],'journald may be missing on another server; a tmpfs mount is fine')
        self.assertIsNone(spec['logging'])
    def test_the_host_network_or_host_name_namespace_sets_no_hostname(self):
        for host in [{'NetworkMode':'host'},{'UTSMode':'host'}]:
            spec=helper.run_spec(shop(Config={'Domainname':'example.internal'},HostConfig=host))
            self.assertEqual((spec['hostname'],spec['domainname']),(None,None),host)
        self.assertNotIn("the host's network",helper.run_spec(shop(HostConfig={'NetworkMode':'host'}))['unsupported'])

class CreateArgsTests(unittest.TestCase):
    def test_create_flags_recreate_the_spec(self):
        args=helper.create_args(helper.run_spec(shop()),'on-failure:3','shopnet',['127.0.0.1:8080:80/tcp'],True)
        def pairs(flag):return [args[i+1] for i,a in enumerate(args) if a==flag]
        self.assertEqual(args[:4],['--restart','on-failure:3','--network','shopnet'])
        self.assertEqual(pairs('--network-alias'),['store']);self.assertEqual(pairs('-p'),['127.0.0.1:8080:80/tcp'])
        for flag,value in [('--hostname','shop-host'),('--memory','268435456'),('--memory-reservation','134217728'),('--memory-swap','536870912'),('--cpus','1.5'),('--cpu-shares','512'),
            ('--cpuset-cpus','0-1'),('--pids-limit','100'),('--shm-size','134217728'),('--ulimit','nofile=1024:2048'),('--log-driver','json-file'),('--log-opt','max-size=10m'),
            ('--dns','192.0.2.53'),('--dns-search','example.internal'),('--dns-option','ndots:2'),('--sysctl','net.core.somaxconn=1024'),('--group-add','101'),
            ('--stop-timeout','30'),('--add-host','db.local:192.0.2.5'),('--tmpfs','/tmp:size=1m')]:self.assertEqual(pairs(flag),[value],flag)
        for flag in ['--tty','--interactive','--init','--publish-all']:self.assertIn(flag,args)
        self.assertEqual(pairs('--mount'),['type=volume,src=shop_data,dst=/data','type=bind,src=/srv/shop/config,dst=/config,readonly'])
        self.assertNotIn('-e',args);self.assertNotIn(SECRET,json.dumps(args))
    def test_an_unsupported_log_driver_is_never_passed(self):
        args=helper.create_args(helper.run_spec(shop(HostConfig={'LogConfig':{'Type':'syslog','Config':{'tag':'x'}}})),'no','shopnet',[],False)
        self.assertNotIn('--log-driver',args);self.assertNotIn('--log-opt',args)
    def test_a_test_copy_network_gets_no_aliases_and_cpu_limits_and_sysctls_fit_the_server(self):
        with patch('helper.os.path.exists',side_effect=lambda path:path=='/proc/sys/net/core/somaxconn'):
            spec,notes=helper.fit_host(helper.run_spec(shop(HostConfig={'NanoCpus':8000000000,'CpusetCpus':'0-7','Sysctls':{'net.core.somaxconn':'1024','net.ipv6.conf.all.forwarding':'1','../etc':'1'}})),2)
            kept,none=helper.fit_host(helper.run_spec(shop()),4)
        self.assertEqual((spec['cpus'],spec['cpusetCpus'],spec['sysctls']),('2',None,{'net.core.somaxconn':'1024'}))
        self.assertEqual(notes,['its CPU limit, capped to 2','its CPU set','the sysctl net.ipv6.conf.all.forwarding','the sysctl ../etc'])
        self.assertNotIn('--network-alias',helper.create_args(spec,'no','dn-test-1234',[],False))
        self.assertEqual((kept['cpus'],kept['cpusetCpus'],kept['sysctls'],none),('1.5','0-1',{'net.core.somaxconn':'1024'},[]))
    def test_publish_all_is_the_callers_choice(self):
        spec=helper.run_spec(shop())
        self.assertNotIn('--publish-all',helper.create_args(spec,'no','shopnet',[],False))
        self.assertEqual(helper.unbound_exposed(spec),['9000/tcp'],'80/tcp has its own host port')
        self.assertEqual(helper.unbound_exposed(helper.run_spec(shop(HostConfig={'PublishAllPorts':False}))),[])

    def test_a_mount_without_a_source_is_refused_for_a_copy_and_named_in_the_compose_file(self):
        c=shop(Mounts=[{'Type':'volume','Destination':'/data','RW':True}])
        spec=helper.run_spec(c);self.assertIn('mounts without a source or target',spec['unsupported'])
        with self.assertRaises(ValueError) as refused:helper.create_args(spec,'no','shopnet',[],False)
        self.assertIn('Container shop has a mount without a source or target',str(refused.exception))
        text=helper.compose_document([spec],['shop:1.2']);self.assertIn('Not recreated for shop: mounts without a source or target.',text)
        self.assertNotIn('volumes',parse_yaml(text)['services']['shop'])

class ComposeTests(unittest.TestCase):
    def test_yaml_writer_round_trips_through_json_quoted_scalars(self):
        value={'a':'x: "y" #z','b':{'c':[True,3,{'d':'e','f':[]}],'g':{}},'h':['- not a list','\n']}
        self.assertEqual(parse_yaml('\n'.join(helper.yaml_lines(value))),{'a':'x: "y" #z','b':{'c':['true','3',{'d':'e','f':[]}],'g':{}},'h':['- not a list','\n']})
    def test_compose_file_recreates_the_container_from_the_snapshot_and_names_no_env_value(self):
        text=helper.compose_document([helper.run_spec(shop())],['sha256:snapshot'])
        self.assertNotIn(SECRET,text);self.assertTrue(text.startswith('# Written by DockNest'))
        document=parse_yaml(text);service=document['services']['shop']
        self.assertEqual(document['networks'],{'shopnet':{'name':'shopnet'}});self.assertEqual(document['volumes'],{'shop_data':{'name':'shop_data'}})
        self.assertEqual(service,{'image':'sha256:snapshot','pull_policy':'never','container_name':'shop','labels':{'docknest.original-image':'shop:1.2'},'env_file':['shop.env'],
            'restart':'on-failure:3','networks':{'shopnet':{'aliases':['store']}},'ports':['127.0.0.1:8080:80/tcp','9000/tcp'],'tmpfs':['/tmp:size=1m'],
            'volumes':[{'type':'volume','source':'shop_data','target':'/data'},{'type':'bind','source':'/srv/shop/config','target':'/config','read_only':'true'}],
            'hostname':'shop-host','mem_limit':'268435456','mem_reservation':'134217728','memswap_limit':'536870912','cpus':'1.5','cpu_shares':'512','cpuset':'0-1',
            'pids_limit':'100','shm_size':'134217728','extra_hosts':['db.local:192.0.2.5'],'dns':['192.0.2.53'],'dns_search':['example.internal'],'dns_opt':['ndots:2'],
            'group_add':['101'],'init':'true','tty':'true','stdin_open':'true','ulimits':{'nofile':{'soft':'1024','hard':'2048'}},
            'logging':{'driver':'json-file','options':{'max-size':'10m'}},'sysctls':{'net.core.somaxconn':'1024'},'stop_grace_period':'30s',
            'cap_drop':['NET_RAW'],'security_opt':['no-new-privileges:true']})
    def test_default_bridge_and_what_compose_cannot_hold_are_noted(self):
        c=shop(HostConfig={'NetworkMode':'default','Privileged':True,'SecurityOpt':['seccomp={"defaultAction":"SCMP_ACT_ERRNO"}']},NetworkSettings={'Networks':{'bridge':{}}})
        text=helper.compose_document([helper.run_spec(c)],['shop:1.2'])
        self.assertIn('# Not recreated for shop: privileged mode, its custom seccomp profile (kept in manifest.json).',text)
        service=parse_yaml(text)['services']['shop'];self.assertEqual(service['network_mode'],'bridge');self.assertNotIn('labels',service)
        self.assertNotIn('networks',parse_yaml(text))
    def test_dollar_signs_are_escaped_for_compose_in_every_value(self):
        c=shop(HostConfig={'LogConfig':{'Type':'json-file','Config':{'tag':'app-$HOST'}}},Mounts=[{'Type':'bind','Source':'/srv/$shop','Destination':'/data','RW':True}])
        service=parse_yaml(helper.compose_document([helper.run_spec(c)],['shop:1.2']))['services']['shop']
        self.assertEqual(service['logging']['options'],{'tag':'app-$$HOST'});self.assertEqual(service['volumes'][0]['source'],'/srv/$$shop')
        self.assertEqual(helper.create_args(helper.run_spec(c),'no','shopnet',[],False).count('type=bind,src=/srv/$shop,dst=/data'),1,'docker create gets the value as it is')
    def test_the_host_network_publishes_nothing_and_joins_no_network(self):
        c=shop(HostConfig={'NetworkMode':'host'},NetworkSettings={'Networks':{'host':{}}})
        document=parse_yaml(helper.compose_document([helper.run_spec(c)],['shop:1.2']));service=document['services']['shop']
        self.assertEqual(service['network_mode'],'host')
        for key in ['ports','networks','hostname']:self.assertNotIn(key,service)
        self.assertNotIn('networks',document)
    def test_env_file_quotes_values_literally_and_leaves_out_what_it_cannot_hold(self):
        text=helper.env_file_text(shop())
        self.assertEqual(text,"PASSWORD='%s'\nPATH='/usr/bin'\n# QUOTED is kept in the snapshot image only (its value has a quote or a line break).\n# MULTI is kept in the snapshot image only (its value has a quote or a line break).\n"%SECRET)
    def test_run_definition_is_only_for_containers_started_without_compose(self):
        files=helper.run_definition([shop()],['sha256:snapshot'])
        self.assertEqual(sorted(files),['run-definition/compose.yaml','run-definition/shop.env'])
        self.assertTrue(all(helper.RUN_DEFINITION.fullmatch(name) for name in files))
        self.assertTrue(helper.standalone([shop()]));self.assertFalse(helper.standalone([shop(Config={'Labels':{'com.docker.compose.project':'shop'}})]))

class DescribeContainersTests(unittest.TestCase):
    def describe(self,names,records):
        events=io.StringIO()
        with patch('helper.inspect',side_effect=records) as inspected,patch('helper.EVENT_STREAM',events):helper.describe_containers({'operation':'describe-containers','containers':names})
        return json.loads(events.getvalue()),inspected
    def test_preview_returns_names_only_and_reads_nothing_else(self):
        result,inspected=self.describe(['shop','shop'],lambda ids:[shop()])
        inspected.assert_called_once_with(['shop'])
        self.assertNotIn(SECRET,json.dumps(result));self.assertIn('shop:1.2',result['result']['compose'])
        item=result['result']['containers'][0];self.assertEqual(item['environment'],['PASSWORD','PATH','QUOTED','MULTI']);self.assertEqual(item['unsupported'],[])
    def test_invalid_requests_are_refused_before_docker_is_asked(self):
        for names in [[],['a']*31,['../etc'],['-rf'],'shop',[1]]:
            with self.assertRaises(ValueError,msg=names):self.describe(names,lambda ids:self.fail('inspected'))
    def test_a_missing_container_gets_a_plain_message(self):
        def missing(ids):raise helper.subprocess.CalledProcessError(1,['docker'])
        with self.assertRaises(ValueError) as refused:self.describe(['gone'],missing)
        self.assertIn('not found',str(refused.exception))
    def test_the_dispatcher_runs_the_read_only_operation(self):
        with patch('helper.describe_containers') as describe:helper.main({'operation':'describe-containers','containers':['shop']})
        describe.assert_called_once()

class PackageTests(unittest.TestCase):
    def package(self,root,records):
        (root/'images.tar').write_bytes(b'images')
        artifacts=helper.artifact_inventory(root);manifest={'containers':[],'artifacts':artifacts}
        if records is not None:manifest['runDefinition']=records
        return manifest
    def test_run_definition_files_verify_and_older_packages_without_them_still_do(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary);self.assertTrue(helper.verify_artifacts(root,self.package(root,None)))
            (root/'run-definition').mkdir();(root/'run-definition'/'compose.yaml').write_bytes(b'services: {}\n')
            manifest=self.package(root,{'run-definition/compose.yaml':helper.document_record(b'services: {}\n')})
            self.assertTrue(helper.verify_artifacts(root,manifest))
            (root/'run-definition'/'compose.yaml').write_bytes(b'changed\n')
            with self.assertRaises(ValueError):helper.verify_artifacts(root,manifest)
            (root/'run-definition'/'compose.yaml').write_bytes(b'services: {}\n');(root/'run-definition'/'extra.env').write_bytes(b'X=1\n')
            with self.assertRaises(ValueError,msg='an unexpected file'):helper.verify_artifacts(root,manifest)
    def test_a_run_definition_that_cannot_be_written_never_fails_the_backup(self):
        with patch('helper.run_definition',side_effect=KeyError('x')):self.assertEqual(helper.package_run_definition([shop()],['sha256:s']),{})
        self.assertEqual(helper.package_run_definition([shop(Config={'Labels':{'com.docker.compose.project':'shop'}})],['sha256:s']),{})
        self.assertEqual(sorted(helper.package_run_definition([shop()],['sha256:s'])),['run-definition/compose.yaml','run-definition/shop.env'])
    def test_zip_export_accepts_the_run_definition_entries(self):
        spec=importlib.util.spec_from_file_location('export_zip',pathlib.Path(__file__).parent/'export_zip.py');export_zip=importlib.util.module_from_spec(spec);spec.loader.exec_module(export_zip)
        for name in ['run-definition/compose.yaml','run-definition/shop.env']:self.assertTrue(export_zip.OUTER.fullmatch(name),name)
        for name in ['run-definition/../x.env','run-definition/sub/x.env','run-definition/x.sh']:self.assertIsNone(export_zip.OUTER.fullmatch(name),name)

class DiscoveryHintTests(unittest.TestCase):
    def test_user_networks_and_volumes_are_listed_without_contents(self):
        self.assertEqual(helper.user_networks({'NetworkSettings':{'Networks':{'bridge':{},'shopnet':{},'host':{},'a-net':{}}}}),['a-net','shopnet'])
        lines=b'{"Driver":"local","Labels":"com.docker.compose.project=shop,empty=","Mountpoint":"/var/lib/docker/volumes/shop_data/_data","Name":"shop_data"}\n{"Driver":"local","Labels":"","Name":"loose"}\n'
        with patch('helper.docker',return_value=lines):volumes=helper.discovered_volumes()
        self.assertEqual(volumes,[{'name':'shop_data','driver':'local','labels':{'com.docker.compose.project':'shop','empty':''}},{'name':'loose','driver':'local','labels':{}}])
        with patch('helper.docker',return_value=b''):self.assertEqual(helper.discovered_volumes(),[])
        with patch('helper.docker',side_effect=helper.subprocess.CalledProcessError(1,['docker'])):self.assertIsNone(helper.discovered_volumes(),'a scan never fails on volumes')
    def test_a_container_that_cannot_be_inspected_is_counted_not_fatal(self):
        def inspect(ids):
            if 'gone' in ids:raise helper.subprocess.CalledProcessError(1,['docker'])
            return [{'Id':cid} for cid in ids]
        with patch('helper.inspect',side_effect=inspect):
            self.assertEqual(helper.inspect_each(['a','gone','b']),([{'Id':'a'},{'Id':'b'}],1))
            self.assertEqual(helper.inspect_each(['a']),([{'Id':'a'}],0));self.assertEqual(helper.inspect_each([]),([],0))

class MoveFactsTests(unittest.TestCase):
    def test_the_move_preview_names_settings_unreadable_mounts_and_cpu_limits(self):
        facts=helper.run_spec_facts([shop(),shop(Name='/gpu',HostConfig={'DeviceRequests':[{'Driver':'nvidia'}],'LogConfig':{'Type':'gelf'},'NanoCpus':0,'CpusetCpus':''},Mounts=[{'Type':'volume','Destination':'/data'}])])
        self.assertEqual(facts,{'unsupported':[{'container':'gpu','settings':['GPUs and other device requests','the gelf log driver']}],'unreadableMounts':['gpu'],
            'cpuLimits':[{'container':'shop','cpus':'1.5','cpuset':'0-1'}]})

if __name__=='__main__':unittest.main()
