// Pure helpers for cloud drive, network share and local folder destinations (docs/cloud-drives.md). No secret passes through
// here: tokens and passwords go from a field straight to the API, and the API only ever returns masked accounts.
export const OAUTH_KINDS = ['drive', 'onedrive', 'dropbox'];
export const DRIVE_KINDS = [...OAUTH_KINDS, 'webdav', 'smb', 'local'];
export const isDriveKind = kind => DRIVE_KINDS.includes(kind);
export const isOauthKind = kind => OAUTH_KINDS.includes(kind);
// The provider's own name in sentences ("Google Drive needs you to sign in again").
export const LABELS = { drive: 'Google Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', webdav: 'WebDAV', smb: 'SMB share', local: 'Local folder' };
export const SENTENCE_LABELS = { ...LABELS, smb: 'The SMB share', local: 'The local folder' };
export const labelOf = backend => LABELS[backend] || 'Cloud storage';
// rclone's own name for the token JSON command.
export const RCLONE_NAMES = { drive: 'drive', onedrive: 'onedrive', dropbox: 'dropbox' };

// "ada@example.com" -> "a•••@example.com"; any other account name keeps two characters. The server masks the same way for lists.
export function maskAccount(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (/[•*]{3}/.test(text)) return text.replace(/\*{3}/g, '•••');
  const at = text.indexOf('@');
  return at < 1 ? text.slice(0, 2) + '•••' : text[0] + '•••' + text.slice(at);
}

// What the card says about a drive: the append-only line, the trash note, the capacity line. Sentences, not flags.
export function driveFacts(target) {
  const label = labelOf(target.backend);
  const trash = target.semantics?.trash;
  return {
    appendOnly: target.kind === 'local' ? 'Not available on a local folder' : `Not available on ${label}`,
    trashNote: trash ? `Deleted backups go to the ${label} trash first. That is a soft safety net, not protection.` : '',
    capacity: target.capacity_bytes > 0 ? null : 'Not reported',
  };
}
export const stateOf = target => (target.needsReconnect ? { state: 'failed', label: 'Needs sign-in' } : target.status === 'connected' || target.connected ? { state: 'success', label: 'Connected' } : { state: 'needs-review', label: 'Needs attention' });

// The folder inside the drive. Same rule as the API: a simple relative path, no dots-only parts.
export const folderIssue = value => {
  const text = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (text.length > 200) return 'Use a shorter folder name.';
  if (!/^[a-zA-Z0-9_ ./-]*$/.test(text) || text.split('/').some(part => part === '..' || part === '.' || (text && !part))) return 'Use a simple folder such as docknest or team/docknest.';
  return '';
};

// The WebDAV address, checked like the API does so the form can say it before sending anything.
export function webdavIssue(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return 'Enter the WebDAV address as a URL, for example https://cloud.example.com/remote.php/dav/files/user.'; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return 'Use an HTTPS address without credentials, query or fragment.';
  if (url.username || url.password || url.search || url.hash) return 'Use an HTTPS address without credentials, query or fragment.';
  return '';
}
export const smbHostIssue = value => (/^[a-zA-Z0-9_.:-]{1,253}$/.test(String(value || '').trim()) ? '' : 'Enter the name or address of the file server, without slashes.');
export const smbShareIssue = value => (/^[A-Za-z0-9_.$ -]{1,80}$/.test(String(value || '').trim()) ? '' : 'Enter the share name only, for example backups.');

// Pasted sign-in result: an address that starts with the local helper's host and port, or the token JSON rclone printed.
export function pasteKind(text) {
  const value = String(text || '').trim();
  if (!value) return 'empty';
  if (value.startsWith('{')) return 'token';
  if (/^https?:\/\/(127\.0\.0\.1|localhost):53682\//i.test(value)) return 'address';
  return 'other';
}
export const PASTE_HELP = { other: 'Paste the address that starts with 127.0.0.1:53682, or the token JSON from rclone.' };

// The lines shown for a local folder (docs/cloud-drives.md, "A folder on a USB disk or NAS"). Fixed text, copied as is.
export const COMPOSE_SNIPPET = `services:
  docknest:
    environment:
      DOCKNEST_LOCAL_STORAGE: /backups/usb
    volumes:
      - /mnt/usb-backup:/backups/usb`;
export const LOCAL_DOCS = 'https://github.com/DahanItamar/DockNest/blob/main/docs/cloud-drives.md#a-folder-on-a-usb-disk-or-nas';
