// Incremental backups (2.12.0 UI) on the real app with the incremental API mocked from the contract.
// Real server and database for the shell; /api/state is patched with `incremental` on sites and chain fields on backups.
// Synthetic data only. SHOTS_DIR=<folder> saves the design-board screenshots (light, dark, 390px).
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await new Promise(resolve => reservation.once('listening', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const directory = await mkdtemp(join(tmpdir(), 'docknest-incremental-ui-'));
Object.assign(process.env, { DATA_DIR: directory, MASTER_KEY_FILE: join(directory, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: `http://127.0.0.1:${port}` });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js'), { db, id } = await import('../src/db.js'), { digest, seal } = await import('../src/crypto.js');
const user = id(), token = randomBytes(32).toString('base64url'), now = new Date().toISOString();
db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, 'fixture@example.invalid', 'fixture', seal('JBSWY3DPEH' + 'PK3PXP'), '[]', now, 'Fixture', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, 'fixture-csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?)").run(JSON.stringify({ running: true, lastSeen: now }));
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server-1', 'Production', 'localhost', 22, 'root', 'synthetic', '0'.repeat(64), now);
const GB = 1e9, MB = 1e6, SITE = 'cinderbean.example.com';
// site-1 history, oldest first: chain A (full + 6 increments), then chain B (full + 1 increment).
const PLAN = [['A', 0, 3.2 * GB], ['A', 1, 410 * MB], ['A', 2, 380 * MB], ['A', 3, 520 * MB], ['A', 4, 290 * MB], ['A', 5, 640 * MB], ['A', 6, 350 * MB], ['B', 0, 3.3 * GB], ['B', 1, 420 * MB]];
const CHAIN_IDS = { A: randomUUID(), B: randomUUID() };
const meta = {}; // backup id -> chain fields
const ids = [];
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site-1', 'server-1', SITE, '{}', now);
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run('site-2', 'server-1', 'pawmeadow.com', '{}', now);
PLAN.forEach(([chain, position, bytes], index) => {
  const jobId = randomUUID(), backupId = randomUUID(), at = new Date(Date.now() - (PLAN.length - index) * 86400000).toISOString();
  ids.push(backupId);
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(jobId, 'site-1', at, at, at);
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, 'site-1', jobId, at, `/data/site-1-${index}.enc`, bytes, 'a'.repeat(64), '{}', 0, 1, at);
});
PLAN.forEach(([chain, position, bytes], index) => {
  const total = PLAN.filter(item => item[0] === chain).length;
  meta[ids[index]] = { backupKind: position === 0 ? 'full' : 'incremental', chainId: CHAIN_IDS[chain], parentId: position === 0 ? null : ids[index - 1], chainPosition: position, chainLength: total, dependents: total - 1 - position, size: bytes };
});
const server = app.listen(port, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${port}`, shots = process.env.SHOTS_DIR;
if (shots) await mkdir(shots, { recursive: true });
let browser;
const refuse = [];
const settingsOf = (siteId, extra = {}) => ({ siteId, enabled: siteId === 'site-1', interval: 6, fullNext: false, fullNextReason: null, fullNextMessage: null, available: true, beta: true, ...extra });
const SETTINGS = { 'site-1': settingsOf('site-1'), 'site-2': settingsOf('site-2') };

function report(saving = true) {
  const storages = [{ id: 't1', targetId: 't1', name: 'Offsite SFTP', mode: 'sftp', packages: 11, bytes: 17.6 * GB, capacityBytes: 2e12, mainBytes: 17.6 * GB, copyBytes: 0, copyCount: 0, chainBytes: 3.2 * GB }];
  const points = Array.from({ length: 30 }, (_, i) => (i < 20 ? 0 : 9e9 + i * 3e8));
  return { generatedAt: new Date().toISOString(), storages, sites: [{ siteId: 'site-1', name: SITE, packages: 9, bytes: 12.4e9 }, { siteId: 'site-2', name: 'pawmeadow.com', packages: 2, bytes: 5.2e9 }],
    totals: { packages: 11, bytes: 17.6e9, estimateUpToBytes: 0, estimateUpToPercent: 71 }, growth: { days: 30, points, fromBytes: points[20], toBytes: points.at(-1), changeBytes: 0 },
    ...(saving ? { incrementalSaving: { bytesSaved: 8.9e9, fullEquivalentBytes: 21.5e9, storedBytes: 12.6e9, increments: 7, chains: 2, keptForChain: 3, keptForChainBytes: 3.2e9, method: 'measured' } } : {}) };
}

async function open(viewport, colorScheme, { settings = SETTINGS, withSaving = true, onApi } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  await context.addCookies([{ name: 'dbm_session', value: token, url: base }]);
  const page = await context.newPage(), errors = [], calls = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(scheme => { try { localStorage.setItem('docknest-theme', scheme); } catch {} }, colorScheme);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/api/, ''), method = request.method();
    let body = null; try { body = request.postDataJSON(); } catch {}
    if (path === '/state' && method === 'GET') {
      let response, json;
      try { response = await route.fetch(); json = await response.json(); } catch { return; }
      for (const site of json.sites) site.incremental = { enabled: settings[site.id].enabled, interval: settings[site.id].interval };
      for (const backup of json.backups) Object.assign(backup, meta[backup.id] || {}, meta[backup.id] ? { sizeBytes: meta[backup.id].size } : {});
      return route.fulfill({ response, json });
    }
    calls.push({ path, method, body });
    const handled = onApi?.({ path, method, body, route, calls });
    if (handled) return handled;
    const match = path.match(/^\/sites\/([^/]+)\/incremental$/);
    if (match && method === 'GET') return route.fulfill({ json: settings[match[1]] });
    if (match && method === 'PUT') return route.fulfill({ json: { ...settings[match[1]], ...body, ...(body.fullNow ? { jobId: 'job-1', fullNext: true } : {}) } });
    if (path === '/storage-report') return route.fulfill({ json: report(withSaving) });
    if (path === '/storage-targets' && method === 'GET') return route.fulfill({ json: { targets: [], activeTargetId: null } });
    return route.continue();
  });
  await page.goto(base);
  const consent = page.getByRole('dialog', { name: 'Check GitHub daily for new versions?' });
  if (await consent.waitFor({ timeout: 4000 }).then(() => true, () => false)) { await consent.getByRole('button', { name: 'No, keep checks off' }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
  return { context, page, errors, calls };
}
async function go(page, viewport, name) {
  if (viewport.width < 900) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).first().click();
}
async function shot(page, name) {
  if (!shots) return;
  await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).every(a => a.playState === 'finished'));
  await page.screenshot({ path: join(shots, name + '.png'), fullPage: false });
}
const noOverflow = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ': no horizontal page scroll');
const oneLine = async (locator, label) => { for (const button of await locator.all()) { const box = await button.boundingBox(); assert.ok(box.height <= 48, label + ': button text does not wrap'); } };
const noScrollbar = async (dialog, label) => assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), label + ': dialog has no sideways scroll');

const next = page => page.getByRole('button', { name: /^Recovery points for .* next page$/ });
// Walk the pager from the first page until the control for a backup is on screen, then click it.
async function reveal(page, name) {
  const first = page.getByRole('button', { name: /^Recovery points for .* previous page$/ });
  while (await first.isEnabled()) await first.click();
  for (let step = 0; step < 6; step++) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.count()) { await button.click(); return; }
    await next(page).click();
  }
  throw new Error('not found: ' + name);
}
const wide = { width: 1280, height: 900 }, phone = { width: 390, height: 844 };
const openSiteDialog = async (page, site, name) => { await page.locator('.site-card', { hasText: site }).getByRole('button', { name: /^Change incremental backups for/ }).click(); return page.getByRole('dialog', { name }); };
const openGroup = async page => { await page.locator('details.backup-group', { hasText: SITE }).locator('summary').click(); };

try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
  for (const [viewport, scheme] of [[wide, 'light'], [wide, 'dark'], [phone, 'light'], [phone, 'dark']]) {
    const tag = (viewport.width === 1280 ? '1280' : '390') + '-' + scheme, label = tag;
    { // Sites page and the settings dialog: on, off, full fallback.
      const fallback = { ...SETTINGS, 'site-1': settingsOf('site-1', { fullNext: true, fullNextReason: 'snapshot-mismatch', fullNextMessage: 'The saved file list on the server no longer matched the last backup, so the next backup is full and starts a new chain.' }) };
      const { context, page, errors } = await open(viewport, scheme);
      await go(page, viewport, 'Sites & schedules');
      const card = page.locator('.site-card', { hasText: SITE });
      assert.match(await card.locator('.def-row', { hasText: 'Incremental' }).innerText(), /Full every 7 backups[\s\S]*Beta/, label);
      assert.match(await page.locator('.site-card', { hasText: 'pawmeadow.com' }).locator('.def-row', { hasText: 'Incremental' }).innerText(), /Off/, label);
      await shot(page, 'sites-row-' + tag);
      let dialog = await openSiteDialog(page, 'pawmeadow.com', 'Incremental backups');
      await dialog.getByRole('switch').waitFor();
      assert.equal(await dialog.getByLabel('Full backup every').isDisabled(), true, label + ': interval disabled while off');
      await shot(page, 'setting-off-' + tag);
      await dialog.getByRole('button', { name: 'Cancel' }).click(); await dialog.waitFor({ state: 'detached' });
      dialog = await openSiteDialog(page, SITE, 'Incremental backups');
      await dialog.getByRole('switch').waitFor();
      assert.equal(await dialog.getByLabel('Full backup every').inputValue(), '7', label + ': 6 increments = every 7 backups');
      assert.match(await dialog.innerText(), /1 full, then 6 increments/);
      await oneLine(dialog.getByRole('button'), label); await noScrollbar(dialog, label);
      await shot(page, 'setting-on-' + tag);
      await dialog.getByRole('button', { name: 'Cancel' }).click(); await dialog.waitFor({ state: 'detached' });
      assert.deepEqual(errors, [], label);
      await context.close();
      const second = await open(viewport, scheme, { settings: fallback });
      await go(second.page, viewport, 'Sites & schedules');
      dialog = await openSiteDialog(second.page, SITE, 'Incremental backups');
      await dialog.getByText('Full backup planned').waitFor();
      await shot(second.page, 'setting-fallback-' + tag);
      await second.context.close();
    }
    { // Settings errors: out-of-range interval stays on the field; a server refusal is a red alert panel.
      const { context, page, calls } = await open(viewport, scheme, { onApi: ({ path, method, route }) => { if (method === 'PUT' && /incremental$/.test(path) && refuse.length) return route.fulfill({ status: 409, json: { error: 'x', code: refuse.shift() } }); } });
      await go(page, viewport, 'Sites & schedules');
      const dialog = await openSiteDialog(page, SITE, 'Incremental backups');
      const input = dialog.getByLabel('Full backup every');
      await input.fill('1'); await dialog.getByRole('button', { name: 'Save' }).click();
      assert.equal(await input.getAttribute('aria-invalid'), 'true', label + ': interval below 2 refused in the page');
      assert.equal(calls.filter(call => call.method === 'PUT').length, 0, label + ': nothing sent');
      await input.fill('7'); refuse.push('static_site');
      await dialog.getByRole('button', { name: 'Save' }).click();
      const alert = dialog.getByRole('alert'); await alert.waitFor();
      assert.match(await alert.evaluate(el => el.className), /alert-error/, label + ': red alert panel');
      await shot(page, 'setting-error-' + tag);
      // Full backup now: marks the chain and queues a backup.
      await dialog.getByRole('button', { name: 'Full backup now' }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.deepEqual(calls.filter(call => call.method === 'PUT').at(-1).body, { fullNow: true });
      assert.equal(calls.some(call => call.path === '/sites/site-1/backup'), false, label + ': the engine queues the backup, the page does not');
      await context.close();
    }
    { // Backup list and chain dialog.
      const { context, page, errors } = await open(viewport, scheme);
      await go(page, viewport, 'Backups');
      await openGroup(page);
      const rows = page.locator('.recovery-row');
      await rows.first().waitFor();
      assert.match(await rows.first().innerText(), /Increment 1 of 1/, label + ': newest is an increment');
      assert.equal(await rows.first().getByLabel(/^Download full ZIP/).count(), 0, label + ': no ZIP for an increment');
      assert.equal(await rows.first().getByLabel(/^Download chain/).count(), 1, label + ': chain download');
      assert.equal(await rows.nth(1).getByLabel(/^Download full ZIP/).count(), 1, label + ': ZIP for a full backup');
      await noOverflow(page, label + ' list');
      await shot(page, 'backups-list-' + tag);
      await next(page).click();
      await shot(page, 'backups-list-page2-' + tag);
      await reveal(page, `Show chain of backup ${ids[6]}`);
      let dialog = page.getByRole('dialog', { name: 'Backup chain' });
      await dialog.waitFor();
      assert.equal(await dialog.locator('tbody tr').count(), 7, label + ': 1 full + 6 increments');
      assert.equal((await dialog.locator('tbody tr').first().innerText()).includes('Full'), true);
      assert.ok(await dialog.getByRole('link', { name: 'Download chain' }).getAttribute('href').then(href => href.endsWith('/chain-download')), label);
      await noScrollbar(dialog, label); await oneLine(dialog.locator('.modal-foot').getByRole('button'), label);
      const rowHeight = (await dialog.locator('tbody tr').first().boundingBox()).height; assert.ok(rowHeight <= 58, rowHeight + ' ' + label + ': compact 56px rows');
      await shot(page, 'chain-' + tag);
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click(); await dialog.waitFor({ state: 'detached' });
      assert.deepEqual(errors, [], label);
      await context.close();
    }
    { // Storage report: real measured saving; and an older server without the field.
      const { context, page, errors } = await open(viewport, scheme);
      await go(page, viewport, 'Storage');
      const tile = page.locator('.dash-metric', { hasText: 'Space saved' });
      await tile.waitFor();
      assert.match(await tile.innerText(), /8\.9 GB[\s\S]*Space saved[\s\S]*3 kept for a chain[\s\S]*By incremental backups/, label);
      await shot(page, 'storage-saving-' + tag);
      assert.deepEqual(errors, [], label);
      await context.close();
      const older = await open(viewport, scheme, { withSaving: false });
      await go(older.page, viewport, 'Storage');
      await older.page.getByText('Possible saving').waitFor();
      assert.equal(await older.page.getByText('Space saved').count(), 0, label + ': no saving tile before chains exist');
      await older.context.close();
    }
  }
  console.log('Incremental backups UI checks passed.');
} finally { await browser?.close(); server.close(); }
process.exit(0);
