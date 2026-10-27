import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceDefaults,maintenancePresets,renderMaintenancePage} from '../shared/maintenance-design.js';

const link='<a class="powered" href="https://github.com/DahanItamar/DockNest" target="_blank" rel="noopener">Powered by DockNest</a>';

test('every maintenance page links Powered by DockNest to GitHub', () => {
  const designs=[maintenanceDefaults,...maintenancePresets.map(p=>p.value||p),{title:'Powered by nobody',message:'<a href="x">hidden</a>',layout:'bold',theme:'dark'}];
  for (const design of designs) {
    const html=renderMaintenancePage(design);
    assert.equal(html.split(link).length,2,'exactly one Powered by DockNest link');
  }
});

test('user text cannot inject or replace the footer link', () => {
  const html=renderMaintenancePage({title:'</footer><footer>x',message:'Powered by Someone'});
  assert.ok(html.includes(link));
  assert.ok(!html.includes('</footer><footer>x'));
});
