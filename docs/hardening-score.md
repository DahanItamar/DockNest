# Hardening score

Each Docker site gets a security grade from A to F, based on how its containers are configured. Every finding comes with a one-line fix you can apply in your Compose file.

DockNest only reads. It never changes a container, a Compose file or a server setting to improve the grade.

## When the grade updates

The grade is refreshed by work DockNest already does, with no extra connection or timer:

- a server scan (discovery, for example when you add or edit a site), and
- every backup of the site.

Until one of these runs after the update, the site has no grade (`grade: null`). A static website has no containers and never gets a grade.

## Checks

| Check | Severity | Fix |
| --- | --- | --- |
| Privileged mode | high | Remove `privileged: true` and add only the capabilities it needs. |
| Docker socket mounted | high | Remove the `docker.sock` mount or use a read-only socket proxy. |
| Extra capabilities | high for `ALL`, `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`, `SYS_RAWIO`, `DAC_READ_SEARCH`, `BPF`, `PERFMON`, `SYS_BOOT`; medium otherwise | Remove `cap_add` entries the service does not strictly need. |
| Runs as root | medium | Set `user:` to a non-root UID in the Compose file. |
| Ports open on all interfaces | medium | Bind ports to `127.0.0.1` and publish through your reverse proxy. |
| Privilege escalation allowed | low | Add `security_opt: no-new-privileges:true` to the service. |
| No memory limit | low | Set `mem_limit` so one service cannot exhaust server memory. |
| Unpinned image tag | low | Pin the image to a version tag or digest, not latest. |
| No healthcheck | low | Add a healthcheck so failures are detected and reported. |

Details:

- **Extra capabilities** counts only capabilities beyond Docker's default set (the same set restore uses), so adding `CHOWN` or `SETUID` is not a finding.
- **Runs as root** passes when the Docker engine runs rootless or with user namespaces, because root in the container is then not root on the server.
- **Ports open on all interfaces** covers ports published on `0.0.0.0` or `::` (or with no address), and containers on the host network. Ports bound to `127.0.0.1` pass.
- **Unpinned image tag** flags `:latest` and images with no tag. A version tag or a `@sha256:` digest passes.
- A healthcheck defined in the image counts.

## Grading

Each check counts once per site. On a site with several containers, each check reports the worst container by name.

| Grade | Rule |
| --- | --- |
| F | Privileged mode or the Docker socket in any container. |
| D | Any other high finding, or two or more medium findings. |
| C | One medium finding. |
| B | No medium finding, two or more low findings. |
| A | At most one low finding. |

## API

The site objects in `GET /api/state` carry a `hardening` field, readable by every role like the other site fields:

```json
"hardening": {
  "grade": "C",
  "checkedAt": "2026-11-02T08:00:00.000Z",
  "passed": 7,
  "total": 9,
  "findings": [
    { "id": "root-user", "severity": "medium", "title": "Runs as root", "fix": "Set user: to a non-root UID in the Compose file.", "container": "app" }
  ]
}
```

A site that was never scanned returns `grade: null`, `checkedAt: null`, `passed: 0`, `total: 0` and no findings.

## What is stored

For each container DockNest stores only the facts it grades: yes/no flags, published port bindings, the image reference and the names of extra capabilities. It never stores environment values, labels, commands or mount paths. A scan from a helper that cannot report these facts keeps the previous grade.
