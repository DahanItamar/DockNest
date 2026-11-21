# Domains

DockNest follows each domain of your apps along one path and tells you which step is broken:

```text
domain -> DNS -> proxy -> app -> certificate
```

Each step (a hop) is **ok**, **warn**, **fail** or **unknown** (not checked yet, or skipped because the step before it
failed). A hop that is not ok has one reason and, where one exists, a next step. DockNest only reads: it never changes
a route, a DNS record or a certificate here.

## When a check runs

DockNest never checks domains on a timer. A check runs:

- when you press **Check again** (or **Check now** for a domain never checked);
- after an operation that already contacts the server: a discovery scan, a readiness check or a backup. The helper
  adds the proxy routes to its answer, and DockNest then looks the domains up in public DNS, at most once per domain
  per hour;
- before a Move preview, for every domain of the app.

Every result keeps the time it was checked and what started it (`manual`, `discover`, `readiness`, `backup` or `move`).
Old results are shown with their time and are not refreshed in the background.

## Where the facts come from

| Hop | Facts |
|---|---|
| DNS | Two public resolvers (1.1.1.1 and 8.8.8.8, the same ones Move uses). With a saved Cloudflare token, the record itself for a domain behind Cloudflare's proxy. |
| Proxy | The routes the helper reads on the server (below). |
| App | The state and Docker health of the app's containers. |
| Certificate | The certbot certificates on the server and the certificate a probe of the site saw, with certbot's latest renewal outcome. |

### Proxies DockNest reads

| Proxy | Where | Notes |
|---|---|---|
| nginx | `/etc/nginx/sites-enabled` and `/etc/nginx/conf.d`: `server_name`, `listen`, `proxy_pass` (and `upstream` blocks), `ssl_certificate` names | files over 1 MB are skipped |
| Nginx Proxy Manager | the nginx files it writes under its `/data` folder (`nginx/proxy_host/*.conf`), read the same way | never its database or its logins |
| Caddy | the admin API at `http://127.0.0.1:2019/config/` (loopback only, GET only, 1 MB limit); when it is off, the `Caddyfile` mounted into the Caddy container | site addresses and `reverse_proxy` targets only |
| Traefik | Docker labels `traefik.http.routers.*.rule` and `traefik.tcp.routers.*.rule` made of `Host()` or `HostSNI()` only, plus `...services.*.loadbalancer.server.port` | a rule with any other matcher is shown as "route not understood" and makes the list partial; it is never guessed |

A route reaches an app when its target is a port the app's container publishes (on loopback, on all interfaces, or on
an address of the server), or the container's Docker network name and port (`http://shop-web:8080`). A route on one
server can also reach an app on another connected server through that server's address and a published port. When a
container cannot be read, the proxy hop is at best amber ("this list may be incomplete"). When a rule is not understood,
a domain with no route found is amber rather than red, because that rule may be the one serving it.

## Reasons

| Hop | Code | Meaning |
|---|---|---|
| DNS | `points-to-server` | ok: every answer is an address of one of your servers |
| DNS | `no-record` | no A or AAAA answer from either resolver |
| DNS | `wrong-record` | an answer (`address`) is not an address of any connected server |
| DNS | `cloudflare-proxied` | behind Cloudflare's proxy and DockNest has no token for the zone, so it cannot see the origin |
| DNS | `cloudflare-origin` | ok: behind Cloudflare's proxy and the record in Cloudflare points to one of your servers |
| DNS | `cloudflare-token-expired` / `cloudflare-token-limited` | the saved token is not active, or lacks `Zone.DNS:Read` (`missing`) |
| DNS | `cgnat` | amber: DNS names none of your servers, and the server holding the route has only private or `100.64.0.0/10` addresses. It may sit behind CGNAT or a home router; Tailscale uses the same range, so this is never red |
| DNS | `not-checked` / `dns-unreachable` | unknown: never looked up, or no resolver answered |
| Proxy | `routed` / `static` | ok: a route sends the domain to this app (or nginx serves the static site) |
| Proxy | `no-route` | no proxy on the server has the domain |
| Proxy | `routes-elsewhere` | the route's target (`upstream`) is not a container of this app |
| Proxy | `proxy-stopped` | the proxy holding the route is not running |
| Proxy | `no-app` | amber: the route goes to something that is not one of your apps |
| Proxy | `route-unknown` / `incomplete` | amber: the route list may be incomplete |
| App | `running` / `static` | ok |
| App | `stopped` / `unhealthy` / `missing` / `starting` | a container (`container`) of the app is not running, unhealthy, gone or still starting |
| Certificate | `valid` | ok |
| Certificate | `expired` / `expires-soon` / `not-covered` / `no-certificate` | from the certificate facts and the same wildcard rule as certificate alerts |
| Certificate | `renewal-port80` | renewal failed with "connection refused" or "timeout" and nothing listens on port 80 |
| Certificate | `renewal-dns` / `renewal-rate-limited` / `renewal-failed` | renewal failed with a DNS problem, a rate limit or another error (`category`) |
| Certificate | `managed-by-proxy` / `not-readable` | unknown: Caddy, Traefik and Nginx Proxy Manager keep their own certificates, or the configured file is not a certbot certificate |

DockNest does not test whether the internet can reach your server: it has no outside prober. Port 80 reasons come only
from certbot's log category and from what listens on the server, and say so.

Domains whose DNS reaches none of your servers are grouped as **Points nowhere**.

## On the Map and the app pages

The Map has a Domains column left of the servers: one node per domain, placed by the server its DNS answers with, and a line to that server coloured by the domain's worst step (dashed when never checked). Domains whose DNS reaches none of your servers sit under **Points nowhere** with a red stub; domains never looked up and without a server sit under **Not placed yet**. A **Domains** button on the canvas hides or shows the column (kept in this browser). Opening a node shows its five steps (domain, DNS, proxy, app, certificate), each with its state, one reason and a next step, the time of the last check, and **Check again** (**Check now** when never checked). While a check runs every step says Checking; if it fails the last results stay with their time. An app's panel lists its domains, one row each, and on a phone the Map lists them under each app. Domain nodes can be moved like others by administrators; nodes never connect to anything but their server. Viewers see no domains.

## Moving an app

A Move preview lists every domain that stops working until DNS points to the new server: the app's own domains and the
ones the old server's proxy routes to it. A domain another server's proxy sends to the app is a separate warning,
because the move does not change that proxy. Both are warnings; neither blocks the move. With Cloudflare switching,
the domain DockNest switches for you is left out of the list.

## API

- `GET /api/domains` (operators and administrators): every stored check with its hops, the apps' domains never checked
  (hops `null`), and the groups `servers` (by the server DNS answers with), `pointsNowhere` and `unplaced`.
- `POST /api/domains/check` with `{ "domain": "shop.example.com" }` or `{ "siteId": "..." }` (operators and
  administrators, 20 per 10 minutes per person): `202 { jobId }` when the domain belongs to an app (the helper part runs
  through the job queue and waits for other work on that server), or `200 { domain }` for a domain only an earlier check
  knows (DNS only). Domain checks are not listed among site jobs.

## Privacy and security

- The helper sends only hosts, ports, upstream addresses (scheme, host and port) and certificate file names, never a
  configuration file, a login, a header value or a path. Labels are parsed as text, never evaluated.
- Domain lookups go to 1.1.1.1 and 8.8.8.8, the same disclosure as Move. There is no other new outbound request.
- The Cloudflare token is opened in memory for the call only; a check keeps only `active` or `expired` and the names of
  missing scopes.
- Domain names are checked against the certificate module's name pattern before they are stored. Each stored path is
  at most 8 KB.
