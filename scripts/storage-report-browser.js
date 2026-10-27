// Storage report on the real Storage page: cards, numbers, sparkline, estimate line, info link, light and dark,
// 390 px phone without horizontal scroll. Synthetic backup rows only; no real storage or Docker is used.
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
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
  for (const [label, viewport, colorScheme] of [['desktop light', { width: 1440, height: 1000 }, 'light'], ['desktop dark', { width: 1440, height: 1000 }, 'dark'], ['phone', { width: 390, height: 844 }, 'light']]) {
    const context = await browser.newContext({ viewport, colorScheme });
    await context.addCookies([{ name: 'dbm_session', value: token, url: base }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const consent = page.getByRole('dialog', { name: 'Check GitHub daily for new versions?' });
    // The first sign-in asks once; later contexts of this run are already answered.
    if (await consent.waitFor({ timeout: 4000 }).then(() => true, () => false)) { await consent.getByRole('button', { name: 'No, keep checks off' }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
    if (viewport.width < 900) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Storage', exact: true }).first().click();
    const region = page.getByLabel('Storage report');
    await region.waitFor();
    assert.ok(await region.getByRole('heading', { name: 'By site' }).count(), label + ': By site card');
    assert.ok(await region.getByRole('heading', { name: 'By storage' }).count(), label + ': By storage card');
    assert.ok(await region.getByRole('heading', { name: 'Last 30 days' }).count(), label + ': Last 30 days card');
    assert.match(await region.locator('.sr-store').first().innerText(), /Local disk|Configured storage/);
    assert.match(await region.locator('.sr-estimate').innerText(), /Incremental backups could save about \d+% \(estimate\)\./);
    assert.equal(await region.locator('.sr-feature canvas').count(), 1, label + ': sparkline');
    const info = region.getByRole('link', { name: 'About this estimate' });
    assert.match(await info.getAttribute('href'), /docs\/restore-tests-guide\.md/);
    const box = await info.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, label + ': info target size');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), label + ': no horizontal scroll');
    if (colorScheme === 'dark') assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
    assert.deepEqual(errors, [], label);
    await context.close();
  }
  console.log('Storage report passed: cards, numbers, sparkline, estimate line, info link, light and dark, 390 px phone.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); db.close(); await rm(directory, { recursive: true, force: true }); }
