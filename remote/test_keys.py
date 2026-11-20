"""App keys and configuration fingerprints (docs/keys-safe.md): rule checks, the keyed fingerprint (a known answer shared
with tests/keys-safe.test.js), env, ini, php-array and file detection, keys in files outside the backup, the proof from
the bytes written into a package (manifest env and archive members), restored-copy fingerprints, and that a key value,
its SHA-256 and its base64 never reach helper stdout. Docker is faked; real Docker runs in scripts/integration-keys-safe.js.
Run: python3 remote/test_keys.py"""
import unittest, tempfile, pathlib, json, io, os, sys, tarfile, hashlib, base64, contextlib
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper_path  # the built helper.py (one file, as servers run it); see helper_path.py
import helper

SECRET=bytes(range(32))
VALUE='base64:'+base64.b64encode(hashlib.sha256(b'made-up test key').digest()).decode()
FORMS=[VALUE,hashlib.sha256(VALUE.encode()).hexdigest(),base64.b64encode(VALUE.encode()).decode(),VALUE[7:]]
RULES=json.loads(r'''[
 {"id":"laravel-app-key","app":"Laravel or Firefly III","kind":"env","name":"APP_KEY"},
 {"id":"rails-secret-key-base","app":"Rails apps","kind":"env","name":"SECRET_KEY_BASE"},
 {"id":"outline-secret-key","app":"Outline","kind":"env","name":"SECRET_KEY","image":["outline"]},
 {"id":"gitea-secret-key","app":"Gitea","kind":"ini","file":"app.ini","section":"security","name":"SECRET_KEY"},
 {"id":"nextcloud-secret","app":"Nextcloud","kind":"php-array","file":"config/config.php","name":"secret"},
 {"id":"vaultwarden-rsa","app":"Vaultwarden","kind":"file","path":"rsa_key.pem"}]''')
REQUEST={'keys':{'fingerprintKey':base64.b64encode(SECRET).decode(),'rules':RULES}}
CONTEXT=helper.key_context(REQUEST)
def fp(rule_id,value):return helper.rule_fingerprint(CONTEXT,{'id':rule_id},value.encode() if isinstance(value,str) else value)
def container(name,env,image='example/app:1',mounts=()):
    return {'Id':'id-'+name,'Name':'/'+name,'Config':{'Image':image,'Env':env},'Mounts':list(mounts)}
def assert_no_value(case,text):
    for form in FORMS:case.assertNotIn(form,text)
def write(path,data):
    os.makedirs(os.path.dirname(path),exist_ok=True)
    with open(path,'wb') as handle:handle.write(data.encode() if isinstance(data,str) else data)
def tar_of(path,members):
    with tarfile.open(path,'w') as archive:
        for name,data in members.items():
            info=tarfile.TarInfo(name);info.size=len(data);archive.addfile(info,io.BytesIO(data))

class Rules(unittest.TestCase):
    def test_the_fingerprint_is_the_keyed_hmac_with_the_shared_known_answer(self):
        self.assertEqual(helper.rule_fingerprint(CONTEXT,{'id':'laravel-app-key'},b'base64:example-value'),'372a976441289f5e938a50f5f0854fa1')
        self.assertNotEqual(fp('laravel-app-key','a'),fp('n8n-encryption-key','a'),'the rule id is part of the input')
        other=helper.key_context({'keys':{'fingerprintKey':base64.b64encode(bytes(32)).decode(),'rules':RULES}})
        self.assertNotEqual(helper.rule_fingerprint(other,{'id':'laravel-app-key'},b'a'),fp('laravel-app-key','a'),'another install gives another fingerprint')

    def test_requests_without_a_valid_key_or_rules_are_refused(self):
        for keys in [None,{},{'fingerprintKey':'not base64!','rules':RULES},{'fingerprintKey':base64.b64encode(bytes(16)).decode(),'rules':RULES},
                     {'fingerprintKey':REQUEST['keys']['fingerprintKey'],'rules':[]},{'fingerprintKey':REQUEST['keys']['fingerprintKey'],'rules':[{'id':'x','app':'x','kind':'file','path':'../etc/shadow'}]},
                     {'fingerprintKey':REQUEST['keys']['fingerprintKey'],'rules':[{'id':'x','app':'x','kind':'env','name':'A','extra':1}]}]:
            self.assertIsNone(helper.key_context({'keys':keys}),keys)
        with self.assertRaises(ValueError):helper.key_scan_operation({'config':{'containers':['web']}})

    def test_env_values_in_env_files_and_compose_files(self):
        text='# app\nexport APP_KEY="%s" # quoted\nOTHER=1\n'%VALUE
        self.assertEqual(helper.assignment_value(text,'APP_KEY'),VALUE)
        self.assertEqual(helper.assignment_value('APP_KEY=%s # comment\n'%VALUE,'APP_KEY'),VALUE)
        compose='services:\n  web:\n    environment:\n      APP_KEY: "%s"\n      - "SECRET_KEY_BASE=abc123"\n'%VALUE
        self.assertEqual(helper.assignment_value(compose,'APP_KEY'),VALUE)
        self.assertEqual(helper.assignment_value(compose,'SECRET_KEY_BASE'),'abc123')
        for skipped in ['APP_KEY=${APP_KEY}\n','APP_KEY: |\n','APP_KEY=\n','#APP_KEY=x\n','MY_APP_KEY=x\n']:self.assertIsNone(helper.assignment_value(skipped,'APP_KEY'),skipped)

    def test_ini_php_and_file_values_and_parse_errors_say_nothing(self):
        self.assertEqual(helper.rule_value(RULES[3],b'APP_NAME = Gitea\n[security]\nINSTALL_LOCK = true\nSECRET_KEY = %s\n'%VALUE.encode()),VALUE.encode())
        self.assertIsNone(helper.rule_value(RULES[3],b'[security\nSECRET_KEY = %s\n'%VALUE.encode()),'a broken ini gives no value and no message')
        self.assertEqual(helper.rule_value(RULES[4],b"<?php\n$CONFIG = array (\n  'instanceid' => 'oc1',\n  'secret' => '%s',\n);\n"%VALUE.encode()),VALUE.encode())
        pem=b'-----BEGIN RSA PRIVATE KEY-----\nmade-up\n-----END RSA PRIVATE KEY-----\n'
        self.assertEqual(helper.rule_value(RULES[5],pem),pem)
        self.assertIsNone(helper.rule_value(RULES[5],b''))

    def test_image_hints_narrow_generic_names(self):
        self.assertTrue(helper.hint_matches(RULES[2],['outlinewiki/outline:0.80']))
        self.assertFalse(helper.hint_matches(RULES[2],['registry.example.com:5000/shop/web:1']))
        self.assertTrue(helper.hint_matches(RULES[0],['anything']))

    def test_compose_env_files_and_where_the_app_keeps_them(self):
        found=helper.compose_env_files('/srv/wiki/compose.yaml',b'services:\n  web:\n    env_file:\n      - extra.env\n      - path: ./secret.env\n        required: false\n  db:\n    env_file: /etc/wiki/db.env\n')
        self.assertEqual(found,['/srv/wiki/.env','/srv/wiki/extra.env','/srv/wiki/secret.env','/etc/wiki/db.env'])
        self.assertEqual(helper.compose_env_files('/srv/a/compose.yaml',b'x:\n  env_file: [one.env, "two.env"]\n'),['/srv/a/.env','/srv/a/one.env','/srv/a/two.env'])

@unittest.skipUnless(os.name=='posix','server paths are POSIX')
class Scans(unittest.TestCase):
    # Plain path strings joined with '/', as on a server.
    def setUp(self):
        self.root=tempfile.mkdtemp();app=self.root+'/srv/wiki';data=self.root+'/volumes/data'
        write(app+'/compose.yaml','services:\n  web:\n    env_file: [.env, extra.env]\n')
        write(app+'/.env','APP_KEY=%s\n'%VALUE)
        write(app+'/extra.env','SECRET_KEY_BASE=made-up-base\n')
        write(data+'/gitea/conf/app.ini','[security]\nSECRET_KEY = gitea-made-up\n')
        write(data+'/config/config.php',"<?php $CONFIG = array('secret' => 'nc-made-up');")
        write(data+'/rsa_key.pem',b'made-up pem\n');write(data+'/.ssh/rsa_key.pem',b'never read\n')
        self.app=app;self.data=data
        self.cfg={'containers':['wiki-web-1'],'composeFiles':[app+'/compose.yaml'],'configFiles':[app+'/.env']}
        self.cs=[container('wiki-web-1',['APP_KEY='+VALUE,'SECRET_KEY=not-outline','PATH=/bin'],mounts=[{'Type':'volume','Source':data,'Destination':'/data'}])]

    def test_a_scan_finds_every_kind_and_reports_fingerprints_only(self):
        hits,files=helper.key_hits(CONTEXT,self.cfg,self.cs)
        found={(hit['rule']['id'],hit['location']):hit['source'] for hit in hits}
        self.assertEqual(found,{
            ('laravel-app-key','env:wiki-web-1'):'env',
            ('laravel-app-key','file:%s/.env'%self.app):'config',
            ('rails-secret-key-base','file:%s/extra.env'%self.app):'outside',
            ('gitea-secret-key','file:%s/gitea/conf/app.ini'%self.data):'mount',
            ('nextcloud-secret','file:%s/config/config.php'%self.data):'mount',
            ('vaultwarden-rsa','file:%s/rsa_key.pem'%self.data):'mount'})
        self.assertEqual([item['path'] for item in files],[self.app+'/compose.yaml',self.app+'/.env',self.app+'/extra.env'])
        self.assertTrue(all(len(hit['fingerprint'])==32 for hit in hits))
        self.assertEqual(next(hit for hit in hits if hit['source']=='env')['fingerprint'],fp('laravel-app-key',VALUE))
        out=io.StringIO()
        with patch('helper.EVENT_STREAM',out),patch('helper.inspect',return_value=self.cs):helper.key_scan_operation({**REQUEST,'config':self.cfg})
        answer=json.loads(out.getvalue())['result']
        self.assertEqual(set(answer),{'keys','files'});self.assertTrue(all(set(item)=={'rule','location','fingerprint'} for item in answer['keys']))
        assert_no_value(self,out.getvalue());self.assertNotIn('made-up',out.getvalue());self.assertNotIn(REQUEST['keys']['fingerprintKey'],out.getvalue())

    def test_the_proof_compares_the_bytes_written_into_the_package(self):
        hits,files=helper.key_hits(CONTEXT,self.cfg,self.cs)
        config=self.root+'/config-1.tar';tar_of(config,{'.env':b'APP_KEY=%s\n'%VALUE.encode()})
        mount=self.root+'/mount-0-0.tar';tar_of(mount,{'data/gitea/conf/app.ini':b'[security]\nSECRET_KEY = gitea-made-up\n','data/rsa_key.pem':b'a different pem\n'})
        packaged={};wanted={}
        for hit in hits:
            if hit['source'] in ('config','mount'):name,member=helper.key_archive_member(hit,self.cfg,self.cs);wanted.setdefault(name,set()).add(member)
        self.assertEqual(wanted,{'config-1.tar':{'.env'},'mount-0-0.tar':{'data/gitea/conf/app.ini','data/config/config.php','data/rsa_key.pem'}})
        with open(config,'rb') as handle:packaged.update({('config-1.tar',k):v for k,v in helper.archive_scan(handle,wanted['config-1.tar'],stream=False)[1].items()})
        with open(mount,'rb') as handle:packaged.update({('mount-0-0.tar',k):v for k,v in helper.archive_scan(handle,wanted['mount-0-0.tar'])[1].items()})
        written=json.loads(json.dumps(self.cs))
        proof=helper.key_proof(CONTEXT,hits,written,lambda hit:packaged.get(helper.key_archive_member(hit,self.cfg,self.cs)),lambda hit:helper.key_missing_reason(hit,self.cs,{}))
        result={(item['rule'],item['inBackup'],item.get('reason')) for item in proof}
        self.assertEqual(result,{('laravel-app-key',True,None),('rails-secret-key-base',False,'not-included'),('gitea-secret-key',True,None),('nextcloud-secret',False,'not-in-package'),('vaultwarden-rsa',False,'differs')})
        # The manifest env as written decides the env key: another value there is not this key.
        changed=[container('wiki-web-1',['APP_KEY=base64:other'])]
        env=next(item for item in helper.key_proof(CONTEXT,[hit for hit in hits if hit['source']=='env'],changed,lambda hit:None,lambda hit:None))
        self.assertEqual((env['inBackup'],env['reason']),(False,'differs'))
        excluded=helper.key_missing_reason(next(hit for hit in hits if hit['rule']['id']=='vaultwarden-rsa'),self.cs,{self.data:[self.data+'/rsa_key.pem']})
        self.assertEqual(excluded,'excluded')
        assert_no_value(self,json.dumps(proof))

    def test_a_streamed_archive_is_scanned_on_the_inventory_pass_with_its_rename_record(self):
        path=self.root+'/stream.tar';tar_of(path,{'data/rsa_key.pem':b'made-up pem\n','data/other':b'x'})
        packaged={};increment={'renames':{}}
        scan=helper.archive_scanner('mount-0-0.tar',{'data/rsa_key.pem'},{'mount-0-0.tar':'key-a'},increment,packaged)
        with open(path,'rb') as handle:scan(handle)
        self.assertEqual(packaged,{('mount-0-0.tar','data/rsa_key.pem'):b'made-up pem\n'});self.assertEqual(increment['renames'],{'key-a':False})
        self.assertEqual(helper.archive_scan(io.BytesIO(b'not a tar'),{'x'},True),(True,{}),'unreadable: renamed and no member')

    def test_a_staged_package_proves_keys_from_its_written_files(self):
        hits,files=helper.key_hits(CONTEXT,self.cfg,self.cs);root=pathlib.Path(self.root)
        tar_of(self.root+'/config-1.tar',{'.env':b'APP_KEY=%s\n'%VALUE.encode()})
        tar_of(self.root+'/mount-0-0.tar',{'data/rsa_key.pem':b'made-up pem\n','data/gitea/conf/app.ini':b'[security]\nSECRET_KEY = gitea-made-up\n',"data/config/config.php":b"<?php $CONFIG = array('secret' => 'nc-made-up');"})
        write(self.root+'/manifest.json',json.dumps({'containers':self.cs}))
        members={}
        for hit in hits:
            if hit['source'] in ('config','mount'):name,member=helper.key_archive_member(hit,self.cfg,self.cs);members.setdefault(name,set()).add(member)
        proof=helper.packaged_keys(CONTEXT,(hits,files),root,False,members,{},self.cfg,self.cs,{})
        self.assertEqual(sorted((item['rule'],item['inBackup']) for item in proof['keys']),[('gitea-secret-key',True),('laravel-app-key',True),('laravel-app-key',True),('nextcloud-secret',True),('rails-secret-key-base',False),('vaultwarden-rsa',True)])
        self.assertEqual(proof['files'],files);assert_no_value(self,json.dumps(proof))
        self.assertIsNone(helper.packaged_keys(CONTEXT,None,root,False,members,{},self.cfg,self.cs,{}),'no key looked for: no proof')
        os.remove(self.root+'/manifest.json')
        self.assertIsNone(helper.packaged_keys(CONTEXT,(hits,files),root,False,members,{},self.cfg,self.cs,{}),'a proof that fails proves nothing')

    def test_a_symlinked_parent_folder_or_a_path_outside_the_root_is_never_read(self):
        outside=self.root+'/outside';write(outside+'/rsa_key.pem',b'outside pem\n');write(outside+'/.env','APP_KEY=outside-made-up\n')
        os.symlink(outside,self.data+'/linked');os.symlink(outside,self.root+'/srvlink')
        self.assertIsNone(helper.read_small(self.data+'/linked/rsa_key.pem',self.data),'a symlinked folder inside the mount')
        self.assertIsNone(helper.read_small(self.root+'/srvlink/.env'),'a symlinked folder above a configuration file')
        self.assertIsNone(helper.read_small(self.data+'/../outside/rsa_key.pem',self.data),'no ..')
        self.assertIsNone(helper.read_small(outside+'/rsa_key.pem',self.data),'outside the mount')
        self.assertEqual(helper.read_small(outside+'/rsa_key.pem'),b'outside pem\n')
        self.assertIsNone(helper.file_fingerprint(CONTEXT,self.root+'/srvlink/.env'))
        hits,files=helper.key_hits(CONTEXT,{**self.cfg,'configFiles':[self.root+'/srvlink/.env']},self.cs)
        self.assertNotIn(self.root+'/srvlink/.env',[item['path'] for item in files])
        self.assertFalse([hit['location'] for hit in hits if 'srvlink' in hit['location'] or 'linked' in hit['location']])

    def test_restored_copy_fingerprints(self):
        expected=[{'rule':'laravel-app-key','location':'env:wiki-web-1'},{'rule':'laravel-app-key','location':'file:/srv/wiki/.env'},{'rule':'vaultwarden-rsa','location':'file:/data/rsa_key.pem'},{'rule':'no-such-rule','location':'env:x'}]
        files={'/srv/wiki/.env':b'APP_KEY=%s\n'%VALUE.encode()}
        result=helper.restored_keys(CONTEXT,expected,lambda service:{'APP_KEY':VALUE} if service=='wiki-web-1' else None,files.get)
        self.assertEqual(result,[{'rule':'laravel-app-key','location':'env:wiki-web-1','fingerprint':fp('laravel-app-key',VALUE)},{'rule':'laravel-app-key','location':'file:/srv/wiki/.env','fingerprint':fp('laravel-app-key',VALUE)},{'rule':'vaultwarden-rsa','location':'file:/data/rsa_key.pem','fingerprint':None}])

    def test_readiness_and_discovery_answers_carry_scans_without_values(self):
        with patch('helper.inspect',return_value=self.cs):scan=helper.readiness_keys({**REQUEST,'config':self.cfg})['keyScan']
        self.assertEqual(len(scan['keys']),6);assert_no_value(self,json.dumps(scan))
        with patch('helper.inspect',side_effect=ValueError('No such container')):self.assertEqual(helper.readiness_keys({**REQUEST,'config':self.cfg}),{})
        self.assertEqual(helper.readiness_keys({'config':self.cfg}),{})
        scans=helper.discover_keys({'keys':{**REQUEST['keys'],'apps':[{'id':'app-1','config':self.cfg},{'id':'app-2','config':{'containers':['gone']}}]}},self.cs)['keyScans']
        self.assertEqual(list(scans),['app-1'])

if __name__=='__main__':unittest.main()
