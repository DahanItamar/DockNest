# ADR: Domains on the Map (3.0.0)

Status: proposed. Index and audit: [3.0.0 design](design-3.0.0.md).

## Context

DockNest already knows most of the path from a domain to an app:

- the domains in nginx `server_name` (`discovery.py:23`), and which loopback upstream matches a container
  (`discovery.py:71`);
- certbot certificates and renewal outcomes (`net.py:247`);
- certificate facts with expiry alerts (`src/alerts/certificates.js`);
- public DNS lookups and Cloudflare proxy detection (`src/moves/dns.js`), and a Cloudflare client (`src/moves/cloudflare.js`);
- an SSRF-safe probe policy (`src/probe-url.js`, `net.py:132,158`).

Nothing joins these into one answer, and the Map says "No DNS data is available" (`web/map/layout.js:24`). The owner
rejected uptime monitoring, so this must not become a timer that polls domains.

## Decision

### One read-only path per domain

`domain -> DNS -> proxy -> app -> certificate`. Each hop has a state: `ok` (green), `warn` (amber), `fail` (red) or
`unknown` (not checked, or skipped because an earlier hop failed). A non-green hop always has one plain reason and, where
one exists, one next step. DockNest never edits a route, a DNS record or a certificate here.

### When it runs: on demand and on events, never on a timer

- "Check again" in the path panel, and "Check now" for a domain never checked.
- Alongside operations that already contact the server. The proxy and certificate facts ride in the helper answers
  of discover, readiness and backup, the way certificate facts do today. DNS is looked up from DockNest after those
  answers arrive, at most once per domain per hour.
- Before a Move preview, for every domain of the app.

Results are stored with `checked_at` and a `trigger` (manual, discover, readiness, backup, move). Old results are
always shown with their time, never refreshed in the background.

### Proxy discovery (helper, read-only, routing metadata only)

| Proxy | Source | Notes |
|---|---|---|
| nginx | existing `nginx_sites()` plus `listen` and `ssl_certificate` names | unchanged limits (1 MB per file) |
| Nginx Proxy Manager | the nginx files NPM generates (`/data/nginx/proxy_host/*.conf` under the NPM container's `/data` mount source), parsed by the same nginx parser | never its database or its credentials |
| Caddy | `GET http://127.0.0.1:2019/config/` from the server (the admin API, loopback only); if it is disabled, Caddyfile site addresses and `reverse_proxy` targets from the Caddy container's mounted config | the JSON is reduced to hosts and upstreams in the helper |
| Traefik | Docker labels `traefik.http.routers.*.rule` with `Host()`/`HostSNI()` only, plus `...services.*.loadbalancer.server.port` | rules with other matchers are shown as "route not understood", which is partial, never guessed |

Upstream matching is shared by all four: a loopback or `0.0.0.0` host port that a container publishes, or a Docker
network name and port (`http://shop-web:8080`). A container that cannot be inspected makes the proxy hop `warn`
("this list may be incomplete"), never `ok`.

### Hop reasons (plain sentences, the evidence that triggers them)

| Hop | Reason | Evidence |
|---|---|---|
| DNS | no record | no A or AAAA from either public resolver |
| DNS | wrong record | the answer is not a known address of any connected server: "points to 192.0.2.99, which is not one of your servers" |
| DNS | behind Cloudflare's proxy | existing `cloudflareProxied`. The state is `ok` when the Cloudflare API shows the record's origin is the server, and `warn` without a token |
| DNS | expired or limited token | Cloudflare token verify answers inactive or expired, or lacks `Zone.DNS:Read` |
| DNS | CGNAT (amber, worded "may") | DNS has no answer for any server, and the server's own interfaces hold only private or `100.64.0.0/10` addresses with no public one. Tailscale also uses 100.64/10, so this is never red |
| Proxy | no route | no adapter has the domain |
| Proxy | routes elsewhere | the route's upstream matches no container of this app |
| App | stopped / unhealthy | container state and health; optional probe through the existing probe policy |
| Certificate | expired / expires soon / no certificate covers the domain | existing facts and `covers()` |
| Certificate | renewal failed: port 80 closed | certbot log category "connection refused" or "timeout", plus a helper fact that nothing listens on port 80, or a firewall fact from the hardening report |
| Certificate | renewal failed: DNS problem / rate limited | certbot log category |

DockNest does not test reachability from the internet. It has no outside prober, and adding one would be an external
service. Port-80 reasons come only from the certbot log and listening facts, and say so.

### Map

- A **Domains** column at the far left: the outermost column, which is the public internet. Domain nodes are grouped
  by the server their DNS answers with, and aligned with that server group.
- The line from domain to server is the DNS hop. The existing line from server to app is the proxy hop.
- A line's colour is the domain's worst hop. Unchecked lines are dashed.
- Domains whose DNS reaches no connected server go to a **Points nowhere** group at the bottom, with a red stub.
- A toolbar toggle shows or hides the column. On a phone, domains are listed under each app.
- This amends the `DESIGN.md` Map rule "only servers, sites and storage are nodes". Domains are nodes, read-only, and
  never draggable onto other nodes. Free-drag positions are saved per domain node (key `domain:<name>`).
- The path panel is a five-row stepper. The app panel's Domains section lists each domain with its worst hop.

### Move

The preview lists every domain that stops working: all of the app's domains, plus domains that other servers' proxies
route to this app. The text is "3 domains stop working until DNS points to Server 2: ...". Today only `domains[0]` is
checked (`preflight.js:175`). The list is a warning and never a block. A domain routed through another server's proxy is
a separate warning, because the move does not change that proxy.

### Data

Table `domain_checks`:

- `domain` (lowercase, at most 253 characters) is the primary key.
- `server_id`, `site_id`: either may be null when the domain points nowhere.
- `hops`: JSON, at most 8 KB, holding states, reason codes and safe parameters (addresses, ports and names only).
- `checked_at`, `trigger`.

Reason text is rendered from codes in the UI, so the wording can improve without a migration. It is a compatible
migration.

### API

- `GET /api/domains` returns domains with their stored hops (operators and administrators).
- `POST /api/domains/check { domain | siteId }`: operators and administrators, rate-limited per user, and it reuses the
  job queue for the helper part.

## Security review notes

- **SSRF:** no new outbound HTTP. App probes use the existing policy. DNS queries go only to the fixed public
  resolvers already used by Move. The Caddy admin call is made by the helper to loopback port 2019 only, with a fixed
  path, GET only and a 1 MB response cap.
- **Secrets:** proxy configs can hold basic-auth hashes or API keys. The helper returns only hosts, ports, upstreams
  and certificate file names, as `nginx_sites()` does. NPM's database and Traefik's dashboard credentials are never read.
- **Cloudflare token:** the token verify call uses the sealed token in memory. Results keep only `active`/`expired`
  and the missing scope names.
- **Injection:** domain names are validated with the certificate module's NAME pattern before storage. Labels from
  Traefik are parsed, never evaluated.
- **Load:** checks are on demand or ride on existing jobs, with an hourly DNS cap per domain, so there is no fan-out
  on large fleets.
- **Privacy:** domain lookups at 1.1.1.1 and 8.8.8.8 are the same disclosure as Move today. The docs say so.

## Tests

- Python: one fixture set per adapter (nginx, NPM confs, Caddy JSON and Caddyfile, Traefik labels with Host,
  HostRegexp and unknown matchers), the upstream matcher, and a secret in a config never appearing in the output.
- JS: the hop reasoner as a table (every reason code from fixed facts), CGNAT versus Tailscale, the Points nowhere
  grouping, and the Move listing.
- Browser: Map column, toggle, path panel states (checking, never, error, partial), phone list.
- Linux integration: nginx and Traefik in Docker on a real host, read-only proof (configs unchanged, by hash, after a
  check).

## Roles used

[Software Architect](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md)
for reusing the existing facts.
[AppSec Engineer](https://github.com/msitarzewski/agency-agents/blob/main/security/security-appsec-engineer.md) for
the SSRF and secret boundaries.
