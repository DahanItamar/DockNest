# Alerts

DockNest can tell you when something needs you: in Telegram, by email, in WhatsApp, Discord, Slack, Microsoft Teams,
Google Chat, Mattermost, ntfy, Gotify, Pushover or Matrix, or at a webhook URL of your own. Nothing is sent until you
add an alert node on the Map and connect it to something with a line.

The design decisions, the migration from 2.8 and the security rules are in [alert-channels.md](alert-channels.md).
This page is the reference for what you see and what the API does.

## Connections and alert nodes

- A **Connection** (Administration, **Connections**) holds everything needed to reach one place: the login and the
  destination, for example a Telegram bot token and a chat ID, or a Discord webhook URL. Secrets are sealed with the
  master key, shown afterwards only as "Saved, hidden", and replaced with the pencil, never read back.
- An **alert node** on the Map is one provider plus one Connection of that provider. One Connection can serve several
  nodes. A node without a Connection shows "Needs a connection" and sends nothing.
- A **line** connects a server, a site or DockNest to a node and lists the events it sends.

A Connection in use cannot be deleted; the Connections page and the API name the nodes that use it.

| Provider | Secret | Plain | Where DockNest connects |
| --- | --- | --- | --- |
| Telegram | Bot token | Chat ID | `api.telegram.org` |
| Email | SMTP account (server, port, encryption, user name, password, from) | Recipients (up to 5), subject prefix | The SMTP server you entered |
| WhatsApp | Access token | Phone number ID, send to, template name, language | `graph.facebook.com` (Meta WhatsApp Cloud API) |
| Discord | Webhook URL | | `discord.com` and its official hosts |
| Slack | Webhook URL | | `hooks.slack.com` |
| Microsoft Teams | Workflow URL | | Teams Workflows hosts |
| Google Chat | Webhook URL | | `chat.googleapis.com` |
| Mattermost | Webhook URL | | Your server |
| ntfy | Access token (optional) | Server, topic | `ntfy.sh` or your server |
| Gotify | Application token | Server | Your server |
| Pushover | Application token, user key | | `api.pushover.net` |
| Matrix | Access token | Homeserver, room ID | Your homeserver |
| Other (webhook URL), under Advanced | Webhook URL, optional header | | Your URL, with one fixed JSON body |

Email is always encrypted (TLS, or STARTTLS that must succeed) with a valid certificate. WhatsApp sends an approved
template by default (`docknest_alert`, language `en`, under "More options"); without one, Meta delivers plain messages
only within 24 hours of a message from you to the business number. WhatsApp and Teams only tell DockNest that they took
the message, so their test says "Accepted" or "Sent to Teams", never "Delivered".

A server on your own network (a self-hosted ntfy, Gotify, Matrix, Mattermost or webhook) needs **Allow private network**
in Connections settings, and the Connection saved by an administrator while it is on. Email relays on a private
address keep working as in 2.8 when an administrator set them.

## Who can do what

Administrators always. Operators only while an administrator turns on **Operators can manage alerts** in Connections
settings (off by default; an upgrade never turns it on). With it on, operators see and change alert nodes, lines and
Connections, with the same re-verification as an administrator, but Other (webhook URL) and both settings stay with
administrators, operator Connections reach public addresses only, and a failed operator test always answers one
sentence, "DockNest could not deliver to this address.", ten seconds after the request. Turning it off applies to the
operator's next request. See [security.md](security.md), "Alerts".

Creating, replacing or deleting a Connection, and changing where it sends (a chat ID, recipients, a number, a topic, a
server or URL), needs a recent re-verification. Changing a server or URL needs its saved secrets typed again, so a
saved token can never be pointed at a new server by editing the server alone.

## Events

| Event | When it fires | Repeats |
| --- | --- | --- |
| `backup.failed` | A backup of a site ended failed or needing recovery | Same site: at most once per 10 minutes |
| `backup.succeeded` | A backup finished | Same site: at most once per 10 minutes |
| `move.finished` | A site move completed, was rolled back, or failed | Once per move state |
| `move.needs_you` | A move waits for the DNS change, for your OK to switch, or for your decision | Once per move state |
| `server.unreachable` | A server's SSH port did not answer twice in a row (checked every 5 minutes) | Same server: at most once per 6 hours |
| `server.disk_low` | A server has less than 5 GB free, or more than 90 percent used when its size is known | Same server: at most once per 24 hours |
| `update.available` | The update check found a newer release (only if update checks are on) | Once per release |
| `restore_test.failed`, `restore_test.couldnt_run`, `restore_test.recovered`, `restore_test.needs_you` | Restore tests, see [restore-tests.md](restore-tests.md) | Once per test |
| `backup.copy_failed` | The first failed attempt of a backup copy (DockNest keeps retrying for 7 days) | Once per copy |
| `backup.copy_recovered` | A copy that failed earlier was saved | Once per copy |
| `backup.copy_gave_up` | A copy still failed after 7 days of retries (it can be retried in DockNest) | Once per copy |

New lines start with the failures: a site with backup failed and restore test failed; a server with those plus
unreachable and low disk; DockNest with those plus update available.

A `docknest` line covers the whole installation, a `server` line that server and the sites on it, a `site` line only
that site. There is one line per source and node. A message goes to a Connection at most once per event, however many
nodes and lines lead to it.

## Messages

One template for every provider: a title ("Backup failed"), the site and server names you typed, the time with its
zone, one plain reason from a fixed list ("The backup did not finish. Open DockNest to see why.") and a link that opens
the job in DockNest after sign-in (`/?job=<id>`, only when `APP_ORIGIN` is not a loopback address). Each provider
formats it in its own way; mentions are always off and markup in names is neutral. No addresses, paths, logs or error
text are ever sent, and bidi control characters are removed from names.

## Delivery

The worker detects events by reading existing tables and keeps one outbox per Connection. A send is retried after 1
and 5 minutes (3 tries); a rejected login or a gone webhook fails at once; a provider that asks to slow down is waited
for (up to 15 minutes, no try used). At most 20 messages per Connection per 10 minutes, at most 50 waiting (more fold
into "N more alerts"), and nothing older than 24 hours is sent. A failed real send shows a warning on the Connections
page and on the node. No alert is sent about a failed alert.

## API

Every route needs a signed-in administrator, or an operator while "Operators can manage alerts" is on (otherwise 403
`ALERTS_ADMIN_REQUIRED`), and the usual CSRF header. Errors are one plain sentence; a `field` names the field it is
about. Views never carry a secret, only `<key>Set` flags.

| Method and path | Purpose |
| --- | --- |
| `GET /api/connections` | `{ connections, settings: { allowPrivateNetwork, operatorsManage }, legacyChanged, limits, role }` |
| `GET /api/connections/providers` | `{ providers: [{ id, label, icon, group, fields, destination, host, testNote?, adminOnly? }] }` |
| `POST /api/connections` | `{ provider, name, values }`. Re-verification. Other: administrators only |
| `PATCH /api/connections/:id` | `{ name?, values? }`. Secrets left out keep their value. Re-verification when a secret, server or destination changes |
| `DELETE /api/connections/:id` | Re-verification. 409 `CONNECTION_IN_USE` with `nodes` while a node uses it |
| `POST /api/connections/:id/test` | Sends the test message through a saved Connection and records the result |
| `POST /api/connections/test` | `{ provider, values, connectionId? }`: sends the test message with unsaved values, stores nothing |
| `PUT /api/connections/settings` | `{ allowPrivateNetwork?, operatorsManage? }`. Administrators only, re-verification, audited |
| `GET /api/alerts` | The Map summary: `{ nodes, rules, connections, providers, events, sourceKinds, diskLow, limits, settings, role }` |
| `GET, POST /api/alerts/nodes`; `PATCH, DELETE /api/alerts/nodes/:id` | `{ name, provider, connectionId }`. A new provider clears the Connection |
| `POST /api/alerts/nodes/:id/test` | Sends the test message through the node's Connection |
| `GET, POST /api/alerts/rules`; `PATCH, DELETE /api/alerts/rules/:id` | `{ nodeId, sourceKind, sourceId \| null, events, enabled? }` (`channelId` is still accepted for one release) |

A Connection view is `{ id, provider, name, values, secretReadable, usedBy, lastTest, lastTestAt, testError, lastSend,
lastSendAt, sendError, editable }`. A node view is `{ id, provider, name, connectionId, connectionName,
needsConnection, prefill, lastSend, lastSendAt, sendError }`; `prefill` is a 2.8 destination (chat ID or recipients)
kept for a node that had no credential. Tests are limited to 10 per 10 minutes per user. A successful test answers
`{ ok, delivered, note? }`.

The 2.8 routes `/api/alerts/credentials` and `/api/alerts/channels` are gone; the Map and the Connections page use the
routes above. Limits: 60 Connections, 40 nodes, 200 lines.

## Screens

- **Administration, Connections**: one table (Name, Provider, Used by, Last test, Actions: edit, send test, delete),
  labelled rows on phones, an empty state, a warning when a real send failed, and the two settings switches
  (administrators only). **New connection** opens a dialog (a bottom sheet on phones): Provider first (searchable;
  Other under Advanced), then Name and the provider's fields, "More options", Send test and Save.
- **Map**: an alert node panel with Name, Provider, Connection (that provider's Connections and "New connection") and
  Send test, and a "Sends when" tab with one block per connected source. Delete a node with the Delete key or the icon
  on its corner: a node with sources asks first, one without goes at once with Undo. On phones the Alerts section lists
  each node with its sources.

## Data

Migration 10 (`alert-connections`, compatible) adds `connections`, `alert_nodes`, `alert_lines` and `alert_outbox` and
copies the 2.8 alerts into them without opening any sealed value. The 2.8 tables stay as they were, so going back to
2.9 keeps the alerts as they were at upgrade time. See [upgrading.md](upgrading.md).
