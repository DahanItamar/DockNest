import test from 'node:test';
import assert from 'node:assert/strict';
import {containerGroups} from '../web/container-groups.js';
test('site groups use Compose evidence, include stopped services and never guess from names',()=>{
 const rows=[{name:'shop-web',labels:{'com.docker.compose.project':'shop'}},{name:'shop-db',state:'exited',Config:{Labels:{'com.docker.compose.project':'shop'}}},{name:'shop-unrelated'},{name:'other-web',labels:{'com.docker.compose.project':'other'}}];
 const groups=containerGroups(rows);
 assert.deepEqual(groups.find(g=>!g.compose).containers.map(c=>c.name),['shop-unrelated']);
 assert.deepEqual(groups.filter(g=>g.compose).map(g=>[g.name,g.containers.map(c=>c.name)]),[['other',['other-web']],['shop',['shop-web','shop-db']]]);
});
