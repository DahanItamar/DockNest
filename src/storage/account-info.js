// The signed-in account's name or e-mail, for the masked line on a destination card. `rclone config userinfo` does not
// exist for these backends, so the provider is asked directly with the access token the destination already holds:
// fixed hosts, no redirects, a timeout and a size cap, and neither the token nor the answer is ever logged. Best effort:
// null on any failure, silently, because a missing account name must never fail a connect, a test or a backup.
const TIMEOUT_MS = 10_000, MAX_BYTES = 64 * 1024;
const HOSTS = Object.freeze({
  drive: { url: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', test: 'DOCKNEST_TEST_GOOGLE_URL', testPath: '/drive/v3/about?fields=user(emailAddress,displayName)' },
  onedrive: { url: 'https://graph.microsoft.com/v1.0/me/drive?$select=owner', test: 'DOCKNEST_TEST_GRAPH_URL', testPath: '/v1.0/me/drive?$select=owner' },
  dropbox: { url: 'https://api.dropboxapi.com/2/users/get_current_account', test: 'DOCKNEST_TEST_DROPBOX_URL', testPath: '/2/users/get_current_account', method: 'POST' },
});
// Tests only: a fake provider on a local address. Production always uses the real hosts over HTTPS.
function target(backend) {
  const host = HOSTS[backend];
  if (!host) return null;
  const fake = process.env[host.test];
  return process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(fake ?? '') ? { ...host, url: fake + host.testPath } : host;
}
const text = value => (typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null);
function pick(backend, data) {
  if (backend === 'drive') return text(data?.user?.emailAddress) ?? text(data?.user?.displayName);
  if (backend === 'onedrive') return text(data?.owner?.user?.email) ?? text(data?.owner?.user?.displayName);
  return text(data?.email) ?? text(data?.name?.display_name);
}
export async function fetchAccount(backend, accessToken) {
  const host = target(backend);
  if (!host || typeof accessToken !== 'string' || !accessToken) return null;
  try {
    const response = await fetch(host.url, { method: host.method ?? 'GET', headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) return null; chunks.push(chunk); }
    return pick(backend, JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { return null; }
}
