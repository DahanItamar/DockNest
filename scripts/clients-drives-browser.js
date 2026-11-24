// Browser checks for the 3.0.0 screens: recovery time (overview, Map panel, Restore tests), Clients (list, editor, preview, PDF)
// and cloud drives (provider list, sign-in paste, card, Reconnect, local folder). Runs the real server with the fake rclone from
// tests/fake-rclone.js and fictional data only: no network, no account, no real provider.
// Needs Chrome (TEST_BROWSER_CHANNEL to change it). SHOTS_DIR also writes pictures: light and dark at 1280, light at 390.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

const shots = process.env.SHOTS_DIR;
if (shots) await mkdir(shots, { recursive: true });
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await new Promise(resolve => reservation.once('listening', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const directory = await mkdtemp(join(tmpdir(), 'docknest-ui1-')), fakeDir = join(directory, 'fake');
await mkdir(fakeDir); await copyFile(new URL('../tests/fake-rclone.js', import.meta.url), join(fakeDir, 'rclone.js'));
Object.assign(process.env, { DATA_DIR: directory, MASTER_KEY_FILE: join(directory, 'master.key'), SETUP_TOKEN_FILE: join(directory, 'setup.token'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: `http://127.0.0.1:${port}`, DOCKNEST_RCLONE_BIN: join(fakeDir, 'rclone.js') });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js'), { db, id } = await import('../src/db.js'), { digest, seal } = await import('../src/crypto.js');
const oauth = await import('../src/storage/rclone-oauth.js');
const base = `http://127.0.0.1:${port}`, DAY = 86_400_000, now = Date.now(), iso = ms => new Date(ms).toISOString();

function session(role) {
  const user = id(), token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, `${role}@example.invalid`, 'fixture', seal('JBSWY3DPEHPK3PXP'), '[]', iso(now), `Fixture ${role}`, role);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, 'fixture-csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
  return token;
}
const adminToken = session('admin'), viewerToken = session('viewer');
db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?)").run(JSON.stringify({ running: true, lastSeen: iso(now) }));

// ---- fictional fleet -------------------------------------------------------------------------------------------------------
const server = {};
for (const name of ['Server 1', 'Server 2']) { server[name] = id(); db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(server[name], name, 'localhost', 22, 'root', 'synthetic', '0'.repeat(64), iso(now - 90 * DAY)); }
const sites = {};
for (const [name, host] of [['Shop', 'Server 1'], ['Wiki', 'Server 1'], ['Ledger', 'Server 2'], ['Media', 'Server 2'], ['Notes', 'Server 1']]) {
  sites[name] = id(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?)').run(sites[name], server[host], name, '{"containers":["web","db"]}', iso(now - 90 * DAY));
  db.prepare("INSERT INTO policies(site_id,enabled,schedule,timezone,retention) VALUES(?,1,'0 2 * * *','UTC',7)").run(sites[name]);
}
function backup(site, capturedMs, size = 1e8) {
  const jobId = id(), backupId = id();
  db.prepare("INSERT INTO jobs(id,site_id,type,status,stage,created_at,started_at,finished_at) VALUES(?,?,'backup','completed','completed',?,?,?)").run(jobId, site, iso(capturedMs), iso(capturedMs), iso(capturedMs + 60_000));
  db.prepare('INSERT INTO backups VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(backupId, site, jobId, iso(capturedMs), '/x/' + backupId, size, 'a'.repeat(64), '{}', 0, 1, iso(capturedMs));
  return backupId;
}
function test(site, backupId, result, finishedMs, steps = { copy_backup: 240, restore_copy: 360, start_containers: 90, check_health: 30 }, serverName = 'Server 2') {
  const testId = randomUUID();
  db.prepare("INSERT INTO restore_tests(id,site_id,backup_id,backup_captured_at,server_id,trigger,result,limits,created_by,created_at,finished_at,restore_seconds) VALUES(?,?,?,?,?,'manual',?,'{}','u',?,?,?)").run(testId, site, backupId, iso(finishedMs - 3600_000), server[serverName], result, iso(finishedMs), iso(finishedMs), 360);
  let offset = 0;
  for (const [step, seconds] of Object.entries(steps)) { db.prepare("INSERT INTO restore_test_steps VALUES(?,?,'done',?,?,NULL)").run(testId, step, iso(finishedMs - 3600_000 + offset * 1000), iso(finishedMs - 3600_000 + (offset + seconds) * 1000)); offset += seconds; }
}
// A month of daily backups for the report (the previous calendar month), the newest backups for the cards.
const today = new Date(now), prevStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1), prevDays = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).getUTCDate();
const newest = {};
for (const [name, missed] of [['Shop', 0], ['Wiki', 0], ['Ledger', 4], ['Media', 0], ['Notes', 0]]) {
  for (let day = 0; day < prevDays - missed; day++) backup(sites[name], prevStart + day * DAY + 2 * 3600_000, 1e8);
  newest[name] = backup(sites[name], now - DAY, name === 'Media' ? 3e8 : 1e8);
}
test(sites.Shop, newest.Shop, 'passed', now - 3 * DAY);
test(sites.Shop, newest.Shop, 'passed', now - 10 * DAY, { copy_backup: 200, restore_copy: 300, start_containers: 100, check_health: 20 });
test(sites.Shop, newest.Shop, 'failed', now - 17 * DAY);
test(sites.Wiki, newest.Wiki, 'passed', now - 5 * DAY, { copy_backup: 120, restore_copy: 180, start_containers: 40, check_health: 20 });
test(sites.Ledger, newest.Ledger, 'failed', now - 20 * DAY);
test(sites.Media, newest.Media, 'passed', now - 41 * DAY, { copy_backup: 500, restore_copy: 800, start_containers: 150, check_health: 50 });
test(sites.Notes, newest.Notes, 'passed', now - 2 * DAY, { copy_backup: 60, restore_copy: 90, start_containers: 20, check_health: 10 });
// Tests inside the previous month, for the report.
test(sites.Shop, newest.Shop, 'passed', prevStart + 27 * DAY + 3600_000);
test(sites.Wiki, newest.Wiki, 'passed', prevStart + 20 * DAY + 3600_000, { copy_backup: 120, restore_copy: 180, start_containers: 40, check_health: 20 });
test(sites.Ledger, newest.Ledger, 'failed', prevStart + 24 * DAY + 3600_000);
const mail = id();
db.prepare("INSERT INTO connections(id,provider,name,secret,settings,created_at,updated_at) VALUES(?,'email','Studio mail (SMTP)',?,?,?,?)").run(mail, seal(JSON.stringify({ password: 'fixture-password-0001' })), JSON.stringify({ host: 'smtp.example.com', port: 587, security: 'starttls', username: 'mailer', from: 'reports@example.com' }), iso(now), iso(now));
// Cloud drive destinations in two states (a token JSON is only ever a fixture here).
const TOKEN = { access_token: 'fixture-access-token-0001', token_type: 'Bearer', refresh_token: 'fixture-refresh-token-0001', expiry: '2031-01-01T00:00:00Z' };
function drive(name, status, backend = 'drive') {
  const targetId = id();
  db.prepare('INSERT INTO storage_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(targetId, name, 'rclone.invalid', 1, '', 'not-sftp', 'rclone', seal(JSON.stringify({ token: TOKEN })), '/DockNest', 2e12, status, iso(now), iso(now));
  db.prepare("INSERT INTO storage_target_settings VALUES(?,'rclone',?)").run(targetId, JSON.stringify({ backend, account: 'ada@example.com', tokenExpiresAt: TOKEN.expiry }));
  return targetId;
}
const goodDrive = drive('Google Drive', 'connected');
db.prepare("INSERT OR REPLACE INTO settings VALUES('backup_storage_target',?)").run(goodDrive);

const http = app.listen(port, '127.0.0.1'); await new Promise(resolve => http.once('listening', resolve));
const call = (method, route, body, token = adminToken) => fetch(base + '/api' + route, { method, headers: { 'content-type': 'application/json', Cookie: 'dbm_session=' + token, Origin: base, 'x-csrf-token': 'fixture-csrf' }, body: body === undefined ? undefined : JSON.stringify(body) });
const must = async (response, status) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
const clientA = await must(await call('POST', '/clients', { name: 'Client A', agency: 'Studio North', contact: 'studio-north.example.com', accent: 'teal', apps: [sites.Shop, sites.Wiki], connectionId: mail, scheduleEnabled: true, timezone: 'Europe/London', recipients: ['a@example.com', 'b@example.com'] }), 201);
const clientB = await must(await call('POST', '/clients', { name: 'Client B', agency: 'Studio North', apps: [sites.Ledger] }), 201);
const clientC = await must(await call('POST', '/clients', { name: 'Client C', agency: 'Studio North', apps: [sites.Media, sites.Notes, sites.Shop], connectionId: mail, scheduleEnabled: true, recipients: ['c@example.com'] }), 201);
db.prepare("INSERT INTO client_reports(id,client_id,period_start,period_end,trigger,status,attempts,error,created_at) VALUES(?,?,?,?,'schedule','failed',3,'The mail server refused the message.',?)").run(id(), clientC.id, '2026-10-01', '2026-10-31', iso(now - 20 * DAY));
db.prepare("INSERT INTO client_reports(id,client_id,period_start,period_end,trigger,status,attempts,sent_at,created_at) VALUES(?,?,?,?,'schedule','sent',1,?,?)").run(id(), clientA.id, '2026-10-01', '2026-10-31', iso(now - 20 * DAY), iso(now - 20 * DAY));

let browser; const failures = [];
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
  const open = async (token, { width = 1280, height = 800, scheme = 'light' } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, acceptDownloads: true });
    await context.addCookies([{ name: 'dbm_session', value: token, url: base }]);
    // The app keeps its own theme choice; set it the way the theme switch does.
    await context.addInitScript(value => { try { localStorage.setItem('docknest-theme', value); } catch { /* none */ } }, scheme);
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => failures.push('pageerror: ' + error.message));
    page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) failures.push('console: ' + message.text()); });
    await page.goto(base);
    const ask = page.getByRole('dialog', { name: 'Check GitHub daily for new versions?' });
    if (await ask.count() || await ask.waitFor({ timeout: 2500 }).then(() => true, () => false)) { await ask.getByRole('button', { name: 'No, keep checks off' }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
    await page.getByRole('main').waitFor();
    return { context, page };
  };
  const nav = async (page, name) => { const menu = page.getByRole('button', { name: 'Open navigation' }); if (await menu.isVisible()) await menu.click(); await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click(); };
  const shot = async (page, name, scheme, width) => { await page.waitForTimeout(450); if (shots) await page.screenshot({ path: join(shots, `${name}-${width}-${scheme}.png`) }); };
  const matrix = [[1280, 'light'], [1280, 'dark'], [390, 'light']];

  for (const [width, scheme] of matrix) {
    const { context, page } = await open(adminToken, { width, height: width === 390 ? 844 : 800, scheme });
    const tag = (name) => shot(page, name, scheme, width);

    // R1: the quiet recovery line under the last test.
    await page.locator('.dash-sites').scrollIntoViewIfNeeded();
    const line = page.locator('.dash-site', { hasText: 'Shop' }).first().locator('.rec-line');
    await line.waitFor({timeout:8000}).catch(async()=>{console.log((await page.locator('.dash-sites').innerText()).slice(0,800));if(shots)await page.screenshot({path:join(shots,'debug.png')});throw new Error('no recovery line')});
    assert.match(await line.innerText(), /^Back in about 12 min · proven 3 days ago$/);
    assert.match(await page.locator('.dash-site', { hasText: 'Media' }).first().locator('.rec-line').innerText(), /not recent$/);
    assert.equal(await page.locator('.dash-site', { hasText: 'Ledger' }).first().locator('.rec-line').count(), 0, 'no passed test, no recovery line');
    await tag('R1-card-recovery');

    // R3: Restore tests dialog.
    await nav(page, 'Apps & Schedules');
    await page.getByRole('button', { name: /More actions for Shop/ }).first().click();
    await page.getByRole('menuitem', { name: 'Restore tests' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Back in about 12 min').waitFor();
    assert.equal(await dialog.locator('.rec-legend li').count(), 3);
    assert.match(await dialog.locator('.rec-legend').innerText(), /Get the backup\s+4 min[\s\S]*Restore data\s+6 min[\s\S]*Start and check\s+2 min/);
    assert.equal(await dialog.locator('.rec-recent tbody tr').count(), 4);
    assert.match(await dialog.innerText(), /Measured on Server 2/);
    await tag('R3-test-card');
    await page.keyboard.press('Escape');

    // R2: Map panel.
    await nav(page, 'Map');
    // The canvas on desktop, a list on phones.
    if (width === 390) await page.getByText('Shop', { exact: true }).first().click(); else await page.locator(`[data-node="site:${sites.Shop}"]`).click();
    await page.locator('.rec-line', { hasText: 'Back in about 12 min' }).waitFor();
    assert.equal(await page.locator('.rec-legend li').count(), 3);
    await tag('R2-map-panel');
    await context.close(); oauth.endAll();
  }

  // ---- Clients -----------------------------------------------------------------------------------------------------------
  for (const [width, scheme] of matrix) {
    const { context, page } = await open(adminToken, { width, height: width === 390 ? 844 : 800, scheme });
    await nav(page, 'Clients');
    await page.getByRole('heading', { name: 'Client A' }).waitFor();
    assert.equal(await page.locator('.cl-card').count(), 3);
    assert.match(await page.locator('.cl-card', { hasText: 'Client A' }).innerText(), /Monthly email on[\s\S]*Shop, Wiki[\s\S]*(Sent|Made) \d+ \w+ \d{4}[\s\S]*Studio North/);
    assert.match(await page.locator('.cl-card', { hasText: 'Client B' }).innerText(), /No email/);
    assert.match(await page.locator('.cl-card', { hasText: 'Client C' }).innerText(), /Email failed/);
    assert.doesNotMatch(await page.locator('main').innerText(), /a@example.com|b@example.com/);
    await shot(page, 'C1-clients-list', scheme, width);

    // C2: the editor, recipients masked, Up to 3, accents by name.
    await page.getByRole('button', { name: 'Edit Client A' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit client' });
    assert.match(await dialog.innerText(), /a\*\*\*@example\.com, b\*\*\*@example\.com/);
    assert.match(await dialog.innerText(), /Up to 3, one per line/);
    assert.equal(await dialog.getByRole('radio').count(), 7);
    assert.ok(await dialog.getByRole('radio', { name: 'Teal' }).isChecked());
    assert.equal(await dialog.getByLabel('Server names').isChecked(), false);
    assert.equal(await dialog.getByLabel('Hardening finding titles').isChecked(), false);
    await shot(page, 'C2-client-edit', scheme, width);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // C3: the preview, PDF and test email.
    await page.getByRole('button', { name: 'Make report for Client A' }).click();
    await page.getByRole('heading', { name: 'Client A report' }).waitFor();
    await page.locator('.cl-report tbody tr').first().waitFor();
    assert.equal(await page.locator('.cl-report tbody tr').count(), 2);
    assert.match(await page.locator('.cl-report tbody').innerText(), /Shop[\s\S]*About 12 min[\s\S]*Good/);
    await shot(page, 'C3-report-preview', scheme, width);
    if (scheme === 'light' && width === 1280) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
      const path = await download.path(), head = (await import('node:fs/promises')).readFile(path).then(bytes => bytes.subarray(0, 5).toString());
      assert.equal(await head, '%PDF-');
      assert.match(download.suggestedFilename(), /\.pdf$/);
      await page.getByRole('button', { name: 'Send test email' }).click();
      await page.getByText('Send last month’s report now?').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
    }
    await context.close(); oauth.endAll();
  }
  // A new client from scratch, with validation, and a viewer who sees no recipients and no edit.
  {
    const { context, page } = await open(adminToken);
    await nav(page, 'Clients');
    await page.getByRole('button', { name: 'Add client' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add client' });
    await dialog.getByRole('button', { name: 'Save' }).click({ force: true });
    assert.match(await dialog.innerText(), /Give the client a name/);
    await dialog.getByLabel('Client name').fill('Client D');
    await dialog.getByLabel('Notes').check();
    await dialog.getByRole('switch', { name: 'Monthly email' }).click();
    await dialog.getByRole('textbox', { name: 'Recipients' }).fill('a@example.com\nb@example.com\nc@example.com\nd@example.com');
    assert.match(await dialog.innerText(), /Up to 3 addresses/);
    await dialog.getByRole('textbox', { name: 'Recipients' }).fill('not an address');
    assert.match(await dialog.innerText(), /plain email addresses/);
    await dialog.getByRole('textbox', { name: 'Recipients' }).fill('d@example.com');
    await dialog.getByRole('button', { name: /Email connection/ }).click();
    await page.getByRole('option', { name: 'Studio mail (SMTP)' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Client D is added.').waitFor();
    assert.equal(await page.locator('.cl-card').count(), 4);
    await context.close(); oauth.endAll();
    const viewer = await open(viewerToken);
    await nav(viewer.page, 'Clients');
    await viewer.page.getByRole('heading', { name: 'Client A' }).waitFor();
    assert.equal(await viewer.page.getByRole('button', { name: /^Edit / }).count(), 0);
    assert.equal(await viewer.page.getByRole('button', { name: 'Add client' }).count(), 0);
    assert.doesNotMatch(await viewer.page.locator('main').innerText(), /Monthly email|Email failed|\*\*\*@/);
    await viewer.page.getByRole('button', { name: 'Make report for Client A' }).click();
    await viewer.page.locator('.cl-report tbody tr').first().waitFor();
    assert.equal(await viewer.page.getByRole('button', { name: 'Send test email' }).count(), 0);
    await viewer.context.close();
  }

  // ---- Cloud drives ------------------------------------------------------------------------------------------------------
  const pickProvider = async (page, name) => { await page.locator('.storage-dialog .cx-combo').click(); await page.getByRole('option', { name }).click(); };
  for (const [width, scheme] of matrix) {
    const { context, page } = await open(adminToken, { width, height: width === 390 ? 844 : 800, scheme });
    await nav(page, 'Storage');
    await page.getByRole('button', { name: 'Add storage destination', exact: true }).click();
    await page.locator('.storage-dialog .cx-combo').click();
    const list = page.getByRole('listbox');
    const groups = await list.locator('.cx-group').allInnerTexts();
    assert.deepEqual(groups.slice(-2), ['Cloud drives', 'Network and local']);
    assert.ok(await list.getByRole('option', { name: /Google Drive/ }).locator('svg.tabler-icon-brand-google-drive').count(), 'brand mark for Google Drive');
    assert.ok(await list.getByRole('option', { name: /OneDrive/ }).locator('svg.tabler-icon-brand-onedrive').count());
    assert.ok(await list.getByRole('option', { name: /Dropbox/ }).locator('svg.tabler-icon-brand-dropbox').count());
    assert.ok(await list.getByRole('option', { name: /Local folder/ }).locator('svg.tabler-icon-folder').count(), 'plain icon where there is no brand mark');
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await shot(page, 'D1-storage-picker', scheme, width);
    await page.getByRole('option', { name: /Google Drive/ }).click();
    const dialog = page.locator('.storage-dialog');
    const link = dialog.getByRole('link', { name: 'Open the sign-in link' });
    await link.waitFor();
    assert.match(await link.getAttribute('href'), /^https:\/\/accounts\.google\.com\//);
    assert.equal(await dialog.getByLabel('Destination name').inputValue(), 'Google Drive');
    const state = new URL(await link.getAttribute('href')).searchParams.get('state');
    const paste = dialog.getByLabel('Paste the address that failed to load'), address = `http://127.0.0.1:53682/?state=${state}&code=fixture-code-12345`;
    await paste.fill(address);
    await shot(page, 'D2-oauth-paste', scheme, width);
    // Nothing pasted: Test & connect says what to do and sends no connect request.
    await paste.fill('');
    await dialog.getByRole('button', { name: 'Test & connect' }).click();
    await dialog.getByText('Paste the address from the sign-in step.').first().waitFor();
    await paste.fill(address);
    if (scheme === 'light' && width === 1280) {
      await dialog.getByRole('button', { name: 'Test & connect' }).click();
      await page.getByText('Storage connected.').first().waitFor();
      assert.equal(await page.locator('.storage-card', { hasText: 'Google Drive' }).count(), 2);
      assert.match(await page.locator('.storage-card', { hasText: 'Google Drive' }).first().innerText(), /Append-only[\s\S]*Not available on Google Drive/);
    }
    await context.close(); oauth.endAll();
  }
  // Token paste (B) and own app (C), then the other providers' fields and the local folder panel.
  {
    const { context, page } = await open(adminToken);
    await nav(page, 'Storage');
    await page.getByRole('button', { name: 'Add storage destination', exact: true }).click();
    await writeFile(join(fakeDir, 'control.json'), JSON.stringify({ authLocation: 'https://www.dropbox.com/oauth2/authorize?client=fixture' }));
    await pickProvider(page, 'Dropbox');
    const dialog = page.locator('.storage-dialog');
    await dialog.getByRole('link', { name: 'Open the sign-in link' }).waitFor().catch(async e => { if (shots) await page.screenshot({ path: join(shots, 'debug.png') }); throw e; });
    await dialog.getByRole('button', { name: 'Use a token from rclone instead' }).click();
    await dialog.getByText('rclone authorize "dropbox"').waitFor();
    await dialog.getByLabel('Paste the token').fill('{"access_token":"x"');
    await dialog.getByRole('button', { name: 'Test & connect' }).click();
    await dialog.locator('[role="alert"]', { hasText: /./ }).first().waitFor();
    await writeFile(join(fakeDir, 'control.json'), '{}');
    await dialog.getByRole('button', { name: 'Use your own app ID' }).click();
    assert.equal(await dialog.getByLabel('Client secret').getAttribute('type'), 'password');
    await pickProvider(page, 'WebDAV');
    await dialog.getByLabel('WebDAV address').fill('http://cloud.example.com/dav');
    await dialog.getByLabel('User name', { exact: true }).fill('ada'); await dialog.locator('input[type="password"]').fill('fixture-password-0001');
    await dialog.getByRole('button', { name: 'Test & connect' }).click();
    await dialog.getByText('Use an HTTPS address without credentials, query or fragment.').first().waitFor();
    await pickProvider(page, 'SMB share');
    assert.ok(await dialog.getByLabel('File server').count());
    await pickProvider(page, 'Local folder');
    await dialog.getByText('Needs a folder mounted into DockNest').waitFor();
    assert.match(await dialog.locator('.dr-code pre').innerText(), /DOCKNEST_LOCAL_STORAGE: \/backups\/usb/);
    assert.equal(await dialog.getByRole('button', { name: 'Test & connect' }).getAttribute('aria-disabled'), 'true', 'Connect stays off without a folder');
    await dialog.getByLabel('Folder inside DockNest').fill('/backups/usb');
    await dialog.getByRole('button', { name: 'Test & connect' }).click();
    await dialog.getByText(/Mount a folder into DockNest first|not inside a path listed/).first().waitFor();
    await context.close(); oauth.endAll();
  }
  for (const [width, scheme] of matrix) {
    const { context, page } = await open(adminToken, { width, height: width === 390 ? 844 : 800, scheme });
    await nav(page, 'Storage');
    await page.locator('.storage-card', { hasText: 'Google Drive' }).first().waitFor();
    await page.locator('.storage-card', { hasText: 'Google Drive' }).first().evaluate(el => el.scrollIntoView({ block: 'center' }));
    await shot(page, 'D3-drive-card', scheme, width);
    await page.getByRole('button', { name: 'Add storage destination', exact: true }).click();
    await pickProvider(page, 'Local folder');
    await shot(page, 'D5-local-folder', scheme, width);
    await context.close(); oauth.endAll();
  }
  // D4: the token stopped working. The card says so, backups are paused, Reconnect is the main button and replaces the token.
  for (const [width, scheme] of matrix) {
    db.prepare("UPDATE storage_targets SET status='needs_reconnect' WHERE id=?").run(goodDrive);
    const { context, page } = await open(adminToken, { width, height: width === 390 ? 844 : 800, scheme });
    await nav(page, 'Storage');
    const card = page.locator('.storage-card', { hasText: 'Google Drive needs you to sign in again' });
    await card.waitFor().catch(async e => { if (shots) await page.screenshot({ path: join(shots, 'debug.png'), fullPage: true }); throw e; });
    assert.equal(await card.getByRole('button', { name: 'Use for new backups' }).count(), 0);
    await card.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await shot(page, 'D4-reconnect', scheme, width);
    if (scheme === 'light' && width === 1280) {
      await card.getByRole('button', { name: 'Reconnect' }).click();
      const dialog = page.getByRole('dialog', { name: 'Reconnect Google Drive' });
      const link = dialog.getByRole('link', { name: 'Open the sign-in link' }); await link.waitFor();
      const state = new URL(await link.getAttribute('href')).searchParams.get('state');
      await dialog.getByLabel('Paste the address that failed to load').fill(`http://127.0.0.1:53682/?state=${state}&code=fixture-code-67890`);
      await dialog.getByRole('button', { name: 'Test & reconnect' }).click();
      await page.getByText(/is connected again/).waitFor();
      assert.equal(await page.locator('.storage-card', { hasText: 'Needs sign-in' }).count(), 0);
    }
    await context.close(); oauth.endAll();
  }
  assert.deepEqual(failures, []);
  console.log('clients, cloud drives and recovery time screens passed');
} finally {
  if (failures.length) console.log('Browser errors:', failures.slice(0, 5));
  await browser?.close(); oauth.endAll(); http.close(); db.close(); await rm(directory, { recursive: true, force: true }).catch(() => {});
}
