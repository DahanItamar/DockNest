# DockNest

**Docker Backup & Restore**

DockNest is a self-hosted dashboard for Docker site backups, with a shared system password + a personal authenticator TOTP code for each authorized person. Product requirements are preserved in [the original spec](docs/docker-backup-spec.md). This first implementation requires the Linux integration checks in [acceptance.md](docs/acceptance.md) before it can be trusted for production recovery.

## Run locally

Current checkout: `./docknest`. Product, package, image, and Compose project names are DockNest. Generic source folders and imports remain unchanged. Private repository: [repository-owner/docknest](https://github.com/repository-owner/docknest).

Install Node.js 24 or newer, then run from this directory:

On Windows PowerShell, use `npm.cmd` in place of `npm` if the execution policy blocks npm?s PowerShell wrapper.

```sh
npm install
npm run setup
npm run build
npm start
```

Start the separate scheduler/worker in another terminal:

```sh
npm run worker
```

On Windows, set your chosen main password locally:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\set-admin-password.ps1
```

The command prompts privately for the password twice. Choose 4-16 characters; a four-digit password is accepted. On first setup, it opens a local administrator QR page. Scan it with your authenticator, save the recovery codes, and enter the six-digit code in PowerShell. The temporary QR file is deleted after confirmation. If setup is interrupted, rerun the command. For an existing enrolled administrator, this command changes only the shared password and preserves the authenticator; it signs out everyone and invalidates pending invitations.

Open http://127.0.0.1:3000. Login has exactly two fields: Password and 2FA code, submitted together. The code identifies your named account; an unused recovery code also works. Keep the PC and phone clocks correct.

Administrators use Access management to create named operator invitations. Each QR enrollment link expires after 15 minutes and can be redeemed once; enrolled accounts remain valid until revoked. The invited person enters the shared password, scans the authenticator QR, and confirms a code. The app does not send invitations by email automatically. Revoking a person immediately ends their sessions. Rotating the shared password signs everyone out and invalidates pending invitations.

Sessions expire after 30 minutes without user interaction and after eight hours overall. Background polling does not keep you signed in. Sensitive access changes require recent verification with the administrator’s own factor. See [security.md](docs/security.md) for the exact behavior.

Setup creates `.env`, `data/master.key`, and `data/setup.token` without overwriting existing files. Secrets and runtime data are ignored by Git. Keep a separate secure copy of the master key: losing it prevents decryption of saved credentials and backup payloads.

## Docker and HTTPS

Follow [deployment.md](docs/deployment.md) for Compose, HTTPS, remote prerequisites, updates, and disaster recovery. The central services do not mount the Docker socket. Docker operations run over SSH on your Linux source/target servers.

Use **Add server** for the guided Ubuntu/Linux setup: select an existing SSH key file or generate a dedicated backup key, run the supplied command in your server console, paste its public-fingerprint report, then test and save. See [server connection steps](docs/server-connection.md). Scan containers, review the entire site and mounted data, then configure capture and maintenance integration before scheduling. Daily policies use the site's configured timezone. Retention applies to successful backups; failed attempts must not consume the retained successful history.

Use **Full ZIP** to download a decrypted, browsable copy of your site files, uploads, physical database data and deployment configuration, with exact Docker images and original Linux recovery archives included. Read `START-HERE.txt` in the ZIP. Keep it private because it contains credentials. **Encrypted backup** downloads the original `.enc` for DockNest recovery. Preparing a ZIP authenticates the whole backup first and needs temporary disk space; temporary plaintext is deleted after completion/cancellation and after an interrupted API restart. Database files need the matching database image; this is not a SQL dump. Explicitly reviewed temporary RAM folders are recreated empty on restore.

Download and Restore are separate operations. New-copy restore supports compatible, unprivileged containers and fresh data paths. Single containers use network none; grouped services on Docker 28+ use fresh internal networks with isolated gateway mode, preserved service aliases and no published ports or external DNS forwarding. Copies have separate project identities and preserve originally stopped services. Static IPs, shared container network namespaces, overlapping mount paths and custom mappings require reviewed offline adapters. Replacement remains blocked until a safety-backup and rollback workflow is validated. External buckets, generic proxy installation and online database backup are extensions. See [verification evidence](docs/acceptance.md) for tested behavior and limits.

## Verification and provenance

```sh
npm run check
```

CI runs the build, automated tests, and Docker image build. These checks do not prove a real site can be recovered. See [the acceptance checklist](docs/acceptance.md).

The project uses selected role guidance from [agency-agents](https://github.com/msitarzewski/agency-agents), including [DevOps Automator](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-devops-automator.md) for reproducible deployment, secret separation, and recovery planning. These role documents are reference material.
