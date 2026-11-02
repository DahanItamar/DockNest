"""Self-heal helper operations (docs/self-heal.md): the event format, the watched-container filter, the connect
snapshot, the bounded stream and the guarded restart. Run: python3 remote/test_heal.py

The fixture remote/fixtures/docker-events-health.jsonl holds lines as `docker events --format HEAL_EVENT_FORMAT` prints
them (the helper's narrow template: ID, action, timeNano, name, Compose project and service, and the two DockNest copy
labels; a missing label prints ""). The Linux integration run (scripts/integration-self-heal.js) captures the live
output of the same template on its Docker and checks this parser against it."""
import unittest, pathlib, json, io, sys, subprocess, contextlib
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

FIXTURE=pathlib.Path(__file__).parent/'fixtures'/'docker-events-health.jsonl'
LINES=FIXTURE.read_text(encoding='utf8').splitlines()
A,B,C='a'*64,'b'*64,'c'*64
WEB={'name':'shop-web-1','project':'shop','service':'web'}
CACHE={'name':'cache','project':None,'service':None}

def container(cid,name,labels=None,running=True,health='unhealthy',check=True):
    state={'Running':running,'Status':'running' if running else 'exited'}
    if health:state['Health']={'Status':health,'FailingStreak':3,'Log':[]}
    return {'Id':cid,'Name':'/'+name,'State':state,'Config':{'Labels':labels or {},'Env':['SECRET=do-not-forward'],'Healthcheck':{'Test':['CMD','true']} if check else None},'HostConfig':{},'Mounts':[]}
COMPOSE={'com.docker.compose.project':'shop','com.docker.compose.service':'web'}

@contextlib.contextmanager
def captured():
    stream=io.StringIO()
    with patch.object(helper,'EVENT_STREAM',stream):yield stream
def lines(stream):return [json.loads(line) for line in stream.getvalue().splitlines()]

class EventFormat(unittest.TestCase):
    def test_both_docker_shapes_parse_to_exactly_five_fields(self):
        first=helper.heal_event(LINES[0],[WEB])
        self.assertEqual(first,{'container':'shop-web-1','status':'unhealthy','at':1762070400.1234567,'id':A,'timeNano':1762070400123456789})
        second=helper.heal_event(LINES[1],[WEB])
        self.assertEqual(set(second),{'container','status','at','id','timeNano'})
        self.assertEqual((second['status'],second['timeNano']),('healthy',1762070460987654321))
        self.assertEqual(helper.heal_event(LINES[2],[WEB])['status'],'starting')
    def test_only_the_five_fields_are_forwarded(self):
        text=json.dumps(helper.heal_event(LINES[0],[WEB]))
        for value in ('project','service','restoreTest','move','action'):self.assertNotIn(value,text)
    def test_the_template_names_only_the_fields_self_heal_reads(self):
        self.assertIn('.Actor.ID',helper.HEAL_EVENT_FORMAT);self.assertIn('.TimeNano',helper.HEAL_EVENT_FORMAT)
        self.assertNotIn('json .}}',helper.HEAL_EVENT_FORMAT,'never the whole event with every label')
    def test_restore_test_and_move_copies_never_match(self):
        self.assertIsNone(helper.heal_event(LINES[3],[WEB]))
        self.assertIsNone(helper.heal_event(LINES[4],[WEB]))
        # Even when the copy is watched by its exact name.
        self.assertIsNone(helper.heal_event(LINES[3],[{'name':'dbm-test-0b5e8d3c1f2a-web','project':None,'service':None}]))
    def test_single_containers_match_by_exact_name_only(self):
        self.assertEqual(helper.heal_event(LINES[5],[CACHE])['container'],'cache')
        self.assertIsNone(helper.heal_event(LINES[5],[{'name':'cache2','project':None,'service':None}]))
        self.assertIsNone(helper.heal_event(LINES[5],[WEB]))
    def test_compose_identity_follows_labels_not_the_name(self):
        # `compose up` recreated the container: a new ID, the same project and service, still healed.
        line=json.loads(LINES[0]);line['id']=B
        self.assertEqual(helper.heal_event(json.dumps(line),[WEB])['id'],B)
        other=json.loads(LINES[0]);other['project']='blog'
        self.assertIsNone(helper.heal_event(json.dumps(other),[WEB]))
    def test_malformed_output_raises_so_the_stream_closes(self):
        base=json.loads(LINES[0])
        bad=[
            'not json',
            json.dumps([1,2]),
            json.dumps({**base,'action':'health_status: sick'}),
            json.dumps({**base,'action':'health_status:unhealthy'}),
            json.dumps({**base,'action':None}),
            json.dumps({**base,'timeNano':'1762070400123456789'}),
            json.dumps({**base,'timeNano':True}),
            json.dumps({**base,'id':'short'}),
            '{"name":"shop-web-1","pad":"%s"}'%('x'*5000),
        ]
        for line in bad:
            with self.subTest(line=line[:60]):self.assertRaises(ValueError,helper.heal_event,line,[WEB])
    def test_unwatched_or_odd_containers_never_close_the_stream(self):
        base=json.loads(LINES[0])
        for line in [json.dumps({**base,'name':'other','project':'blog','id':'short','timeNano':'x','action':'health_status: sick'}),json.dumps({**base,'name':'bad name; rm'}),json.dumps({'Type':'container'}),json.dumps({**base,'project':'blog','action':7})]:
            with self.subTest(line=line[:60]):self.assertIsNone(helper.heal_event(line,[WEB]))
    def test_other_actions_are_ignored(self):
        self.assertIsNone(helper.heal_event(json.dumps({**json.loads(LINES[0]),'action':'start'}),[WEB]))

class Watch(unittest.TestCase):
    def test_watch_entries_are_validated(self):
        for bad in [None,[],[{'name':'a b'}],[{'name':'web','project':'shop'}],[{'name':'web','project':'shop','service':'we b'}],['web'],[{'name':'x'}]*61]:
            with self.subTest(bad=str(bad)[:40]):self.assertRaises(ValueError,helper.heal_watch,{'watch':bad})
    def test_resolve_prefers_saved_name_then_running(self):
        cs=[container(B,'shop-web-2',COMPOSE),container(A,'shop-web-1',COMPOSE),container(C,'dbm-test-1-web',{**COMPOSE,'docknest.restore-test':'1'})]
        self.assertEqual([c and c['Id'] for c in helper.heal_resolve([WEB,CACHE],cs)],[A,None])
        moved=[container(C,'shop-web-1',{**COMPOSE,'docknest.move':'m'})]
        self.assertEqual(helper.heal_resolve([WEB],moved),[None])

class Containers(unittest.TestCase):
    def test_a_container_removed_between_ps_and_inspect_is_left_out(self):
        def run(args,**kw):
            if args[:2]==['docker','ps']:return subprocess.CompletedProcess(args,0,(A+'\n'+B+'\n').encode(),b'')
            return subprocess.CompletedProcess(args,1,json.dumps([container(A,'shop-web-1',COMPOSE)]).encode(),b'Error: No such object')
        with patch.object(helper.subprocess,'run',side_effect=run):self.assertEqual([c['Id'] for c in helper.heal_containers()],[A])
        def gone(args,**kw):
            if args[:2]==['docker','ps']:return subprocess.CompletedProcess(args,0,(A+'\n').encode(),b'')
            return subprocess.CompletedProcess(args,1,b'[]',b'Error')
        with patch.object(helper.subprocess,'run',side_effect=gone):
            self.assertRaises(ValueError,helper.heal_containers)  # Docker failed: reconnect, never 'every container gone'
        def broken(args,**kw):
            if args[:2]==['docker','ps']:return subprocess.CompletedProcess(args,0,(A+'\n').encode(),b'')
            return subprocess.CompletedProcess(args,1,b'',b'Cannot connect to the Docker daemon')
        with patch.object(helper.subprocess,'run',side_effect=broken):self.assertRaises(ValueError,helper.heal_containers)
        def empty(args,**kw):return subprocess.CompletedProcess(args,0,b'',b'')
        with patch.object(helper.subprocess,'run',side_effect=empty):self.assertEqual(helper.heal_containers(),[],'no containers at all is fine')

class Resolve(unittest.TestCase):
    def test_reports_health_checks_and_compose_identity_without_secrets(self):
        cs=[container(A,'shop-web-1',COMPOSE),container(B,'cache',None,health=None,check=False),container(C,'dbm-test-x',{'docknest.restore-test':'1'})]
        with captured() as out,patch.object(helper,'heal_containers',return_value=cs):helper.self_heal_resolve({'names':['shop-web-1','cache','dbm-test-x','gone']})
        result=lines(out)[-1]['result']
        self.assertEqual(result['containers'],[{'name':'shop-web-1','project':'shop','service':'web','healthcheck':True,'running':True,'health':'unhealthy'},{'name':'cache','project':None,'service':None,'healthcheck':False,'running':True,'health':None}])
        self.assertNotIn('do-not-forward',out.getvalue())
    def test_invalid_names_are_refused(self):
        self.assertRaises(ValueError,helper.self_heal_resolve,{'names':['a;b']})
        self.assertRaises(ValueError,helper.self_heal_resolve,{'names':[]})

class FakeProcess:
    def __init__(self,data):self.stdout=io.BytesIO(data);self.pid=999999
def fake_popen(data,calls):
    def popen(args,**kw):calls.append((args,kw));return FakeProcess(data)
    return popen

class Stream(unittest.TestCase):
    def run_stream(self,data,cs,watch=None):
        calls=[]
        with captured() as out,patch.object(helper.os,'killpg',create=True):
            with self.assertRaises(ValueError) as raised:helper.health_events({'watch':watch or [WEB,CACHE]},popen=fake_popen(data,calls),containers=cs,watch_stdin=False)
        return lines(out),calls,str(raised.exception)
    def test_snapshot_first_then_only_watched_events_and_no_since(self):
        cs=[container(A,'shop-web-1',COMPOSE,health='unhealthy'),container(C,'cache',None,health='healthy')]
        data=('\n'.join(LINES)+'\n').encode()
        out,calls,error=self.run_stream(data,cs)
        args,kw=calls[0]
        self.assertEqual(args,['docker','events','--filter','type=container','--filter','event=health_status','--format',helper.HEAL_EVENT_FORMAT])
        self.assertNotIn('--since',args)
        self.assertTrue(kw['start_new_session'])
        self.assertEqual(kw['stderr'],subprocess.DEVNULL)
        self.assertEqual(out[:3],[{'watched':{'index':0,'name':'shop-web-1','id':A}},{'watched':{'index':1,'name':'cache','id':C}},{'watching':2}])
        self.assertEqual([(o['container'],o['status'],o['timeNano']) for o in out[3:5]],[('shop-web-1','unhealthy',0),('cache','healthy',0)])
        streamed=out[5:]
        self.assertEqual([(o['container'],o['status']) for o in streamed],[('shop-web-1','unhealthy'),('shop-web-1','healthy'),('shop-web-1','starting'),('cache','unhealthy')])
        for o in out[3:]:self.assertEqual(set(o),{'container','status','at','id','timeNano'})
        for line in [json.dumps(o) for o in out]:self.assertLess(len(line),400,'every line stays short')
        self.assertEqual(error,'docker events stopped.')
    def test_missing_watched_container_is_reported_as_none(self):
        out,_,_=self.run_stream(b'',[container(C,'cache',None,health='healthy')])
        self.assertEqual(out[:3],[{'watched':{'index':0,'name':None,'id':None}},{'watched':{'index':1,'name':'cache','id':C}},{'watching':2}])
    def test_sixty_watched_containers_fit_in_short_lines(self):
        watch=[{'name':'svc-%02d-%s'%(i,'x'*100),'project':None,'service':None} for i in range(60)]
        cs=[container('%064x'%i,w['name'],None,health='healthy') for i,w in enumerate(watch)]
        out,_,_=self.run_stream(b'',cs,watch=watch)
        self.assertEqual(out[60],{'watching':60})
        self.assertTrue(all(len(json.dumps(o))<4096 for o in out))
    def test_long_or_malformed_lines_close_the_stream(self):
        cs=[container(A,'shop-web-1',COMPOSE,health='healthy')]
        out,_,error=self.run_stream(b'{"name":"shop-web-1","x":"'+b'y'*5000+b'"}\n'+LINES[0].encode()+b'\n',cs)
        self.assertIn('4 KB',error)
        self.assertEqual(len(out),4,'nothing after the long line is forwarded')
        out,_,error=self.run_stream(b'garbage\n'+LINES[0].encode()+b'\n',cs)
        self.assertEqual(len(out),4)
    def test_stdin_close_ends_the_docker_events_group(self):
        killed=[]
        class Proc:
            pid=4242
            def wait(self,timeout):return 0
        with patch.object(helper.os,'killpg',side_effect=lambda pid,sig:killed.append(pid),create=True),patch.object(helper.os,'_exit',side_effect=SystemExit):
            with self.assertRaises(SystemExit):helper.heal_stop_with_stdin(Proc(),read=lambda:'')
        self.assertEqual(killed,[4242])

class Restart(unittest.TestCase):
    def restart(self,current,request=None,code=0,maintenance=False,busy=False):
        runs=[]
        def run(args,**kw):
            runs.append(args)
            if args[:2]==['docker','inspect']:
                if current is None:return subprocess.CompletedProcess(args,1,b'',b'')
                return subprocess.CompletedProcess(args,0,json.dumps([current]).encode(),b'')
            return subprocess.CompletedProcess(args,code,b'',b'secret stderr')
        req={'siteKey':'site-1','name':'shop-web-1','project':'shop','service':'web','containerId':A,'maintenanceDirectory':'/var/lib/docker-backup-manager/maintenance/site-1',**(request or {})}
        with captured() as out,patch.object(helper.subprocess,'run',side_effect=run),patch.object(helper,'heal_lock',return_value=None if busy else True),patch.object(helper.os.path,'lexists',return_value=maintenance):
            helper.self_heal_restart(req,run=run)
        return lines(out)[-1]['result'],runs
    def test_restarts_a_running_unhealthy_container_with_fixed_argv(self):
        result,runs=self.restart(container(A,'shop-web-1',COMPOSE))
        self.assertEqual(result,{'outcome':'restarted'})
        self.assertEqual(runs[-1],['docker','restart','--time','30','shop-web-1'])
    def test_refusals(self):
        cases={
            'not_unhealthy':dict(current=container(A,'shop-web-1',COMPOSE,health='healthy')),
            'not_running':dict(current=container(A,'shop-web-1',COMPOSE,running=False)),
            'labels':dict(current=container(A,'shop-web-1',{'com.docker.compose.project':'other','com.docker.compose.service':'web'})),
            'recreated':dict(current=container(B,'shop-web-1',COMPOSE)),
            'missing':dict(current=None),
            'maintenance':dict(current=container(A,'shop-web-1',COMPOSE),maintenance=True),
            'busy':dict(current=container(A,'shop-web-1',COMPOSE),busy=True),
        }
        for code,kw in cases.items():
            with self.subTest(code=code):
                result,runs=self.restart(**kw)
                self.assertEqual(result,{'outcome':'refused','code':code})
                self.assertFalse(any(args[:2]==['docker','restart'] for args in runs))
        result,_=self.restart(container(A,'shop-web-1',{**COMPOSE,'docknest.restore-test':'t'}))
        self.assertEqual(result['code'],'labels')
    def test_exit_codes_become_fixed_sentences_never_stderr(self):
        result,_=self.restart(container(A,'shop-web-1',COMPOSE),code=1)
        self.assertEqual(result,{'outcome':'failed','code':'exit_1','exitCode':1,'message':'Docker could not restart the container.'})
        result,_=self.restart(container(A,'shop-web-1',COMPOSE),code=9)
        self.assertEqual((result['code'],result['message']),('exit_other','Docker could not restart the container.'))
        self.assertNotIn('secret',json.dumps(result))
    def test_invalid_requests_are_refused(self):
        for bad in [{'containerId':'abc'},{'name':'a b'},{'project':'shop','service':None},{'maintenanceDirectory':'../x'},{'maintenanceDirectory':'relative'},{'siteKey':'../x'}]:
            with self.subTest(bad=bad):self.assertRaises(ValueError,self.restart,container(A,'shop-web-1',COMPOSE),bad)

class CleanupLock(unittest.TestCase):
    """While a server cleanup holds its lock: Safe Edit answers SITE_BUSY (retried by the engine, so a rollback is never
    stranded), self-heal a 'cleanup' refusal; other steps still fail. cleanup-apply watches stdin."""
    def busy(self,*args,**kw):raise ValueError('A server cleanup is running on this server. Try again when it finishes.')
    def test_edit_ops_answer_site_busy_with_copy_facts(self):
        for op in ('edit-prepare','edit-apply','edit-rollback'):
            with self.subTest(op=op),captured() as out,patch.object(helper,'cleanup_shared',side_effect=self.busy),patch.object(helper,'edit_copy_facts',return_value={'dataCopy':'kept'}),patch.object(helper,'edit_id_ok',return_value=True),patch.object(helper,'edit_operation') as run:
                helper.main({'operation':op,'editId':'e'})
                result=lines(out)[-1]['result']
                self.assertEqual((result['ok'],result['code'],result['reason']),(False,'SITE_BUSY',helper.EDIT_REASONS['SITE_BUSY']))
                self.assertEqual(result.get('dataCopy'),'kept' if op!='edit-prepare' else None)
                run.assert_not_called()
    def test_self_heal_restart_is_refused_as_cleanup(self):
        with captured() as out,patch.object(helper,'cleanup_shared',side_effect=self.busy),patch.object(helper,'self_heal_restart') as run:
            helper.main({'operation':'self-heal-restart'})
        self.assertEqual(lines(out)[-1]['result'],{'outcome':'refused','code':'cleanup'});run.assert_not_called()
    def test_other_steps_still_fail(self):
        with patch.object(helper,'cleanup_shared',side_effect=self.busy):self.assertRaises(ValueError,helper.main,{'operation':'capture'})
    def test_cleanup_apply_watches_stdin(self):
        with patch.object(helper,'watch_stdin') as watch,patch.object(helper,'cleanup_apply') as apply:
            helper.main({'operation':'cleanup-apply','watchStdin':True})
        watch.assert_called_once();apply.assert_called_once()

if __name__=='__main__':
    unittest.main()
