# Alert channels and Connections (ADR)

Status: accepted design for the release after 2.9.0. In progress: PR 1a (migration 10 and the store) and PR 1b (the guarded outbound client) are done, see "Notes from PR 1a" and "Notes from PR 1b". Date: 2026-10-27.
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
| Schema | New tables only, the next free migration number at merge time (restore tests take 9, the radar comes later), `compatible: true`. Old tables stay frozen for rollback. |
| Migration | Pure SQL and JSON copy at upgrade. Sealed values are copied byte for byte, never opened. Same ids for nodes and lines. |
| Outbound | Every request goes through one guarded client: HTTPS, own DNS check pinned to the socket, no redirects, 10 s, 64 KB. |
| Private network | Refused by default. An admin setting "Allow private network" opens RFC 1918, ULA and CGNAT, but only for Connections an admin saved while it is on. A fixed list (loopback, link-local, metadata and others) is always refused. |
| Who | Administrators, plus operators when an admin turns on "Operators can manage alerts" (off by default). Creating, replacing or deleting a Connection needs a recent re-verification. |
| Message | One template for every provider: title, site and server, a plain reason, a link to the job. Each provider formats it natively. |

## Data model (migration `alert-connections`, `compatible: true`)

The 2.8 tables cannot hold new providers: `alert_credentials.kind` and `alert_channels.kind` have `CHECK` lists, and
SQLite cannot change a `CHECK` without rebuilding the table. A rebuild inside the migration transaction would also
fire `ON DELETE CASCADE` on the lines (foreign keys are on). So the migration only adds tables:

```sql
CREATE TABLE connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (length(provider) <= 32),
  name TEXT NOT NULL CHECK (length(name) <= 80), secret TEXT NOT NULL CHECK (length(secret) <= 8192),
  settings TEXT NOT NULL CHECK (length(settings) <= 4096), origin TEXT, private_ok INTEGER NOT NULL DEFAULT 0
  CHECK (private_ok IN (0,1)), created_by TEXT, updated_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_test TEXT CHECK (last_test IS NULL OR last_test IN ('ok','failed')), last_test_at TEXT,
  last_send TEXT CHECK (last_send IS NULL OR last_send IN ('ok','failed')), last_send_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200));
CREATE TABLE alert_nodes (id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (length(provider) <= 32),
  name TEXT NOT NULL CHECK (length(name) <= 80), connection_id TEXT REFERENCES connections(id) ON DELETE RESTRICT,
  prefill TEXT CHECK (prefill IS NULL OR length(prefill) <= 2048), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE alert_lines (...same columns as alert_rules, node_id REFERENCES alert_nodes(id) ON DELETE CASCADE...);
CREATE TABLE alert_outbox (...same columns as alert_queue, plus:
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES alert_nodes(id) ON DELETE SET NULL,
  payload TEXT, -- the structured template; NULL for a migrated 2.8 item, which is sent as its plain `message`
  expires_at INTEGER NOT NULL);
CREATE INDEX alert_outbox_due ON alert_outbox(status, next_attempt_at);
CREATE INDEX alert_outbox_dedupe ON alert_outbox(connection_id, dedupe_key, created_at);
CREATE INDEX alert_lines_node ON alert_lines(node_id);
```

- `provider` is checked in code against the registry, not in SQL, so a new provider never needs a migration.
- `secret` is the sealed JSON of the provider's secret fields. `settings` is plain JSON of its other fields.
- `origin` records where a migrated row came from (`legacy:<credentialId>`), for support and for the clean-up below.
- `prefill` keeps a 2.8 destination (a chat ID, recipients) for a node that had no matching credential, so
  "New connection" can offer it. It holds no secret.
- `created_by`, `updated_by`: user ids, for the audit trail only. NULL for migrated rows. They never decide what a
  Connection may reach.
- `private_ok`: whether the Connection may reach a private address. It follows who last set the host or URL (for
  Email, the SMTP host), not who saved last, so an operator renaming or changing recipients never breaks an admin's
  private server. HTTP providers: 1 when that was an administrator while "Allow private network" was on. Email: 1
  when that was an administrator (the 2.8 rule, which does not depend on the setting). Migrated Email rows get 1, so a
  2.8 private relay keeps working; migrated Telegram rows reach only their fixed host. An operator setting a host or
  URL sets it to 0.
- Foreign keys: a node's Connection is `ON DELETE RESTRICT` (a Connection in use cannot be deleted); a line is
  `ON DELETE CASCADE` with its node; an outbox item is `ON DELETE CASCADE` with its Connection (it is keyed on the
  Connection) and `ON DELETE SET NULL` on its node, so dedup history survives a deleted node.
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
6. Outbox: **all** rows are copied (2.8 already prunes them to 7 days) with their `connection_id`, so `occ:` keys
   (one move state, one release) are never sent twice and repeat windows still hold. Copied rows get
   `payload = NULL`: pending ones are sent as their 2.8 plain text through each provider's plain-text path.
7. Credentials that no node uses become Connections with empty `settings` and show "Add the chat ID" (Telegram) or
   "Add recipients" (Email) in the Connections list. They send nothing until completed.

The result, for every 2.8 install: the same nodes, lines and messages, to the same chats and inboxes, with no action.

### Rollback

- The four 2.8 tables are not changed. The new code never reads or writes them, with one exception below.
- `compatible: true` holds: only new objects. A downgrade to 2.9 opens the database and keeps sending with the alert
  setup as it was at upgrade time. Changes made after the upgrade are not visible to 2.9.
- Downgrade, change, upgrade again: the migration has already run, so changes made in 2.9 to the legacy tables are
  not copied again and are lost. At start the new code compares the newest `updated_at` in the legacy tables with the
  migration time; when legacy rows are newer, the Connections page warns: "Alert changes made in an older DockNest
  version are not shown here. Enter them again."
- Exception, so a removed secret is gone from the live tables: replacing a secret of, or deleting, a Connection with
  `origin = legacy:<id>` also deletes that legacy credential row (legacy nodes get `credential_id = NULL` by their
  existing `ON DELETE SET NULL`). After a downgrade those nodes show "Needs a credential" and send nothing.
- A credential split into several Connections has one legacy row. Changing the secret of, or deleting, any one of
  them deletes it, so after a downgrade every legacy node of that credential needs a credential, not only one.
- These deletes run with `PRAGMA secure_delete=ON` (set on the connection for the statement, then restored), so the
  freed pages are zeroed, followed by `PRAGMA wal_checkpoint(TRUNCATE)` so the old page images leave the WAL file. Pre-upgrade snapshots and older self-backups still hold the old sealed token. The UI says it
  plainly when a secret is replaced: "If this login leaked, also revoke it at the provider."
- Pending legacy queue items are not cleared. A downgrade within minutes may send a message a second time. Accepted.
- A later release drops the legacy tables in its own migration and says so in [upgrading.md](upgrading.md).

## Sealed storage, redaction, audit and roles

- Each provider field is `secret` or not. Secret fields are sealed together (AES-256-GCM with the master key, as SSH
  keys and the Cloudflare token). They are opened only at the moment of a send or a test.
- Webhook URLs are secrets (Discord, Slack, Teams, Google Chat, Mattermost, Other): the URL is the login. Also secret:
  bot and access tokens, passwords, the Pushover user key, the ntfy token, the Gotify app token, the webhook header.
- The API never returns a secret. A view carries the plain fields and `<field>Set: true` flags. The UI shows
  "Saved, hidden" with a pencil; the pencil only replaces ("The saved one is replaced when you save.").
- Secrets left out of a PATCH keep their saved value. Changing where a secret goes (`host` fields) requires typing it
  again: the ntfy, Gotify or Matrix server, the SMTP server, port, encryption or user name. A saved token can never be
  pointed at a new host by editing the host alone. This generalises today's SMTP rule.
- Destination fields (`destination` in the registry) decide who reads the alerts: Telegram chat ID, email recipients,
  WhatsApp number, ntfy topic, Matrix room, and every server URL. Changing one needs a recent re-verification, for
  administrators and operators alike, and is audited by field name.
- Never in logs, audit events, outbox rows, `last_error`, API errors or problem reports: secret values, webhook URLs,
  request or response bodies, provider error text. Transport errors are replaced by fixed sentences, because Node's
  error text can contain the URL. `last_error` is one sentence from the provider's `explain()`, at most 200 chars.
- Audit events (actor, target id, detail with no values):
  `connection.create {provider}`, `connection.update {provider, fields}` (field names only),
  `connection.delete {provider}`, `connection.test {provider, ok}`, `alert.node.create|update|delete {provider}`,
  `alert.node.test {provider, ok}`, `alert.rule.*` as today, `alerts.private_network {enabled}`,
  `alerts.operators_manage {enabled}`. Every event's detail carries `role` (`admin` or `operator`); destination and
  host changes list their field names in `fields`.

## Who may do what

An admin setting, "Operators can manage alerts" (Administration, Connections; settings key
`alerts_operators_manage`), decides whether operators take part. It is **off by default**, and the migration does not
set it, so every existing install behaves exactly as 2.8. Only an administrator can turn it on or off, with a recent
re-verification and the `alerts.operators_manage` audit event.

| Action | Administrator | Operator, setting off | Operator, setting on |
|---|---|---|---|
| See alert nodes, lines and Connections (no secrets) | Yes | No (no alert data, no alert parts on the Map) | Yes |
| Create, edit, delete nodes and lines; send tests | Yes | No | Yes |
| Create, replace a secret, delete a Connection | Yes, re-verification | No | Yes, same re-verification |
| Create or edit an "Other (webhook URL)" Connection | Yes, re-verification | No | No (shown, not editable) |
| Reach private addresses (ntfy, Gotify, Matrix, Mattermost, Email) | Only Connections saved while "Allow private network" is on | No | No: public hosts only |
| "Allow private network" | Yes, re-verification | No | No |
| "Operators can manage alerts" | Yes, re-verification | No | No |

- When the setting is on, an operator may still pick an existing Other Connection for a node and test it; it can
  only reach the URL an administrator saved.
- Operators can reach public hosts only. An admin-saved private Connection keeps working when an operator uses it on
  a node, tests it or renames it; if the operator changes its host or URL, `private_ok` drops to 0 and it is checked
  as public. For Email the same `private_ok` rule decides: a relay host set by an operator must resolve to a public
  address; one set by an administrator (or migrated) keeps the 2.8 rule.
- "Send test" with unsaved values follows the same rule. An operator's failed test answers with one fixed sentence,
  "DockNest could not deliver to this address.", for every cause (policy, DNS, refused, timeout, TLS), with no timing
  or stage in the reply. Every failed operator test, timeouts included, answers exactly 10 seconds after the request
  (the request limit), so the answer time carries no signal and it cannot map the network.
- Turning the setting off takes effect on the next request. Operators keep nothing: their views carried no secrets.
- Honest risk: with the setting on, an operator (or anyone holding a stolen operator session that passes
  re-verification) can create a Connection to an account they control, or move an existing one there, and receive
  alert text: site and server names, event times, plain reasons and job links. They never receive saved secrets
  (write-only), the link still needs a DockNest sign-in, and operators already see those names and jobs in DockNest.
  Destination changes need re-verification and are audited with the actor and role. They cannot probe the LAN:
  operator Connections reach public hosts only and failures reveal nothing. Other (any public URL with a fixed body)
  and "Allow private network" stay admin-only. That is why the setting is an explicit, audited admin opt-in.

## Provider registry

`src/alerts/providers/<id>.js`, one file each, listed in `providers/index.js`. A provider is data plus small pure
functions; it never opens a socket. Shape:

```js
export default {
  id: 'discord', label: 'Discord', icon: 'brand-discord', group: 'common', // or 'advanced'
  fields: [{ key: 'url', label: 'Webhook URL', type: 'url', secret: true, required: true, help: 'Server settings, Integrations, Webhooks.' }],
  schema: z.object({ url: discordWebhook }).strict(),     // full validation of secret + settings
  destination: ['url'],                                    // changing these needs re-verification, audited
  host: ['url'],                                           // changing these needs the secrets typed again
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
| Telegram | Bot token | Chat ID | `api.telegram.org` | `sendMessage`, plain text, no `parse_mode`, `link_preview_options: { is_disabled: true }` |
| Email | SMTP account | Recipients (max 5), subject prefix | The SMTP server | Subject = title, plain text body |
| WhatsApp | Access token | Phone number ID, send to number, template name, language | `graph.facebook.com` | See below |
| Discord | Webhook URL | | `discord.com`, `ptb.discord.com`, `canary.discord.com`, `discordapp.com` | `?wait=true`, `content`, `allowed_mentions: { parse: [] }`, 2000 chars |
| Slack | Webhook URL | | `hooks.slack.com` | `{ text }` with `&` `<` `>` escaped, link as `<url\|Open job>` |
| Teams | Webhook URL | | Workflows hosts (see below) | Adaptive Card in a `message` envelope |
| Google Chat | Webhook URL | | `chat.googleapis.com` | `{ text }`, title in `*bold*`, link as `<url\|Open job>` |
| Mattermost | Webhook URL | | User host | `{ text }` Markdown, escaped |
| ntfy | Token (optional) | Server (`https://ntfy.sh`), topic | ntfy.sh or user host | JSON publish: `topic`, `title`, `message`, `click`, `priority` 4 for failures |
| Gotify | App token | Server | User host | `POST /message`, `X-Gotify-Key`, `title`, `message`, `priority`, click URL in `extras` |
| Pushover | App token, user key | | `api.pushover.net` | `POST /1/messages.json`, `title`, `message`, `url`, `url_title` |
| Matrix | Access token | Homeserver, room ID | User host | `PUT /_matrix/client/v3/rooms/{room}/send/m.room.message/{txn}`, `m.text`, room ID URL-encoded; txn = outbox id, so a retry never posts twice |
| Other | Webhook URL, header (optional) | | User host | Fixed JSON `{ title, site, server, message, url, event, at }` |

The ntfy topic is plain but treated as sensitive in the UI help: on ntfy.sh anyone who knows a topic can read it, so
the help says "Pick a long topic that is hard to guess, or use a token." Matrix needs a room ID, not an alias, so no
extra lookup request is ever made: `!opaque:server`, or the room version 12 form `!opaque` with no server part.

Other's header is optional, one line `Name: value`, validated on save: the name is `Authorization` or starts with
`X-`; printable ASCII only, at most 1 KB in all. Refused always: `Host`, `Content-Length`, `Content-Type`,
`Transfer-Encoding`, `TE`, `Trailer`, `Connection`, `Keep-Alive`, `Upgrade`, `Expect`, `Cookie`, any `Proxy-*` and
any pseudo-header (`:name`).

### WhatsApp (Meta WhatsApp Cloud API only)

- `POST https://graph.facebook.com/<pinned version>/<phone number id>/messages`, `Authorization: Bearer <token>`.
  The Graph API version is pinned in code and bumped on purpose. No unofficial libraries, no WhatsApp Web sessions.
- The user brings a Meta WhatsApp Business account, a phone number ID and a token. The help recommends a permanent
  system user token; temporary tokens from the developer page expire after about 24 hours.
- The dialog shows the approved amber note: "Uses your own Meta WhatsApp Business account. Meta may charge for
  messages."
- The honest rule: Meta allows a free-form text message only inside the 24-hour customer service window, which opens
  when the recipient messages the business number. Outside it only an approved template can start the conversation.
  Alerts are business-initiated, so free-form text reaches the recipient only if they wrote in the last day.
- DockNest cannot see that refusal. The send answers 200 with a message id when Meta accepts it; delivery errors
  such as 131047 (outside the window) arrive later through Meta's webhook, and DockNest has no inbound webhook. Only
  login, format and template errors come back on the send and map to sentences.
- So "Send test" never says "Delivered" for WhatsApp. It shows "Accepted by WhatsApp." and always the note: "If it
  does not arrive, check the template name. Plain messages arrive only within 24 hours of a message from you."
- **Template is the default.** The user creates one Utility template once in WhatsApp Manager, named
  `docknest_alert`, language `en`, body `DockNest alert: {{1}}. {{2}}. {{3}} Open DockNest for details.` (title, site
  and server, reason). The fixed words keep the variable-to-length ratio Meta asks for, and the body neither starts
  nor ends with a variable. DockNest sends a `template` message with those three text parameters.
- Under "More options": Template name (pre-filled `docknest_alert`) and Language (pre-filled `en`). Clearing the
  template name falls back to free-form text. Help text: "WhatsApp delivers alerts with an approved template. Create a
  Utility template named docknest_alert in WhatsApp Manager. Without a template, messages arrive only within 24 hours
  of a message from you to the business number."
- Template parameter rules, applied before sending: no newlines or tabs (replaced by a space), never more than 4
  spaces in a row (Meta error 132018), each parameter trimmed and cut to 200 characters, never empty (a dash
  instead).
- The link is in the body text; templates cannot carry a dynamic button without more setup. Accepted.

### Microsoft Teams (Workflows)

- Office 365 connectors (the old "Incoming Webhook") are being retired by Microsoft; the date has moved more than
  once, so the implementation PR re-checks it and states it in the help. DockNest supports only the Workflows
  template "Post to a channel when a webhook request is received".
- Hosts: the URL must be HTTPS on `*.logic.azure.com` or `*.api.powerplatform.com` (newer Workflows URLs). Others are
  refused with "Paste the URL from a Teams Workflows webhook."
- Body: `{ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content:
  { type: "AdaptiveCard", version: "1.4", body: [TextBlocks], actions: [Action.OpenUrl] } }] }`.
- Workflows answers 202 when it accepts the request, before it posts. A test that returns 202 shows "Sent to Teams. If
  it does not appear, open the workflow's run history." It never claims "Delivered" for Teams.

### Slack, Discord and Google Chat

- Slack incoming webhooks answer `200 ok`, or 400 `invalid_payload`, 403, 404 `no_service`, 410
  `channel_is_archived`; each maps to one sentence. Path must start `/services/`.
- Discord webhooks must match `/api/webhooks/<id>/<token>`. With `?wait=true` Discord answers with the created
  message (200) instead of an empty 204, so a refused body shows up as an error. 401 or 404 means the webhook was
  deleted.
- Google Chat webhooks must be `/v1/spaces/<space>/messages` with `key` and `token` query values (both part of the
  secret URL). 400 means the payload was refused; 403 or 404 means the webhook or the app was removed.

## Outbound safety

All HTTP providers send through one client in `src/alerts/outbound.js`. Nothing else in alerts calls `fetch`.

- **Scheme**: HTTPS only. Plain HTTP only for an admin-saved Connection with `private_ok = 1` while "Allow private
  network" is on, when every address of the host is private, with an amber note ("This sends your token without
  encryption.").
- **URL**: no user name or password in the URL, no fragments, at most 2048 chars. Fixed-host providers must match
  their host list exactly. Host names `localhost`, `*.localhost`, `metadata`, `metadata.google.internal`,
  `instance-data` and `instance-data.ec2.internal` are refused by name.
- **Port**: public hosts on 443 only. An admin-saved private Connection (`private_ok = 1`) may use its own port.
- **Always refused, even with "Allow private network" on**: `0.0.0.0/8`, `127.0.0.0/8`, `::`, `::1`,
  `169.254.0.0/16` (with `169.254.169.254`), `fe80::/10`, `fd00:ec2::254`, `192.0.0.0/24`, `100.100.100.200/32`
  (Alibaba metadata), `100.100.100.100/32` (Tailscale resolver), multicast, reserved (`240.0.0.0/4`), documentation
  and benchmark ranges, and the IPv4-mapped (`::ffff:0:0/96`), NAT64 and 6to4 forms of any refused IPv4. The lists
  extend those in `src/probe-url.js` and share one `BlockList` module.
- **Private ranges** (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`): refused unless the Connection has
  `private_ok = 1` and "Allow private network" is on now (Administration, Connections, off by default,
  re-verification, audited). It exists for self-hosted ntfy, Gotify, Matrix, Mattermost and webhooks, often behind
  Tailscale.
- **IP literals**: Node skips the custom `lookup` for an IP literal host, so `outbound.js` checks literals itself
  before any connection, in every notation (decimal, octal, hex, short forms). IPv6 zone ids (`%iface`) are refused
  outright.
- **DNS rebinding**: names go through a custom `lookup` that resolves, checks every address and hands the socket only
  checked addresses. It honours `all: true` (returns the checked array) and refuses the whole name if any answer is
  refused. The check and the connection use the same answer. The TLS name stays the host name.
- **Agent**: an explicit `https.Agent` built by `outbound.js`, with no proxy. `HTTPS_PROXY` and
  `NODE_USE_ENV_PROXY` are ignored, so no proxy can resolve names for us.
- **Redirects**: never followed. A 3xx is a failure: "The server answered with a redirect. Paste the final URL."
- **Limits**: 10 seconds for the whole request, request body at most 16 KB, response read at most 64 KB then
  dropped. One request at a time per Connection.
- **TLS**: system CAs, TLS 1.2 or newer, certificate must match the host name. There is no "skip verification".
- **Checked twice**: at save (format and policy, with a DNS check) and again at every send, because DNS changes.
- **Email** keeps the 2.8 rule in `src/alerts/smtp.js` word for word: TLS or STARTTLS with a valid certificate; the
  host is resolved once, the address checked and the connection made to that address; refused are `0.0.0.0/8`,
  link-local `169.254.0.0/16`, multicast `224.0.0.0/4`, reserved `240.0.0.0/4`, loopback `127.0.0.0/8`, `::`, `::1`,
  `fe80::/10`, `ff00::/8`, `fd00:ec2::254`, and their IPv4-mapped forms; private relays are allowed when `private_ok = 1`
  (host set by an administrator, or migrated). A host set by an operator must resolve to a public address. Note for the implementation PR: the "Alerts"
  part of `docs/security.md` reads as if any host the admin enters is used, but loopback is refused in code; it gets
  corrected there.

## Delivery, dedup, rate limits and failures

- The detector and the template are unchanged apart from the new fields. `emit` finds matching lines, then the nodes,
  then the Connections.
- **Dedup per Connection**: a message goes to one Connection at most once per event, even when two nodes or several
  lines lead to it. Repeat windows stay as in 2.8 (10 minutes, 6 hours unreachable, 24 hours low disk).
- **Rate limit per Connection**: at most 20 messages per 10 minutes. Over that, items wait for the next window.
- **Cap and collapse**: at most 50 pending items per Connection. Beyond that, new items are not stored one by one;
  they are folded into one item, "12 more alerts. Open DockNest to see them.", updated in place.
- **Maximum age**: an item older than 24 hours is marked failed without sending. A stale "server unreachable" helps
  no one.
- **429**: reschedules by the wait the provider gives, capped at 15 minutes, and does not use up a try. Read from
  `Retry-After` as seconds or as an HTTP date, Discord's JSON `retry_after` (seconds) and Telegram's
  `parameters.retry_after`.
- **Retries**: 1 minute, then 5 minutes, 3 tries, as today. Final at once, with no retry: a rejected login (401, 403
  or the provider's equivalent) and a gone destination (Discord 404, Slack 404 `no_service` or 410, Google Chat 403 or
  404, and whatever each provider's `explain()` marks as `final`).
- **Status**: every real send sets `last_send` on the Connection; every test sets `last_test`. The Connections list
  shows "Last test": "Delivered", "Failed" or "Not tested" with a relative time. When the last real send failed, the
  page shows a warning panel ("Phone alerts failed. The last message did not reach ntfy.") and the node's Map
  caption turns to warn. No alert is sent about a failed alert, so there are no loops.
- **Tests**: "Send test" in the dialog (unsaved values, sent once and not stored), in the Connections row and in the
  node panel. Shared limit 10 per 10 minutes per user, as today.

## API

All routes need a signed-in administrator, or an operator when "Operators can manage alerts" is on, plus the
usual CSRF header. Rows marked *admin* stay admin-only. Operators get 403 `ALERTS_ADMIN_REQUIRED` otherwise.

| Method and path | Purpose |
|---|---|
| `GET /api/connections`, `GET /api/connections/providers` | List with `usedBy`, statuses; provider field lists |
| `POST /api/connections` | `{ provider, name, values }`. Re-verification. `provider: "webhook"` *admin* |
| `PATCH /api/connections/:id` | `{ name?, values? }`. Re-verification when a secret, `host` or `destination` field changes. Webhook *admin* |
| `DELETE /api/connections/:id` | 409 `CONNECTION_IN_USE` with node names. Re-verification. Webhook *admin* |
| `POST /api/connections/:id/test`, `POST /api/connections/test` | Test a saved Connection, or unsaved values |
| `PUT /api/connections/settings` | `{ allowPrivateNetwork?, operatorsManage? }`. Re-verification. *admin* |
| `GET/POST/PATCH/DELETE /api/alerts/nodes`, `POST /api/alerts/nodes/:id/test` | Nodes: `{ name, provider, connectionId }` |
| `/api/alerts/rules` | Unchanged, `channelId` renamed `nodeId` (old name accepted for one release) |
| Any change of a `destination` field | Re-verification, for admins and operators |

The 2.8 `/api/alerts/credentials` and `/api/alerts/channels` routes keep working on the new store until the Map
switches to the new routes (PR 4), so main never has a broken alerts UI. They are removed in that PR. Adapter rules
(PR 1a):

- A 2.8 credential id is the id of its first Connection (the one that kept the credential's id, or the first with
  `origin = legacy:<id>`). Credentials made through the 2.8 routes after the upgrade create one Connection with
  that origin.
- Creating or editing a 2.8 channel with a chat ID or recipients that no Connection of that origin has creates a new
  Connection with the same sealed secret copied as is (never opened), the new destination and the same `origin`.
- Replacing a 2.8 credential's secret, or its name, updates every Connection with the same `origin`. Deleting it
  deletes them all, refused with 409 while any of their nodes exist.
- A 2.8 credential view's `usedBy` combines the nodes of all those Connections; its last test is the newest of them.

## Screens

- **Administration, Connections**: title "Connections", "Logins your alerts use.", "New connection". Table: Name,
  Provider (icon and name), Used by (node names or "Not used"), Last test, Actions (edit, send test, delete). Empty
  state: "No connections yet. A connection holds the login for one provider. Add one, then pick it on an alert node."
  On phones the table becomes cards with the same labels.
- **New or Edit connection dialog**: Provider first (searchable, grouped; Other sits under Advanced), then Name and
  the provider's fields. Cancel, Send test, Save; Test and Save stay disabled with "Add the missing details." Edit
  locks the provider and shows secrets as "Saved, hidden". Other shows the amber "For advanced users" note and the
  exact JSON it sends. WhatsApp shows "How to get these", the Meta note and, under "More options", Template name and
  Language. Email has Subject prefix under "More options". Operators see Other as read-only.
- **Connections settings** (admin only): "Allow private network" and "Operators can manage alerts", each a switch
  that asks for re-verification.
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
- Email relays on private addresses keep working; the 2.8 SMTP address rule is kept as it is.

## Test plan

- **Migration** (`tests/migrations.test.js`, fixture from 2.8.2 and 2.9.0): one credential and one node; one bot
  shared by two chats (two Connections, names); two nodes with the same chat (one Connection); a node without a
  credential (`prefill`); an unused credential; sealed bytes identical after copy; ids kept; lines and outbox copied;
  every outbox row copied with `payload = NULL` and a pending one sent as plain text; `occ:` keys not resent;
  idempotent; compat floor unchanged; deleting a migrated Connection removes its legacy row (with `secure_delete` and a
  WAL checkpoint);
  a split credential; the "older version changes" warning when legacy rows are newer.
- **Previous version still runs**: a CI step checks out the previous release tag in a `git worktree`, points it at a
  database migrated by this branch, and runs that release's alerts store tests and a start-up of api and worker.
- **Per provider** (`tests/alert-providers.test.js`): a local fake HTTPS server records each request. Body shape,
  headers, escaping (`<`, `&`, `@everyone`, Markdown), length cut, link present or absent, every documented error
  status to its sentence, Matrix txn reuse on retry, WhatsApp template and free-form bodies and 131047, Teams 202
  wording, ntfy with and without token, WhatsApp "Accepted" wording and parameter cleaning (newlines, tabs, 5
  spaces), Discord `ptb` and `canary` hosts, Matrix v12 room ids, Telegram `link_preview_options`, Other header
  allowlist. The fake server stands in by host override in tests only.
- **SSRF** (`tests/alert-outbound.test.js`): each refused range as literal and via DNS; IPv4-mapped, NAT64, 6to4,
  decimal and octal forms; a name that resolves to public then private (rebinding) never connects to the second; mixed
  answers refused; redirects refused; timeout; oversized response; HTTP refused unless private and allowed; metadata
  refused even with the setting on; every "always refused" entry and metadata name; IP literals checked without
  `lookup`; `all: true` lookups; proxy variables ignored; port 443 only for public hosts; operator Connections and
  operator unsaved tests never reach private addresses and fail with the one sentence at exactly 10 seconds, for a
  refusal and for a timeout alike; `private_ok` drops when an operator changes a host and stays when an operator
  renames or changes recipients; a migrated private SMTP relay keeps working; zone ids refused.
- **Secrets**: no secret, URL or response text in logs, audit rows, outbox, `last_error`, API errors or views (scan
  every captured string for the planted values); PATCH without secrets keeps them; changing a `host` field without
  the secret is refused; a destination change without re-verification is refused and audited by field name.
- **Permissions** (`tests/alert-permissions.test.js`): setting off, an operator gets 403 on every alert and Connection
  route and no alert data in Map payloads; setting on, an operator can list, create, edit, test and delete nodes and
  Connections, with re-verification where an admin needs it; Other create, edit and delete, "Allow private network"
  and the setting itself stay 403 for operators; only an admin can toggle the setting, with re-verification and an
  audit event; turning it off applies on the next request; audit rows carry the actor's role.
- **Delivery**: dedup across two nodes on one Connection; rate limit defers; cap and collapse into "N more alerts";
  24-hour maximum age; 401 and gone webhooks final; 429 with `Retry-After` seconds and date, Discord and Telegram
  bodies; deleting a node keeps its outbox rows (`SET NULL`), deleting a Connection removes them; `last_send` and
  `last_test` updates.
- **Browser** (from the mockup boards): node panel with provider and Connection combos, New connection from the
  panel, Sends when defaults; grid delete by key and corner icon, confirm only with sources; Connections list, empty
  state, failure panel; dialog for WhatsApp, Discord, ntfy, Other and Edit ("Saved, hidden", pencil replace); phone
  width 390 px, light and dark, keyboard only.
- No real provider accounts in CI. A manual check with real Telegram, Discord and ntfy.sh before release.

## Implementation PRs

1. **1a, migration and store** (security-critical review): migration and copy, Connections and nodes store, sealed
   storage and views, registry with Telegram and Email, dedup, cap, maximum age. The 2.8 routes and UI keep working
   on the new store, with no behaviour change. Migration, previous-version, secret and adapter tests (a 2.8 credential
   with two chats through the old routes: ids, new Connection on a new chat, secret copied byte for byte, replace
   updates all, `usedBy` combined, delete refused while used).
2. **1b, outbound client** (security-critical review): `outbound.js`, SSRF and rebinding guard, port and proxy rules,
   the private-network setting and `private_ok`, Retry-After parsing. SSRF tests.
3. **Providers**: WhatsApp, Discord, Slack, Teams, Google Chat, Mattermost, ntfy, Gotify, Pushover, Matrix, Other,
   the message template with reasons and the job deep link. Fake-server tests.
4. **API, Connections page and Map**: new routes, the operator gate and setting, re-verification, audit events,
   Connections list and dialog, node panel, grid delete, phone list; the Map switches to the new routes and the 2.8
   routes go in the same PR. API, permission and browser tests, design review. Docs: rewrite `alerts.md`, update
   `security.md` (operator opt-in, its risk, the SMTP loopback wording), `upgrading.md`, README, release note.

## Notes from PR 1a

What PR 1a settled where this document left room, or chose a narrower step:

- The migration is number 10, `alert-connections`. Besides the tables above it adds the `connections_origin` and
  `alert_nodes_connection` indexes and a one-row table `alert_legacy_import (imported_at)`: it marks the copy as done
  (a repeated start copies nothing twice) and is the migration time the "older version changes" warning compares with.
- `alert_outbox.payload` has a 4 KB `CHECK` like the other text columns.
- Queue rows of a 2.8 node with no matching credential are not copied: `connection_id` is required and such a node
  could never send them.
- The newest 2.8 node result of a group becomes its Connection's `last_send`, so the Map caption stays as it was.
- Until the Map moves to the new routes (PR 4), a node test through the 2.8 route records `last_send` (what the node
  caption shows), and a credential check records `last_test`, exactly as the 2.8 fields behaved.
- Adapter: a node whose new chat or recipients no Connection of its credential has takes its own Connection in place
  when no other node uses it, else an unused one of that credential, else a new copy. So a credential holds at most one
  Connection more than it has destinations.
- Every write to a `connections` row runs with `secure_delete` on, not only deletes: SQLite rewrites the whole row
  on any update, so the old sealed value would otherwise stay in free page space.
- Delivery: dedup per Connection, the 50-item cap with "N more alerts", the 24-hour maximum age and final failures
  (a rejected bot token) are in. The per-Connection rate limit and `Retry-After` come with the outbound client (1b).
  Telegram keeps the 2.8 request shape (`disable_web_page_preview`) until the message template (PR 3).
- Nothing is sent through a Connection that no node uses any more; its pending items are marked failed.
- A Connection whose destination changes (a new chat, new recipients) loses its finished dedup history, so a real
  alert to the new destination is never suppressed. Pending items stay and go to the new destination.
- An event folded into "N more alerts" still leaves a dedup entry (status `sent`, payload `{ foldedInto }`, never
  delivered on its own), so a repeat inside its window is not counted again.

## Notes from PR 1b

What PR 1b settled where this document left room, or chose a narrower step:

- No migration. "Allow private network" is the `settings` row `alerts_private_network` (`'true'` or `'false'`); a
  missing row is off, so every upgraded install starts with it off. It is read at every send, so turning it off stops
  private sends with the next request. `setAllowPrivateNetwork` refuses anyone but an administrator and writes
  `alerts.private_network {enabled, role}`; its route (`PUT /api/connections/settings`) and the re-verification come
  with PR 4.
- `private_ok` is stamped by one function, `privateOkFor` (connections.js), with the rule from "Data model". The 2.8
  routes are administrators only, so they stamp as an administrator: Email gets 1 (as before), Telegram 0. Changing the
  mail server or port re-stamps; renames and token changes keep the saved value.
- The address lists live in `src/alerts/addresses.js`, not shared with `src/probe-url.js`: probe URLs follow a
  different rule (loopback probes are allowed there, and the helper on the source server decides). Beyond the list in
  "Outbound safety" it also refuses `192.88.99.0/24` (6to4 relay), `168.63.129.16` (Azure host endpoint), Teredo
  `2001::/32`, ORCHID, the `3fff::/20` documentation range, all of `64:ff9b::/32` except the well-known NAT64
  `/96` (which is judged by the IPv4 it carries, as are IPv4-mapped, IPv4-translated and 6to4 forms), and every IPv6
  address outside global unicast `2000::/3` and ULA `fc00::/7` (so link-local, site-local, multicast, discard and
  IPv4-compatible forms).
- A name whose answers mix public and private addresses is refused even with the setting on: it is neither a public
  nor a private host.
- Pinning: `outbound.js` resolves the name once (with the 10 second limit running), checks every answer, and gives
  the socket a `lookup` that answers only those checked addresses (honouring `all: true` and `family`), so Node never
  resolves the name itself. HTTP and ports other than 443 are refused before DNS unless private addresses are allowed,
  and after DNS unless every answer is private.
- `Retry-After` is clamped to 1 second .. 15 minutes; a 429 with no readable wait waits 60 seconds. A 429 uses up no
  try and moves every pending item of that Connection to the same time. `last_send` records the attempt as failed. A
  provider that answers 429 forever is tried once per wait until the 24-hour maximum age fails the item.
- The rate limit counts delivered messages (`status = 'sent'` with at least one attempt, so folded dedup entries do
  not count) by `finished_at`. Over the limit, the Connection's pending items move to the end of the window, with no
  try used. Other Connections are not held back.
- Fold race: an item is marked sent only while its `message` and `payload` are what was sent. When "N more alerts"
  grew during the send, the part that was sent is done and the rest stays pending as a smaller count.
- Final failures added: Telegram 403 (bot blocked, removed or never started) and an SMTP sign-in rejection (534, 535,
  or no supported sign-in method). Telegram 400 and 5xx still retry.
- Email: a relay with `private_ok = 1` keeps the 2.8 address rule word for word. With `private_ok = 0` (a host set by
  an operator, from PR 4) the address must be public by the outbound policy above. `docs/security.md` now says that
  loopback is refused (the "SMTP loopback wording" item from PR 4 is done here).
- "One request at a time per Connection" holds inside the worker (deliveries are sent one after another). A test sent
  from the API process can overlap with a worker send; that is not locked across processes.
- Test seams, like `smtpIo`: `outboundIo.resolve`, `outboundIo.dial` (points a checked address and port at a local fake
  server) and `outboundIo.ca`. No setting or API reaches them.

## Owner answers (2026-10-27)

1. WhatsApp: yes, Template name and Language under "More options", with the 24-hour help text. After the security
   review the template is the default (pre-filled `docknest_alert`) and free-form text is the fallback.
2. Email: yes, keep the optional Subject prefix field (under "More options") so 2.8 setups stay identical.
3. Operators: yes, behind the admin setting "Operators can manage alerts", off by default (see "Who may do what").

## Roles used

From [agency-agents](https://github.com/msitarzewski/agency-agents):
[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for the data model, migration, registry and PR split, and
[Security Engineer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-security-engineer.md)
for sealed storage, redaction, SSRF and rebinding protection, and abuse limits.
