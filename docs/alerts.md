# Alerts (2.8.0)

DockNest can tell you when something needs you, in Telegram or by email. Nothing is sent until you add a channel and
connect it to something with a line on the Map. There are no webhooks and no third-party services other than the
two channels below.

## Credentials and nodes

Secrets and destinations are kept apart, as in n8n.

- A **credential** holds the secret and is entered once: a Telegram bot token, or an SMTP account (server, port, `starttls` or `tls`, user name and password, from address). It is sealed, never shown again, and creating, replacing or deleting one needs a recent re-verification.
- A **node** (a channel on the Map) holds only what is not secret and points at a credential: a Telegram chat ID, or up to 5 email recipients and an optional subject prefix. One credential can serve many nodes, for example one bot for several chats. A node without a matching credential shows "Needs a credential" and sends nothing.
- A credential that nodes use cannot be deleted (the answer is 409 `CREDENTIAL_IN_USE` with the node names).

| Kind | Credential | Node | Where DockNest connects |
| --- | --- | --- | --- |
| Telegram | Bot token (from BotFather) | Chat ID | `https://api.telegram.org` only |
| Email | SMTP account | Recipients, subject prefix | The SMTP server in the credential, nothing else |

Email is always encrypted. `tls` connects with TLS from the first byte (usually port 465). `starttls` (usually port 587)
asks the server to switch to TLS before anything secret is sent and stops if the server does not offer it. The server
certificate must be valid for the name you entered. There is no unencrypted option.

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

The disk figures are the ones DockNest already collects when it tests or inspects a server; alerts never run a new
command on your servers. The reachability check is a plain TCP connection to the SSH port already configured for the
server, with no login. Backups that a move takes as part of the move are reported by the move events, not as backups.

## Lines (rules)

A rule connects a source to a channel and lists the events it wants:

- `docknest` (no source id): everything that happens in this installation, plus new DockNest releases.
- `server`: that server's own events (unreachable, low disk) and the events of every site on it (backups, and moves to or from it).
- `site`: only that site's events.

There is one rule per source and channel. A message goes to a channel at most once per event even when several rules
match.

## Messages

Short plain text with only the names you typed (site, server) and a time with its zone (the site schedule time zone, else the self-backup schedule zone, else UTC), for example:
`Backup failed: shop.example.com on mobiX-Srv at 03:00 UTC. Open DockNest to see why.`
No addresses, paths, logs or error details are ever included.

## Delivery

The worker detects events by reading the existing job, move, server and update tables (it changes none of them), puts one
message per channel in a queue and sends it. A failed send is retried after 1 minute and then after 5 minutes (3 tries
in all); after that it is marked failed and kept for 7 days. The channel shows the last result. History is never
replayed: the first time the worker runs, it starts from "now".

## API (administrators only)

All routes are under `/api/alerts`, need a signed-in administrator and the usual CSRF header. Creating, changing or
deleting a **credential** also needs a recent re-verification (the same as the Cloudflare token). Nodes and rules hold no
secret and need an administrator only.

| Method and path | Purpose |
| --- | --- |
| `GET /` | `{ credentials, channels, rules, events, sourceKinds, diskLow, limits }` |
| `GET /credentials`, `POST /credentials` | `{ kind: "telegram", name, config: { token } }` or `{ kind: "smtp", name, config: { host, port, security, username?, password?, from } }` |
| `PATCH /credentials/:id` | `{ name?, config? }`; secrets left out keep their saved value. Changing the mail server, port or encryption needs the password again |
| `DELETE /credentials/:id` | 409 `CREDENTIAL_IN_USE` (with `nodes`) while nodes use it |
| `POST /credentials/:id/test` | Checks the login without sending a message: Telegram `getMe`, or SMTP connect, encrypt and sign in |
| `GET /channels`, `POST /channels` | `{ kind: "telegram", name, credentialId, config: { chatId } }` or `{ kind: "email", name, credentialId, config: { to: [..], subjectPrefix? } }`; the credential must match the kind |
| `PATCH /channels/:id` | `{ name?, credentialId?, config? }` |
| `DELETE /channels/:id` | Removes the node and its lines |
| `POST /channels/:id/test` | Sends "This is a test message from DockNest. Your alerts are connected." through the node (10 per 10 minutes) |
| `GET /rules`, `POST /rules` | `{ channelId, sourceKind, sourceId \| null, events: [..], enabled? }` |
| `PATCH /rules/:id`, `DELETE /rules/:id` | `{ events?, enabled? }` |

A credential looks like `{ id, kind, name, config, usedBy: [{id, name}], lastTest, lastTestAt, lastError }`. `config` never
holds a secret: Telegram shows `{ tokenSet }`, SMTP shows `{ host, port, security, username, passwordSet, from }`. A node
looks like `{ id, kind, name, credentialId, credentialName, needsCredential, config, lastResult, lastResultAt, lastError }`.

Limits: 20 credentials, 40 nodes, 200 rules.

## Data

Migration 8 adds `alert_credentials`, `alert_channels`, `alert_rules` and `alert_queue` (additive; nothing existing
changes). A credential's whole configuration is one value sealed with the master key; nodes store plain, non-secret
settings. See `docs/security.md`, "Alerts".

## Map screens

Administrators see alert nodes (Telegram, Email) in a column right of backup storage and a DockNest node top-left. Lines are plain, thin and quiet; hovering or selecting a node or a line lights its whole path. Drag from the single output circle of a server, site or DockNest to an alert node, or use "Send alerts to…" in a details panel (also the phone path). Opening an alert node shows one panel with two tabs: Settings (credential, chat ID or recipients, "Send test message") and Sends when (one block per connected source with its events and Disconnect). Save applies every change at once; Cancel discards them. "+" adds Telegram or Email alerts and lists Credentials: a credential holds the login (bot token, or mail account) and can serve several nodes; its sheet shows "Used by" and a Test button, and deleting one that is in use is refused with the API's sentence. Secrets show "Saved" and Replace, never the value. Operators get no alert data (the API is administrators only), so their Map has no alert parts.
