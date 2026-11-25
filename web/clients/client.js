// The only place that knows the client report API (docs/client-reports.md, src/reports/routes.js). `api` is the app's fetch
// helper: api(path, body, method). Recipients go out only when the owner types them; views carry them back masked.
export const PDF_FAILED = 'The report could not be created. Nothing was saved. Try again.';
export function createClientsClient(api) {
  const id = x => encodeURIComponent(x);
  return {
    list: () => api('/clients'),
    create: body => api('/clients', body),
    update: (clientId, body) => api('/clients/' + id(clientId), body, 'PUT'),
    remove: clientId => api('/clients/' + id(clientId), undefined, 'DELETE'),
    report: (clientId, from, to) => api('/clients/' + id(clientId) + '/report?from=' + id(from) + '&to=' + id(to)),
    sendTest: clientId => api('/clients/' + id(clientId) + '/report/send-test', {}),
    // Email Connections the monthly report can go through (administrators).
    connections: () => api('/connections'),
    reauth: (password, code) => api('/auth/reauth', { password, code }),
    // The PDF is built on the server and downloaded as a file; the page keeps nothing of it.
    async pdf(clientId, from, to) {
      const status = await fetch('/api/auth/status', { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({}));
      const response = await fetch('/api/clients/' + id(clientId) + '/report.pdf', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-csrf-token': status.csrfToken || '' }, body: JSON.stringify({ from, to }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw Object.assign(new Error(data.error || PDF_FAILED), { status: response.status, code: data.code }); }
      const name = /filename="?([^";]+)"?/.exec(response.headers.get('content-disposition') || '')?.[1] || 'report.pdf';
      return { blob: await response.blob(), name };
    },
  };
}
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
