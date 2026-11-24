import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { NAS_WIZARD } from '../src/nas/guidance.js';

// NAS screens against a mocked API (fake data only): the NAS label on the server card, readiness in the Map panel, discovery
// grouped by app manager with the WebUI as plain text, the unsupported TrueNAS message and the connect wizard guidance.
// Run against a Vite dev server: TEST_BASE_URL=http://127.0.0.1:5299. SHOTS_DIR writes screenshots (light and dark, 1280 and 390).
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5173', shots = process.env.SHOTS_DIR;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const unraidCaps = { nas: { kind: 'unraid', version: '6.12.10' }, helperRuntime: 'container', stagingBase: '/mnt/cache/system/docknest', sshIdentity: 'root', freeBytes: 1.2e12, dockerVersion: '27.0.3' };
const state = {
  servers: [
    { id: 'nas1', name: 'NAS 1', host: 'nas1.example.invalid', port: 22, username: 'root', status: 'connected', capabilities: unraidCaps, hostKey: 'ab'.repeat(32) },
    { id: 'truenas', name: 'NAS 2', host: 'nas2.example.invalid', port: 22, username: 'admin', status: 'connected', capabilities: { nas: { kind: 'truenas', version: '24.04.2' }, sshIdentity: 'sudo' }, hostKey: 'cd'.repeat(32) },
    { id: 'plain', name: 'Server 1', host: 'srv1.example.invalid', port: 22, username: 'root', status: 'connected', capabilities: { freeBytes: 6.1e10 }, hostKey: 'ef'.repeat(32) },
  ],
  sites: [{ id: 's1', name: 'Wiki', serverId: 'plain', config: { containers: ['wiki-web'] } }], policies: [], jobs: [], backups: [], audit: [], storage: { used: 0, total: 1e12 },
};
const checks = [
  { id: 'nas-version', status: 'ok', message: 'unraid 6.12.10' },
  { id: 'identity', status: 'ok', message: 'Connected as root.' },
  { id: 'runtime', status: 'ok', message: 'The helper runtime image is loaded.' },
  { id: 'staging', status: 'ok', message: '/mnt/cache/system/docknest is on persistent storage.', freeBytes: 1.2e12 },
  { id: 'key-persistence', status: 'warn', message: 'SSH key is lost on reboot', fix: 'save the key in /boot/config/ssh/root so it stays after a reboot.' },
  { id: 'docker', status: 'ok', message: 'Docker 27.0.3' },
];
const containers = [
  { name: 'media', image: 'example/media', state: 'running', running: true, labels: {}, mounts: [], ports: {}, nasApp: { manager: 'unraid-template', displayName: 'Media', webUi: 'http://[IP]:[PORT:8096]/', icon: null }, backupConfiguration: { configFiles: [] } },
  { name: 'notes', image: 'example/notes', state: 'running', running: true, labels: {}, mounts: [], ports: {}, nasApp: { manager: 'unraid-template', displayName: 'Notes', webUi: '<b>x</b>', icon: null }, backupConfiguration: { configFiles: [] } },
  { name: 'wiki-web', image: 'example/wiki', state: 'running', running: true, labels: { 'com.docker.compose.project': 'wiki' }, mounts: [], ports: {}, nasApp: { manager: 'unraid-compose-manager', displayName: 'wiki', project: 'wiki' }, backupConfiguration: { configFiles: [] } },
];
const errors = [];
async function newPage(scheme, width) {
  const context = await browser.newContext({ viewport: { width, height: width > 600 ? 800 : 844 }, reducedMotion: 'reduce', colorScheme: scheme });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(theme => localStorage.setItem('docknest-theme', theme), scheme);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), endpoint = url.pathname;
    if (endpoint === '/api/auth/status') return route.fulfill({ json: { authenticated: true, csrfToken: 'fixture', user: { name: 'UI Reviewer', role: 'admin' }, serverTime: Date.now(), idleExpiresAt: Date.now() + 1800000, absoluteExpiresAt: Date.now() + 28800000 } });
    if (endpoint === '/api/state') return route.fulfill({ json: state });
    if (endpoint === '/api/servers/nas1/nas') return route.fulfill({ json: { nas: unraidCaps.nas, identity: 'root', helperRuntime: 'container', stagingBase: unraidCaps.stagingBase, ready: true, checks } });
    if (endpoint === '/api/servers/nas1/discover') return route.fulfill({ json: { nas: unraidCaps.nas, containers, staticSites: [], volumes: null } });
    if (endpoint === '/api/servers/truenas/discover') return route.fulfill({ status: 500, json: { error: 'TrueNAS apps before 24.10 run on Kubernetes, which DockNest does not back up. Update TrueNAS to 24.10 or newer.' } });
    if (endpoint === '/api/servers/onboarding') return route.fulfill({ json: { reportCommand: 'echo report', nas: NAS_WIZARD } });
    if (endpoint === '/api/auth/activity') return route.fulfill({ json: {} });
    if (endpoint === '/api/storage-targets') return route.fulfill({ json: { targets: [], active: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(base + '/');
  await page.locator('.berry-sidebar, nav').first().waitFor();
  return { context, page };
}
const nav = async (page, name) => { if (page.viewportSize().width < 900 && await page.getByRole('button', { name: 'Open navigation' }).count()) await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click(); };
const shot = async (page, name, scheme, width) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}-${width}-${scheme}.png`) }); };

for (const scheme of ['light', 'dark']) for (const width of [1280, 390]) {
  const { context, page } = await newPage(scheme, width);
  try {
    // Server card: the NAS name next to the status, nothing else added.
    await nav(page, 'Servers');
    const card = page.getByRole('article', { name: 'NAS 1', exact: true });
    await card.waitFor();
    assert.equal(await card.getByText('Unraid NAS', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('article', { name: 'Server 1', exact: true }).getByText(/NAS/).count(), 0, 'a Linux server shows no NAS label');
    assert.equal(await card.getByText(/Helper runtime|Staging folder/).count(), 0, 'Details rows are trimmed');
    await shot(page, 'N0-server-card', scheme, width);
    // Discover: grouped by manager, WebUI as text, never markup.
    await card.getByRole('button', { name: 'Discover apps', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Select app media', exact: true }).waitFor();
    assert.ok(await dialog.getByText('Unraid template · the Docker page keeps managing it').count() >= 1);
    assert.ok(await dialog.getByText('Web page setting: http://[IP]:[PORT:8096]/').count() === 1);
    assert.equal(await dialog.locator('b', { hasText: 'x' }).count(), 0, 'WebUI markup is shown as text');
    assert.equal(await dialog.locator('a[href*="IP"]').count(), 0, 'WebUI is never a link');
    await shot(page, 'N2-nas-discover', scheme, width);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    // Unsupported TrueNAS: its own title and the exact message.
    await page.getByRole('article', { name: 'NAS 2', exact: true }).getByRole('button', { name: 'Discover apps', exact: true }).click();
    await page.getByText('This TrueNAS version is not supported').waitFor();
    assert.ok(await page.getByText('Update TrueNAS to 24.10 or newer.').count() >= 1);
    await shot(page, 'N3-truenas-old', scheme, width);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    // Connect wizard: system type, guidance from the server, manual fingerprint, relaxed root text.
    await page.getByRole('button', { name: /Add server/ }).first().click();
    const wizard = page.getByRole('dialog');
    await wizard.getByLabel('System type').selectOption('truenas');
    await wizard.getByText('Before you connect').waitFor();
    assert.ok(await wizard.getByText(/passwordless sudo/).count() >= 1);
    await shot(page, 'N4-wizard', scheme, width);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    // Map panel: label next to the status, readiness first, warning with its fix.
    await nav(page, 'Map');
    await page.getByRole('heading', { level: 1, name: 'Map' }).waitFor();
    if (width >= 900) await page.locator('[data-node="server:nas1"]').click(); else await page.getByRole('button', { name: 'Details for NAS 1' }).click();
    const panel = page.locator('body');
    await panel.getByText('Helper runtime: Container (no Python on host)').waitFor().catch(async error => { if (shots) await page.screenshot({ path: path.join(shots, 'debug-map.png') }); throw error; });
    assert.ok(await panel.getByText('Unraid NAS').count() >= 1);
    assert.ok(await panel.getByText('SSH key is lost on reboot').count() === 1);
    assert.ok(await panel.getByRole('button', { name: 'Copy fix command' }).count() === 1);
    assert.equal(await panel.locator('dt', { hasText: /^(Helper runtime|Staging folder)$/ }).count(), 0, 'no Helper runtime or Staging folder rows in Details');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
    await shot(page, 'N1-nas-readiness', scheme, width);
  } finally { await context.close(); }
}
await browser.close();
assert.deepEqual(errors, [], 'no page errors');
console.log('NAS screens passed');
