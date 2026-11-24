// rclone's stderr can hold URLs with tokens, so it is only matched against known failures and then dropped. What leaves
// this module is a plain sentence per reason and a stable `reason` code, never a fragment of the output.
export const BACKENDS = Object.freeze({
  drive: { label: 'Google Drive', oauth: true },
  onedrive: { label: 'OneDrive', oauth: true },
  dropbox: { label: 'Dropbox', oauth: true },
  webdav: { label: 'WebDAV', oauth: false },
  smb: { label: 'The SMB share', oauth: false },
});
export const backendLabel = backend => BACKENDS[backend]?.label ?? 'The storage provider';

const RECONNECT = /invalid_grant|token (?:has been )?(?:expired|revoked)|AADSTS(?:50173|70000|70008|700082|70043|50076|50079|65001)|interaction_required|InvalidAuthenticationToken|invalid_client|token_expired|AuthenticationFailed|Lifetime validation failed|expired_access_token|invalid_access_token|couldn'?t (?:fetch|refresh) token|failed to (?:get|refresh) token|unauthorized_client|refresh token (?:is )?(?:invalid|revoked)|oauth2: cannot fetch token|expired or revoked/i;
const UNAUTHORIZED = /\b401\b|unauthori[sz]ed|authentication required|login failed|logon failure|STATUS_LOGON_FAILURE|wrong (?:user|password)/i;
const RATE = /rateLimitExceeded|sharedDriveRateLimit|dailyLimitExceeded|(?<![A-Za-z])quotaExceeded|userRateLimitExceeded|too many requests|\b429\b|throttl|activityLimitReached|too_many_requests|too_many_write_operations|\b403\b.*(?:rate|limit)/i;
const QUOTA = /storageQuotaExceeded|insufficient (?:storage|space)|quota (?:exceeded|has been exceeded)|\b507\b|out of space|not enough space|insufficient_space/i;
const TLS = /x509|certificate (?:signed by unknown|has expired|is not valid|verify)|unknown authority|tls: failed to verify/i;
const NETWORK = /no such host|dial tcp|i\/o timeout|connection (?:refused|reset)|TLS handshake|network is unreachable|context deadline|timeout awaiting|\bEOF\b/i;
// Any other Microsoft sign-in error code: the sign-in was refused, but not because the grant was revoked or expired.
const MS_REFUSED = /AADSTS\d{4,6}/;
const MISSING = /directory not found|object not found|file not found|\b404\b/i;

// Google counts the shared sign-in app's requests per project, across every DockNest that uses it.
export const GOOGLE_SHARED_APP = 'Google is limiting the shared sign-in app. Use your own Google app ID for steady speed.';
const again = label => `${label} needs you to sign in again. Open the storage destination and press Reconnect.`;
// -> { reason, message, needsReconnect, missing }
export function classify(stderr, exitCode, backend) {
  const text = String(stderr ?? '').slice(-16384), label = backendLabel(backend), oauth = Boolean(BACKENDS[backend]?.oauth);
  if (oauth && RECONNECT.test(text)) return { reason: 'needs_reconnect', needsReconnect: true, message: again(label) };
  if (UNAUTHORIZED.test(text)) {
    return oauth ? { reason: 'needs_reconnect', needsReconnect: true, message: again(label) }
      : { reason: 'auth_failed', needsReconnect: false, message: `${label} refused the login. Check the user name and password.` };
  }
  if (backend === 'onedrive' && MS_REFUSED.test(text)) return { reason: 'sign_in_refused', needsReconnect: false, message: `Microsoft refused the sign-in. Check the account and the app settings, then try again.` };
  if (RATE.test(text)) return { reason: 'rate_limited', needsReconnect: false, message: backend === 'drive' ? GOOGLE_SHARED_APP : `${label} is limiting requests, DockNest retries at the next run.` };
  if (QUOTA.test(text)) return { reason: 'quota', needsReconnect: false, message: `${label} has no space left for this backup.` };
  if (exitCode === 3 || exitCode === 4 || MISSING.test(text)) return { reason: 'not_found', needsReconnect: false, missing: true, message: `The file or folder is not on ${label}.` };
  if (TLS.test(text)) return { reason: 'tls', needsReconnect: false, message: `${label} could not be trusted: its security certificate was not accepted. Check that the server clock is right and that the system certificates are installed.` };
  if (NETWORK.test(text)) return { reason: 'network', needsReconnect: false, message: `${label} could not be reached. Check the network connection.` };
  return { reason: 'failed', needsReconnect: false, message: `${label} did not accept the request.` };
}
// Status 502, never 401: a provider's refusal must not end the owner's DockNest session.
export function rcloneError(info, extra = {}) {
  return Object.assign(new Error(info.message), { code: info.missing ? 'ENOENT' : 'ERCLONE', reason: info.reason, needsReconnect: info.needsReconnect, status: 502, expose: true, publicCode: info.reason, ...extra });
}
