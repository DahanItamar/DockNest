import test from 'node:test';
import assert from 'node:assert/strict';
import {backupLayout,backupRoot,backupFilename,managerBackupFilename} from '../src/backup-layout.js';
test('backup folders are readable, stable, unique and cannot escape storage',()=>{
 const stamp=new Date('2026-10-01T20:30:00Z');
 const layout=backupLayout({id:'server-1',name:'Production / EU'},{id:'site-1',name:'My Shop'});
 assert.deepEqual(layout,['production-eu--server-1','my-shop--site-1']);
 assert.notDeepEqual(layout,backupLayout({id:'server-2',name:'Production / EU'},{id:'site-1',name:'My Shop'}));
 const unsafe=backupLayout({id:'s1',name:'../../'},{id:'s2',name:'אתר'});
 assert.ok(unsafe.every(part=>/^[a-zA-Z0-9_-]+$/.test(part)));
 assert.throws(()=>backupLayout({id:'../escape',name:'Server'},'site'));
 assert.equal(backupFilename('backup-1',stamp),'backup_2026-10-01_20-30-00Z--backup-1.tar.gz.enc');
 assert.notEqual(backupFilename('backup-1',stamp),backupFilename('backup-2',stamp),'Same-second captures have distinct filenames');
 assert.throws(()=>backupFilename('../escape',stamp));
});
test('the BACKUP root is reused and manager kits are flat, distinct siblings of server folders',()=>{
 assert.equal(backupRoot('/home/docknest/'),'/home/docknest/BACKUP');
 assert.equal(backupRoot('/home/docknest/BACKUP/'),'/home/docknest/BACKUP');
 const file=managerBackupFilename('0123456789abcdef','backup-1',new Date('2026-10-03T12:13:14Z'));
 assert.equal(file,'docknest_0123456789abcdef_2026-10-03_12-13-14Z--backup-1.dkit');
 assert.ok(!file.includes('/'));
 assert.throws(()=>managerBackupFilename('../escape','backup-1'));
});
