// OneDrive: the drives the signed-in account can use, asked of Microsoft Graph with the access token the sign-in just
// obtained (`rclone backend drives` exists only for Google Drive). In-process, with a timeout and a size cap. The token and
// the response body are never logged or put in an error; a failure becomes a plain sentence, never an empty list.
const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 15_000, MAX_BYTES = 1024 * 1024;
const TYPES = ['personal', 'business', 'documentLibrary'];
const fail = (message, publicCode = 'onedrive_drives') => Object.assign(new Error(message), { status: 502, expose: true, publicCode });
// Tests only: a fake Graph on a local address. Production always talks to Microsoft over HTTPS.
const base = () => (process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(process.env.DOCKNEST_TEST_GRAPH_URL ?? '') ? process.env.DOCKNEST_TEST_GRAPH_URL + '/v1.0' : GRAPH);

async function get(token, route) {
  let response;
  try { response = await fetch(base() + route, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { throw fail('Microsoft could not be reached to list your OneDrive drives. Check the network connection and try again.'); }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => {}); throw Object.assign(fail('Microsoft did not allow listing your OneDrive drives. Start the sign-in again.', 'onedrive_denied'), { status: 400 }); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail('Microsoft did not list your OneDrive drives. Try again in a moment.'); }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) { throw new Error('too large'); } chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw fail('Microsoft sent an answer DockNest could not read. Try again.'); }
}
const clean = item => {
  const id = String(item?.id ?? '');
  if (!/^[A-Za-z0-9!_.-]{1,200}$/.test(id)) return null;
  const type = TYPES.includes(item.driveType) ? item.driveType : 'personal';
  const name = String(item.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) || (type === 'personal' ? 'OneDrive' : type === 'business' ? 'OneDrive for work or school' : 'Document library');
  return { id, name, type };
};
export async function listOneDrives(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) throw fail('Sign in again before choosing a OneDrive drive.', 'onedrive_denied');
  const main = clean(await get(accessToken, '/me/drive'));
  // Other drives (work libraries, shared libraries). The default drive alone is still a valid answer if this is refused.
  let others = [];
  try { const more = await get(accessToken, '/me/drives'); others = Array.isArray(more?.value) ? more.value.slice(0, 50) : []; } catch (error) { if (!main) throw error; }
  const seen = new Set(), out = [];
  for (const drive of [main, ...others.map(clean)]) if (drive && !seen.has(drive.id)) { seen.add(drive.id); out.push(drive); }
  if (!out.length) throw fail('No OneDrive drive was found for this account.', 'onedrive_none');
  return out;
}
