// The client report (docs/client-reports.md): one document model per client and period, built only from the allow-listed
// fields below, then drawn by the Recovery Guide's PDF writer (src/runbook/pdf.js). Nothing here reads a host name, an
// address, a user name, a port, a key, a token, a storage endpoint or bucket, a path, a container name or an environment
// value, so none can reach the PDF (decision 4); tests/client-reports.test.js renders a fixture full of them to prove it.
// Server names and hardening finding titles are the only opt-in extras, both off by default.
import { db } from '../db.js';
import { hardeningView } from '../hardening.js';
import { worstState } from '../domains/hops.js';
import { renderPdf } from '../runbook/pdf.js';
import { VERSION } from '../runbook/render.js';
import { recoveryTime, formatRecoveryTime } from '../../shared/recovery-time.js';
import { longDate } from './period.js';

export const INCLUDE_DEFAULTS = Object.freeze({ serverNames: false, findingTitles: false });
export const ACCENTS = Object.freeze(['default', 'blue', 'green', 'amber', 'red', 'violet']);
const json = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
// A name the owner typed, shown as typed minus control characters and bidi overrides (a name can never reorder its neighbours).
export const plain = (value, max = 80) => String(value ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const includeOf = stored => { const own = typeof stored === 'string' ? json(stored, {}) : stored; return Object.fromEntries(Object.keys(INCLUDE_DEFAULTS).map(name => [name, own?.[name] === true])); };
const STATES = { good: 'Good', attention: 'Needs attention', unprotected: 'Not protected' };
const FAILED_COPY = new Set(['failed', 'gave_up']);

// Recovery time of a passed restore test, measured the same way as everywhere else (shared/recovery-time.js).
const measured = test => formatRecoveryTime(recoveryTime(db.prepare('SELECT step,state,started_at,finished_at FROM restore_test_steps WHERE test_id=?').all(test.id), { result: 'passed', finished_at: test.finished_at })?.seconds);
const about = text => (text ? (text.startsWith('under') ? text : `about ${text}`) : null);
const daysAgo = (iso, at) => { const days = Math.floor((at - Date.parse(iso)) / 86_400_000); return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`; };
const kindOf = targetId => { const row = db.prepare('SELECT auth_type FROM storage_targets WHERE id=?').get(targetId); return row ? (row.auth_type === 's3-access-key' ? 'S3-compatible storage' : 'SFTP server') : null; };
export const sizeText = bytes => { const n = Number(bytes) || 0; if (n < 1024) return `${n} B`; const units = ['KB', 'MB', 'GB', 'TB']; let value = n / 1024, unit = 0; while (value >= 1024 && unit < 3) { value /= 1024; unit += 1; } return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`; };

function appFacts(site, period, include, madeAt) {
  const { start, end } = period, id = site.id;
  // Jobs are never pruned, so counts come from them; sizes come from the backups retention has not removed yet.
  const count = status => db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE site_id=? AND type='backup' AND status=? AND COALESCE(finished_at,created_at)>=? AND COALESCE(finished_at,created_at)<?").get(id, status, start, end).n;
  const taken = count('completed'), failed = count('failed');
  const missed = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='backup.missed' AND target=? AND created_at>=? AND created_at<?").get(id, start, end).n;
  const newest = db.prepare("SELECT MAX(COALESCE(finished_at,created_at)) AS at FROM jobs WHERE site_id=? AND type='backup' AND status='completed' AND COALESCE(finished_at,created_at)<?").get(id, end).at ?? null;
  const kept = db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS size FROM backups WHERE site_id=?').get(id);
  const copyRows = db.prepare("SELECT c.status,c.target_id FROM backup_copies c JOIN backups b ON b.id=c.backup_id WHERE b.site_id=? AND c.status IN ('verified','failed','gave_up')").all(id);
  const kinds = [...new Set(copyRows.map(row => kindOf(row.target_id)).filter(Boolean))].sort();
  const tests = db.prepare("SELECT id,result,finished_at FROM restore_tests WHERE site_id=? AND result IN ('passed','failed') AND finished_at>=? AND finished_at<? ORDER BY finished_at,id").all(id, start, end);
  const proven = db.prepare("SELECT id,finished_at FROM restore_tests WHERE site_id=? AND result='passed' AND finished_at<? ORDER BY finished_at DESC,id DESC LIMIT 1").get(id, end) ?? null;
  const certificate = db.prepare('SELECT not_after,expired,renewal FROM site_certificates WHERE site_id=?').get(id) ?? null;
  const hardening = hardeningView(id);
  const domains = db.prepare('SELECT domain,hops FROM domain_checks WHERE site_id=? ORDER BY domain LIMIT 50').all(id).map(row => { const hops = json(row.hops, null); return { name: row.domain, pointsHere: hops?.dns?.state === 'ok', httpsOk: hops?.certificate?.state === 'ok', state: worstState(hops) }; });
  const lastTest = tests.at(-1) ?? null;
  const state = !taken ? 'unprotected' : failed || missed || lastTest?.result === 'failed' ? 'attention' : 'good';
  const server = include.serverNames ? plain(db.prepare('SELECT name FROM servers WHERE id=?').get(site.server_id)?.name, 80) || null : null;
  return {
    name: plain(site.name), ...(server ? { server } : {}), state: STATES[state],
    backups: { taken, due: taken + failed + missed, failed, missed, newest, keptCount: kept.n, keptSize: sizeText(kept.size) },
    copies: { verified: copyRows.filter(row => row.status === 'verified').length, failed: copyRows.filter(row => FAILED_COPY.has(row.status)).length, kinds },
    restoreTests: tests.map(test => ({ at: test.finished_at, result: test.result === 'passed' ? 'Passed' : 'Failed', recovery: test.result === 'passed' ? about(measured(test)) : null })),
    recovery: proven && measured(proven) ? `Back in ${about(measured(proven))}, proven ${daysAgo(proven.finished_at, madeAt)}` : 'Not proven yet: no restore test has passed',
    certificate: certificate ? { validUntil: certificate.not_after, expired: certificate.expired === 1, renewal: certificate.renewal === 'failed' ? 'Renewal failed' : 'Renewal ok' } : null,
    hardening: hardening.grade ? { grade: hardening.grade, findings: hardening.findings.length, ...(include.findingTitles ? { titles: hardening.findings.map(item => plain(item.title, 120)) } : {}) } : null,
    domains,
  };
}

// client: a `clients` row; period: from resolvePeriod; madeAt: ms. Returns the JSON the preview shows and the PDF draws.
export function buildReport(client, period, madeAt = Date.now()) {
  const include = includeOf(client.include);
  const sites = db.prepare('SELECT s.id,s.name,s.server_id,a.archived_at FROM client_apps c JOIN sites s ON s.id=c.site_id LEFT JOIN site_archives a ON a.site_id=s.id WHERE c.client_id=? ORDER BY s.name,s.id').all(client.id);
  const active = sites.filter(site => !site.archived_at), removed = sites.filter(site => site.archived_at && site.archived_at >= period.start);
  const apps = active.map(site => appFacts(site, period, include, madeAt));
  return {
    client: plain(client.name), agency: client.agency ? plain(client.agency) : null, contact: client.contact ? plain(client.contact, 120) : null, accent: ACCENTS.includes(client.accent) ? client.accent : 'default',
    period: { from: period.from, to: period.to, label: period.label }, madeAt: new Date(madeAt).toISOString(), version: VERSION, include, apps,
    removed: removed.map(site => plain(site.name)),
    summary: { good: apps.filter(app => app.state === STATES.good).length, attention: apps.filter(app => app.state === STATES.attention).length, unprotected: apps.filter(app => app.state === STATES.unprotected).length },
  };
}

const when = (iso, zone) => iso ? longDate(Date.parse(iso), zone) : 'never';
export function reportBlocks(report, { timeZone = 'UTC' } = {}) {
  const asOf = longDate(Date.parse(report.madeAt), timeZone);
  const lines = [report.agency ? `Prepared by ${report.agency}` : null, report.contact].filter(Boolean);
  const blocks = [
    { type: 'title', title: report.client, subtitle: `Backup report, ${report.period.label}`, lines: lines.length ? lines : ['Backups and recovery checks for your apps.'] },
    { type: 'heading', text: 'Summary' },
    { type: 'paragraph', text: report.apps.length ? `${report.summary.good} of ${report.apps.length} apps are in good shape.${report.summary.attention ? ` ${report.summary.attention} need attention.` : ''}${report.summary.unprotected ? ` ${report.summary.unprotected} had no backup in this period.` : ''}` : 'No apps are included in this report.' },
    { type: 'table', columns: ['App', 'Backups taken / due', 'Last restore test', 'Recovery', 'State'], rows: report.apps.map(app => [app.name, `${app.backups.taken} / ${app.backups.due}`, app.restoreTests.at(-1) ? `${app.restoreTests.at(-1).result}, ${when(app.restoreTests.at(-1).at, timeZone)}` : 'None in this period', app.recovery, app.state]) },
  ];
  if (report.removed.length) blocks.push({ type: 'paragraph', text: `Removed during this period: ${report.removed.join(', ')}.`, tone: 'muted' });
  for (const app of report.apps) {
    blocks.push({ type: 'heading', text: app.name, newPage: true });
    blocks.push({ type: 'paragraph', text: `State: ${app.state}.${app.server ? ` Runs on ${app.server}.` : ''}`, tone: app.state === STATES.good ? undefined : 'warning' });
    blocks.push({ type: 'heading', level: 2, text: 'Backups' });
    blocks.push({ type: 'list', items: [`${app.backups.taken} taken, ${app.backups.failed} failed, ${app.backups.missed} missed (${app.backups.due} due).`, `Newest backup: ${when(app.backups.newest, timeZone)}.`, `Kept now: ${app.backups.keptCount} backups, ${app.backups.keptSize}.`] });
    blocks.push({ type: 'heading', level: 2, text: 'Extra copies' });
    blocks.push({ type: 'paragraph', text: app.copies.verified || app.copies.failed ? `${app.copies.verified} verified copies${app.copies.kinds.length ? ` on ${app.copies.kinds.join(', ')}` : ''}; ${app.copies.failed} not completed.` : 'No extra copies are kept for this app.' });
    blocks.push({ type: 'heading', level: 2, text: 'Restore tests' });
    blocks.push(app.restoreTests.length ? { type: 'table', columns: ['Date', 'Result', 'Recovery time'], rows: app.restoreTests.map(test => [when(test.at, timeZone), test.result, test.recovery ?? 'n/a']) } : { type: 'paragraph', text: 'No restore test ran in this period.' });
    blocks.push({ type: 'paragraph', text: `${app.recovery}.`, tone: 'muted' });
    blocks.push({ type: 'heading', level: 2, text: `Current state, as of ${asOf}` });
    const facts = [];
    facts.push(app.certificate ? `Certificate: ${app.certificate.expired ? 'expired' : `valid until ${when(app.certificate.validUntil, timeZone)}`}. ${app.certificate.renewal}.` : 'Certificate: not tracked.');
    facts.push(app.hardening ? `Hardening grade ${app.hardening.grade}, ${app.hardening.findings} ${app.hardening.findings === 1 ? 'finding' : 'findings'}${app.hardening.titles?.length ? `: ${app.hardening.titles.join('; ')}` : ''}.` : 'Hardening grade: not checked.');
    for (const domain of app.domains) facts.push(`${domain.name}: ${domain.pointsHere ? 'points to the right server' : 'does not point to the right server'}, HTTPS ${domain.httpsOk ? 'ok' : 'not ok'}.`);
    blocks.push({ type: 'list', items: facts });
  }
  return blocks;
}

export function reportPdf(report, { timeZone = 'UTC' } = {}) {
  return renderPdf(reportBlocks(report, { timeZone }), { title: `${report.client}, backup report, ${report.period.label}`, header: `${report.client}, ${report.period.label}`, createdAt: report.madeAt });
}
