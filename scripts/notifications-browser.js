// Browser checks for the notification center: the bell (unread count, newest four, pinned running jobs, Mark all read,
// outside click and Escape), the page (folders, filters, Mark read, Archive, Open), the toast stack (max three, "+N more",
// errors stay, success clears in 5 s, pause on hover) and the "updated" toast. Runs the real server with fictional data only.
// Needs Chrome (TEST_BROWSER_CHANNEL to change it). SHOTS_DIR also writes pictures: light and dark at 1280, light at 390.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

const shots = process.env.SHOTS_DIR;
if (shots) await mkdir(shots, { recursive: true });
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await new Promise(resolve => reservation.once('listening', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const directory = await mkdtemp(join(tmpdir(), 'docknest-notify-'));
Object.assign(process.env, { DATA_DIR: directory, MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: `http://127.0.0.1:${port}` });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js'), { db, id } = await import('../src/db.js'), { digest, seal } = await import('../src/crypto.js');
const { emit } = await import('../src/alerts/delivery.js'), { notify } = await import('../src/notifications/store.js');
const base = `http://127.0.0.1:${port}`, MIN = 60_000, now = Date.now(), iso = ms => new Date(ms).toISOString();

const user = id(), token = randomBytes(32).toString('base64url');
db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, 'admin@example.invalid', 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', iso(now), 'Admin', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, 'fixture-csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?)").run(JSON.stringify({ running: true, lastSeen: iso(now) }));
const server = id(), shop = id();
db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(server, 'Server 1', 'localhost', 22, 'root', 'synthetic', '0'.repeat(64), iso(now - 90 * 86400_000));
db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(shop, server, 'Shop', '{"containers":["web","db"]}', iso(now - 90 * 86400_000));
db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at) VALUES(?,?,'backup','running','dump',?,?)").run('job-running-0001', shop, iso(now - 2 * MIN), iso(now - 2 * MIN));

// A fictional inbox: older ones first so the newest ends on top.
const feed = [
  [{ type: 'update.available', key: 'occ:update:3.0.1', version: '3.0.1' }, 600],
  [{ type: 'certificate.expiring', key: 'site:cert', siteName: 'Shop', daysLeft: 6 }, 240],
  [{ type: 'backup.copy_failed', key: 'occ:copy:1', siteName: 'Wiki', serverName: 'Server 1', destinationName: 'Office drive' }, 200],
  [{ type: 'restore_test.recovered', key: 'occ:rt:1', siteName: 'Ledger', serverName: 'Server 2' }, 150],
  [{ type: 'server.disk_low', key: 'server:1', serverName: 'Server 2', freeBytes: 3 * 1024 ** 3, usedPercent: 94 }, 90],
  [{ type: 'backup.succeeded', key: 'site:wiki', siteName: 'Wiki', serverName: 'Server 1', jobId: 'job-wiki-0001' }, 60],
  [{ type: 'backup.failed', key: 'site:shop', siteName: 'Shop', serverName: 'Server 1', jobId: 'job-shop-0001' }, 30],
];
for (const [event, minutes] of feed) emit(event, { at: now - minutes * MIN });
emit({ type: 'backup.failed', key: 'site:shop', siteName: 'Shop', serverName: 'Server 1', jobId: 'job-shop-0001' }, { at: now - 12 * MIN });
db.prepare('UPDATE notifications SET read_at=? WHERE title IN (?,?)').run(iso(now), 'Update available', 'Restore test passed again');
notify({ type: 'restore.succeeded', key: 'occ:restore:fixture', siteName: 'Ledger', serverName: 'Server 2', jobId: 'job-ledger-0001' }, { at: now - 5 * MIN });

const http = app.listen(port, '127.0.0.1'); await new Promise(resolve => http.once('listening', resolve));
const call = (method, route, body) => fetch(base + '/api' + route, { method, headers: { 'content-type': 'application/json', Cookie: 'dbm_session=' + token, Origin: base, 'x-csrf-token': 'fixture-csrf' }, body: body === undefined ? undefined : JSON.stringify(body) });
const unread = async () => (await (await call('GET', '/notifications/unread-count')).json()).unread;

let browser; const failures = [];
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
  const open = async ({ width = 1280, height = 800, scheme = 'light', clock = false } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    await context.addCookies([{ name: 'dbm_session', value: token, url: base }]);
    await context.addInitScript(value => { try { localStorage.setItem('docknest-theme', value); } catch { /* none */ } }, scheme);
    const page = await context.newPage(); page.setDefaultTimeout(12000); if (clock) await page.clock.install(); page.on('pageerror', error => failures.push('pageerror: ' + error.message));
    page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) failures.push('console: ' + message.text()); });
    await page.goto(base);
    const ask = page.getByRole('dialog', { name: 'Check GitHub daily for new versions?' });
    if (await ask.count() || await ask.waitFor({ timeout: 2500 }).then(() => true, () => false)) { await ask.getByRole('button', { name: 'No, keep checks off' }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
    await page.getByRole('main').waitFor();
    return { context, page };
  };
  // Wide screens have folder tabs; narrow ones one selector that opens a sheet.
  const folder = async (page, name) => { const tab = page.getByRole('tab', { name }); if (await tab.count()) { await tab.click(); return; } await page.locator('.nc-folder').click(); await page.getByRole('radio', { name }).click(); };
  const shot = async (page, name, scheme, width) => { await page.waitForTimeout(400); if (shots) await page.screenshot({ path: join(shots, `${name}-${width}-${scheme}.png`) }); };

  for (const [width, scheme] of [[1280, 'light'], [768, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
    await call('POST', '/notifications/read-all'); // start each pass the same way
    db.prepare("UPDATE notifications SET read_at=NULL,archived_at=NULL WHERE title NOT IN ('Update available','Restore test passed again')").run();
    const { context, page } = await open({ width, scheme });
    const bell = page.getByRole('banner').getByRole('button', { name: /^Notifications/ });
    await bell.waitFor();
    // Bell: unread count, newest four, pinned running job.
    await bell.click();
    const popover = page.getByRole('dialog', { name: 'Notifications' });
    await popover.waitFor();
    assert.equal(await popover.locator('.nc-bell-item').count(), 4, 'the last four');
    assert.ok(await popover.getByText('1 job running').count(), 'the running job is one pinned row');
    assert.ok(await popover.getByRole('button', { name: 'Open notification center' }).count());
    await shot(page, 'bell', scheme, width);
    await page.keyboard.press('Escape'); await popover.waitFor({ state: 'detached' });
    await bell.click(); await popover.waitFor(); await page.mouse.click(width - 40, 500); await popover.waitFor({ state: 'detached' }); // outside click
    // Mark all read from the bell.
    await bell.click(); await popover.getByRole('button', { name: 'Mark all read' }).click();
    assert.equal(await unread(), 0, 'all read');
    await page.keyboard.press('Escape');
    await call('POST', '/notifications/unarchive', { ids: [1] });
    db.prepare("UPDATE notifications SET read_at=NULL WHERE title NOT IN ('Update available','Restore test passed again')").run();

    // Page.
    const menu = page.getByRole('button', { name: 'Open navigation' }); if (await menu.isVisible()) await menu.click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Notifications/ }).click();
    await page.getByRole('heading', { name: 'Notification center' }).waitFor();
    await page.locator('.nc-toolbar').first().waitFor();
    await page.getByRole('banner').getByRole('button', { name: /unread/ }).waitFor({ timeout: 9000 }); // the 5 s state poll brings the count
    assert.ok(await page.locator('.nc-row').count() >= 8, 'rows listed');
    await shot(page, 'v2-center', scheme, width);
    await folder(page, /^Needs action/);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.nc-row .nc-sev-success, .nc-row .nc-sev-info').count(), 0, 'only errors and warnings need action');
    await folder(page, /^All/);
    if (width < 640) {
      assert.equal(await page.locator('[role=tab]').count(), 0, 'one folder selector instead of tabs');
      const row = await page.locator('.nc-toolbar-narrow').boundingBox(); assert.ok(row.height <= 64, 'one line toolbar');
      await page.getByRole('button', { name: 'Filter' }).click(); await shot(page, 'v2-filter', scheme, width);
      await page.getByRole('radio', { name: 'Error' }).click(); await page.getByRole('switch', { name: 'Unread only' }).click(); await page.getByRole('button', { name: 'Done' }).click(); await page.waitForTimeout(400);
      assert.ok(await page.getByRole('button', { name: 'Filter, active' }).count(), 'active filter is marked');
      await page.getByRole('button', { name: 'Filter, active' }).click(); await page.getByRole('radio', { name: 'All severities' }).click(); await page.getByRole('switch', { name: 'Unread only' }).click(); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      await page.locator('.nc-folder').click(); await shot(page, 'v2-folders', scheme, width); await page.keyboard.press('Escape');
    }
    if (scheme === 'light' && width === 1280) {
      await page.getByLabel('Severity').selectOption('error'); await page.waitForTimeout(400);
      assert.ok(await page.locator('.nc-row').count() >= 1); assert.equal(await page.locator('.nc-row-meta .nc-sev-label:not(.nc-sev-error)').count(), 0);
      await page.getByLabel('Severity').selectOption('');
      const before = await unread();
      await page.locator('.nc-row.unread').first().getByRole('button', { name: 'Mark read' }).click(); await page.waitForTimeout(500);
      assert.equal(await unread(), before - 1, 'Mark read');
      const title = await page.locator('.nc-row').first().locator('b').innerText();
      await page.locator('.nc-row').first().getByRole('button', { name: 'Archive' }).click(); await page.waitForTimeout(500);
      await folder(page, /^Archived/); await page.waitForTimeout(400);
      assert.ok(await page.locator('.nc-row', { hasText: title }).count(), 'archived row is in Archived');
      await page.locator('.nc-row').first().getByRole('button', { name: 'Unarchive' }).click(); await page.waitForTimeout(400);
      await folder(page, /^All/);
      await page.locator('.nc-row').first().getByRole('button', { name: /Open|View job/ }).first().click();
      await page.getByRole('heading', { name: /Job Activity|Jobs/ }).first().waitFor();
    }

    // Toast stack: four new problems -> three shown plus "+1 more"; errors stay, newest at the bottom.
    await call('GET', '/state');
    for (const [index, name] of ['Alpha', 'Bravo', 'Charlie', 'Delta'].entries()) emit({ type: 'backup.failed', key: `site:toast${index}-${width}-${scheme}`, siteName: name, serverName: 'Server 1' });
    const stack = page.getByRole('region', { name: 'Notifications' });
    await stack.waitFor({ timeout: 9000 });
    await page.waitForFunction(() => document.querySelectorAll('.nc-toast').length >= 3, null, { timeout: 9000 });
    assert.equal(await page.locator('.nc-toast').count(), 3, 'max three');
    assert.ok(await stack.getByRole('button', { name: /^\+\d+ more$/ }).count(), '+N more');
    const last = await page.locator('.nc-toast').last().innerText(); assert.match(last, /Delta/, 'newest at the bottom');
    await shot(page, 'toasts', scheme, width);
    await page.waitForTimeout(5600); assert.equal(await page.locator('.nc-toast').count(), 3, 'errors stay');
    await stack.getByRole('button', { name: /^\+\d+ more$/ }).click();
    await page.getByRole('heading', { name: 'Notification center' }).waitFor();
    await context.close();
  }

  // Success toast clears in 5 s and pauses on hover. The page clock is controlled, so there are no real sleeps: time moves only when we run it.
  {
    const { context, page } = await open({ clock: true });
    emit({ type: 'backup.succeeded', key: 'site:toast-ok', siteName: 'Shop', serverName: 'Server 1' });
    const toast = page.locator('.nc-toast-success', { hasText: 'Shop on Server 1' });
    for (let step = 0; step < 40 && !(await toast.count()); step++) await page.clock.runFor(1000); // the 5 s state poll brings it in
    await toast.waitFor();
    await toast.hover();
    await page.clock.runFor(30_000); assert.equal(await toast.count(), 1, 'paused while hovered, however long');
    await page.mouse.move(5, 5);
    await page.clock.runFor(2000); assert.equal(await toast.count(), 1, 'still there while time is left');
    await page.clock.runFor(4000); await toast.waitFor({ state: 'detached' }); // success clears itself
    await context.close();
  }
} finally { await browser?.close(); http.close(); }
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Notification center browser checks passed.');
process.exit(0);
