// The one recorded Compose invocation per site (docs/safe-edit.md, "Security review changes" item 13): project, every
// -f file, --project-directory and every --env-file, exactly as the site was started. Check, apply and rollback all
// use it, so an environment value can never steer which files Compose reads. A single-container site records its
// container name instead (recreated from inspect, as moves do).
// Launch records it when it starts a site; for sites that existed before, DockNest derives it once from the Compose
// labels Docker keeps on the containers (com.docker.compose.project*), and stores it.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { db } from '../db.js';

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const absolute = value => typeof value === 'string' && value.length <= 4096 && value.startsWith('/') && !value.startsWith('//') && !value.split('/').includes('..') && !/[\0\r\n]/.test(value);
const list = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);

// A clean invocation, or null when any part is unusable.
export function validInvocation(kind, invocation) {
  if (kind === 'container') return invocation && CONTAINER.test(invocation.container ?? '') && Object.keys(invocation).length === 1 ? { container: invocation.container } : null;
  if (kind !== 'compose' || !invocation || !PROJECT.test(invocation.project ?? '')) return null;
  const files = invocation.files, envFiles = invocation.envFiles ?? [];
  if (!Array.isArray(files) || !files.length || files.length > 10 || !files.every(absolute)) return null; // the helper's limit too
  if (!Array.isArray(envFiles) || envFiles.length > 10 || !envFiles.every(absolute)) return null;
  if (!absolute(invocation.projectDirectory)) return null;
  return { project: invocation.project, files: [...files], projectDirectory: invocation.projectDirectory, envFiles: [...envFiles] };
}

export function storedInvocation(siteId) {
  const row = db.prepare('SELECT kind,invocation,source FROM site_compose_invocations WHERE site_id=?').get(siteId);
  if (!row) return null;
  let parsed; try { parsed = JSON.parse(row.invocation); } catch { return null; }
  const invocation = validInvocation(row.kind, parsed);
  return invocation ? { kind: row.kind, invocation, source: row.source } : null;
}

// Launch (and the label derivation below) record through here. `source`: 'launch' | 'labels' | 'site'.
export function recordInvocation(siteId, kind, invocation, source, at = new Date().toISOString()) {
  const clean = validInvocation(kind, invocation);
  if (!clean) throw Object.assign(new Error('The Compose invocation is not valid.'), { status: 422, code: 'NOT_EDITABLE' });
  db.prepare('INSERT INTO site_compose_invocations(site_id,kind,invocation,source,recorded_at) VALUES(?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET kind=excluded.kind,invocation=excluded.invocation,source=excluded.source,recorded_at=excluded.recorded_at').run(siteId, kind, JSON.stringify(clean), source, at);
  return { kind, invocation: clean, source };
}

// Derives the invocation from discovered containers (the helper's `discover` result). Pure.
// Returns { kind, invocation, source } or { problem } with a plain sentence.
export function invocationFromContainers(config, containers) {
  const names = config?.containers ?? [];
  const mine = names.map(name => (containers ?? []).find(item => item.name === name)).filter(Boolean);
  if (!names.length || mine.length !== names.length) return { problem: 'Some of the site\'s containers were not found on the server.' };
  const labels = mine.map(item => item.labels ?? {});
  const projects = new Set(labels.map(item => item['com.docker.compose.project'] ?? ''));
  if (projects.size === 1 && projects.has('')) {
    if (mine.length === 1) return { kind: 'container', invocation: { container: mine[0].name }, source: 'site' };
    return { problem: 'These containers were not started with Docker Compose, so DockNest cannot edit them together.' };
  }
  if (projects.size !== 1) return { problem: 'The site\'s containers belong to different Compose projects.' };
  const pick = key => { const values = new Set(labels.map(item => item[key] ?? '')); return values.size === 1 ? [...values][0] : null; };
  const project = [...projects][0], files = pick('com.docker.compose.project.config_files'), directory = pick('com.docker.compose.project.working_dir'), envFiles = pick('com.docker.compose.project.environment_file');
  if (files === null || directory === null || envFiles === null) return { problem: 'The site\'s containers were started with different Compose files.' };
  const invocation = validInvocation('compose', { project, files: list(files), projectDirectory: directory, envFiles: list(envFiles) });
  return invocation ? { kind: 'compose', invocation, source: 'labels' } : { problem: 'DockNest could not read how this Compose project was started.' };
}

// The recorded invocation, deriving and storing it on first use. `discover(server)` is the helper's discover call.
export async function resolveInvocation(site, server, discover) {
  const stored = storedInvocation(site.id);
  if (stored) return stored;
  const derived = invocationFromContainers(site.config, (await discover(server))?.containers);
  if (derived.problem) return derived;
  return recordInvocation(site.id, derived.kind, derived.invocation, derived.source);
}

// The site's application locations: the folders of its Compose and configuration files and the project folder. The
// helper adds its own protected list on top and resolves every path with symlinks followed.
export function allowedRoots(config, resolved) {
  const roots = new Set();
  for (const file of [...(config?.composeFiles ?? []), ...(config?.configFiles ?? [])]) if (absolute(file)) roots.add(posix.dirname(file));
  if (resolved?.kind === 'compose') { roots.add(resolved.invocation.projectDirectory); for (const file of [...resolved.invocation.files, ...resolved.invocation.envFiles]) roots.add(posix.dirname(file)); }
  return [...roots].filter(root => root !== '/').sort();
}

export const invocationHash = resolved => createHash('sha256').update(JSON.stringify([resolved.kind, resolved.invocation])).digest('hex');
// The request fields every helper op takes.
export const helperInvocation = resolved => (resolved.kind === 'container' ? { container: resolved.invocation.container } : { ...resolved.invocation });
