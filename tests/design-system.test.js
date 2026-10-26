import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bucketActivity} from '../web/chart-data.js';
import {maintenanceDefaults,normalizeMaintenance,renderMaintenancePage} from '../shared/maintenance-design.js';

test('activity chart groups actual data and excludes old, future and invalid records',()=>{
 const now=new Date('2026-10-02T12:00:00Z'),data=bucketActivity({backups:[{createdAt:'2026-10-02T10:00:00Z',verified:true},{createdAt:'2026-10-01T10:00:00Z',verified:false},{createdAt:'2025-01-01',verified:true},{createdAt:'2026-10-03',verified:true},{createdAt:'invalid'}],jobs:[{createdAt:'2026-10-01T11:00:00Z',status:'completed',type:'restore'},{createdAt:'2026-10-02T11:00:00Z',status:'failed',type:'backup'},{createdAt:'2026-10-02T11:00:00Z',status:'completed',type:'backup'}]},'week',now);
 assert.equal(data.labels.length,7);assert.deepEqual(data.series.map(x=>x.values.reduce((a,b)=>a+b,0)),[1,1,1,1]);
});
test('chart periods change real buckets and include month boundaries',()=>{
 const now=new Date('2026-10-02T12:00:00Z');assert.equal(bucketActivity({},'month',now).labels.length,30);assert.equal(bucketActivity({},'year',now).labels.length,12);
 const state={backups:[{createdAt:'2026-09-01T12:00:00Z',verified:true}],jobs:[]};assert.equal(bucketActivity(state,'week',now).series[0].values.reduce((a,b)=>a+b,0),0);assert.equal(bucketActivity(state,'year',now).series[0].values.reduce((a,b)=>a+b,0),1);
});
test('maintenance design remains compatible with old settings and rejects unsafe values',()=>{
 assert.deepEqual(normalizeMaintenance({title:'Existing title',message:'Existing message',color:'#123456'}),{...maintenanceDefaults,title:'Existing title',message:'Existing message',color:'#123456'});
 assert.deepEqual(normalizeMaintenance({color:"red;background:url(evil)",layout:'injection',theme:'injection',typeScale:'injection'}),maintenanceDefaults);
 const html=renderMaintenancePage({title:'</title><script>evil()</script>',message:'<img onerror="evil()"> & "quotes"'},{art:"x' onerror='evil()",font:"x');color:red"});
 assert.ok(!html.includes('<script>evil()'));assert.ok(!html.includes('<img onerror'));assert.ok(html.includes('&lt;img onerror=&quot;evil()&quot;&gt; &amp; &quot;quotes&quot;'));
 assert.ok(!html.includes("x' onerror"));assert.ok(html.includes('/fonts/Roboto-Latin.woff2'));
});
test('visitor page preserves the maintenance probe marker and availability recovery loop',async()=>{
 const html=await readFile('remote/maintenance.html','utf8');
 assert.ok(html.slice(0,1024).includes('dbm-maintenance-v1'));assert.ok(html.includes("fetch('/__backup_status'"));assert.ok(html.includes('AbortSignal.timeout(4000)'));assert.ok(html.includes('},15000)'));
 assert.ok(html.includes('maintenance-animation'));assert.ok(html.includes('@keyframes site-float'));assert.ok(html.includes('prefers-reduced-motion'));assert.ok(!html.includes('<img'));assert.ok(html.includes('data:font/woff2;base64,'));assert.ok(!html.replace('href="https://github.com/DahanItamar/DockNest"','').includes('https://'),'no external addresses except the Powered by DockNest link');
 const preview=renderMaintenancePage(maintenanceDefaults,{interactive:false});assert.ok(!preview.includes('<script>'));assert.ok(preview.includes(' disabled'));
});
