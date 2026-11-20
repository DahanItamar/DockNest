import assert from 'node:assert/strict';

// Linked apps (docs/linked-apps.md) in the real UI, against the fixture `servers[].appLinks` of /api/state: the Map lines
// and details, the Backup, Move and Restore test warnings and the phone list. Called from map-browser.js, which owns the
// browser, the mocked API and the helpers passed in. Fictional names and documentation addresses only.
const scan = (links = [], unowned = [], hubs = [], extra = {}) => ({checkedAt: '2026-11-19T08:00:00.000Z', partial: false, links, unowned, hubs, ...extra});
const detail = (kind, via, containers) => [{kind, via, containers}];
const link = (appIds, kind, via, containers, warns = true) => ({appIds, kind, via, warns, details: detail(kind, via, containers)});

// Demo Shop, Ledger and Wiki share one host; Media is alone on the other. Ledger has three warnings, Demo Shop two,
// and Wiki's only link to Demo Shop is a network, which never warns.
export function linkedState(mediaLinks = scan()) {
  const host = (id, name, address, appLinks) => ({id, name, host: address, port: 22, username: 'root', status: 'connected', appLinks});
  const app = (id, name, serverId, containers) => ({id, name, serverId, config: {containers}});
  return {
    servers: [
      host('lk1', 'Demo host', '192.0.2.10', scan(
        [link(['ledger', 'wiki'], 'volume', '/srv/shared', ['ledger-web', 'wiki-web']), link(['ledger', 'shop'], 'database', 'demo-db', ['demo-db', 'ledger-web']), link(['shop', 'wiki'], 'network', 'demo-net', ['demo-shop-web', 'wiki-web'], false)],
        [{container: 'demo-cache', appIds: ['ledger', 'shop'], kind: 'link', via: 'demo-cache', details: detail('link', 'demo-cache', ['demo-cache', 'demo-shop-web'])}],
        [{network: 'proxy', appIds: ['ledger', 'shop', 'wiki']}])),
      host('lk2', 'Media host', '192.0.2.20', mediaLinks),
    ],
    sites: [app('shop', 'Demo Shop', 'lk1', ['demo-shop-web', 'demo-db']), app('ledger', 'Ledger', 'lk1', ['ledger-web']), app('wiki', 'Wiki', 'lk1', ['wiki-web']), app('media', 'Media', 'lk2', ['media-web'])],
    jobs: [], backups: [], policies: [], audit: [], storage: {used: 0, total: 1e12}, worker: {online: true},
  };
}

const panel = page => page.locator('.map-panel');
async function openApp(page, id) {
  await page.locator(`.map-site[data-site="${id}"]`).click();
  await panel(page).locator('.lk-section').waitFor();
}
// The page after open() with the fixture: the Backup and restore test endpoints answer, and every backup request is kept.
async function start(open, state, options) {
  const session = await open({...options, appState: state});
  const backups = [];
  await session.page.route('**/api/sites/*/backup', route => { backups.push(new URL(route.request().url()).pathname); return route.fulfill({status: 202, json: {job: {id: 'job1'}}}); });
  await session.page.route('**/api/sites/*/restore-tests', route => route.fulfill({status: 404, json: {error: 'Not found'}}));
  return {...session, backups};
}
// "and N more" is a toggle: it names the hidden count, then offers to hide them again, and aria-expanded follows.
async function expandsLines(scope, hidden) {
  const more = scope.getByRole('button', {name: /^and \d+ more$/});
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await scope.getByText(hidden).count(), 0, 'hidden before expanding');
  await more.click();
  const fewer = scope.getByRole('button', {name: 'Show fewer'});
  assert.equal(await fewer.getAttribute('aria-expanded'), 'true');
  await scope.getByText(hidden).waitFor();
  await fewer.click();
  assert.equal(await scope.getByRole('button', {name: /^and \d+ more$/}).getAttribute('aria-expanded'), 'false');
  assert.equal(await scope.getByText(hidden).count(), 0, 'collapsed again');
}

async function mapLines(open, options) {
  const {context, page} = await start(open, linkedState(), options);
  await page.locator('.map-site').first().waitFor();
  assert.equal(await page.locator('.map-lines path.link').count(), 3, 'one dashed line per linked pair');
  assert.notEqual(await page.locator('.map-lines path.link').first().evaluate(p => getComputedStyle(p).strokeDasharray), 'none', 'link lines are dashed');
  await openApp(page, 'shop');
  assert.equal(await page.locator('.map-lines path.link.lit').count(), 2, 'selecting Demo Shop lights its two links');
  assert.equal(await page.locator('.map-lines path.link.dim').count(), 1, 'the link between the others dims');
  const section = panel(page).locator('.lk-section');
  await section.getByText('Shares the database demo-db with Ledger').waitFor();
  await section.getByText('On the network demo-net with Wiki').waitFor();
  await section.getByText('On the shared network proxy with 2 other apps').waitFor();
  await section.getByText('Uses demo-cache, which no app backs up').waitFor();
  await section.getByRole('button', {name: /Ledger/}).click();
  await panel(page).getByRole('heading', {name: 'Ledger'}).waitFor();
  await context.close();
}

async function states(open, options) {
  for (const [media, text] of [
    [scan(), 'No linked apps found in the last scan.'],
    [{...scan(), checkedAt: null}, 'Not scanned yet.'],
    [scan([], [], [], {partial: true}), 'Some containers could not be read, so this list may be incomplete.'],
  ]) {
    const {context, page} = await start(open, linkedState(media), options);
    await openApp(page, 'media');
    await panel(page).locator('.lk-section').getByText(text, {exact: false}).waitFor();
    assert.equal(await panel(page).locator('.lk-row').count(), 0, text + ': no link rows');
    await context.close();
  }
}

async function appsPage(open, options) {
  const {context, page, backups} = await start(open, linkedState(), options);
  await page.getByRole('navigation', {name: 'Main navigation'}).getByRole('button', {name: 'Apps & Schedules', exact: true}).click();
  const card = name => page.getByRole('article', {name});
  const dialog = page.getByRole('dialog');
  // Warning links: confirm first, nothing queued until "Back up now" in the confirm
  await card('Demo Shop').getByRole('button', {name: 'Back up now'}).click();
  await dialog.getByText('Demo Shop shares the database demo-db with Ledger, so back up both to keep the copies matching.').waitFor();
  await dialog.getByText('Demo Shop uses demo-cache, which no app backs up, so its data is not in this copy.').waitFor();
  assert.equal(await dialog.getByRole('button', {name: /^and \d+ more$/}).count(), 0, 'two warnings fit without "more"');
  assert.deepEqual(backups, [], 'nothing queued before the confirm');
  await dialog.getByRole('button', {name: 'Back up now'}).click();
  await dialog.waitFor({state: 'detached'});
  assert.deepEqual(backups, ['/api/sites/shop/backup']);
  // No warning links: one click queues the backup, no dialog
  await card('Media').getByRole('button', {name: 'Back up now'}).click();
  await page.getByText('Backup queued.', {exact: false}).waitFor();
  assert.equal(await dialog.count(), 0, 'no confirm without warnings');
  assert.deepEqual(backups, ['/api/sites/shop/backup', '/api/sites/media/backup']);
  // Restore test start: the warning shows, the rest behind "and N more"
  await card('Ledger').getByRole('button', {name: 'Restore tests'}).click();
  await dialog.getByText('Ledger shares the folder /srv/shared with Wiki, so the test copy may not work without it.').waitFor();
  await expandsLines(dialog, 'Ledger uses demo-cache, which no app backs up, so the test copy may not work without it.');
  await context.close();
}

async function moveReview(open, options) {
  const {context, page} = await start(open, linkedState(), options);
  await openApp(page, 'ledger');
  await panel(page).getByRole('button', {name: 'Move to…'}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', {name: /^Media host/}).click();
  await page.getByText(/will move to Media host/).waitFor();
  await page.waitForFunction(() => !document.querySelector('.map-toolbar .primary').disabled);
  await page.getByRole('button', {name: 'Save changes'}).click();
  await dialog.getByRole('heading', {name: 'Ready to move'}).waitFor();
  await dialog.getByText('Ledger shares the folder /srv/shared with Wiki, so moving only one can break it.').waitFor();
  await expandsLines(dialog, 'Ledger uses demo-cache, which no app backs up, so it stays behind when this app moves.');
  await context.close();
}

async function phone(open, options, fits) {
  const {context, page} = await start(open, linkedState(), {...options, width: 390, height: 844});
  await page.locator('.map-list').waitFor();
  const item = name => page.locator('.map-list li').filter({has: page.locator('.map-name', {hasText: new RegExp(`^${name}$`)})});
  assert.equal((await item('Demo Shop').locator('.lk-line').textContent()).trim(), 'Linked to Ledger and Wiki');
  assert.equal((await item('Ledger').locator('.lk-line').textContent()).trim(), 'Linked to Wiki and Demo Shop');
  assert.equal(await item('Media').locator('.lk-line').count(), 0, 'no caption without links');
  await fits(page, 'phone linked list');
  await item('Ledger').getByRole('button', {name: 'Details'}).click();
  const sheet = page.getByRole('dialog');
  await sheet.locator('.lk-section').waitFor();
  assert.ok(await sheet.locator('.map-dialog-body').evaluate(e => e.scrollWidth <= e.clientWidth), 'details sheet fits');
  await fits(page, 'phone linked details');
  await context.close();
}

// open(options) is map-browser's page opener; fits(page, label) asserts there is no horizontal overflow.
export async function linkedChecks({open, fits, scheme}) {
  const options = {scheme};
  await mapLines(open, options);
  await states(open, options);
  await appsPage(open, options);
  await moveReview(open, options);
  await phone(open, options, fits);
}
