// The public progress endpoint and the 423 lock (docs/update-center.md sections 4 and 7). Both read only the in-memory
// snapshot of the update service: no database read or write per request, and the limiter is in memory too (the shared
// rateLimit writes SQLite). Nothing here is allowed to fail an update because a browser keeps polling.

export const progressLimit = Object.freeze({ perMinute: 120, windowMs: 60_000, clients: 10_000 });

// Fixed window per client address. The map is bounded: when it is full, expired windows go first, then everything.
export function createLimiter({ perMinute = progressLimit.perMinute, windowMs = progressLimit.windowMs, clients = progressLimit.clients, now = Date.now } = {}) {
  const windows = new Map();
  return key => {
    const t = now();
    if (windows.size >= clients && !windows.has(key)) { for (const [name, window] of windows) if (window.reset <= t) windows.delete(name); if (windows.size >= clients) windows.clear(); }
    let window = windows.get(key);
    if (!window || window.reset <= t) { window = { count: 0, reset: t + windowMs }; windows.set(key, window); }
    window.count += 1;
    return window.count <= perMinute ? 0 : Math.max(1, Math.ceil((window.reset - t) / 1000));
  };
}

// Public by design: only {active, phase, to, state, stale, updatedAt, events: [{phase, at}]}. The snapshot is rebuilt from
// fixed enums and is copied field by field here, so a future snapshot field cannot leak by accident.
export function progressHandler(service, limiter = createLimiter()) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    const wait = limiter(req.ip ?? 'unknown');
    if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: 'Too many requests. Try again shortly.', code: 'RATE_LIMITED' }); }
    const { active, phase, to, state, stale, updatedAt, events } = service.progress();
    res.json({ active, phase, to, state, stale, updatedAt, events: events.map(({ phase: eventPhase, at }) => ({ phase: eventPhase, at })) });
  };
}

// Exempt from the 423 (exact method and path; anything that differs by case, a trailing slash or encoding stays locked):
// the lock view needs its own status, an admin's acknowledge, the session status and a way to sign out. Exempt routes keep
// their normal session, admin, CSRF and origin checks later in the chain.
const EXEMPT_GET = new Set(['/api/version', '/api/updates/progress', '/api/updates', '/api/updates/status', '/api/auth/status']);
const ACKNOWLEDGE = /^\/api\/updates\/requests\/[0-9a-f-]{36}\/acknowledge$/;
export function lockExempt(method, path) {
  if (method === 'GET') return EXEMPT_GET.has(path);
  return method === 'POST' && (path === '/api/auth/logout' || ACKNOWLEDGE.test(path));
}
export function lockMiddleware(service) {
  return (req, res, next) => {
    if (!service.locked()) return next();
    const path = (req.originalUrl ?? req.url).split('?')[0];
    if (lockExempt(req.method, path)) return next();
    res.set('Cache-Control', 'no-store');
    res.status(423).json({ error: 'UPDATE_IN_PROGRESS' });
  };
}
