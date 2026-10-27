// Storage report (docs/restore-tests.md, "Storage report"). Computed on request from backup metadata only: it reads no
// backup data and calls no site server. The only outside call is the existing capacity call to each destination,
// cached for 10 minutes. Nothing is stored. The savings number is a labelled best-case estimate, never a promise.
import express from 'express';
import { db } from './db.js';
import { requireAdmin } from './auth.js';
import { adapters, targetOptions } from './storage/index.js';
import * as local from './storage/local.js';

export const reportMethod = 'A rough best-case estimate from package sizes. DockNest cannot see inside encrypted backups.';
const DAY = 86400000, CAPACITY_CACHE_MS = 10 * 60 * 1000;
const number = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

// "sftp:<id>:/path", "s3:<id>:key", legacy "sftp:/path" (environment destination) or a plain local path.
export function storageIdOf(path) {
  const match = /^(sftp|s3):([^:]*):/.exec(String(path ?? ''));
  if (match) return match[2] === '' ? 'env' : match[2];
  return /^(sftp|s3):/.test(String(path ?? '')) ? 'env' : 'local';
}

// needed = max(largest package, first package + every increase between consecutive packages); upTo = stored - needed.
export function siteEstimate(sizes) {
  const stored = sizes.reduce((sum, size) => sum + size, 0);
  if (sizes.length < 2) return { stored, needed: stored, upToBytes: 0, upToPercent: 0, growthPerBackupBytes: 0 };
  let needed = sizes[0], increases = 0;
  for (let i = 1; i < sizes.length; i++) increases += Math.max(0, sizes[i] - sizes[i - 1]);
  needed = Math.max(Math.max(...sizes), sizes[0] + increases);
  const upToBytes = Math.max(0, stored - needed);
  return { stored, needed, upToBytes, upToPercent: stored ? Math.min(100, Math.round(upToBytes / stored * 100)) : 0, growthPerBackupBytes: Math.round(increases / (sizes.length - 1)) };
}

// Cumulative stored bytes of today's packages at the end of each of the last `days` days (oldest first).
export function growthSeries(rows, nowMs, days = 30) {
  const times = rows.map(row => ({ at: Date.parse(row.capturedAt), size: number(row.size) })).filter(row => Number.isFinite(row.at));
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const end = nowMs - i * DAY;
    points.push(times.reduce((sum, row) => row.at <= end ? sum + row.size : sum, 0));
  }
  return { points, fromBytes: points[0], toBytes: points.at(-1), changeBytes: points.at(-1) - points[0] };
}

export function buildReport({ backups, sites, targets, capacities = {}, nowMs = Date.now() }) {
  const names = new Map(sites.map(site => [site.id, site.name]));
  const storageNames = new Map([['local', 'Local disk'], ['env', 'Configured storage'], ...targets.map(target => [target.id, target.name])]);
  const bySite = new Map(), byStorage = new Map();
  for (const row of backups) {
    const size = number(row.size);
    (bySite.get(row.siteId) ?? bySite.set(row.siteId, []).get(row.siteId)).push({ ...row, size });
    const id = storageIdOf(row.path), entry = byStorage.get(id) ?? byStorage.set(id, { id, name: storageNames.get(id) ?? 'Removed destination', packages: 0, bytes: 0 }).get(id);
    entry.packages++; entry.bytes += size;
  }
  const siteRows = [...bySite].map(([siteId, rows]) => {
    rows.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || String(a.id).localeCompare(String(b.id)));
    const estimate = siteEstimate(rows.map(row => row.size));
    return { siteId, name: names.get(siteId) ?? 'Removed site', packages: rows.length, bytes: estimate.stored, newestBytes: rows.at(-1).size, growthPerBackupBytes: estimate.growthPerBackupBytes, estimate: { upToBytes: estimate.upToBytes, upToPercent: estimate.upToPercent } };
  }).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const storages = [...byStorage.values()].map(entry => ({ ...entry, capacityBytes: capacities[entry.id] ?? null })).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const bytes = siteRows.reduce((sum, row) => sum + row.bytes, 0), estimateUpToBytes = siteRows.reduce((sum, row) => sum + row.estimate.upToBytes, 0);
  const growth = growthSeries(backups, nowMs);
  return { generatedAt: new Date(nowMs).toISOString(), storages, sites: siteRows,
    totals: { packages: backups.length, bytes, estimateUpToBytes, estimateUpToPercent: bytes ? Math.round(estimateUpToBytes / bytes * 100) : 0 },
    growth: { days: 30, points: growth.points, fromBytes: growth.fromBytes, toBytes: growth.toBytes, changeBytes: growth.changeBytes },
    method: reportMethod };
}

const cache = new Map();
export const capacityTestHooks = { read: null };
async function capacityOf(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CAPACITY_CACHE_MS) return hit.value;
  let value = null;
  try {
    if (capacityTestHooks.read) value = await capacityTestHooks.read(id);
    else if (id === 'local') value = (await local.capacity()).total;
    else { const options = targetOptions(id); value = (await adapters[options.mode].capacity(options, { maxAgeMs: CAPACITY_CACHE_MS })).total; }
    value = number(value) || null;
  } catch { value = null; }
  cache.set(id, { at: Date.now(), value });
  return value;
}

export async function storageReport() {
  const backups = db.prepare('SELECT id,site_id AS siteId,captured_at AS capturedAt,path,size FROM backups WHERE id NOT IN (SELECT backup_id FROM retention_operations)').all();
  const sites = db.prepare('SELECT id,name FROM sites').all(), targets = db.prepare('SELECT id,name FROM storage_targets').all();
  const ids = [...new Set(backups.map(row => storageIdOf(row.path)))];
  const capacities = Object.fromEntries(await Promise.all(ids.map(async id => [id, await capacityOf(id)])));
  return buildReport({ backups, sites, targets, capacities });
}

export const storageReportRoutes = express.Router();
storageReportRoutes.get('/storage-report', requireAdmin, async (_req, res, next) => { try { res.json(await storageReport()); } catch (error) { next(error); } });
