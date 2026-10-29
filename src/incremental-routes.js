// Incremental backups API (docs/incremental-backups.md). Mounted under /api after authentication and CSRF.
// - GET/PUT /api/sites/:id/incremental: the per-site option (beta, off by default), its chain length and "full now".
// - GET /api/backups/:id/chain-download: the encrypted packages a backup needs (full first) plus ORDER.txt, streamed as
//   one uncompressed tar. Nothing is decrypted on the server; each package is checked against its stored SHA-256 while
//   it streams, and a mismatch cuts the download short so a damaged chain never looks complete.
import express from 'express';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, id, audit, parse, transaction } from './db.js';
import { requireAdmin, requireRecentAuth } from './auth.js';
import { statFile, openRead } from './storage.js';
import { packagePath } from './artifact-journal.js';
import { discardIncrementalState, busySite, enqueueBackup } from './engine.js';
import { incrementalSettings, updateIncrementalSettings, applyIncrementalSettings, loadChain, verifyChainLinks, inChain, ChainError, FULL_REASONS } from './incremental.js';

const notFound = message => { throw Object.assign(new Error(message), { status: 404 }); };
const site = siteId => parse(db.prepare('SELECT * FROM sites WHERE id=?').get(siteId)) || notFound('Site not found.');
const view = (row, settings) => ({ siteId: row.id, enabled: settings.enabled, interval: settings.interval, fullNext: settings.fullNext, fullNextReason: settings.fullNextReason, fullNextMessage: settings.fullNextReason ? FULL_REASONS[settings.fullNextReason] ?? null : null, available: row.config?.kind !== 'static', beta: true });

// ---- tar (POSIX ustar; sizes past 8 GiB use the GNU/POSIX base-256 form that GNU tar, bsdtar and Python read) ----------
const BLOCK = 512;
export function tarHeader(name, size, mtimeMs = Date.now()) {
  const header = Buffer.alloc(BLOCK);
  if (Buffer.byteLength(name) > 100) throw new Error('tar entry name too long');
  header.write(name, 0, 100, 'utf8');
  header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  if (size < 0o77777777777) header.write(size.toString(8).padStart(11, '0') + '\0', 124);
  else { header[124] = 0x80; let value = BigInt(size); for (let index = 135; index > 124; index--) { header[index] = Number(value & 0xffn); value >>= 8n; } }
  header.write(Math.floor(mtimeMs / 1000).toString(8).padStart(11, '0') + '\0', 136);
  header.fill(' ', 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  let sum = 0; for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}
export const tarPadding = size => (BLOCK - (size % BLOCK)) % BLOCK;
export const packageName = (index, backupId) => `${String(index + 1).padStart(2, '0')}-${backupId}.enc`;
// ORDER.txt: what to restore, in which order, and how to check each file without DockNest. Not a secret: ids and
// checksums of encrypted files only.
export function orderText(members) {
  const lines = [
    'DockNest incremental backup chain',
    `Chain: ${members[0].link.chain_id}`,
    `Backups: ${members.length} (1 full backup and ${members.length - 1} ${members.length === 2 ? 'increment' : 'increments'})`,
    '',
    'Restore in this order. Decrypt and extract the full backup first, then each increment in order, using',
    'tar --listed-incremental=/dev/null when you extract the mount archives, so files deleted later are removed too.',
    'The recovery kit tool checks every file and every link first:',
    '  node decrypt-backup.js --chain <this folder> <master.key> <new empty folder>',
    '',
    'position file kind backup sha256 size parent parentSha256',
  ];
  members.forEach((member, index) => {
    const manifest = typeof member.manifest === 'string' ? JSON.parse(member.manifest) : member.manifest;
    lines.push([index, packageName(index, member.id), member.link.backup_kind, member.id, member.checksum, member.size, manifest?.chain?.parentBackupId ?? '-', manifest?.chain?.parentSha256 ?? '-'].join(' '));
  });
  return Buffer.from(lines.join('\n') + '\n');
}

export const incrementalRoutes = express.Router();
incrementalRoutes.get('/sites/:id/incremental', (req, res) => { const row = site(req.params.id); res.json(view(row, incrementalSettings(row.id))); });
// "Full backup now" ({ fullNow: true } alone) is a backup request: the same role as Back up now (operators too). Changing
// the option or its interval stays an administrator change with recent authentication.
const fullNowOnly = body => Boolean(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && body.fullNow === true);
const settingsChange = (req, res, next) => fullNowOnly(req.body) ? next() : requireAdmin(req, res, () => requireRecentAuth(req, res, next));
incrementalRoutes.put('/sites/:id/incremental', settingsChange, async (req, res) => {
  const row = site(req.params.id);
  if (db.prepare('SELECT 1 FROM site_archives WHERE site_id=?').get(row.id)) return res.status(409).json({ error: 'This site was removed from active sites.', code: 'site_removed' });
  const staticSite = row.config?.kind === 'static';
  let outcome, job = null;
  try {
    // fullNow marks the next backup full and starts it now through the same enqueue as Back up now (deployment hold,
    // site moving, busy and archived guards, audit). The settings change commits in the job's transaction, so a refused
    // backup leaves the settings and the audit trail exactly as they were.
    if (req.body?.fullNow === true) job = enqueueBackup(row.id, req.user.id, {}, { within: () => { outcome = applyIncrementalSettings(row.id, req.body, req.user.id, { staticSite }); } });
    else outcome = updateIncrementalSettings(row.id, req.body, req.user.id, { staticSite });
  } catch (error) { if (error.status && error.code) return res.status(error.status).json({ error: error.message, code: error.code }); throw error; }
  // Turning the option off removes the source's snapshot files. A running backup may still write them; it removes them
  // itself after its commit once it sees the option off (src/engine.js), so the discard is skipped while the site is busy.
  if (outcome.discard && !busySite(row.id)) await discardIncrementalState(row.id);
  if (job) {
    audit(req.user.id, 'backup.full_now', row.id, { job: job.id });
    return res.status(202).json({ ...view(row, incrementalSettings(row.id)), job: { id: job.id } });
  }
  res.json(view(row, outcome.settings));
});

incrementalRoutes.get('/backups/:id/chain-download', async (req, res, next) => {
  const leases = [];
  let members;
  try {
    members = transaction(() => {
      if (db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(req.params.id)) throw Object.assign(new Error('Package retention is in progress.'), { status: 409 });
      if (!db.prepare('SELECT 1 FROM backups WHERE id=?').get(req.params.id)) notFound('Backup not found.');
      const chain = verifyChainLinks(loadChain(req.params.id));
      if (!inChain(chain)) throw Object.assign(new Error('This backup is not part of an incremental chain. Use Download.'), { status: 409, publicCode: 'not_incremental' });
      for (const member of chain) {
        // Every package must be verified, as for a single Download.
        if (member.verified !== 1 || db.prepare('SELECT 1 FROM retention_operations WHERE backup_id=?').get(member.id)) throw new ChainError(member.id);
        // The same download lease as a single download: nothing of the chain is deleted while it streams.
        const lease = id(); db.prepare('INSERT INTO downloads VALUES (?,?,?)').run(lease, member.id, Date.now() + 120000); leases.push(lease);
      }
      return chain.map(member => ({ ...member, path: packagePath(member) }));
    });
  } catch (error) { return next(error.code === 'chain_broken' ? Object.assign(error, { status: 409 }) : error); }
  const refresh = setInterval(() => { for (const lease of leases) db.prepare('UPDATE downloads SET expires_at=? WHERE id=?').run(Date.now() + 120000, lease); }, 30000);
  let cleared = false;
  const clear = () => { if (cleared) return; cleared = true; clearInterval(refresh); for (const lease of leases) db.prepare('DELETE FROM downloads WHERE id=?').run(lease); };
  res.once('close', clear); res.once('finish', clear);
  try {
    for (const member of members) { const attrs = await statFile(member.path); if (attrs.size !== member.size) throw new ChainError(member.id); }
    const order = orderText(members), at = Date.now();
    const length = BLOCK + order.length + tarPadding(order.length) + members.reduce((sum, member) => sum + BLOCK + member.size + tarPadding(member.size), 0) + 2 * BLOCK;
    const target = members.at(-1);
    res.attachment(`${target.site_id}_${target.id}_chain.tar`);
    res.set({ 'Content-Type': 'application/x-tar', 'Content-Length': String(length), 'Cache-Control': 'no-store' });
    audit(req.user.id, 'backup.download_chain', target.id, { packages: members.length });
    if (req.method === 'HEAD') return res.end();
    const write = chunk => new Promise((resolve, reject) => { if (res.write(chunk)) resolve(); else { res.once('drain', resolve); res.once('close', () => reject(new Error('Download closed'))); } });
    await write(tarHeader('ORDER.txt', order.length, at)); await write(order); await write(Buffer.alloc(tarPadding(order.length)));
    for (const [index, member] of members.entries()) {
      await write(tarHeader(packageName(index, member.id), member.size, Date.parse(member.captured_at) || at));
      const hash = createHash('sha256');
      await pipeline(await openRead(member.path), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }), res, { end: false });
      if (hash.digest('hex') !== member.checksum) throw new ChainError(member.id);
      await write(Buffer.alloc(tarPadding(member.size)));
    }
    res.end(Buffer.alloc(2 * BLOCK));
  } catch (error) {
    if (!res.headersSent) { clear(); return next(error.code === 'chain_broken' ? Object.assign(error, { status: 409 }) : error); }
    audit(req.user.id, 'backup.download_chain_failed', req.params.id, { reason: error.code === 'chain_broken' ? 'package changed or damaged' : 'transfer stopped' });
    res.destroy();
  } finally { if (res.writableEnded) clear(); }
});
