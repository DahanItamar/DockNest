# Launch a new site from the Map

## What it does

Launch a new site from the **+** beside a server on the Map. This beta feature deploys a Docker Compose site, puts nginx in front of it, and sets up HTTPS when DNS is ready. It also starts backups on the first day and can schedule weekly restore tests.

Only administrators can launch a site. DockNest asks you to confirm your sign-in again before the final launch.

## Requirements

The server needs Docker, Docker Compose 2.24 or later, nginx, certbot and Git 2.37 or later. During **Check**, DockNest can offer to install a missing supported tool. You can also install the tool yourself and select **Check again**.

You need a domain and a server with enough free disk space for the source, images and the first backup. Choose a test server if you want weekly restore tests. Without one, backups still start, and DockNest tells you how to add a test server later.

## Choose a source

Choose one source and provide the domain, web service and its container port.

- **Compose.** Paste a Compose file. You can also enter environment values. DockNest writes them for the site and never shows them again.
- **Public Git.** Use a public `https` repository, then choose a branch or tag and the Compose file in it.
- **Private Git.** Use a Git repository over SSH. On **Connections**, create a deploy key for the Git host. Add its public key to the repository as a read-only deploy key. Confirm the Git host key's SHA-256 fingerprint when you create the key. If the host key changes, re-pin it before launching.

## Check before launching

Select **Check** before **Launch**. It checks the server tools and free space, the source, the Compose configuration, the requested domain, nginx and the required ports. It also finds services and ports so you can select the web service.

Common refusals and fixes:

| Check result | Fix |
| --- | --- |
| Privileged service, host network or Docker socket | Remove that setting. Launches run unprivileged and cannot use host networking or the Docker socket. |
| Host mount | Use a named volume, or keep the mount inside the new site's folder. |
| Build setting is not allowed | Remove unsupported build settings. Builds may use only a local context and Dockerfile, arguments, target, labels and platforms. |
| Name collision | Change the Compose project, container, volume or network name so it does not use an existing name. |
| Domain is already served by nginx | Choose another domain or remove the existing nginx site first. |
| Existing certificate | Use another domain, or remove the certificate only when it is no longer needed. |
| Port 443 is in use | Stop the service using the port or choose a server where nginx can use it. |

If the source contains a build, DockNest warns that it will build and run code from that repository on the server. Launch only code you trust.

## DNS and HTTPS

DockNest can add an A or AAAA record when you have connected Cloudflare. Otherwise it shows the record to add with your DNS provider. After DNS points at the server, select **Check again** to continue the certificate step.

If a certificate cannot be issued, the site stays available on HTTP. Read the reason, fix the DNS, CAA or certificate problem, then select **Try again**.

DockNest also sets up the maintenance page for the new site. If that step fails, the launch still finishes and the site shows the usual **Set up maintenance page** offer.

## After launch

The first backup runs as the last launch step. DockNest creates a daily backup schedule and, when you selected a test server, a weekly restore-test schedule.

For 24 hours, **Remove launch** is available from the launch. It removes what the launch created and archives the site. The first backup is kept.

If a step fails before the site is saved, DockNest removes everything that launch created. A failed cleanup is shown as needing attention so you can try again. A certificate failure is different: the saved site stays on HTTP and you can try the certificate step again.

## Security

Git must be version 2.37 or later. DockNest refuses submodules and symlinks that escape the repository. It disables Git hooks, file and extension transports, and bundle URI downloads. It also prevents repository settings from changing how the source is fetched.

Builds use a dedicated BuildKit builder without extra entitlements. The builder itself runs as a privileged container, like Docker's own builder. A BuildKit sandbox escape could therefore reach the server, so treat a build source as trusted code.
