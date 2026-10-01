import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const problems = [];
page.on('pageerror', error => problems.push(error.message));
await mkdir('data/screenshots', { recursive: true });
try {
  await page.goto('http://127.0.0.1:3000');
  await page.getByRole('heading', { name: 'Set up your administrator' }).waitFor();
  await page.getByLabel('First-run setup token').waitFor();
  await page.screenshot({ path: 'data/screenshots/setup-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Setup must fit mobile viewport');
  await page.screenshot({ path: 'data/screenshots/setup-mobile.png', fullPage: true });
  // Isolated browser-only empty fixtures exercise UI navigation without creating an administrator.
  await page.route('**/api/auth/status', route => route.fulfill({ json: { authenticated: true, setupRequired: false, csrfToken: 'fixture', user: { email: 'ui-test@example.org' } } }));
  await page.route('**/api/state', route => route.fulfill({ json: { servers: [], sites: [], policies: [], backups: [], jobs: [], restores: [], audit: [], storage: { used: 0, total: 1000000 }, maintenance: { title: 'Briefly under maintenance', message: 'We will be back shortly.', color: '#147d73' } } }));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.screenshot({ path: 'data/screenshots/dashboard-desktop.png', fullPage: true });
  for (const name of ['Servers', 'Sites & schedules', 'Backups', 'Jobs', 'Maintenance', 'Audit']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    await page.locator('#content h1').waitFor();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Dashboard must fit mobile viewport');
  await page.screenshot({ path: 'data/screenshots/dashboard-mobile.png', fullPage: true });
  assert.deepEqual(problems, [], 'No uncaught browser errors');
  console.log('Browser smoke passed: setup desktop/mobile, seven dashboard views, responsive layout, no uncaught errors.');
} finally { await browser.close(); }
