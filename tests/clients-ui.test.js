import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCENTS, accentVar, appNames, attentionNote, emailState, lastReportText, monthChoices, parseRecipients, previewRow, summaryText } from '../web/clients/model.js';
import { ACCENTS as SERVER_ACCENTS } from '../src/reports/client.js';
import { COMPOSE_SNIPPET, driveFacts, folderIssue, maskAccount, pasteKind, smbHostIssue, smbShareIssue, stateOf, webdavIssue } from '../web/storage-drives/drive-model.js';

test('accent: the page offers exactly the names the server allows, each mapped to a design token, never a colour', () => {
  assert.deepEqual(ACCENTS.map(item => item[0]), [...SERVER_ACCENTS]);
  for (const [, , token] of ACCENTS) assert.match(token, /^--dn-[a-z0-9-]+$/);
  assert.equal(accentVar('teal'), '--dn-teal');
  assert.equal(accentVar('#ff0000'), '--dn-brand-solid', 'an unknown name falls back, a raw colour is never used');
  const source = readFileSync(new URL('../web/clients/ClientDialog.jsx', import.meta.url), 'utf8');
  assert.ok(!/accent[^\n]*#[0-9a-f]{3,8}/i.test(source), 'no raw colour in the editor');
});

test('card text: email state, last report, apps', () => {
  const schedule = enabled => ({ enabled, connectionId: 'c', nextDueAt: null });
  assert.deepEqual(emailState({ schedule: schedule(true) }), { state: 'success', label: 'Monthly email on' });
  assert.deepEqual(emailState({ schedule: schedule(false) }), { state: 'queued', label: 'No email' });
  assert.deepEqual(emailState({ schedule: schedule(true), lastReport: { status: 'failed' } }), { state: 'failed', label: 'Email failed' });
  assert.equal(emailState({}), null, 'a viewer sees no schedule');
  assert.equal(lastReportText({}), 'None yet');
  assert.match(lastReportText({ lastReport: { status: 'sent', sentAt: '2026-11-01T08:00:00Z' } }), /^Sent \d{1,2} Nov 2026$/);
  assert.match(lastReportText({ lastReport: { status: 'failed', createdAt: '2026-11-01T08:00:00Z' } }), /^Email failed /);
  assert.equal(lastReportText({ lastReport: { status: 'sending' } }), 'Sending now');
  const sites = [{ id: 'a', name: 'Wiki' }, { id: 'b', name: 'Shop' }, { id: 'c', name: 'Notes' }, { id: 'd', name: 'Ledger' }];
  assert.equal(appNames({ apps: ['a', 'b'] }, sites).text, 'Shop, Wiki');
  assert.equal(appNames({ apps: ['a', 'b', 'c', 'd'] }, sites).text, 'Ledger, Notes, Shop and 1 more');
  assert.equal(appNames({ apps: ['gone'] }, sites).text, 'Apps no longer available');
  assert.equal(appNames({ apps: [] }, sites).text, 'No apps yet');
});

test('recipients: up to 3, one per line, plain addresses only', () => {
  assert.deepEqual(parseRecipients('a@example.com\nb@example.com, c@example.com'), { list: ['a@example.com', 'b@example.com', 'c@example.com'], error: '' });
  assert.equal(parseRecipients('a@example.com\nA@example.com'.replace('A', 'a')).list.length, 1, 'duplicates collapse');
  assert.equal(parseRecipients('a@example.com\nb@example.com\nc@example.com\nd@example.com').error, 'Up to 3 addresses, one per line.');
  assert.match(parseRecipients('not an address').error, /plain email addresses/);
  assert.match(parseRecipients('Name <a@example.com>').error, /plain email addresses/);
  assert.deepEqual(parseRecipients(''), { list: [], error: '' });
});

test('periods: the last 12 calendar months in the client zone, whole months', () => {
  const choices = monthChoices('UTC', Date.parse('2026-11-24T12:00:00Z'));
  assert.equal(choices.length, 12);
  assert.deepEqual([choices[0].label, choices[1].from, choices[1].to], ['November 2026', '2026-10-01', '2026-10-31']);
  assert.deepEqual([choices[11].label, choices[11].from, choices[11].to], ['December 2025', '2025-12-01', '2025-12-31']);
  assert.equal(monthChoices('Pacific/Kiritimati', Date.parse('2026-01-01T00:30:00Z'))[0].label, 'January 2026', 'the client zone decides the month');
  assert.equal(monthChoices('Not/AZone', Date.parse('2026-03-05T00:00:00Z'))[0].label, 'March 2026', 'a bad zone falls back to UTC');
  assert.equal(monthChoices('UTC', Date.parse('2026-03-05T00:00:00Z'))[1].to, '2026-02-28');
});

test('preview rows come from the API facts and explain what needs attention', () => {
  const good = { name: 'Shop', state: 'Good', backups: { taken: 31, due: 31, failed: 0, missed: 0 }, restoreTests: [{ at: '2026-10-28T02:00:00Z', result: 'Passed', recovery: 'about 12 min' }], recovery: 'Back in about 12 min, proven 3 days ago' };
  const bad = { name: 'Ledger', state: 'Needs attention', backups: { taken: 27, due: 31, failed: 0, missed: 4 }, restoreTests: [{ at: '2026-10-25T02:00:00Z', result: 'Failed', recovery: null }], recovery: 'Not proven yet: no restore test has passed' };
  const none = { name: 'Notes', state: 'Not protected', backups: { taken: 0, due: 0 }, restoreTests: [], recovery: 'Not proven yet: no restore test has passed' };
  assert.deepEqual([previewRow(good).backups, previewRow(good).test.label, previewRow(good).recovery, previewRow(good).state], ['31 of 31', 'Passed 28 Oct', 'About 12 min', 'success']);
  assert.deepEqual([previewRow(bad).test.label, previewRow(bad).recovery, previewRow(bad).state], ['Failed 25 Oct', 'Not measured', 'needs-review']);
  assert.equal(previewRow(bad).note, 'Ledger: 4 backups missed. The last restore test failed.');
  assert.equal(previewRow(good).note, '');
  assert.equal(previewRow(none).test.label, 'No test in this period');
  assert.match(attentionNote(none), /No backup finished in this period/);
  assert.equal(summaryText({ apps: [good, bad, none], summary: { good: 1, attention: 1, unprotected: 1 } }), '3 apps · 1 good · 1 needs attention · 1 not protected');
  assert.equal(previewRow({ ...good, recovery: 'Back in under 2 min, proven today' }).recovery, 'Under 2 min');
});

test('cloud drives: masked account, honest semantics, folder and address checks', () => {
  assert.equal(maskAccount('ada@example.com'), 'a•••@example.com');
  assert.equal(maskAccount('a***@e***.com'), 'a•••@e•••.com');
  assert.equal(maskAccount('fixture'), 'fi•••');
  assert.equal(maskAccount(null), '');
  const drive = { kind: 'rclone', backend: 'drive', semantics: { appendOnly: false, trash: true }, capacity_bytes: 0 };
  assert.deepEqual(driveFacts(drive), { appendOnly: 'Not available on Google Drive', trashNote: 'Deleted backups go to the Google Drive trash first. That is a soft safety net, not protection.', capacity: 'Not reported' });
  assert.equal(driveFacts({ kind: 'local', semantics: { trash: false }, capacity_bytes: 0 }).trashNote, '');
  assert.deepEqual(stateOf({ needsReconnect: true, status: 'needs_reconnect' }), { state: 'failed', label: 'Needs sign-in' });
  assert.equal(stateOf({ status: 'connected' }).state, 'success');
  for (const bad of ['../x', 'a//b', './a', 'a/..', 'x'.repeat(201), 'a;b']) assert.notEqual(folderIssue(bad), '', bad);
  for (const ok of ['', 'docknest', 'team/docknest', '/docknest/', 'My backups']) assert.equal(folderIssue(ok), '', ok);
  assert.notEqual(webdavIssue('http://cloud.example.com/dav'), '');
  assert.notEqual(webdavIssue('https://user:pw@cloud.example.com/dav'), '');
  assert.notEqual(webdavIssue('https://cloud.example.com/dav?x=1'), '');
  assert.equal(webdavIssue('https://cloud.example.com/remote.php/dav/files/user'), '');
  assert.equal(webdavIssue('http://127.0.0.1:8080/dav'), '');
  assert.notEqual(smbHostIssue('nas/share'), '');
  assert.equal(smbHostIssue('nas.example.com'), '');
  assert.notEqual(smbShareIssue('a/b'), '');
  assert.equal(smbShareIssue('backups'), '');
});

test('sign-in paste: addresses and token JSON are told apart, anything else is explained', () => {
  assert.equal(pasteKind(''), 'empty');
  assert.equal(pasteKind('http://127.0.0.1:53682/?state=abc&code=def'), 'address');
  assert.equal(pasteKind('{"access_token":"x"}'), 'token');
  assert.equal(pasteKind('https://evil.example.com/?code=x'), 'other');
});

test('the local folder snippet is the documented one and holds no real path', () => {
  const docs = readFileSync(new URL('../docs/cloud-drives.md', import.meta.url), 'utf8');
  assert.match(docs, /DOCKNEST_LOCAL_STORAGE: \/backups\/usb/);
  assert.match(COMPOSE_SNIPPET, /DOCKNEST_LOCAL_STORAGE: \/backups\/usb/);
  assert.match(COMPOSE_SNIPPET, /- \/mnt\/usb-backup:\/backups\/usb/);
});

test('providers: new groups come after SFTP and S3, with brand marks only where Tabler has one', async () => {
  const { PROVIDER_GROUPS } = await import('../web/storage-providers.js');
  assert.deepEqual(PROVIDER_GROUPS.map(group => group.label).slice(-2), ['Cloud drives', 'Network and local']);
  const items = Object.fromEntries(PROVIDER_GROUPS.flatMap(group => group.items).map(item => [item.id, item]));
  assert.deepEqual([items.gdrive.icon, items.onedrive.icon, items.dropbox.icon], ['brand-google-drive', 'brand-onedrive', 'brand-dropbox']);
  for (const id of ['webdav', 'smb', 'local']) assert.ok(!items[id].icon.startsWith('brand-'), id);
});
