# Launch a new site from the Map

## What it does

Launch a new site from the **+** beside a server on the Map. This beta feature deploys a Docker Compose site, puts nginx in front of it, and sets up HTTPS when DNS is ready. It also starts backups on the first day and can schedule weekly restore tests.

Only administrators can launch a site. DockNest asks you to confirm your sign-in again before the final launch.

## Requirements

The server needs Docker, Docker Compose 2.24 or later, nginx, certbot and Git 2.37 or later. DockNest must sign in to the server as root, and SSH repositories need the OpenSSH client on the server. During **Check**, DockNest can offer to install a missing supported tool. You can also install the tool yourself and select **Check again**.

You need a domain and a server with enough free disk space for the source, images and the first backup. Choose a test server if you want weekly restore tests. Without one, backups still start, and DockNest tells you how to add a test server later.

## Choose a source

Choose one source and provide the domain, web service and its container port.

- **Compose.** Paste a Compose file. You can also enter environment values. DockNest writes them for the site and never shows them again.
- **Public Git.** Use a public `https` repository, then choose a branch or tag and the Compose file in it.
- **Private Git.** Use a Git repository over SSH. On **Connections**, create a deploy key: enter a name and the Git host, confirm the Git host key's SHA-256 fingerprint, then add the public key DockNest shows to the repository as a read-only deploy key. Re-pin the host key when it changes, or when you first use the key from another server. A self-hosted Git server on a private address needs **Allow private address**. Git LFS and submodules are not supported.

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
| Port 80 or 443 is used by another program | Stop it, then select **Check again**. |
| Existing certificate | Use another domain, or remove the certificate only when it is no longer needed. |

Before **Launch**, confirm that the app saves its data when its containers stop, so backups are consistent. For a Git source, also confirm that you trust the repository: DockNest builds and runs its code on the server.

## DNS and HTTPS

DockNest shows the A record (and the AAAA record when the server has IPv6) to add with your DNS provider. After DNS points at the server, select **Check again** to continue the certificate step.

If a certificate cannot be issued, the site stays available on HTTP. Read the reason, fix the DNS, CAA or certificate problem, then select **Try again**.

DockNest also sets up the maintenance page for the new site. If that step fails, the launch still finishes and the site shows the usual **Set up maintenance page** offer.

## After launch

The first backup runs as the last launch step. DockNest creates a daily backup schedule and, when you selected a test server, a weekly restore-test schedule.

For 24 hours, **Remove launch** is available from the launch. It removes what the launch created and archives the site. Backups are kept. It is not offered after the site was moved or while a job runs on it.

If a step fails before the site is saved, DockNest removes everything that launch created. A failed cleanup is shown as needing attention so you can try again. A certificate failure is different: the saved site stays on HTTP and you can try the certificate step again.

## Security

Git must be version 2.37 or later. DockNest refuses submodules and symlinks that escape the repository. It disables Git hooks, file and extension transports, and bundle URI downloads. It also prevents repository settings from changing how the source is fetched.

Builds use a dedicated BuildKit builder without extra entitlements. The builder itself runs as a privileged container, like Docker's own builder. A BuildKit sandbox escape could therefore reach the server, so treat a build source as trusted code.
