import test from 'node:test';
import assert from 'node:assert/strict';
import {backupLayout} from '../src/backup-layout.js';
test('backup folders are readable, stable, unique and cannot escape storage',()=>{
 const stamp=new Date('2026-10-01T20:30:00Z');
 const layout=backupLayout({id:'server-1',name:'Production / EU'},{id:'site-1',name:'My Shop'},'backup-1',stamp);
 assert.deepEqual(layout,['production-eu--server-1','my-shop--site-1','2026-10-01','20-30-00Z--backup-1']);
 assert.notDeepEqual(layout,backupLayout({id:'server-2',name:'Production / EU'},{id:'site-1',name:'My Shop'},'backup-1',stamp));
 const unsafe=backupLayout({id:'s1',name:'../../'},{id:'s2',name:'אתר'},'b1',stamp);
 assert.ok(unsafe.every(part=>/^[a-zA-Z0-9_-]+$/.test(part)));
 assert.throws(()=>backupLayout({id:'../escape',name:'Server'},'site','backup',stamp));
});
