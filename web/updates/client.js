// The only module that knows the Update Center endpoints (docs/update-center.md section 4). `api` is the app's
// request helper (session cookie, CSRF header, {error, code} errors). A 423 anywhere raises "docknest:locked" there.
export const LOCKED_EVENT = 'docknest:locked';
export function createUpdatesClient(api) {
  const query = (path, value) => path + (value ? '?cursor=' + encodeURIComponent(value) : '');
  return {
    state: () => api('/updates'),
    consent: checkEnabled => api('/updates/consent', { checkEnabled }),
    setChecks: checkEnabled => api('/updates/settings', { checkEnabled }, 'PATCH'),
    checkNow: () => api('/updates/check', {}),
    release: version => api('/updates/releases/' + encodeURIComponent(version)),
    status: () => api('/updates/status'),
    history: cursor => api(query('/updates/history', cursor)),
    progress: () => api('/updates/progress'),
    whatsNew: () => api('/updates/whats-new'),
    whatsNewSeen: version => api('/updates/whats-new/seen', { version }),
    submit: (version, retryOf) => api('/updates/requests', retryOf ? { version, retryOf } : { version }),
    acknowledge: id => api('/updates/requests/' + encodeURIComponent(id) + '/acknowledge', {}),
    reauth: (password, code) => api('/auth/reauth', { password, code }),
    authStatus: () => api('/auth/status'),
    version: () => api('/version'),
  };
}
