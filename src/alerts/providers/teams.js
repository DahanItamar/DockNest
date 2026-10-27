// Microsoft Teams, Workflows only (docs/alert-channels.md, "Microsoft Teams (Workflows)"). The old Office 365 connector
// ("Incoming Webhook") is being retired by Microsoft and is not supported. The help names no date: Microsoft has moved it
// more than once. The workflow answers 202 when it accepts the request, before it posts, so a test never says "Delivered".
import { z } from 'zod';
import { parts, cut, urlField, failure, field, freeze } from './common.js';

export const noLink = text => String(text).replace(/\]\s*\(/g, ']\u200b(');

export const TEAMS_HOSTS = freeze(['*.logic.azure.com', '*.api.powerplatform.com']);
const inTeams = host => host.endsWith('.logic.azure.com') || host.endsWith('.api.powerplatform.com');
const webhook = urlField({
  label: 'workflow URL',
  check: url => {
    if (!inTeams(url.hostname)) return 'Paste the URL from a Teams Workflows webhook.';
    if (url.port && url.port !== '443') return 'Paste the URL from a Teams Workflows webhook.';
    if (url.pathname.length < 2) return 'Paste the whole URL from the Teams workflow, including everything after the host name.';
    return null;
  },
});

export default freeze({
  id: 'teams', label: 'Microsoft Teams', icon: 'brand-teams', group: 'common',
  fields: freeze([field({ key: 'url', label: 'Workflow URL', type: 'url', secret: true, required: true, help: 'In Teams, create a workflow from the template "Post to a channel when a webhook request is received" and paste its URL. The old Incoming Webhook connector is being retired by Microsoft.' })]),
  secretSchema: z.object({ url: webhook }).strict(),
  settingsSchema: z.object({}).strict(),
  destination: freeze(['url']),
  host: freeze(['url']),
  target: () => ({ hosts: TEAMS_HOSTS }),
  format: (message, values) => {
    const { title, where, reason, url } = parts(message);
    // TextBlocks read a Markdown subset, so "[text](url)" in a site name would become a link. A zero-width space between
    // "]" and "(" keeps the text as typed and never makes a link.
    const block = (value, extra = {}) => ({ type: 'TextBlock', text: cut(noLink(value), 1000), wrap: true, ...extra });
    const body = [block(title, { weight: 'Bolder', size: 'Medium' }), where && block(where), reason && block(reason)].filter(Boolean);
    const card = { type: 'AdaptiveCard', version: '1.4', body, ...(url ? { actions: [{ type: 'Action.OpenUrl', title: 'Open job', url }] } : {}) };
    return { method: 'POST', url: values.url, json: { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] } };
  },
  explain: status => failure('Teams', status, { login: [401, 403, 404, 410], loginText: 'Teams does not accept this workflow URL. Copy the URL from the workflow again and paste it.', otherText: 'Teams refused the message. Check that the workflow accepts a message request.' }),
  unreachable: 'Teams could not be reached.',
  // Shown after a test: a 202 only means the workflow took the request.
  testNote: 'Sent to Teams. If it does not appear, open the workflow’s run history.',
});
