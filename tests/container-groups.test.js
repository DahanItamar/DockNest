import test from 'node:test';
import assert from 'node:assert/strict';
import {containerGroups} from '../web/container-groups.js';
test('site groups use Compose evidence, include stopped services and never guess from names',()=>{
 const rows=[{name:'shop-web',labels:{'com.docker.compose.project':'shop'}},{name:'shop-db',state:'exited',Config:{Labels:{'com.docker.compose.project':'shop'}}},{name:'shop-unrelated'},{name:'other-web',labels:{'com.docker.compose.project':'other'}}];
 const groups=containerGroups(rows);
 assert.deepEqual(groups.find(g=>!g.compose).containers.map(c=>c.name),['shop-unrelated']);
 assert.deepEqual(groups.filter(g=>g.compose).map(g=>[g.name,g.containers.map(c=>c.name)]),[['other',['other-web']],['shop',['shop-web','shop-db']]]);
});

test('group identities separate Compose and Swarm with identical names and reserved-looking projects',()=>{
 const groups=containerGroups([
  {name:'compose',Labels:{'com.docker.compose.project':'shop'}},
  {name:'swarm',labels:{'com.docker.stack.namespace':'shop','com.docker.swarm.service.name':'shop_db'}},
  {name:'reserved',Config:{Labels:{'com.docker.compose.project':'standalone:'}},labels:{}},
  {name:'manual'}
 ]);
 assert.equal(groups.length,4);
 assert.equal(groups.find(g=>g.id==='swarm:shop').containers[0].service,'shop_db');
 assert.equal(groups.find(g=>g.id==='compose:shop').containers[0].name,'compose');
 assert.equal(groups.find(g=>g.id==='compose:standalone:').containers[0].name,'reserved');
 assert.deepEqual(groups.find(g=>g.id==='standalone:').containers.map(c=>c.name),['manual']);
});
