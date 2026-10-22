// Who may open a report, and the facts every report adds. Pure, so the rules are unit-tested without a browser.

// audience "all" is only Report a bug; every other report is admin-only. An explicit role (the lock view, which sits
// outside the app's provider) wins over the signed-in role; there is no default role.
export function reportAllowed(roleProp, contextRole, audience = 'admin') {
  const who = roleProp !== undefined ? roleProp : contextRole;
  if (!who) return false;
  return audience === 'all' || who === 'admin';
}

// One loader per signed-in user and role: its cache never outlives a sign-out or a role change. /api/version for
// everyone; the Update Center state (install mode, coarse environment) only for administrators.
export function createFactsLoader({ api, role, fetchImpl = globalThis.fetch }) {
  let cache = null;
  return () => {
    if (!cache) cache = (async () => {
      let version = null, installMode = null, env = null;
      try { const r = await fetchImpl('/api/version', { credentials: 'same-origin' }); if (r.ok) version = (await r.json())?.version ?? null; } catch { /* none */ }
      if (role === 'admin' && api) { try { const s = await api('/updates'); installMode = s?.updater?.installMode ?? null; env = s?.updater?.env ?? null; } catch { /* none */ } }
      return { version, installMode, env };
    })();
    return cache;
  };
}
