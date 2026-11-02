// Server cleanup on the Storage page (docs/server-cleanup.md), on the real app with only the two cleanup endpoints
// mocked: Scan, the grouped preview with sizes, kept items with reasons, leaving a group out, the confirm dialog, the
// result with skipped items, a busy server, a scan error, an empty server and an expired preview. Light, dark and a
// 390 px phone. Synthetic data only; no real server or Docker is used.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await new Promise(resolve => reservation.once('listening', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const directory = await mkdtemp(join(tmpdir(), 'docknest-cleanup-ui-'));
Object.assign(process.env, { DATA_DIR: directory, MASTER_KEY_FILE: join(directory, 'master.key'), NODE_ENV: 'test', BACKUP_STORAGE: 'unconfigured', SECURE_COOKIES: 'false', APP_ORIGIN: `http://127.0.0.1:${port}` });
await writeFile(process.env.MASTER_KEY_FILE, randomBytes(32).toString('base64'));
const { app } = await import('../src/server.js'), { db, id } = await import('../src/db.js'), { digest, seal } = await import('../src/crypto.js');
const user = id(), token = randomBytes(32).toString('base64url'), past = new Date(Date.now() - 3 * 86400000).toISOString();
db.prepare('INSERT INTO users(id,email,password_hash,totp_secret,recovery_codes,enrolled,created_at,name,role) VALUES(?,?,?,?,?,1,?,?,?)').run(user, 'fixture@example.invalid', 'fixture', seal('JBSWY3DPEH' + 'PK3PXP'), '[]', past, 'Fixture', 'admin');
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,last_activity_at,created_at,authenticated_at) VALUES(?,?,?,?,?,?,?)').run(digest(token), user, 'fixture-csrf', Date.now() + 3600000, Date.now(), Date.now(), Date.now());
db.prepare("INSERT INTO settings VALUES('worker_heartbeat',?)").run(JSON.stringify({ running: true, lastSeen: new Date().toISOString() }));
for (const [serverId, name] of [['server-1', 'Production'], ['server-2', 'Staging box with a long name']]) db.prepare('INSERT INTO servers(id,name,host,port,username,private_key,host_key,created_at) VALUES(?,?,?,?,?,?,?,?)').run(serverId, name, 'localhost', 22, 'root', 'synthetic', '0'.repeat(64), past);
const server = app.listen(port, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${port}`;
const hex = c => c.repeat(64);
const preview = (extra = {}) => ({
  token: 'preview-token', expiresAt: new Date(Date.now() + 900000).toISOString(), busy: null, totalBytes: 1_234_000_000,
  items: [
    ...Array.from({ length: 7 }, (_, i) => ({ kind: 'containers', id: hex(String(i)), name: i === 0 ? 'a-very-long-one-off-migration-container-name-that-keeps-going' : 'job-' + i, bytes: 1000 * (i + 1) })),
    { kind: 'images', id: 'sha256:' + hex('d'), name: 'dddddddddddd', bytes: 900_000_000 },
    { kind: 'volumes', id: hex('e'), name: 'eeeeeeeeeeee', bytes: null },
    { kind: 'buildCache', id: 'build-cache', name: 'Unused build cache', bytes: 300_000_000 },
  ],
  protected: [{ kind: 'volumes', id: 'shop_data', name: 'shop_data', reason: 'site' }, { kind: 'containers', id: hex('f'), name: 'shop-old', reason: 'oldCopy' }, { kind: 'images', id: 'sha256:' + hex('a'), name: 'aaaaaaaaaaaa', reason: 'docknest' }],
  ...extra,
});
let browser;
async function openStorage(viewport, colorScheme, { scan = () => ({ json: preview() }), clean = null } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  await context.addCookies([{ name: 'dbm_session', value: token, url: base }]);
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(scheme => { try { localStorage.setItem('docknest-theme', scheme); } catch {} }, colorScheme);
  // The account is older than this release, so What's new would open first; it has its own suite.
  await page.route('**/api/updates/whats-new', route => route.fulfill({ json: { show: false } }));
  await page.route('**/api/servers/*/cleanup/scan', route => { requests.push({ url: route.request().url(), body: route.request().postDataJSON() }); return route.fulfill(scan()); });
  await page.route('**/api/servers/*/cleanup', route => { const body = route.request().postDataJSON(); requests.push({ url: route.request().url(), body }); return route.fulfill(clean ? clean(body) : { json: { result: 'partial', removed: body.items.length - 1, skipped: 1, failed: 0, bytes: 1_200_000_000, results: body.items.map((item, i) => i === 0 ? { ...item, name: 'job-0', status: 'skipped', reason: 'inUse' } : { ...item, name: item.id.slice(0, 12), status: 'removed' }) } }); });
  await page.goto(base);
  const consent = page.getByRole('dialog', { name: 'Check GitHub daily for new versions?' });
  if (await consent.waitFor({ timeout: 4000 }).then(() => true, () => false)) { await consent.getByRole('button', { name: 'No, keep checks off' }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
  if (viewport.width < 900) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Storage', exact: true }).first().click();
  const card = page.locator('section.sc-root');
  await card.getByRole('heading', { name: 'Server cleanup' }).waitFor();
  return { context, page, errors, requests, card };
}
const box = locator => locator.boundingBox();
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
  for (const [label, viewport, colorScheme] of [['desktop light', { width: 1440, height: 1000 }, 'light'], ['desktop dark', { width: 1440, height: 1000 }, 'dark'], ['phone', { width: 390, height: 844 }, 'light']]) {
    const { context, page, errors, requests, card } = await openStorage(viewport, colorScheme);
    assert.deepEqual(await card.getByRole('combobox', { name: 'Server to clean' }).locator('option').allInnerTexts(), ['Production', 'Staging box with a long name'], label);
    await card.getByRole('button', { name: 'Scan', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sc-group').length === 4);
    assert.match(requests[0].url, /\/api\/servers\/server-1\/cleanup\/scan$/, label);
    assert.deepEqual(await card.locator('.sc-group .t-section').allInnerTexts(), ['Stopped containers', 'Dangling images', 'Unused volumes', 'Build cache'], label + ': grouped by kind, in a fixed order');
    assert.match(await card.locator('.sc-total').innerText(), /^1\.2 GB\s+can be freed$/, label);
    assert.equal(await card.locator('.sc-group').first().locator('tbody tr').count(), 5, label + ': five rows per page');
    assert.equal(await card.getByRole('button', { name: 'Stopped containers next page' }).count(), 1, label + ': the long group pages');
    assert.match(await card.locator('.sc-group').nth(2).locator('tbody td').nth(2).innerText(), /Unknown/, label + ': a size the server could not count says so');
    assert.equal(await card.locator('.sc-group').nth(2).locator('.sc-group-size').innerText(), 'Unknown', label + ': never a false 0 B');
    assert.equal(await card.locator('.sc-group').nth(3).locator('.sc-group-size').innerText(), 'Up to 300 MB', label + ': build cache is an upper bound');
    if (viewport.width < 768) {
      assert.equal(await card.locator('.sc-items').first().locator('tbody td:nth-child(2)').first().isVisible(), false, label + ': no ID column on a phone');
      assert.equal(await card.locator('.sc-items').first().locator('.sc-id-inline').first().innerText(), '000000000000', label + ': the ID shows under the name');
    } else assert.equal(await card.locator('.sc-items .sc-id-inline').first().isVisible(), false, label + ': the ID has its own column');
    const longName = card.locator('.sc-group').first().locator('tbody td').first();
    assert.match(await longName.getAttribute('title'), /^a-very-long-one-off/, label + ': long names keep their full text in the title');
    // Kept items with plain reasons, behind a disclosure.
    await card.locator('.sc-kept summary').click();
    assert.deepEqual(await card.locator('.sc-kept tbody td:nth-child(3)').allInnerTexts(), ['Used by a site', 'Kept old copy', 'DockNest'], label);
    // Controls: equal heights, no wrapping.
    const select = await box(card.getByRole('combobox', { name: 'Server to clean' })), scanButton = await box(card.getByRole('button', { name: 'Scan', exact: true }));
    if (viewport.width > 480) assert.ok(Math.abs(select.height - scanButton.height) <= 4 && Math.abs(select.y + select.height - scanButton.y - scanButton.height) <= 1, label + ': select and Scan line up');
    for (const name of ['Scan', 'Clean up']) assert.equal(await card.getByRole('button', { name, exact: true }).evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap', label + ': ' + name);
    // Leave the images out, then confirm.
    await card.locator('.sc-group').nth(1).getByRole('checkbox').uncheck();
    await card.getByRole('button', { name: 'Clean up', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Clean up Production?' });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /removes 9 items, about 300 MB\. This cannot be undone\./, label);
    const [cancel, go] = [dialog.getByRole('button', { name: 'Cancel' }), dialog.getByRole('button', { name: 'Clean up' })];
    const [a, b] = [await box(cancel), await box(go)];
    assert.ok(Math.abs(a.height - b.height) < 1, label + ': dialog buttons match');
    await go.click();
    await card.locator('.sc-result').waitFor();
    const sent = requests.at(-1).body;
    assert.equal(sent.token, 'preview-token');
    assert.equal(sent.items.length, 9); assert.ok(!sent.items.some(item => item.kind === 'images'), label + ': a group left out is not sent');
    assert.match(await card.locator('.sc-result .alert-panel').innerText(), /Removed 8 items, 1\.2 GB freed\. 1 item skipped\./, label);
    assert.deepEqual(await card.locator('.sc-result tbody td').allInnerTexts(), ['job-0', 'Stopped containers', 'In use'], label + ': why an item stayed');
    assert.equal(await card.getByRole('heading', { name: 'Items not removed' }).count(), 1, label + ': a section heading, not a caption');
    assert.equal(await card.locator('.sc-result caption').count(), 0, label);
    assert.equal(await page.getByRole('dialog').count(), 0, label + ': the dialog closed');
    if (viewport.width < 768) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), label + ': no horizontal scroll');
    if (colorScheme === 'dark') assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
    assert.deepEqual(errors, [], label);
    await context.close();
  }
  const wide = { width: 1440, height: 1000 };
  { // A busy server: red panel with the action, and Clean up stays off.
    const { context, page, card } = await openStorage(wide, 'light', { scan: () => ({ json: preview({ busy: 'A backup is running on this server.' }) }) });
    await card.getByRole('button', { name: 'Scan', exact: true }).click();
    const panel = card.locator('.alert-panel.alert-error'); await panel.waitFor();
    assert.match(await panel.innerText(), /Cleanup must wait[\s\S]*A backup is running on this server\./);
    assert.equal(await panel.getByRole('button', { name: 'Scan again' }).count(), 1);
    assert.equal(await card.getByRole('button', { name: 'Clean up', exact: true }).isDisabled(), true);
    await context.close();
  }
  { // The server cannot be reached: the message and Scan again.
    const { context, card } = await openStorage(wide, 'dark', { scan: () => ({ status: 502, json: { error: 'DockNest could not reach Production. Test the connection on the Servers page.', code: 'SERVER_UNREACHABLE' } }) });
    await card.getByRole('button', { name: 'Scan', exact: true }).click();
    const panel = card.locator('.alert-panel.alert-error'); await panel.waitFor();
    assert.match(await panel.innerText(), /Cleanup did not run[\s\S]*could not reach Production/);
    assert.equal(await panel.getByRole('button', { name: 'Scan again' }).count(), 1);
    await context.close();
  }
  { // On a phone the alert action is full width and 44 px high.
    const { context, page, card } = await openStorage({ width: 390, height: 844 }, 'light', { scan: () => ({ status: 502, json: { error: 'DockNest could not reach Production.', code: 'SERVER_UNREACHABLE' } }) });
    await card.getByRole('button', { name: 'Scan', exact: true }).click();
    const action = card.locator('.alert-panel.alert-error').getByRole('button', { name: 'Scan again' }); await action.waitFor();
    const button = await box(action), panel = await box(card.locator('.alert-panel-body'));
    assert.ok(button.height >= 44 && Math.abs(button.width - panel.width) <= 1, 'phone: full-width 44 px action ' + JSON.stringify({ button, panel }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'phone: no horizontal scroll');
    await context.close();
  }
  { // Nothing to clean, on the second server.
    const { context, page, card, requests } = await openStorage(wide, 'light', { scan: () => ({ json: preview({ items: [], totalBytes: 0 }) }) });
    await card.getByRole('combobox', { name: 'Server to clean' }).selectOption('server-2');
    await card.getByRole('button', { name: 'Scan', exact: true }).click();
    await card.locator('.sc-empty').waitFor();
    assert.equal(await card.locator('.sc-empty').innerText(), 'Nothing to clean on Staging box with a long name.');
    assert.match(requests[0].url, /server-2/);
    assert.equal(await card.getByRole('button', { name: 'Clean up', exact: true }).count(), 0);
    assert.equal(await page.locator('.sc-kept').count(), 1, 'kept items still explain what stays');
    await context.close();
  }
  { // The preview expired between Scan and Clean up: a red panel says so and the preview is gone.
    const { context, page, card } = await openStorage(wide, 'light', { clean: () => ({ status: 409, json: { error: 'This preview has expired. Scan again.', code: 'PREVIEW_EXPIRED' } }) });
    await card.getByRole('button', { name: 'Scan', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sc-group').length === 4);
    await card.getByRole('button', { name: 'Clean up', exact: true }).click();
    await page.getByRole('dialog', { name: 'Clean up Production?' }).getByRole('button', { name: 'Clean up' }).click();
    const panel = card.locator('.alert-panel.alert-error'); await panel.waitFor();
    assert.match(await panel.innerText(), /This preview has expired\. Scan again\./);
    assert.equal(await card.locator('.sc-group').count(), 0);
    await context.close();
  }
  console.log('Server cleanup passed: scan, grouped preview, kept reasons, group left out, confirm dialog, result with skipped item, busy, unreachable, empty, expired preview, light and dark, 390 px phone.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); db.close(); await rm(directory, { recursive: true, force: true }); }
