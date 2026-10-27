// The 2.8 alert routes (/api/alerts/credentials, /api/alerts/channels) were removed when the Map moved to the
// Connections routes (docs/alert-channels.md, "API"). Their store functions stay as the 2.8 view of the Connections store,
// so the upgrade tests keep proving that a 2.8 setup reads and behaves the same after the upgrade. This calls those store
// functions the way the old routes did and answers like them: { status, body }, 201 on create, the store's status and
// sentence on an error. Test-only; no route reaches it.
export function legacyCalls({ store, delivery, actor = 'test', record = () => {} }) {
  const answer = (status, body) => { record(JSON.stringify(body)); return { status, body }; };
  const routes = {
    'GET alerts': () => ({ credentials: store.listCredentials(), channels: store.listChannels(), rules: store.listRules() }),
    'GET credentials': () => ({ credentials: store.listCredentials() }),
    'POST credentials': body => [201, store.createCredential(body, actor)],
    'PATCH credentials/:id': (body, id) => store.updateCredential(id, body, actor),
    'DELETE credentials/:id': (_body, id) => store.deleteCredential(id, actor),
    'POST credentials/:id/test': (_body, id) => delivery.verifyCredential(id, actor),
    'GET channels': () => ({ channels: store.listChannels() }),
    'POST channels': body => [201, store.createChannel(body, actor)],
    'PATCH channels/:id': (body, id) => store.updateChannel(id, body, actor),
    'DELETE channels/:id': (_body, id) => store.deleteChannel(id, actor),
    'POST channels/:id/test': (_body, id) => delivery.sendTest(id, actor),
    'GET rules': () => ({ rules: store.listRules() }),
    'POST rules': body => [201, store.createRule(body, actor)],
    'PATCH rules/:id': (body, id) => store.updateRule(id, body, actor),
    'DELETE rules/:id': (_body, id) => store.deleteRule(id, actor),
  };
  return async (method, route, body) => {
    const parts = route.split('?')[0].split('/').filter(Boolean).slice(1); // drop "alerts"
    const key = `${method} ${parts.length ? [parts[0], ...(parts[1] ? [':id'] : []), ...parts.slice(2)].join('/') : 'alerts'}`;
    const handler = routes[key]; if (!handler) throw new Error(`No 2.8 route ${key}`);
    try {
      const result = await handler(body, parts[1]);
      return Array.isArray(result) ? answer(result[0], result[1]) : answer(200, result);
    } catch (error) {
      if (!error.status) throw error;
      return answer(error.status, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.nodes ? { nodes: error.nodes } : {}) });
    }
  };
}
