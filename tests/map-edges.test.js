import test from 'node:test';
import assert from 'node:assert/strict';
import {edgePath,EDGE,layoutMap} from '../web/map/layout.js';

const nums = d => d.match(/-?\d+(?:\.\d+)?/g).map(Number);

test('a forward link is one cubic bezier with horizontal control points (Vue Flow shape, curvature 0.25)', () => {
  const e = edgePath([100, 100], [300, 220]);
  assert.equal(e.kind, 'bezier');
  assert.match(e.d, /^M100 100 C[\d. ]+ 300 220$/);
  const [sx, sy, c1x, c1y, c2x, c2y, tx, ty] = nums(e.d);
  assert.deepEqual([sx, sy, tx, ty], [100, 100, 300, 220]);
  assert.equal(c1y, 100, 'leaves the source horizontally');
  assert.equal(c2y, 220, 'enters the target horizontally');
  assert.equal(c1x, 200, 'control offset is half the distance');
  assert.equal(c2x, 200);
  assert.equal(e.labelX, 200);
  assert.equal(e.labelY, 160);
  assert.ok(!/ L| Q/.test(e.d), 'no straight pieces or elbows');
});

test('a link at the same height is a straight horizontal line', () => {
  const e = edgePath([100, 80], [260, 80]);
  assert.equal(e.kind, 'straight');
  assert.equal(e.d, 'M100 80 L260 80');
});

test('a backward link leaves right, drops 130 below the source and comes back into the target from the left, without crossing the source', () => {
  const source = { x: 400, y: 300, w: 64, h: 64 }, sx = source.x + source.w, sy = source.y + source.h / 2;
  const e = edgePath([sx, sy], [100, 150]);
  assert.equal(e.kind, 'back');
  const pts = e.points;
  assert.deepEqual(pts[0], [sx, sy]);
  assert.deepEqual(pts.at(-1), [100, 150]);
  assert.equal(Math.max(...pts.map(p => p[1])), sy + EDGE.drop, 'drops to sourceY + 130');
  assert.equal(pts[1][0], sx + EDGE.side, 'first goes out to the right by the side offset');
  assert.ok(pts.slice(1).every(p => p[0] >= sx + EDGE.side || p[1] >= source.y + source.h || p[1] <= source.y || p[0] > source.x + source.w), 'stays out of the source box');
  // no point of the path (sampled on the straight pieces) lies inside the source rectangle
  const inside = ([x, y]) => x > source.x && x < source.x + source.w && y > source.y && y < source.y + source.h;
  for (let i = 1; i < pts.length; i++) for (let t = 0; t <= 1; t += 0.05) assert.ok(!inside([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]));
  assert.match(e.d, /Q/, 'corners are rounded');
  assert.ok(nums(e.d).length > 8);
});

test('a target barely to the right (within the handle size) counts as backward; forward only past it', () => {
  assert.equal(edgePath([100, 0], [100 + EDGE.handle, 50]).kind, 'back');
  assert.equal(edgePath([100, 0], [100 + EDGE.handle + 1, 50]).kind, 'bezier');
});

test('the layout draws every kind of line with the new curves, in the automatic and the free layout', () => {
  const servers = [{ id: 's1', name: 'a-box' }, { id: 's2', name: 'b-box' }];
  const sites = [{ id: 'x', name: 'x', serverId: 's1' }, { id: 'y', name: 'y', serverId: 's2' }];
  const opts = { storage: [{ id: 't1', name: 'vault' }], backupOf: { x: 't1', y: 't1' }, links: [{ id: 'l1', a: 'x', b: 'y', kind: 'network' }], domains: [{ id: 'd1', serverId: 's1' }] };
  for (const l of [layoutMap(servers, sites, opts), layoutMap(servers, sites, { ...opts, positions: { 'site:x': { x: 900, y: 40 } } })]) {
    for (const p of [...l.paths, ...l.backupPaths, ...l.domainPaths.filter(d => !d.stub)]) assert.match(p.d, /^M[-\d. ]+ (C|L|[-\d. ]+L)/, p.id + ': ' + p.d);
    assert.ok(l.paths.every(p => !/ Q| L[-\d. ]+ L/.test(p.d.replace(/^M\S+ \S+ L\S+ \S+$/, ''))) || l.custom, 'no right-angle elbows in the automatic layout');
    for (const p of l.linkPaths) assert.match(p.d, /^M[-\d. ]+ C/);
  }
});
