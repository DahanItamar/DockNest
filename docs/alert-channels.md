# Alert channels and Connections (ADR)

Status: accepted design for the release after 2.9.0. Not implemented yet. Date: 2026-10-27.
Spec: the owner-approved mockup "Alert channels, final design, Option C". This doc turns it into decisions.
Builds on [alerts.md](alerts.md) (2.8.0) and [security.md](security.md), "Alerts".

Today DockNest sends alerts to Telegram and email. This release adds eleven more providers and moves the logins to
a new Administration page, Connections. Alert nodes stay on the Map. Existing nodes keep working with no user action.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Model | A **Connection** holds everything needed to reach one place: the login and the destination. A **node** on the Map is one provider plus one Connection. Lines (rules) keep their meaning and events. |
| Providers | Telegram, Email, WhatsApp (Meta Cloud API only), Discord, Slack, Microsoft Teams (Workflows), ntfy, Gotify, Pushover, Matrix, Google Chat, Mattermost, and "Other (webhook URL)" under Advanced. |
| Registry | One file per provider in `src/alerts/providers/`: fields, validation, `format()`, `send()`, `explain()`. The core does all network work. |
| Storage | Secret fields sealed with the master key as one value; destination fields plain. Never returned, logged or audited. |
| Schema | New tables only, next free migration number at merge time (currently 10), `compatible: true`. Old tables stay frozen for rollback. |
| Migration | Pure SQL and JSON copy at upgrade. Sealed values are copied byte for byte, never opened. Same ids for nodes and lines. |
| Outbound | Every request goes through one guarded client: HTTPS, own DNS check pinned to the socket, no redirects, 10 s, 64 KB. |
| Private network | Refused by default. An admin setting "Allow private network" opens RFC 1918, ULA and CGNAT for self-hosted ntfy, Gotify, Matrix, Mattermost and webhooks. Loopback, link-local and metadata are always refused. |
| Who | Administrators only, as today. Creating, replacing or deleting a Connection needs a recent re-verification. |
| Message | One template for every provider: title, site and server, a plain reason, a link to the job. Each provider formats it natively. |

## Data model (migration `alert-connections`, `compatible: true`)

The 2.8 tables cannot hold new providers: `alert_credentials.kind` and `alert_channels.kind` have `CHECK` lists, and
SQLite cannot change a `CHECK` without rebuilding the table. A rebuild inside the migration transaction would also
fire `ON DELETE CASCADE` on the lines (foreign keys are on). So the migration only adds tables:

```sql
CREATE TABLE connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (length(provider) <= 32),
  name TEXT NOT NULL CHECK (length(name) <= 80), secret TEXT NOT NULL CHECK (length(secret) <= 8192),
  settings TEXT NOT NULL CHECK (length(settings) <= 4096), origin TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_test TEXT CHECK (last_test IS NULL OR last_test IN ('ok','failed')), last_test_at TEXT,
  last_send TEXT CHECK (last_send IS NULL OR last_send IN ('ok','failed')), last_send_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200));
CREATE TABLE alert_nodes (id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (length(provider) <= 32),
  name TEXT NOT NULL CHECK (length(name) <= 80), connection_id TEXT REFERENCES connections(id) ON DELETE RESTRICT,
  prefill TEXT CHECK (prefill IS NULL OR length(prefill) <= 2048), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE alert_lines (...same columns as alert_rules, node_id REFERENCES alert_nodes(id) ON DELETE CASCADE...);
CREATE TABLE alert_outbox (...same columns as alert_queue, plus connection_id; node_id ON DELETE CASCADE...);
CREATE INDEX alert_outbox_due ON alert_outbox(status, next_attempt_at);
CREATE INDEX alert_outbox_dedupe ON alert_outbox(connection_id, dedupe_key, created_at);
CREATE INDEX alert_lines_node ON alert_lines(node_id);
```

- `provider` is checked in code against the registry, not in SQL, so a new provider never needs a migration.
- `secret` is the sealed JSON of the provider's secret fields. `settings` is plain JSON of its other fields.
- `origin` records where a migrated row came from (`legacy:<credentialId>`), for support and for the clean-up below.
- `prefill` keeps a 2.8 destination (a chat ID, recipients) for a node that had no matching credential, so
  "New connection" can offer it. It holds no secret.
- `ON DELETE RESTRICT` backs up the API rule that a Connection in use cannot be deleted.
- Limits: 60 Connections (one per destination now, so more than the 20 credentials), 40 nodes, 200 lines.

### Email keeps its sealed shape

Today the whole SMTP account (server, port, encryption, user, password, from) is one sealed value. The Email provider
keeps exactly that shape as its `secret`, so the copy needs no decryption. Recipients and the optional subject prefix
go to `settings`. The view opens the sealed value only to show the non-secret members, as `credentialView` does now.

## Migrating 2.8 alerts

The migration runs inside the normal pre-upgrade snapshot and transaction. It never opens a sealed value and never
needs the master key.

1. For each legacy node with a credential of the matching kind, take its destination: Telegram `chatId`, or Email
   `to` and `subjectPrefix`.
2. Group the nodes of one credential by destination. The first group gets a Connection with the credential's id and
   name. Each further group gets a new id and the name `<credential name> (<first node name>)`, cut to 80 characters.
3. Each Connection copies `secret` = `alert_credentials.config` byte for byte, `settings` = the destination,
   `origin = legacy:<credentialId>`, and the credential's last test fields.
4. Each node is copied to `alert_nodes` with its own id, `provider` (`telegram` or `email`) and its group's Connection.
   A node without a matching credential gets `connection_id = NULL` and `prefill` = its old config. It shows "Needs a
   connection" and sends nothing, exactly as it showed "Needs a credential" before.
5. Lines are copied to `alert_lines` with the same ids, events and enabled flag.
6. Outbox: pending items, and sent or failed items from the last 24 hours (the longest repeat window), are copied with
   their `connection_id`, so pending messages still go out and repeat windows still hold.
7. Credentials that no node uses become Connections with empty `settings` and show "Add the chat ID" (Telegram) or
   "Add recipients" (Email) in the Connections list. They send nothing until completed.

The result, for every 2.8 install: the same nodes, lines and messages, to the same chats and inboxes, with no action.

### Rollback

- The four 2.8 tables are not changed. The new code never reads or writes them, with one exception below.
- `compatible: true` holds: only new objects. A downgrade to 2.9 opens the database and keeps sending with the alert
  setup as it was at upgrade time. Changes made after the upgrade are not visible to 2.9.
- Exception, so a removed secret is really gone: replacing a secret of, or deleting, a Connection with
  `origin = legacy:<id>` also deletes that legacy credential row (legacy nodes get `credential_id = NULL` by their
  existing `ON DELETE SET NULL`). After a downgrade those nodes show "Needs a credential" and send nothing.
- Pending legacy queue items are not cleared. A downgrade within minutes may send a message a second time. Accepted.
- A later release drops the legacy tables in its own migration and says so in [upgrading.md](upgrading.md).

## Sealed storage, redaction, audit and roles

- Each provider field is `secret` or not. Secret fields are sealed together (AES-256-GCM with the master key, as SSH
  keys and the Cloudflare token). They are opened only at the moment of a send or a test.
- Webhook URLs are secrets (Discord, Slack, Teams, Google Chat, Mattermost, Other): the URL is the login. Also secret:
  bot and access tokens, passwords, the Pushover user key, the ntfy token, the Gotify app token, the webhook header.
- The API never returns a secret. A view carries the plain fields and `<field>Set: true` flags. The UI shows
  "Saved, hidden" with a pencil; the pencil only replaces ("The saved one is replaced when you save.").
- Secrets left out of a PATCH keep their saved value. Changing where a secret goes requires typing it again: the
  ntfy, Gotify or Matrix server, the SMTP server, port, encryption or user name. A saved token can never be pointed at
  a new host by editing the host alone. This generalises today's SMTP rule.
- Never in logs, audit events, outbox rows, `last_error`, API errors or problem reports: secret values, webhook URLs,
  request or response bodies, provider error text. Transport errors are replaced by fixed sentences, because Node's
  error text can contain the URL. `last_error` is one sentence from the provider's `explain()`, at most 200 chars.
- Audit events (actor, target id, detail with no values):
  `connection.create {provider}`, `connection.update {provider, fields}` (field names only),
  `connection.delete {provider}`, `connection.test {provider, ok}`, `alert.node.create|update|delete {provider}`,
  `alert.node.test {provider, ok}`, `alert.rule.*` as today, `alerts.private_network {enabled}`.
- Roles: administrators only, as in 2.8. Operators get no Connection or alert data, and their Map has no alert parts.
  Recent re-verification for create, replace, delete of a Connection and for "Allow private network". Tests and node
  changes need an administrator only.

## Provider registry

`src/alerts/providers/<id>.js`, one file each, listed in `providers/index.js`. A provider is data plus small pure
functions; it never opens a socket. Shape:

```js
export default {
  id: 'discord', label: 'Discord', icon: 'brand-discord', group: 'common', // or 'advanced'
  fields: [{ key: 'url', label: 'Webhook URL', type: 'url', secret: true, required: true, help: 'Server settings, Integrations, Webhooks.' }],
  schema: z.object({ url: discordWebhook }).strict(),     // full validation of secret + settings
  rebind: ['url'],                                         // changing these needs the secrets again
  target: ({ url }) => ({ url, hosts: ['discord.com', 'discordapp.com'] }), // or hosts: 'user'
  format: (message, values) => ({ method: 'POST', path: '', json: { ... } }),
  explain: (status, body) => 'Discord does not accept this webhook. Create a new one and paste it again.',
};
```

- The core (`outbound.js`) validates, opens the secret, calls `target` and `format`, sends, and calls `explain` for
  any failure. A success is any 2xx unless `explain` says the body is an error.
- Email is the one non-HTTP provider: it keeps `smtp.js` behind the same `send()` contract.
- A new provider is one file of about 40 to 80 lines, one test file and one icon. No migration, route or UI change:
  the Connections dialog and the node panel render from `fields`.
- `GET /api/connections/providers` returns `{ id, label, icon, group, fields }` (no schema code) for the UI.

## Message template

One message for every provider: `{ title, site, server, reason, url, event, at }`, built in `events.js`.

- `title`: the event in words, for example "Backup failed".
- `site`, `server`: names the owner typed, cleaned as today (no control characters, `<` `>`, 80 chars).
- `reason`: one fixed sentence from a closed catalogue keyed by failure code, for example "The database didn't stop
  cleanly." Unknown codes give "Open DockNest to see why." Never raw error text, paths, hosts or log lines.
- `url`: `${APP_ORIGIN}/?job=<id>` (a new deep link that opens the job after sign-in), only when `APP_ORIGIN` is not
  loopback. Otherwise no link.
- Each provider renders it natively and escapes it for its own markup. Mentions are always disabled. Text is cut to
  the provider's limit with an ellipsis.

The test message uses the same template: title "DockNest test message", reason "Your alerts are connected."

## Providers

| Provider | Secret | Plain | Where it connects | Format |
|---|---|---|---|---|
| Telegram | Bot token | Chat ID | `api.telegram.org` | `sendMessage`, plain text, no `parse_mode`, link preview off |
| Email | SMTP account | Recipients (max 5), subject prefix | The SMTP server | Subject = title, plain text body |
| WhatsApp | Access token | Phone number ID, send to number | `graph.facebook.com` | See below |
| Discord | Webhook URL | | `discord.com`, `discordapp.com` | `?wait=true`, `content`, `allowed_mentions: { parse: [] }`, 2000 chars |
| Slack | Webhook URL | | `hooks.slack.com` | `{ text }` with `&` `<` `>` escaped, link as `<url\|Open job>` |
| Teams | Webhook URL | | Workflows hosts (see below) | Adaptive Card in a `message` envelope |
| Google Chat | Webhook URL | | `chat.googleapis.com` | `{ text }`, title in `*bold*`, link as `<url\|Open job>` |
| Mattermost | Webhook URL | | User host | `{ text }` Markdown, escaped |
| ntfy | Token (optional) | Server (`https://ntfy.sh`), topic | ntfy.sh or user host | JSON publish: `topic`, `title`, `message`, `click`, `priority` 4 for failures |
| Gotify | App token | Server | User host | `POST /message`, `X-Gotify-Key`, `title`, `message`, `priority`, click URL in `extras` |
| Pushover | App token, user key | | `api.pushover.net` | `POST /1/messages.json`, `title`, `message`, `url`, `url_title` |
| Matrix | Access token | Homeserver, room ID | User host | `PUT /_matrix/client/v3/rooms/{room}/send/m.room.message/{txn}`, `m.text`; txn = outbox id, so a retry never posts twice |
| Other | Webhook URL, header (optional) | | User host | Fixed JSON `{ title, site, server, message, url, event, at }` |

The ntfy topic is plain but treated as sensitive in the UI help: on ntfy.sh anyone who knows a topic can read it, so
the help says "Pick a long topic that is hard to guess, or use a token." Matrix needs a room ID (`!id:server`), not an
alias, so no extra lookup request is ever made. Other's header is one line `Name: value`; names that change transport
(`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Cookie`) are refused.

### WhatsApp (Meta WhatsApp Cloud API only)

- `POST https://graph.facebook.com/<pinned version>/<phone number id>/messages`, `Authorization: Bearer <token>`.
  The Graph API version is pinned in code and bumped on purpose. No unofficial libraries, no WhatsApp Web sessions.
- The user brings a Meta WhatsApp Business account, a phone number ID and a token. The help recommends a permanent
  system user token; temporary tokens from the developer page expire after about 24 hours.
- The dialog shows the approved amber note: "Uses your own Meta WhatsApp Business account. Meta may charge for
  messages."
- The honest rule: Meta allows a free-form text message only inside the 24-hour customer service window, which opens
  when the recipient messages the business number. Outside it, Meta refuses free-form text (error 131047) and only an
  approved template can start the conversation. Alerts are business-initiated, so without a template they arrive only
  if the recipient wrote to the number in the last day.
- Simplest compliant path: one Utility template the user creates once in WhatsApp Manager, named `docknest_alert`,
  language `en`, body `DockNest alert: {{1}}. {{2}}. {{3}} Open DockNest for details.` (title, site and server,
  reason; Meta refuses a body that ends with a variable). DockNest sends a `template` message with those three text
  parameters when the Connection has a template name, else free-form text.
- Two optional fields under "More options": Template name (default empty) and Template language (default `en`).
  "Send test" reports 131047 in words: "WhatsApp only delivers this outside a 24-hour chat with a template. Add your
  template name, or send any message to the business number and test again."
- The link is in the body text; templates cannot carry a dynamic button without more setup. Accepted.

### Microsoft Teams (Workflows)

- Office 365 connectors (the old "Incoming Webhook") are retired. DockNest supports only the Workflows template "Post
  to a channel when a webhook request is received".
- Hosts: the URL must be HTTPS on `*.logic.azure.com` or `*.api.powerplatform.com` (newer Workflows URLs). Others are
  refused with "Paste the URL from a Teams Workflows webhook."
- Body: `{ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content:
  { type: "AdaptiveCard", version: "1.4", body: [TextBlocks], actions: [Action.OpenUrl] } }] }`.
- Workflows answers 202 when it accepts the request, before it posts. A test that returns 202 shows "Sent to Teams. If
  it does not appear, open the workflow's run history." It never claims "Delivered" for Teams.

### Slack, Discord and Google Chat

- Slack incoming webhooks answer `200 ok`, or 400 `invalid_payload`, 403, 404 `no_service`, 410
  `channel_is_archived`; each maps to one sentence. Path must start `/services/`.
- Discord webhooks must match `/api/webhooks/<id>/<token>`; `?wait=true` makes Discord report errors; 401 or 404 means
  the webhook was deleted.
- Google Chat webhooks must be `/v1/spaces/<space>/messages` with `key` and `token` query values (both part of the
  secret URL). 400 means the space removed the app.

## Outbound safety

All HTTP providers send through one client in `src/alerts/outbound.js`. Nothing else in alerts calls `fetch`.

- **Scheme**: HTTPS only. Plain HTTP only when "Allow private network" is on and every address of the host is
  private, with an amber note in the dialog ("This sends your token without encryption.").
- **URL**: no user name or password in the URL, no fragments, at most 2048 chars. Fixed-host providers must match
  their host list exactly.
- **Addresses always refused**: loopback (`127.0.0.0/8`, `::1`), unspecified, link-local (`169.254.0.0/16`,
  `fe80::/10`), cloud metadata (`169.254.169.254`, `fd00:ec2::254`), multicast, reserved, documentation and benchmark
  ranges, and IPv4-mapped, NAT64 and 6to4 forms of any refused IPv4. The lists extend those in `src/probe-url.js`
  and share one `BlockList` module.
- **Private ranges** (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`): refused unless the admin setting
  "Allow private network" is on (Administration, Connections, off by default, re-verification, audited). It exists
  for self-hosted ntfy, Gotify, Matrix, Mattermost and webhooks, often behind Tailscale. It never opens loopback,
  link-local or metadata.
- **DNS rebinding**: requests use `node:https` with a custom `lookup` that resolves the name, checks every address
  and hands the socket only a checked address. The check and the connection use the same answer, so a second DNS
  answer cannot slip in. IP literals are checked the same way. The TLS name stays the host name.
- **Redirects**: never followed. A 3xx is a failure: "The server answered with a redirect. Paste the final URL."
- **Limits**: 10 seconds for the whole request, request body at most 16 KB, response read at most 64 KB then
  dropped. One request at a time per Connection.
- **TLS**: system CAs, TLS 1.2 or newer, certificate must match the host name. There is no "skip verification".
- **Checked twice**: at save (format and policy, with a DNS check) and again at every send, because DNS changes.
- **Email**: keeps the 2.8 rules (TLS or STARTTLS, valid certificate). Link-local and metadata addresses are now
  refused; private and loopback relays keep working, so existing email setups are unaffected.

## Delivery, dedup, rate limits and failures

- The detector and the template are unchanged apart from the new fields. `emit` finds matching lines, then the nodes,
  then the Connections.
- **Dedup per Connection**: a message goes to one Connection at most once per event, even when two nodes or several
  lines lead to it. Repeat windows stay as in 2.8 (10 minutes, 6 hours unreachable, 24 hours low disk).
- **Rate limit per Connection**: at most 20 messages per 10 minutes. Over that, items wait for the next window; none
  are dropped. A provider 429 reschedules by `Retry-After` (capped at 15 minutes) and does not use up a try.
- **Retries**: 1 minute, then 5 minutes, 3 tries, as today. A rejected login (401 or 403, or the provider's
  equivalent) is final at once: no retries against a revoked token.
- **Status**: every real send sets `last_send` on the Connection; every test sets `last_test`. The Connections list
  shows "Last test": "Delivered", "Failed" or "Not tested" with a relative time. When the last real send failed, the
  page shows a warning panel ("Phone alerts failed. The last message did not reach ntfy.") and the node's Map
  caption turns to warn. No alert is sent about a failed alert, so there are no loops.
- **Tests**: "Send test" in the dialog (unsaved values, sent once and not stored), in the Connections row and in the
  node panel. Shared limit 10 per 10 minutes per administrator, as today.

## API (administrators only)

| Method and path | Purpose |
|---|---|
| `GET /api/connections`, `GET /api/connections/providers` | List with `usedBy`, statuses; provider field lists |
| `POST /api/connections` | `{ provider, name, values }`. Re-verification |
| `PATCH /api/connections/:id` | `{ name?, values? }`. Re-verification when a secret or a `rebind` field changes |
| `DELETE /api/connections/:id` | 409 `CONNECTION_IN_USE` with node names. Re-verification |
| `POST /api/connections/:id/test`, `POST /api/connections/test` | Test a saved Connection, or unsaved values |
| `PUT /api/connections/settings` | `{ allowPrivateNetwork }`. Re-verification |
| `GET/POST/PATCH/DELETE /api/alerts/nodes`, `POST /api/alerts/nodes/:id/test` | Nodes: `{ name, provider, connectionId }` |
| `/api/alerts/rules` | Unchanged, `channelId` renamed `nodeId` (old name accepted for one release) |

The 2.8 `/api/alerts/credentials` and `/api/alerts/channels` routes are removed; the bundled UI is their only client.

## Screens

- **Administration, Connections**: title "Connections", "Logins your alerts use.", "New connection". Table: Name,
  Provider (icon and name), Used by (node names or "Not used"), Last test, Actions (edit, send test, delete). Empty
  state: "No connections yet. A connection holds the login for one provider. Add one, then pick it on an alert node."
  On phones the table becomes cards with the same labels.
- **New or Edit connection dialog**: Provider first (searchable, grouped; Other sits under Advanced), then Name and
  the provider's fields. Cancel, Send test, Save; Test and Save stay disabled with "Add the missing details." Edit
  locks the provider and shows secrets as "Saved, hidden". Other shows the amber "For advanced users" note and the
  exact JSON it sends. WhatsApp shows "How to get these" and the Meta note.
- **Node panel** (desktop side panel, phone sheet): Name, Provider (searchable), Connection (only that provider's,
  plus "New connection" prefilled with the provider and any `prefill`, and a pencil to edit), Send test. Tab "Sends
  when": one block per connected source with its events and Disconnect, then "Connect another source". New sources
  start with the defaults: site: backup failed, restore test failed; server: those plus unreachable and low disk;
  DockNest: those plus update available. No "Send on", no "Last result", no delete button in the panel.
- **Delete on the grid**: Delete or Backspace on a focused node (never while typing in a field), or the trash icon on
  the node's corner. A node with sources asks "Delete Ops WhatsApp? It stops alerts from 2 sources."; one without
  sources goes at once, with Undo.
- **Changing a node's provider** clears its Connection; Save stays disabled until one is chosen.
- **Phone list**: the Alerts section shows one block per node (name, provider) with its source rows and their event
  words, and "Add alert node".
- Tabler icons, design tokens, `StatusLabel` states, no emoji, per [DESIGN.md](design/DESIGN.md). Brand icons only
  as the provider's mark.

## Upgrade safety

- No user action. Every 2.8 node, line, chat, inbox and repeat window works after the upgrade; the first message
  after the upgrade looks richer (title, reason, link) but goes to the same place.
- The migration adds tables and copies rows; it never alters or deletes 2.8 data and never decrypts anything.
- Downgrade to 2.9 works with the alert setup from upgrade time (see Rollback).
- Email relays on private addresses keep working; the private-network setting applies to HTTP providers only.

## Test plan

- **Migration** (`tests/migrations.test.js`, fixture from 2.8.2 and 2.9.0): one credential and one node; one bot
  shared by two chats (two Connections, names); two nodes with the same chat (one Connection); a node without a
  credential (`prefill`); an unused credential; sealed bytes identical after copy; ids kept; lines and outbox copied;
  idempotent; compat floor unchanged; 2.9 code still runs on the migrated database; deleting a migrated Connection
  removes its legacy row.
- **Per provider** (`tests/alert-providers.test.js`): a local fake HTTPS server records each request. Body shape,
  headers, escaping (`<`, `&`, `@everyone`, Markdown), length cut, link present or absent, every documented error
  status to its sentence, Matrix txn reuse on retry, WhatsApp template and free-form bodies and 131047, Teams 202
  wording, ntfy with and without token. The fake server stands in by host override in tests only.
- **SSRF** (`tests/alert-outbound.test.js`): each refused range as literal and via DNS; IPv4-mapped, NAT64, 6to4,
  decimal and octal forms; a name that resolves to public then private (rebinding) never connects to the second; mixed
  answers refused; redirects refused; timeout; oversized response; HTTP refused unless private and allowed; metadata
  refused even with the setting on; fixed-host lists.
- **Secrets**: no secret, URL or response text in logs, audit rows, outbox, `last_error`, API errors or views (scan
  every captured string for the planted values); PATCH without secrets keeps them; changing a `rebind` field without
  the secret is refused.
- **Delivery**: dedup across two nodes on one Connection; rate limit defers, never drops; 401 is final; 429 respects
  `Retry-After`; `last_send` and `last_test` updates.
- **Browser** (from the mockup boards): node panel with provider and Connection combos, New connection from the
  panel, Sends when defaults; grid delete by key and corner icon, confirm only with sources; Connections list, empty
  state, failure panel; dialog for WhatsApp, Discord, ntfy, Other and Edit ("Saved, hidden", pencil replace); phone
  width 390 px, light and dark, keyboard only.
- No real provider accounts in CI. A manual check with real Telegram, Discord and ntfy.sh before release.

## Implementation PRs

1. **Core** (security-critical review): migration and copy, Connections and nodes store, sealed storage and views,
   registry, `outbound.js` with SSRF guard and the private-network setting, Telegram and Email moved onto the
   registry, delivery dedup and rate limits. Migration, SSRF and secret tests.
2. **Providers**: WhatsApp, Discord, Slack, Teams, Google Chat, Mattermost, ntfy, Gotify, Pushover, Matrix, Other,
   the message template with reasons and the job deep link. Fake-server tests.
3. **API and Connections page**: routes, re-verification, audit events, Connections list, dialog, settings toggle.
   API and browser tests.
4. **Map and docs**: node panel, grid delete, phone list, browser tests and design review. Rewrite `alerts.md`,
   update `security.md`, `upgrading.md`, README and the release note.

## Questions for the owner

1. WhatsApp: add the two optional template fields under "More options" (recommended), or ship free-form text only,
   which reliably works only inside the 24-hour window?
2. Email subject prefix is not in the mockup. Keep it as an optional field so 2.8 setups stay identical (recommended)?
3. Should operators see alert nodes read-only on the Map, or stay with no alert data as in 2.8 (recommended)?

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for the data model, migration, registry and PR split, and
[Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md)
for sealed storage, redaction, SSRF and rebinding protection, and abuse limits.
