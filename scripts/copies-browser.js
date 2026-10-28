// Storage per site and backup copies (2.11.0) on the real app with the new API routes mocked from the fixed contract.
// Real server and database for the shell; /api/state is patched with `storage` and `copies`, and the storage, copy,
// restore-plan and destination routes are fakes. Synthetic data only. SHOTS_DIR=<folder> also saves screenshots.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await new Promise(resolve => reservation.once('listening', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const directory = await mkdtemp(join(tmpdir(), 'docknest-copies-ui-'));
Object.assign(process.env, { DATA_DIR: directory, MASTER_KEY_FILE: join(directory, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: `http://127.0.0.1:${port}` });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js'), { db, id } = await import('../src/db.js'), { digest, seal } = await import('../src/crypto.js');
const user = id(), token = randomBytes(32).toString('base64url'), now = new Date().toISOString();
db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, 'fixture@example.invalid', 'fixture', seal('JBSWY3DPEH' + 'PK3PXP'), '[]', now, 'Fixture', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, 'fixture-csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?)").run(JSON.stringify({ running: true, lastSeen: now }));
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run('server-1', 'Production', 'localhost', 22, 'root', 'synthetic', '0'.repeat(64), now);
const GB = 1e9, LONG_SITE = 'cinderbean.example-with-a-very-long-site-name-that-keeps-going.com';
const backups = {}; // name -> id
for (const [siteId, name, count] of [['site-1', LONG_SITE, 4], ['site-2', 'pawmeadow.com', 2]]) {
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(siteId, 'server-1', name, '{}', now);
  for (let i = 0; i < count; i++) {
    const jobId = randomUUID(), backupId = randomUUID();
    backups[`${siteId}#${i}`] = backupId;
    db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(jobId, siteId, now, now, now);
    db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, siteId, jobId, new Date(Date.now() - (count - i) * 86400000).toISOString(), `/data/${siteId}-${i}.enc`, (i + 1) * GB, 'a'.repeat(64), '{}', 0, 1, now);
  }
}
const server = app.listen(port, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${port}`, shots = process.env.SHOTS_DIR;
if (shots) await mkdir(shots, { recursive: true });
let browser;
const TB = 1e12;
const target = (n, name, kind = 'sftp') => kind === 's3'
  ? { id: 't' + n, name, kind: 's3', bucket: 'docknest-backups', endpoint: 'https://s3.eu-central-1.example.net', root: 'docknest', objectLock: null }
  : { id: 't' + n, name, kind: 'sftp', host: 'storage-box.example.net', port: 23, username: 'u1', auth_type: 'password', root: '/home/docknest', capacity_bytes: 2 * TB };
const TARGETS = [target(1, 'Offsite SFTP'), target(2, 'Cloudflare R2 archive bucket in Frankfurt with a long name', 's3'), target(3, 'Garage MinIO', 's3'), target(4, 'Backblaze B2', 's3')];
const day = n => new Date(Date.now() - n * 86400000).toISOString();
const copyRow = (t, status, extra = {}) => ({ targetId: TARGETS[t - 1].id, name: TARGETS[t - 1].name, mode: TARGETS[t - 1].kind, status, verifiedAt: status === 'verified' ? day(1) : null, attempts: status === 'verified' ? 1 : 2, nextAttemptAt: null, lastError: null, ...extra });
const main = { id: 't1', name: TARGETS[0].name, mode: 'sftp' };
// Per backup (by seeded key): the copies the fake API reports. site-2 has none, like every backup made before 2.11.
const COPIES = {
  'site-1#3': [copyRow(2, 'verified'), copyRow(3, 'copying')],
  'site-1#2': [copyRow(2, 'gave_up', { lastError: 'The destination refused the upload.' }), copyRow(3, 'failed', { lastError: 'Connection timed out.' })],
  'site-1#1': [copyRow(2, 'verified'), copyRow(3, 'verified', { mode: null })],
  'site-1#0': [copyRow(2, 'pending')]
};
const siteStorage = { 'site-1': { mainTargetId: null, copyTargetIds: ['t2', 't3'], copyMissing: true }, 'site-2': { mainTargetId: null, copyTargetIds: [], copyMissing: false } };
const idToKey = Object.fromEntries(Object.entries(backups).map(([key, backupId]) => [backupId, key]));

async function open(viewport, colorScheme, { copies = true, targets = TARGETS, onApi } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  await context.addCookies([{ name: 'dbm_session', value: token, url: base }]);
  const page = await context.newPage(), errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(scheme => { try { localStorage.setItem('docknest-theme', scheme); } catch {} }, colorScheme);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/^\/api/, ''), method = request.method();
    let body = null; try { body = request.postDataJSON(); } catch {}
    if (path === '/state' && method === 'GET') {
      let response, json;
      try { response = await route.fetch(); json = await response.json(); } catch { return; } // the page closed while the state was loading
      if (copies) {
        for (const site of json.sites) site.storage = siteStorage[site.id];
        for (const backup of json.backups) { const key = idToKey[backup.id]; if (key?.startsWith('site-1')) { backup.mainTarget = main; backup.copies = COPIES[key] || []; if (key === 'site-1#1') backup.mainRemoved = true; } else if (key) { backup.mainTarget = main; backup.copies = []; } }
      }
      return route.fulfill({ response, json });
    }
    calls.push({ path, method, body });
    const handled = onApi?.({ path, method, body, route, calls });
    if (handled) return handled;
    if (path === '/storage-targets' && method === 'GET') return route.fulfill({ json: { targets, activeTargetId: targets[0]?.id ?? null } });
    if (path === '/storage-report') return route.fulfill({ json: report() });
    const siteMatch = path.match(/^\/sites\/([^/]+)\/storage$/);
    if (siteMatch && method === 'GET') return route.fulfill({ json: storageOf(siteMatch[1], targets) });
    if (siteMatch && method === 'PUT') return route.fulfill({ json: storageOf(siteMatch[1], targets) });
    if (/^\/backups\/[^/]+\/copies\/[^/]+\/retry$/.test(path)) return route.fulfill({ status: 202, json: { status: 'pending', nextAttemptAt: null } });
    return route.continue();
  });
  await page.goto(base);
  const consent = page.getByRole('dialog', { name: 'Check GitHub daily for new versions?' });
  if (await consent.waitFor({ timeout: 4000 }).then(() => true, () => false)) { await consent.getByRole('button', { name: 'No, keep checks off' }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
  return { context, page, errors, calls, viewport };
}
function storageOf(siteId, targets = TARGETS) {
  const s = siteStorage[siteId] || siteStorage['site-2'], byId = Object.fromEntries(targets.map(t => [t.id, t]));
  const eff = byId[s.mainTargetId || 't1'] || targets[0];
  return { siteId, main: { targetId: s.mainTargetId, effective: { id: eff.id, name: eff.name, mode: eff.kind } }, default: { id: 't1', name: TARGETS[0].name, mode: 'sftp' },
    copies: s.copyTargetIds.map((tid, i) => ({ targetId: tid, name: byId[tid]?.name || tid, mode: byId[tid]?.kind || 'sftp', retention: i === 0 ? 30 : null, effectiveRetention: i === 0 ? 30 : 7 })), maxCopies: 3, copyMissing: s.copyMissing };
}
function report() {
  const storages = [
    { id: 't1', targetId: 't1', name: TARGETS[0].name, mode: 'sftp', packages: 6, bytes: 12 * GB, capacityBytes: 2 * TB, mainBytes: 9 * GB, copyBytes: 0, copyCount: 0, chainBytes: 3 * GB },
    { id: 't2', targetId: 't2', name: TARGETS[1].name, mode: 's3', packages: 3, bytes: 7 * GB, capacityBytes: null, mainBytes: 0, copyBytes: 7 * GB, copyCount: 3, chainBytes: 0 }
  ];
  const points = Array.from({ length: 30 }, (_, i) => (i < 20 ? 0 : 15e9 + i * 3e8));
  return { generatedAt: new Date().toISOString(), storages, sites: [{ siteId: 'site-1', name: LONG_SITE, packages: 4, bytes: 14e9 }, { siteId: 'site-2', name: 'pawmeadow.com', packages: 2, bytes: 5e9 }],
    totals: { packages: 6, bytes: 19e9, estimateUpToBytes: 0, estimateUpToPercent: 40 }, growth: { days: 30, points, fromBytes: points[20], toBytes: points.at(-1), changeBytes: 0 } };
}
async function go(page, viewport, name) {
  if (viewport.width < 900) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).first().click();
}
async function shot(page, name) { if (!shots) return; await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).every(a => a.playState === 'finished'));
  await page.screenshot({ path: join(shots, name + '.png'), fullPage: false }); }
const noOverflow = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ': no horizontal page scroll');
const oneLine = async (locator, label) => { for (const button of await locator.all()) { const box = await button.boundingBox(); assert.ok(box.height <= 48, label + ': button text does not wrap'); } };

const wide = { width: 1280, height: 900 }, phone = { width: 390, height: 844 };
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });

  for (const [label, viewport, scheme] of [['desktop light', wide, 'light'], ['desktop dark', wide, 'dark'], ['phone light', phone, 'light'], ['phone dark', phone, 'dark']]) {
    const tag = (viewport.width === 1280 ? '1280' : '390') + '-' + scheme;
    { // Sites: the Storage row, Copy missing, and a site without storage data.
      const { context, page, errors } = await open(viewport, scheme);
      await go(page, viewport, 'Sites & schedules');
      const card = page.locator('.site-card', { hasText: LONG_SITE });
      await card.waitFor();
      assert.match(await card.locator('.def-row', { hasText: 'Storage' }).innerText(), /Default destination[\s\S]*2 extra copies[\s\S]*Copy missing/, label + ': storage row');
      const quiet = page.locator('.site-card', { hasText: 'pawmeadow.com' });
      assert.match(await quiet.locator('.def-row', { hasText: 'Storage' }).innerText(), /No extra copies/, label);
      assert.equal(await quiet.getByText('Copy missing').count(), 0, label + ': no warning without a missing copy');
      await shot(page, 'sites-' + tag);
      await noOverflow(page, label + ' sites');

      // Site settings, Storage dialog.
      await card.getByRole('button', { name: /^Change storage for/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Site storage' });
      await dialog.getByLabel('Main destination').waitFor();
      assert.equal(await dialog.getByLabel('Main destination').inputValue(), '', label + ': default selected');
      assert.match(await dialog.getByLabel('Main destination').locator('option').first().innerText(), /^Default \(Offsite SFTP\)$/, label);
      assert.equal(await dialog.getByLabel(/^Destination for copy/).count(), 2, label + ': two copies listed');
      assert.equal(await dialog.getByLabel('Backups to keep on copy 1').inputValue(), '30');
      assert.equal(await dialog.getByLabel('Backups to keep on copy 2').inputValue(), '', label + ': empty means the site count');
      const add = dialog.getByRole('button', { name: 'Add copy' });
      await shot(page, 'storage-dialog-' + tag);
      await add.click(); // the third copy takes the remaining free destination; nothing else is free afterwards
      assert.equal(await dialog.getByLabel(/^Destination for copy/).count(), 3);
      assert.equal(await add.isDisabled(), true, label + ': at most 3 copies');
      await shot(page, 'storage-dialog-three-' + tag);
      await dialog.getByRole('button', { name: 'Remove copy 3' }).click();
      assert.equal(await add.isDisabled(), false);
      await oneLine(dialog.getByRole('button'), label);
      await noOverflow(page, label + ' dialog');
      assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, label + ': dialog has no sideways scroll');
      assert.deepEqual(errors, [], label);
      await context.close();
    }
  }

  { // Save: body shape, API 400 codes as a red alert with reason and action, then success.
    const refused = [];
    const { context, page, calls } = await open(wide, 'light', { onApi: ({ path, method, route }) => {
      if (/^\/sites\/site-1\/storage$/.test(path) && method === 'PUT' && refused.length) return route.fulfill({ status: 400, json: { error: 'x', code: refused.shift() } });
    } });
    await go(page, wide, 'Sites & schedules');
    for (const code of ['copy_equals_main', 'duplicate_copy', 'too_many_copies', 'unknown_destination', 'invalid_retention']) {
      refused.push(code);
      await page.locator('.site-card', { hasText: LONG_SITE }).getByRole('button', { name: /^Change storage for/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Site storage' });
      await dialog.getByLabel('Main destination').waitFor();
      await dialog.getByRole('button', { name: 'Save' }).click();
      const alert = dialog.getByRole('alert');
      await alert.waitFor();
      const text = await alert.innerText();
      assert.ok(text.split('\n').filter(Boolean).length >= 2, code + ': reason and action');
      assert.match(await alert.evaluate(el => el.className), /alert-error/, code + ': red alert panel');
      if (code === 'copy_equals_main') { assert.match(text, /cannot use the main destination/); assert.match(text, /different destination/); }
      if (code === 'invalid_retention') assert.match(text, /1 to 365/);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'detached' });
    }
    // Override equal to a copy: pick the copy's destination as the main and save; the API refuses, nothing is hidden.
    refused.push('copy_equals_main');
    await page.locator('.site-card', { hasText: LONG_SITE }).getByRole('button', { name: /^Change storage for/ }).click();
    let dialog = page.getByRole('dialog', { name: 'Site storage' });
    await dialog.getByLabel('Main destination').waitFor();
    await dialog.getByLabel('Main destination').selectOption('t2');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.getByRole('alert').waitFor();
    assert.deepEqual(calls.filter(c => c.method === 'PUT').at(-1).body.mainTargetId, 't2');
    await shot(page, 'storage-dialog-error-1280-light');
    // Fix and save.
    await dialog.getByLabel('Main destination').selectOption('');
    await dialog.getByLabel('Backups to keep on copy 2').fill('14');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'detached' });
    const put = calls.filter(c => c.method === 'PUT').at(-1).body;
    assert.deepEqual(put, { mainTargetId: null, copies: [{ targetId: 't2', retention: 30 }, { targetId: 't3', retention: 14 }] });
    assert.match(await page.locator('.notice').innerText(), /Storage saved/);
    await context.close();
  }

  { // Only one destination: nothing to copy to, said plainly.
    const { context, page } = await open(wide, 'light', { targets: [TARGETS[0]] });
    await go(page, wide, 'Sites & schedules');
    await page.locator('.site-card', { hasText: 'pawmeadow.com' }).getByRole('button', { name: /^Change storage for/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Site storage' });
    await dialog.getByLabel('Main destination').waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Add copy' }).isDisabled(), true);
    assert.match(await dialog.innerText(), /Connect another destination to add a copy\./);
    await context.close();
  }

  { // Server older than 2.11 (no storage or copies in the state): the pages look exactly as before.
    const { context, page } = await open(wide, 'light', { copies: false });
    await go(page, wide, 'Sites & schedules');
    await page.locator('.site-card').first().waitFor();
    assert.equal(await page.locator('.site-card .def-row', { hasText: 'Storage' }).count(), 0, 'no Storage row without data');
    await go(page, wide, 'Backups');
    await page.locator('details.backup-group summary').first().click();
    await page.locator('.recovery-row').first().waitFor();
    assert.equal(await page.locator('.cp-copies').count(), 0, 'no copy labels for backups without copies');
    await context.close();
  }

  for (const [label, viewport, scheme] of [['desktop light', wide, 'light'], ['desktop dark', wide, 'dark'], ['phone light', phone, 'light'], ['phone dark', phone, 'dark']]) {
    const tag = (viewport.width === 1280 ? '1280' : '390') + '-' + scheme;
    { // Backups: copy labels, Retry for failed and gave_up, long destination name, backup without copies.
      const { context, page, calls, errors } = await open(viewport, scheme);
      await go(page, viewport, 'Backups');
      await page.locator('details.backup-group summary', { hasText: LONG_SITE }).click();
      const rows = page.locator('details[open] .recovery-row');
      await rows.first().waitFor();
      const withCopies = page.locator('details[open] .recovery-row', { has: page.locator('.cp-copies') });
      assert.ok(await withCopies.count() >= 1, label + ': copy labels rendered');
      const labels = (await page.locator('details[open] .cp-label').allInnerTexts()).join(' | ');
      assert.match(labels, /Verified/); assert.match(labels, /Main/);
      assert.match(labels, /Garage MinIO \(removed\)/); assert.match(labels, /Main removed/);
      await shot(page, 'backups-' + tag);
      const name = page.locator('.cp-label-name', { hasText: 'Cloudflare R2 archive' }).first();
      assert.equal(await name.evaluate(el => el.scrollWidth > el.clientWidth), viewport.width < 600, label + ': long names are cut with an ellipsis only when too wide');
      assert.equal(await name.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis');
      await noOverflow(page, label + ' backups');
      assert.deepEqual(errors, [], label);
      if (viewport.width === 1280 && scheme === 'light') {
        // Page 1 shows the newest backups. Find the gave_up copy and retry it.
        const retry = page.getByRole('button', { name: /^Retry copy to/ });
        await retry.first().waitFor();
        await oneLine(retry, label);
        const before = calls.length;
        await retry.first().click();
        await page.waitForFunction(() => document.querySelector('.notice')?.textContent.includes('Copy queued'));
        const call = calls.slice(before).find(c => /\/retry$/.test(c.path));
        assert.ok(call && call.method === 'POST', 'retry posts to the copy route');
        assert.match(call.path, /^\/backups\/[^/]+\/copies\/t[23]\/retry$/);
      }
      await context.close();
    }
  }

  for (const [label, viewport, scheme] of [['desktop light', wide, 'light'], ['desktop dark', wide, 'dark'], ['phone light', phone, 'light'], ['phone dark', phone, 'dark']]) {
    const tag = (viewport.width === 1280 ? '1280' : '390') + '-' + scheme;
    { // Storage page: per-destination bytes and the in-use guard.
      const { context, page, calls, errors } = await open(viewport, scheme, { onApi: ({ path, method, route }) => {
        if (path === '/storage-targets/t2' && method === 'DELETE') return route.fulfill({ status: 409, json: { error: 'In use.', code: 'destination_in_use', copies: 3, copyBackups: 3, bytes: 7 * GB, mainForSites: [], copyForSites: [{ id: 'site-1', name: LONG_SITE }] } });
        if (path === '/storage-targets/t3' && method === 'DELETE') return route.fulfill({ json: { removed: true } });
        if (path === '/storage-targets/t2/copies/delete' && method === 'POST') return route.fulfill({ status: 202, json: { deleting: 3 } });
      } });
      await go(page, viewport, 'Storage');
      await page.getByRole('heading', { name: 'Remote backup destinations' }).waitFor();
      const card = page.locator('.sr-destinations');
      await card.waitFor();
      assert.deepEqual(await card.locator('thead th').allInnerTexts(), ['Destination', 'Main', 'Copies', 'Kept for chain', 'Total'], label);
      const first = card.locator('tbody tr').first();
      assert.deepEqual(await first.locator('td').allInnerTexts(), ['Offsite SFTP', '9 GB', '0 B', '3 GB', '12 GB'], label + ': main, copies and chain are separate');
      assert.match(await card.locator('tbody tr').nth(1).innerText(), /7 GB[\s\S]*0 B[\s\S]*7 GB/);
      assert.equal(await card.locator('th.num').count(), 4, label + ': numeric headers right aligned');
      await card.scrollIntoViewIfNeeded(); await shot(page, 'storage-report-' + tag);
      const remove = page.getByRole('button', { name: 'Remove ' + TARGETS[1].name });
      await remove.scrollIntoViewIfNeeded();
      await remove.click();
      const confirm = page.getByRole('alert').filter({ hasText: 'Remove ' + TARGETS[1].name });
      await confirm.waitFor();
      assert.equal(calls.filter(c => c.method === 'DELETE').length, 0, label + ': nothing is deleted before the confirmation');
      await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
      const inUse = page.getByRole('alert').filter({ hasText: 'still in use' });
      await inUse.waitFor();
      const text = await inUse.innerText();
      assert.match(text, /3 copies of 3 backups/); assert.match(text, /Extra copy destination for 1 site/); assert.match(text, /main copy/);
      await oneLine(inUse.getByRole('button'), label);
      await inUse.scrollIntoViewIfNeeded();
      await shot(page, 'destination-in-use-' + tag);
      await noOverflow(page, label + ' storage');
      assert.equal(calls.filter(c => c.path.endsWith('/copies/delete')).length, 0, label + ': the copies are only deleted on request');
      await inUse.getByRole('button', { name: 'Delete copies' }).click();
      await page.waitForFunction(() => document.querySelector('.alert-panel')?.textContent.includes('Deleting 3 copies'));
      assert.deepEqual(calls.find(c => c.path === '/storage-targets/t2/copies/delete').body, {});
      // A destination nothing uses is removed after one confirmation.
      await page.getByRole('button', { name: 'Remove ' + TARGETS[2].name }).click();
      await page.getByRole('alert').filter({ hasText: 'Remove ' + TARGETS[2].name }).getByRole('button', { name: 'Remove', exact: true }).click();
      await page.waitForFunction(() => document.body.textContent.includes('Destination removed'));
      assert.deepEqual(errors, [], label);
      await context.close();
    }
  }

  { // The default destination and main backups block removal: why and what to do, and no Delete copies.
    const { context, page } = await open(wide, 'light', { onApi: ({ path, method, route }) => {
      if (path === '/storage-targets/t1' && method === 'DELETE') return route.fulfill({ status: 409, json: { error: 'In use.', code: 'destination_in_use', copies: 0, copyBackups: 0, bytes: 0, mainForSites: [], copyForSites: [], mainBackups: 4, recoveryKits: 1, isDefault: true } });
    } });
    await go(page, wide, 'Storage');
    await page.getByRole('button', { name: 'Remove ' + TARGETS[0].name }).click();
    await page.getByRole('alert').filter({ hasText: 'Remove ' + TARGETS[0].name }).getByRole('button', { name: 'Remove', exact: true }).click();
    const inUse = page.getByRole('alert').filter({ hasText: 'still in use' });
    await inUse.waitFor();
    const text = await inUse.innerText();
    assert.match(text, /default destination/); assert.match(text, /4 backups keep their main copy here/); assert.match(text, /1 recovery kit/); assert.match(text, /Choose another default/);
    assert.equal(await inUse.getByRole('button', { name: 'Delete copies' }).count(), 0, 'nothing to delete but main backups');
    await context.close();
  }

  { // Copies that are the only package left: an explicit confirm, then the request is resent with includeLastPackages.
    const { context, page, calls } = await open(wide, 'light', { onApi: ({ path, method, body, route }) => {
      if (path === '/storage-targets/t2' && method === 'DELETE') return route.fulfill({ status: 409, json: { error: 'In use.', code: 'destination_in_use', copies: 3, copyBackups: 3, bytes: 7 * GB, mainForSites: [], copyForSites: [], onlyPackageBackups: 2 } });
      if (path === '/storage-targets/t2/copies/delete' && method === 'POST') return body?.includeLastPackages ? route.fulfill({ status: 202, json: { deleting: 3 } }) : route.fulfill({ status: 409, json: { error: 'x', code: 'last_packages', onlyPackageBackups: 2 } });
    } });
    await go(page, wide, 'Storage');
    await page.getByRole('button', { name: 'Remove ' + TARGETS[1].name }).click();
    await page.getByRole('alert').filter({ hasText: 'Remove ' + TARGETS[1].name }).getByRole('button', { name: 'Remove', exact: true }).click();
    const inUse = page.getByRole('alert').filter({ hasText: 'still in use' });
    await inUse.waitFor();
    assert.match(await inUse.innerText(), /2 backups exist only here and will be lost/);
    await inUse.getByRole('button', { name: 'Delete copies' }).click();
    const lost = page.getByRole('alert').filter({ hasText: 'Backups would be lost' });
    await lost.waitFor();
    assert.equal(calls.filter(c => c.path.endsWith('/copies/delete')).length, 1, 'nothing is lost without the second confirmation');
    await lost.getByRole('button', { name: 'Delete anyway' }).click();
    await page.waitForFunction(() => document.body.textContent.includes('Deleting 3 copies'));
    assert.equal(calls.filter(c => c.path.endsWith('/copies/delete')).at(-1).body.includeLastPackages, true);
    await context.close();
  }

  { // Restore: choose the source, fallback explained, sourceTargetId sent.
    const sources = [
      { targetId: 't1', name: 'Offsite SFTP', role: 'main', status: 'verified', verifiedAt: day(1) },
      { targetId: 't2', name: 'Cloudflare R2 archive bucket in Frankfurt with a long name', role: 'copy', status: 'verified', verifiedAt: day(1) },
      { targetId: 't3', name: 'Garage MinIO', role: 'copy', status: 'failed', verifiedAt: null }
    ];
    for (const [label, viewport, scheme, mainMissing] of [['desktop light', wide, 'light', false], ['phone dark', phone, 'dark', false], ['fallback', wide, 'light', true]]) {
      const plans = [];
      const { context, page, calls } = await open(viewport, scheme, { onApi: ({ path, method, body, route }) => {
        if (/\/restore-plan$/.test(path) && method === 'POST') {
          plans.push(body);
          const wanted = body.sourceTargetId, list = mainMissing ? sources.map(s => s.role === 'main' ? { ...s, status: 'missing' } : s) : sources;
          const planned = wanted ? list.find(s => s.targetId === wanted) : mainMissing ? list[1] : list[0];
          return route.fulfill({ json: { plan: { executable: true, mode: 'copy' }, sources: list, source: { targetId: planned.targetId, role: planned.role } } });
        }
        if (/\/restore$/.test(path) && method === 'POST') return route.fulfill({ status: 202, json: { id: 'job-1' } });
      } });
      await go(page, viewport, 'Backups');
      await page.locator('details.backup-group summary').first().click();
      await page.getByRole('button', { name: /^Restore backup/ }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Restore a recovery point' });
      await dialog.getByLabel('Target server').selectOption('server-1');
      await dialog.getByRole('button', { name: 'Prepare restore plan' }).click();
      const picker = dialog.getByLabel('Restore from');
      await picker.waitFor();
      assert.equal(await picker.inputValue(), mainMissing ? 't2' : 't1', label + ': main is the default; the verified copy when main is missing');
      assert.equal(await picker.locator('option[disabled]').count(), 1, label + ': a failed copy cannot be chosen');
      if (mainMissing) assert.match(await dialog.getByRole('alert').innerText(), /Main copy is not available[\s\S]*Cloudflare R2/);
      else assert.equal(await dialog.getByRole('alert').count(), 0);
      await shot(page, 'restore-source-' + (viewport.width === 1280 ? '1280' : '390') + '-' + scheme + (mainMissing ? '-fallback' : ''));
      if (!mainMissing) {
        await picker.selectOption('t2');
        await page.waitForFunction(() => document.querySelector('#cp-source')?.value === 't2');
        assert.equal(plans.at(-1).sourceTargetId, 't2', 'the plan is prepared again for the chosen copy');
      }
      await dialog.getByLabel(/Type the site name to confirm/).fill(LONG_SITE);
      await dialog.getByRole('button', { name: 'Confirm restore' }).click();
      await page.waitForFunction(() => document.querySelector('.notice')?.textContent.includes('Restore job queued'));
      const restore = calls.find(c => /\/restore$/.test(c.path) && c.method === 'POST');
      assert.equal(restore.body.sourceTargetId, mainMissing ? undefined : 't2', label + ': sourceTargetId only when picked');
      await context.close();
    }
    // One source only (no copies): no picker.
    const { context, page } = await open(wide, 'light', { onApi: ({ path, method, route }) => {
      if (/\/restore-plan$/.test(path) && method === 'POST') return route.fulfill({ json: { plan: { executable: true }, sources: [sources[0]], source: { targetId: 't1', role: 'main' } } });
    } });
    await go(page, wide, 'Backups');
    await page.locator('details.backup-group summary').first().click();
    await page.getByRole('button', { name: /^Restore backup/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Restore a recovery point' });
    await dialog.getByLabel('Target server').selectOption('server-1');
    await dialog.getByRole('button', { name: 'Prepare restore plan' }).click();
    await dialog.getByLabel(/Type the site name to confirm/).waitFor();
    assert.equal(await dialog.getByLabel('Restore from').count(), 0, 'no picker with a single source');
    await context.close();
  }
  console.log('Copies UI passed: site Storage row and dialog (limits, errors, defaults), copy labels and Retry, pre-2.11 data, report split, destination guard, restore source, light/dark, 1280 and 390.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); db.close(); await rm(directory, { recursive: true, force: true }); }
