// Google Drive: the ID of the account's root folder, asked once after sign-in and kept in the destination's settings.
// rclone otherwise asks Google for it before every operation, and with the shared sign-in app those extra calls hit the
// per-project rate limit. In-process, with a timeout and a size cap; the token and the response are never logged.
const API = 'https://www.googleapis.com/drive/v3/files/root?fields=id&supportsAllDrives=false';
export const ROOT_ID = /^[A-Za-z0-9_-]{10,100}$/;
// Tests only: a fake Google API on a local address.
const url = () => (process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(process.env.DOCKNEST_TEST_GOOGLE_URL ?? '') ? process.env.DOCKNEST_TEST_GOOGLE_URL + '/drive/v3/files/root?fields=id' : API);
// The ID, or null when Google does not answer in time or answers unexpectedly. Best effort: rclone still works without it.
export async function fetchRootFolderId(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) return null;
  try {
    const response = await fetch(url(), { headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 4096) return null; chunks.push(chunk); }
    const id = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.id;
    return typeof id === 'string' && ROOT_ID.test(id) ? id : null;
  } catch { return null; }
}
