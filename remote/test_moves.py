"""Move helper operations (docs/moving-sites.md) and the golden restore test that proves the shared
restore code paths did not change isolated restore. Run: python3 remote/test_moves.py"""
import unittest, tempfile, pathlib, json, io, hashlib, os, sys
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import helper

GOLDEN=pathlib.Path(__file__).parent/'fixtures'/'restore-golden.json'
JOB='0b5e8d3c-1f2a-4c3d-9e8f-123456789abc'

def fixture_manifest():
    def container(i,name,running,ports=None):
        return {'Id':'c%d'%i,'Name':'/'+name,'State':{'Running':running},'Config':{'Hostname':name,'Image':'img','Env':['DATABASE_URL=postgres://user:secret@10.0.0.5:5432/app','PLAIN=1'],'Labels':{'com.docker.compose.project':'shop'}},
            'HostConfig':{'NetworkMode':'shop_default','RestartPolicy':{'Name':'unless-stopped'},'PortBindings':ports or {},'Tmpfs':{}},
            'NetworkSettings':{'Networks':{'shop_default':{'Aliases':[name]}},'Ports':{}},
            'Mounts':[{'Type':'volume','Name':'shop_data%d'%i,'Source':'/var/lib/docker/volumes/shop_data%d/_data'%i,'Destination':'/data','RW':True},{'Type':'bind','Source':'/srv/shop/config.txt','Destination':'/config.txt','RW':False}]}
    return {'formatVersion':1,'complete':True,'architecture':'x86_64','containers':[container(0,'web',True,{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'8080'}]}),container(1,'db',True)],
        'snapshotImages':['sha256:aaa','sha256:bbb'],'backupPlan':{'services':[],'restartOrder':['c1','c0']},'configurationFiles':[],'temporaryMemoryFolders':[]}

class FakeHost:
    """Records docker invocations and fakes their output; safe_extract creates the one entry a mount archive holds."""
    def __init__(self,root,manifest):
        self.root=pathlib.Path(root);self.manifest=manifest;self.calls=[];self.events=io.StringIO();self.existing=set()
    def docker(self,*args):
        self.calls.append(list(args))
        if args[:2]==('info','--format'):return b'x86_64\n'
        if args[:2]==('version','--format'):return b'29.0.0\n'
        if args[:2]==('network','inspect'):return json.dumps([{'Internal':True,'Options':{'com.docker.network.bridge.gateway_mode_ipv4':'isolated'},'Labels':{}}]).encode()
        if args[:2]==('volume','create'):
            mount=self.root/'volumes'/args[-1]/'_data';mount.mkdir(parents=True);return (args[-1]+'\n').encode()
        if args[:2]==('volume','inspect'):return json.dumps([{'Mountpoint':str(self.root/'volumes'/args[-1]/'_data')}]).encode()
        if args[0]=='create':return (args[args.index('--name')+1]+'-id\n').encode()
        if args[0]=='inspect':return json.dumps([{'Id':a,'State':{'Running':True},'NetworkSettings':{'Networks':{'shop_default':{'IPAddress':'172.18.0.2'}}}} for a in args[1:]]).encode()
        if args[0]=='ps':return b''
        return b''
    def safe_extract(self,archive,destination):
        destination=pathlib.Path(destination);destination.mkdir(parents=True,exist_ok=True)
        name=pathlib.Path(archive).name
        if name=='payload.tar.gz':(destination/'manifest.json').write_text(json.dumps(self.manifest));return
        if name.startswith('mount-') and name.endswith('-1.tar'):(destination/'config.txt').write_text('DATABASE_URL=postgres://u:p@10.0.0.5/app\n');return
        (destination/'entry').mkdir()
    def patches(self):
        return [patch('helper.docker',side_effect=self.docker),patch('helper.safe_extract',side_effect=self.safe_extract),patch('helper.verify_artifacts',return_value=True),
            patch('helper.health',return_value=True),patch('helper.restart_services',return_value=None),patch('helper.EVENT_STREAM',self.events),patch('helper.time.sleep',return_value=None)]
    def result(self):
        return [json.loads(line) for line in self.events.getvalue().splitlines() if line.strip()]

def normalise(value,root):
    text=json.dumps(value,sort_keys=True).replace(json.dumps(str(root))[1:-1],'<ROOT>')
    return json.loads(text.replace('\\\\','/'))

def run_restore(temporary):
    root=pathlib.Path(temporary)/JOB;root.mkdir()
    payload=root/'payload.tar.gz';payload.write_bytes(b'payload')
    host=FakeHost(temporary,fixture_manifest())
    with patch('helper.owned_job_root',return_value=root),patch('helper.shutil.disk_usage',return_value=type('U',(),{'free':10**15})()):
        patches=host.patches()
        for item in patches:item.start()
        try:helper.restore({'job':JOB,'plaintextChecksum':hashlib.sha256(b'payload').hexdigest()})
        finally:
            for item in patches:item.stop()
    return normalise({'docker':host.calls,'events':host.result()},temporary)

class RestoreGoldenTests(unittest.TestCase):
    def test_isolated_restore_commands_and_result_are_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:actual=run_restore(temporary)
        if os.environ.get('DOCKNEST_WRITE_GOLDEN')=='1':GOLDEN.write_text(json.dumps(actual,indent=1,sort_keys=True)+'\n')
        self.assertEqual(actual,json.loads(GOLDEN.read_text()))
        creates=[call for call in actual['docker'] if call[0]=='create']
        self.assertTrue(all(call[call.index('--network')+1].startswith('dbm-restore-') for call in creates))
        self.assertTrue(all('-p' not in call for call in creates),'isolated restore never publishes ports')

if __name__=='__main__':unittest.main()
