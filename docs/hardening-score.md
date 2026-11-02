# Hardening score

Each Docker site gets a security grade from A to F, based on how its containers are configured. Every finding comes with a one-line fix you can apply in your Compose file.

DockNest only reads. It never changes a container, a Compose file or a server setting to improve the grade.

## When the grade updates

The grade is refreshed by work DockNest already does, with no extra connection or timer:

- a server scan run by an administrator (discovery, for example when you add or edit a site), and
- every backup of the site.

Scans run by operators and viewers only read; they never change the stored grade.

Until one of these runs after the update, the site has no grade (`grade: null`). A static website has no containers and never gets a grade. A scan updates a site only when it finds every container of that site; otherwise the previous grade stays. A site with more than 30 containers (more than a site can hold) gets no grade.

## Checks

| Check | Severity | Fix |
| --- | --- | --- |
| Privileged mode | high | Remove `privileged: true` and add only the capabilities it needs. |
| Docker socket mounted | high | Remove the `docker.sock` mount or use a read-only socket proxy. |
| Extra capabilities | high for `ALL`, `SYS_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`, `SYS_RAWIO`, `DAC_READ_SEARCH`, `BPF`, `PERFMON`, `SYS_BOOT`; medium otherwise | Remove `cap_add` entries the service does not strictly need. |
| Runs as root | medium | Set `user:` to a non-root UID in the Compose file. |
| Ports open to the network | high for database ports, low for only 80/443, medium otherwise | Bind ports to `127.0.0.1` and publish through your reverse proxy. |
| Privilege escalation allowed | low | Add `security_opt: no-new-privileges:true` to the service. |
| No memory limit | low | Set `mem_limit` so one service cannot exhaust server memory. |
| Unpinned image tag | low | Pin the image to a version tag or digest, not latest. |
| No healthcheck | low | Add a healthcheck so failures are detected and reported. |

Details:

- **Extra capabilities** counts only capabilities beyond Docker's default set (the same set restore uses), so adding `CHOWN` or `SETUID` is not a finding.
- **Runs as root** passes when the Docker engine runs rootless or with user namespaces, because root in the container is then not root on the server.
- **Docker socket mounted** covers a bind of any `docker.sock` or `podman.sock`, a bind of `/`, `/var`, `/run`, `/var/run` or anything under `/run/user/` (folders that hold the socket), and any mount onto `/var/run/docker.sock`.
- **Runs as root** with user namespace remapping still counts a container started with `userns_mode: host`, because it runs as real root.
- **Ports open to the network** covers every published port not bound to a loopback address: `0.0.0.0`, `::`, no address, or a specific LAN or public address. Containers on the host network and containers with "publish all ports" (`-P`) are medium. Database ports (3306, 5432, 6379, 27017, 1433, as the container port or the host port) are high. When the only reachable host ports are 80 and 443, the finding is low, because a public web server needs them. Ports bound to `127.0.0.1` pass.
- **Privilege escalation allowed** looks at the container's own `security_opt`. If you set `no-new-privileges` for the whole Docker daemon (`daemon.json`), DockNest cannot see it yet and still reports this check.
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
