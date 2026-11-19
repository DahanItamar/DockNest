# helper/engine_mongo.py: MongoDB 6.0/7.0/8.0 contract, WiredTiger clean-stop proof, ping readiness and document counts.
# <build:header>
# Removed when src/helper-bundle.js joins the modules into one helper.py (one namespace).
# These imports exist only so editors and linters can resolve names.
import sys,json,subprocess,os,time,uuid,pathlib,shutil,signal,urllib.request,urllib.error,urllib.parse,tarfile,re,http.client,threading,ssl,socket,shlex,hashlib,stat,tempfile,sqlite3,io,ipaddress,posixpath,errno
from .common import (
    run)
from .engine_base import (
    DatabaseEngine, in_writable_mount, require_readable_logs, stop_window_gap, writable_mount_source)
# </build:header>
# Static shell, never interpolated. It reads the official image's root credentials inside the container and hands
# them to mongosh as environment variables only: never Docker arguments, evidence, logs or job text.
MONGO_SHELL_SCRIPT='set -eu; command -v mongosh >/dev/null 2>&1 || exit 69; user="${MONGO_INITDB_ROOT_USERNAME:-}"; password="${MONGO_INITDB_ROOT_PASSWORD:-}"; if [ -n "${MONGO_INITDB_ROOT_USERNAME_FILE:-}" ]; then user=$(cat -- "$MONGO_INITDB_ROOT_USERNAME_FILE") || exit 70; fi; if [ -n "${MONGO_INITDB_ROOT_PASSWORD_FILE:-}" ]; then password=$(cat -- "$MONGO_INITDB_ROOT_PASSWORD_FILE") || exit 70; fi; if [ -n "$user" ] && [ -z "$password" ]; then exit 70; fi; export DOCKNEST_MONGO_USER="$user" DOCKNEST_MONGO_PASSWORD="$password" DOCKNEST_MONGO_OPERATION="$1" DOCKNEST_MONGO_DATABASE="$2" DOCKNEST_MONGO_COLLECTION="$3"; exec mongosh --quiet --nodb --norc --eval "$4"'
# Static mongosh script: connects over the loopback, authenticates from process.env, runs one fixed read-only
# operation and prints one EJSON line. Exit codes name the refusal (MONGO_REFUSALS); error text never leaves mongosh.
MONGO_EVAL_SCRIPT='''const env = process.env;
const user = env.DOCKNEST_MONGO_USER, password = env.DOCKNEST_MONGO_PASSWORD;
delete env.DOCKNEST_MONGO_USER; delete env.DOCKNEST_MONGO_PASSWORD;
let admin;
try { admin = connect('mongodb://127.0.0.1:27017/admin?directConnection=true&serverSelectionTimeoutMS=10000'); } catch (error) { quit(75); }
if (user) { try { admin.auth(user, password); } catch (error) { quit(77); } }
const operations = {
  ping: () => admin.runCommand({ ping: 1 }),
  contract: () => ({ version: admin.version(), options: admin.adminCommand({ getCmdLineOpts: 1 }).parsed, hello: admin.adminCommand({ hello: 1 }), storageEngine: admin.serverStatus().storageEngine.name }),
  count: () => ({ count: admin.getSiblingDB(env.DOCKNEST_MONGO_DATABASE).getCollection(env.DOCKNEST_MONGO_COLLECTION).countDocuments({}) }),
};
let result;
try { result = operations[env.DOCKNEST_MONGO_OPERATION](); } catch (error) { quit(error.code === 13 ? (user ? 77 : 78) : 76); }
print(EJSON.stringify(result, { relaxed: true }));'''
MONGO_REFUSALS={
    69:'MongoDB shell (mongosh) is missing in the container; DockNest needs it to check the server and does not pull images',
    70:'MongoDB root credentials in the container are incomplete or their _FILE could not be read',
    75:'MongoDB did not answer a plain local connection on port 27017; TLS-only mode and other ports are not supported',
    77:'MongoDB rejected the root credentials from the container environment',
    78:'MongoDB requires authentication; set MONGO_INITDB_ROOT_USERNAME and MONGO_INITDB_ROOT_PASSWORD (or _FILE) in the container',
}

def mongo_query(container,operation,database='',collection=''):
    """One fixed read-only mongosh operation inside the container; returns its decoded reply."""
    try:output=run(['docker','exec',container,'sh','-c',MONGO_SHELL_SCRIPT,'docknest',operation,database,collection,MONGO_EVAL_SCRIPT],timeout=60)
    except subprocess.CalledProcessError as error:raise ValueError(MONGO_REFUSALS.get(error.returncode,'MongoDB local native query failed; review the server configuration')) from None
    except subprocess.TimeoutExpired:raise ValueError('MongoDB local native query timed out') from None
    lines=[line for line in output.decode(errors='replace').splitlines() if line.startswith('{')]
    try:reply=json.loads(lines[-1])
    except (IndexError,ValueError):raise ValueError('MongoDB local native reply is incomplete') from None
    if not isinstance(reply,dict):raise ValueError('MongoDB local native reply is incomplete')
    return reply

def mongo_log_entries(logs):
    """mongod 4.4+ writes one JSON document per log line; anything else on the stream is ignored."""
    entries=[]
    for line in logs.splitlines():
        try:entry=json.loads(line)
        except ValueError:continue
        if isinstance(entry,dict):entries.append(entry)
    return entries

def mongo_stop_gap(logs):
    entries=mongo_log_entries(logs)
    if any(entry.get('s')=='F' for entry in entries):raise ValueError('MongoDB current stop reported a fatal error')
    if not any(entry.get('msg')=='WiredTiger closed' for entry in entries):return 'WiredTiger closed'
    if not any(entry.get('msg')=='Shutting down' and isinstance(entry.get('attr'),dict) and entry['attr'].get('exitCode')==0 for entry in entries):return 'shutdown exit code 0'
    return None

def mongo_lock_empty(service,c):
    """mongod empties mongod.lock in dbPath on a clean shutdown. Read from the host mount, never through a link."""
    directory=writable_mount_source(service['dataDirectory'],c)
    if directory is None or directory.resolve()!=directory:raise ValueError('MongoDB dbPath must be a captured writable directory without symbolic links')
    try:fd=os.open(directory/'mongod.lock',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError:raise ValueError('MongoDB mongod.lock is missing from dbPath; the clean stop cannot be proven') from None
    except OSError:raise ValueError('MongoDB mongod.lock must be a regular file') from None
    try:metadata=os.fstat(fd)
    finally:os.close(fd)
    if not stat.S_ISREG(metadata.st_mode):raise ValueError('MongoDB mongod.lock must be a regular file')
    if metadata.st_size:raise ValueError('MongoDB mongod.lock is not empty; mongod did not stop cleanly')

def mongo_require_whole_copy(hello):
    """One member's files are a whole copy only for a standalone server or a single-member replica set."""
    if hello.get('arbiterOnly') or hello.get('secondary') or hello.get('isWritablePrimary') is not True:raise ValueError('MongoDB secondaries and arbiters are not supported; back up a standalone server or the only member of its replica set')
    members=[*hello.get('hosts',[]),*hello.get('passives',[]),*hello.get('arbiters',[])]
    if hello.get('setName') and len(members)!=1:raise ValueError('MongoDB replica sets with more than one member are not supported; one member is not a whole copy of the set')

def mongo_check_target(service,check):
    database=check.get('database') or service.get('database')
    if not isinstance(database,str) or not re.fullmatch(r'[a-zA-Z0-9_]{1,63}',database):raise ValueError('MongoDB data checks need a database name of letters, digits and underscores')
    collection=check.get('collection')
    if not isinstance(collection,str) or not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_.-]{0,119}',collection) or collection.startswith('system.'):raise ValueError('MongoDB data checks need a simple collection name')
    return database,collection

class MongoEngine(DatabaseEngine):
    binary='mongod'
    version_pattern=r'\bdb version v(\d+\.\d+\.\d+)\b'
    check_field='collection'

    def check_version(self,version):
        if not re.fullmatch(r'[678]\.0\.\d+',version):raise ValueError('MongoDB native capture is limited to tested MongoDB 6.0, 7.0 and 8.0 versions')

    def validate(self,service,c):
        reply=mongo_query(c['Id'],'contract')
        options,hello=reply.get('options'),reply.get('hello')
        if not isinstance(options,dict) or not isinstance(hello,dict):raise ValueError('MongoDB local native reply is incomplete')
        if reply.get('version')!=service['version']:raise ValueError('Running MongoDB version does not match the installed server binary')
        if reply.get('storageEngine')!='wiredTiger':raise ValueError('MongoDB capture requires the WiredTiger storage engine')
        net=options.get('net') or {}
        if (net.get('tls') or {}).get('mode')=='requireTLS' or (net.get('ssl') or {}).get('mode')=='requireSSL':raise ValueError('MongoDB TLS-only mode is not supported; DockNest checks the server over a plain local connection')
        if (options.get('sharding') or {}).get('clusterRole'):raise ValueError('MongoDB sharded cluster members are not supported')
        mongo_require_whole_copy(hello)
        if (options.get('systemLog') or {}).get('destination'):raise ValueError('MongoDB shutdown proof requires the default log on standard output; remove systemLog.destination')
        require_readable_logs(c,'MongoDB shutdown proof requires readable Docker logs; logging driver none is unsupported','MongoDB Docker logs are unavailable; fix the logging driver before retrying','MongoDB Docker logs are unavailable; enable a readable logging driver before retrying')
        directory=(options.get('storage') or {}).get('dbPath') or '/data/db'
        if not directory.startswith('/') or '..' in pathlib.PurePosixPath(directory).parts or directory=='/' or not in_writable_mount(directory,c):raise ValueError('MongoDB dbPath must be inside a captured writable mount')
        if run(['docker','exec',c['Id'],'readlink','-f',directory],timeout=30).decode().strip()!=directory:raise ValueError('MongoDB dbPath must be a captured writable directory without symbolic links')
        service['dataDirectory']=directory

    def stop_evidence(self,service,c,original,stopped_at,staging_root):
        missing=stop_window_gap(c['Id'],stopped_at,mongo_stop_gap,'MongoDB current shutdown logs timed out; review the Docker logging driver before retrying','MongoDB current shutdown logs could not be read; review the Docker logging driver before retrying')
        if missing:raise ValueError('MongoDB current '+missing+' proof is missing after waiting for log delivery; verify mongod logs to standard output and Docker log retention')
        mongo_lock_empty(service,c)
        return {'cleanShutdownLogVerified':True,'wiredTigerClosedVerified':True,'lockFileEmptyVerified':True}

    def ready(self,cid,service):
        return mongo_query(cid,'ping').get('ok')==1

    def data_check(self,cid,service,check):
        database,collection=mongo_check_target(service,check)
        count=mongo_query(cid,'count',database,collection).get('count')
        if not isinstance(count,int) or isinstance(count,bool) or count<0:raise ValueError('MongoDB data check did not return one count')
        return {'name':check['name'],'database':database,'collection':collection,'sha256':hashlib.sha256(str(count).encode()).hexdigest(),'method':'read-only MongoDB countDocuments'}
