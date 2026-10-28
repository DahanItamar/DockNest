// Storage page on the real app: metric tiles (Overview compact metric), By site table, short-history Growth chart, destinations grid and cards.
// Real backup rows feed the main run; the edge cases (no history, 12 sites, one destination, S3 without capacity, errors) mock only the two Storage GET endpoints.
// Synthetic data only; no real storage or Docker is used.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await new Promise(resolve => reservation.once('listening', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const directory = await mkdtemp(join(tmpdir(), 'docknest-storage-report-ui-'));
Object.assign(process.env, { DATA_DIR: directory, MASTER_KEY_FILE: join(directory, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: `http://127.0.0.1:${port}` });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js'), { db, id } = await import('../src/db.js'), { digest, seal } = await import('../src/crypto.js');
const user = id(), token = randomBytes(32).toString('base64url'), now = new Date().toISOString();
db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, 'fixture@example.invalid', 'fixture', seal('JBSWY3DPEH' + 'PK3PXP'), '[]', now, 'Fixture', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, 'fixture-csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?)").run(JSON.stringify({ running: true, lastSeen: now }));
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server-1', 'Production', 'localhost', 22, 'root', 'synthetic', '0'.repeat(64), now);
const GB = 1024 ** 3;
for (const [siteId, name, sizes] of [['site-1', 'cinderbean.example-with-a-very-long-site-name.com', [40, 41, 42, 42, 43]], ['site-2', 'pawmeadow.com', [10, 10, 10]]]) {
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, 'server-1', name, '{}', now);
  sizes.forEach((gb, i) => {
    const jobId = randomUUID();
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(jobId, siteId, now, now, now);
    db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), siteId, jobId, new Date(Date.now() - (sizes.length - i) * 4 * 86400000).toISOString(), `/data/${siteId}-${i}.enc`, gb * GB, 'a'.repeat(64), '{}', 0, 1, now);
  });
}
const server = app.listen(port, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${port}`;
let browser;
const TB = 1e12;
const sftpTarget = (n, name, cap = 2) => ({ id: 't' + n, name, kind: 'sftp', host: 'storage-box.example.net', port: 23, username: 'u1', auth_type: 'password', root: '/home/docknest', capacity_bytes: cap * TB });
const s3Target = (n, name) => ({ id: 't' + n, name, kind: 's3', bucket: 'docknest-backups', endpoint: 'https://s3.eu-central-1.example.net', root: 'docknest', objectLock: null });
const siteRows = n => Array.from({ length: n }, (_, i) => ({ siteId: 's' + i, name: i === 0 ? 'cinderbean.example-with-a-very-long-site-name-that-keeps-going.com' : `site-${i}.example.com`, packages: 4, bytes: (n - i + 1) * 1e9 }));
function mockReport({ sites = 4, targets = [], days = 9 } = {}) {
  const rows = siteRows(sites), total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const points = Array.from({ length: 30 }, (_, i) => { const d = i - (30 - days); return days <= 0 || d < 0 ? 0 : Math.round(total * (0.55 + 0.45 * d / Math.max(1, days - 1))); });
  const storages = targets.map(t => ({ id: t.id, name: t.name, packages: 4, bytes: Math.round(total / targets.length), capacityBytes: t.kind === 's3' ? null : t.capacity_bytes }));
  return { generatedAt: new Date().toISOString(), storages, sites: rows, totals: { packages: 12, bytes: total, estimateUpToBytes: 0, estimateUpToPercent: 40 }, growth: { days: 30, points, fromBytes: points[0], toBytes: points.at(-1), changeBytes: points.at(-1) - points[0] }, method: 'x' };
}
async function openStorage(viewport, colorScheme, { report, targets, reportStatus } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  await context.addCookies([{ name: 'dbm_session', value: token, url: base }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(scheme => { try { localStorage.setItem('docknest-theme', scheme); } catch {} }, colorScheme);
  if (report || reportStatus) await page.route('**/api/storage-report', route => reportStatus ? route.fulfill({ status: reportStatus, json: { error: 'x' } }) : route.fulfill({ json: report }));
  if (targets) await page.route('**/api/storage-targets', route => route.request().method() === 'GET' ? route.fulfill({ json: { targets, activeTargetId: targets[0]?.id ?? null } }) : route.continue());
  await page.goto(base);
  const consent = page.getByRole('dialog', { name: 'Check GitHub daily for new versions?' });
  if (await consent.waitFor({ timeout: 4000 }).then(() => true, () => false)) { await consent.getByRole('button', { name: 'No, keep checks off' }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
  if (viewport.width < 900) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Storage', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Remote backup destinations' }).waitFor();
  return { context, page, errors };
}
const box = locator => locator.boundingBox();
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });

  // Real fixture: two sites with history that started about 20 days ago, so the window is short.
  for (const [label, viewport, colorScheme] of [['desktop light', { width: 1440, height: 1000 }, 'light'], ['desktop dark', { width: 1440, height: 1000 }, 'dark'], ['phone', { width: 390, height: 844 }, 'light']]) {
    const { context, page, errors } = await openStorage(viewport, colorScheme);
    const region = page.getByLabel('Storage report');
    await region.waitFor();
    assert.equal(await region.getByRole('heading', { name: 'By storage' }).count(), 0, label + ': the By storage card is gone');
    assert.ok(await region.getByRole('heading', { name: 'By site' }).count(), label + ': By site card');
    assert.ok(await region.getByRole('heading', { name: 'Growth' }).count(), label + ': Growth card');
    const tiles = region.locator('.sr-metrics .berry-metric-compact');
    assert.equal(await tiles.count(), 4, label + ': four metric tiles');
    assert.deepEqual(await tiles.locator('.metric-label').allInnerTexts(), ['Stored', 'Capacity used', 'Growth', 'Possible saving'], label);
    assert.match(await tiles.nth(0).locator('strong').innerText(), /^\d+(\.\d)? (GB|TB)$/, label + ': decimal size in the Stored tile');
    assert.match(await tiles.nth(2).locator('small').innerText(), /^Since [A-Z][a-z]{2} \d{1,2}$/, label + ': a short history says Since <date>, not 30 days');
    assert.match(await tiles.nth(3).locator('strong').innerText(), /^About \d+%$/, label);
    assert.equal(await region.locator('.sr-chart canvas').count(), 1, label + ': chart drawn');
    assert.match(await region.locator('.sr-growth-range').innerText(), /^\d+(\.\d)? (GB|TB) to \d+(\.\d)? (GB|TB), since [A-Z][a-z]{2} \d{1,2}$/, label + ': range line');
    assert.match(await region.locator('.sr-axis').innerText(), /Today/, label + ': endpoint labels');
    const info = region.getByRole('link', { name: 'About this estimate' });
    assert.match(await info.getAttribute('href'), /docs\/restore-tests-guide\.md/);
    // The icon sits left of the value at every width, with no box or outline.
    const tile = tiles.nth(0).locator('.metric-tile'), icon = await box(tile), value = await box(tiles.nth(0).locator('strong'));
    assert.ok(icon.x + icon.width <= value.x, label + ': icon left of the text');
    assert.equal(await tile.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', label + ': bare icon');
    assert.equal(await tile.evaluate(el => getComputedStyle(el).borderTopWidth), '0px', label + ': no outline');
    // The long site name truncates and keeps its full name in the title.
    const longName = region.locator('.sr-table tbody th').first();
    assert.match(await longName.getAttribute('title'), /^cinderbean\.example-with-a-very-long-site-name/, label);
    if (viewport.width >= 1280) assert.ok(await longName.locator('span').evaluate(el => el.scrollWidth > el.clientWidth), label + ': long name is truncated');
    // One grid: the report and the destinations header share the same edges, and the two columns match.
    const metrics = await box(region.locator('.sr-metrics')), head = await box(page.locator('.storage-intro'));
    assert.ok(Math.abs(metrics.x - head.x) < 1 && Math.abs(metrics.width - head.width) < 1, label + ': one content width');
    if (viewport.width >= 1280) {
      const cards = region.locator('.sr-split > .card'), left = await box(cards.nth(0)), right = await box(cards.nth(1));
      assert.ok(Math.abs(left.height - right.height) < 1 && Math.abs(left.y - right.y) < 1, label + ': equal columns');
      assert.ok(Math.abs(left.width - right.width) < 1 && Math.abs(right.x + right.width - (metrics.x + metrics.width)) < 1, label + ': columns fill the width');
    } else assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), label + ': no horizontal scroll');
    if (colorScheme === 'dark') assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
    assert.deepEqual(errors, [], label);
    await context.close();
  }

  // Edge cases on the desktop layout, with only the Storage endpoints mocked.
  const wide = { width: 1440, height: 1000 };
  { // No history yet: no chart, no fake zero line.
    const targets = [sftpTarget(1, 'Storage box')], { context, page } = await openStorage(wide, 'dark', { report: mockReport({ targets, days: 0 }), targets });
    const region = page.getByLabel('Storage report'); await region.waitFor();
    assert.equal(await region.locator('.sr-chart canvas').count(), 0, 'no history: no chart');
    assert.match(await region.locator('.sr-chart-empty').innerText(), /No history yet/);
    assert.equal(await region.locator('.berry-metric-compact').nth(2).locator('strong').innerText(), '—');
    await context.close();
  }
  { // The first day only: the chart waits for a second day.
    const targets = [sftpTarget(1, 'Storage box')], { context, page } = await openStorage(wide, 'dark', { report: mockReport({ targets, days: 1 }), targets });
    const region = page.getByLabel('Storage report'); await region.waitFor();
    assert.match(await region.locator('.sr-chart-empty').innerText(), /History starts today/);
    await context.close();
  }
  { // A full 30 days is labelled as the last 30 days.
    const targets = [sftpTarget(1, 'Storage box')], { context, page } = await openStorage(wide, 'dark', { report: mockReport({ targets, days: 30 }), targets });
    const region = page.getByLabel('Storage report'); await region.waitFor();
    assert.match(await region.locator('.sr-growth-range').innerText(), /last 30 days$/);
    assert.equal(await region.locator('.berry-metric-compact').nth(2).locator('small').innerText(), 'Last 30 days');
    await context.close();
  }
  { // One destination spans the whole grid width and shows capacity used with a bar.
    const targets = [sftpTarget(1, 'Storage box')], { context, page } = await openStorage(wide, 'dark', { report: mockReport({ targets }), targets });
    await page.locator('.storage-card').waitFor();
    const card = await box(page.locator('.storage-card')), metrics = await box(page.locator('.sr-metrics'));
    assert.ok(Math.abs(card.width - metrics.width) < 1 && Math.abs(card.x - metrics.x) < 1, 'one destination spans the full width');
    const usage = await page.locator('.storage-card .storage-usage').innerText();
    assert.match(usage, /Capacity used/); assert.match(usage, /of 2 TB/);
    assert.equal(await page.locator('.storage-card .storage-usage progress').count(), 1);
    assert.match(await page.locator('.storage-card').innerText(), /2 TB configured/, 'one unit system: 2 TB reads 2 TB');
    await context.close();
  }
  { // Three destinations: two columns, and the odd last card stays a normal half-width cell.
    const targets = [sftpTarget(1, 'Storage box'), sftpTarget(2, 'Offsite box'), sftpTarget(3, 'Third box')], { context, page } = await openStorage(wide, 'dark', { report: mockReport({ targets }), targets });
    await page.locator('.storage-card').first().waitFor();
    const cards = page.locator('.storage-card'), a = await box(cards.nth(0)), b = await box(cards.nth(1)), c = await box(cards.nth(2));
    assert.ok(Math.abs(a.y - b.y) < 1 && b.x > a.x, 'two columns');
    assert.ok(Math.abs(c.width - a.width) < 1 && Math.abs(c.x - a.x) < 1 && c.y > a.y, 'the odd last card is a half-width cell under the first');
    assert.ok(Math.abs(c.height - a.height) < 1, 'rows keep equal height');
    await context.close();
  }
  { // S3 without reported capacity: the tile says so and the card has no bar.
    const targets = [s3Target(1, 'Cloud bucket')], { context, page } = await openStorage(wide, 'dark', { report: mockReport({ targets }), targets });
    const region = page.getByLabel('Storage report'); await region.waitFor();
    assert.equal(await region.locator('.berry-metric-compact').nth(1).locator('strong').innerText(), 'Not reported');
    assert.equal(await region.locator('.berry-metric-compact').nth(1).locator('progress').count(), 0);
    await page.locator('.storage-card').waitFor();
    assert.equal(await page.locator('.storage-card progress').count(), 0, 'no capacity bar for S3');
    assert.match(await page.locator('.storage-card .storage-usage').innerText(), /Used by DockNest backups/);
    assert.match(await page.locator('.storage-card').innerText(), /Beta/);
    await context.close();
  }
  { // 12 sites: the list scrolls inside its card instead of stretching the page.
    const targets = [sftpTarget(1, 'Storage box')], { context, page } = await openStorage(wide, 'dark', { report: mockReport({ targets, sites: 12 }), targets });
    const region = page.getByLabel('Storage report'); await region.waitFor();
    assert.equal(await region.locator('.sr-table tbody tr').count(), 12);
    const scroll = region.locator('.sr-scroll');
    assert.ok(await scroll.evaluate(el => el.scrollHeight > el.clientHeight + 1), '12 sites scroll');
    assert.equal(await scroll.getAttribute('tabindex'), '0', 'scroll area is keyboard reachable');
    await context.close();
  }
  { // One site and no destinations: the notice stays.
    const { context, page } = await openStorage(wide, 'light', { report: mockReport({ sites: 1 }), targets: [] });
    const region = page.getByLabel('Storage report'); await region.waitFor();
    assert.equal(await region.locator('.sr-table tbody tr').count(), 1);
    assert.match(await page.locator('.notice').innerText(), /Connect your first destination/);
    await context.close();
  }
  { // A report load error leaves the destinations usable.
    const { context, page } = await openStorage(wide, 'light', { reportStatus: 500 });
    await page.getByText('The storage report is not available right now.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add storage destination' }).count(), 1);
    await context.close();
  }
  console.log('Storage page passed: tiles, By site, short-history chart, no history, one destination spanning, S3 without capacity, 12-site scroll, errors, light and dark, 390 px phone.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); db.close(); await rm(directory, { recursive: true, force: true }); }
