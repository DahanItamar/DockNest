import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteGroups,sqliteProblem,mergeSqliteFiles,removeSqlitePath,sqliteFailure,pathLines} from '../web/sqlite-files.js';

const services=[
 {container:'web',engine:'generic',sqliteFiles:['/data/app.db','/data/sessions.db'],sqliteVersion:'3.45.1',sqliteSigtermConfirmed:true},
 {container:'worker',engine:'generic',sqliteFiles:['/data/app.db','/data/sessions.db'],sqliteVersion:'3.45.1',sqliteSigtermConfirmed:false},
 {container:'queue',engine:'generic',sqliteFiles:['/data/queue.db'],sqliteVersion:'3.45.1'},
 {container:'proxy',engine:'generic',sqliteFiles:[]},
 {container:'cache',engine:'generic'}
];

test('identical non-empty lists collapse into one shared group; empty lists never do',()=>{
 const groups=sqliteGroups(services);
 assert.deepEqual(groups.map(g=>[g.containers,g.shared]),[[['web','worker'],true],[['queue'],false],[['proxy'],false],[['cache'],false]]);
 assert.equal(groups[0].version,'3.45.1');
});

test('merging changes only sqliteFiles of edited services',()=>{
 const merged=mergeSqliteFiles(services,{web:'/data/a.db\n\n /data/b.db ',worker:'/data/a.db\n/data/b.db'});
 assert.deepEqual(merged[0],{...services[0],sqliteFiles:['/data/a.db','/data/b.db']});
 assert.equal(merged[2],services[2]);
 assert.equal(merged[0].sqliteVersion,'3.45.1');assert.equal(merged[0].sqliteSigtermConfirmed,true);assert.equal(merged[0].engine,'generic');
});

test('problems: relative or odd paths, duplicates, and SIGTERM acceptance without files',()=>{
 assert.match(sqliteProblem(services,{web:'data/app.db'}),/absolute/);
 assert.match(sqliteProblem(services,{web:'/data/../x.db'}),/absolute/);
 assert.match(sqliteProblem(services,{web:'/a.db\n/a.db'}),/twice/);
 assert.match(sqliteProblem(services,{web:''}),/SIGTERM/);
 assert.equal(sqliteProblem(services,{worker:''}),'');
 assert.equal(sqliteProblem(services,{}),'');
 assert.deepEqual(pathLines(' /a\r\n\n/b '),['/a\r'.trim(),'/b']);
});

test('remove path takes the path out of every service that declares it',()=>{
 const result=removeSqlitePath(services,'/data/app.db');
 assert.deepEqual(result.containers,['web','worker']);
 assert.deepEqual(result.services[0].sqliteFiles,['/data/sessions.db']);
 assert.equal(result.services[2],services[2]);
});

test('helper messages are recognised, other errors are not',()=>{
 assert.deepEqual(sqliteFailure('SQLite database file is missing or not a regular file: /data/app.db'),{kind:'missing',path:'/data/app.db'});
 assert.deepEqual(sqliteFailure('x SQLite database path contains a symbolic link: /data/a-b.db'),{kind:'link',path:'/data/a-b.db'});
 assert.deepEqual(sqliteFailure('SQLite database path is unreadable or contains a symbolic link'),{kind:'legacy',path:null});
 assert.equal(sqliteFailure('Backup plan changed'),null);
 assert.equal(sqliteFailure(null),null);
});
