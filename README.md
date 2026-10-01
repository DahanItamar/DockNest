# Docker Backup Manager

A central web dashboard for Docker site backups, with a shared system password + a personal authenticator TOTP code for each authorized person. Product requirements are preserved in [the original spec](docs/docker-backup-spec.md). This first implementation requires the Linux integration checks in [acceptance.md](docs/acceptance.md) before it can be trusted for production recovery.

## Run locally

Install Node.js 24 or newer, then run from this directory:

On Windows PowerShell, use `npm.cmd` in place of `npm` if the execution policy blocks npm's PowerShell wrapper.

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

Open http://127.0.0.1:3000. Read the one-time setup token from `data/setup.token`, create your admin account, enroll an authenticator, and save the recovery codes privately. Later logins require the shared system password and your personal six-digit authenticator code (or an unused recovery code); the code identifies your named account. Keep the PC and phone clocks correct.

Administrators use Access management to create named operator invitations. Each QR enrollment link expires after 15 minutes and can be redeemed once; enrolled accounts remain valid until revoked. The invited person enters the shared password, scans the authenticator QR, and confirms a code. The app does not send invitations by email automatically. Revoking a person immediately ends their sessions. Rotating the shared password signs everyone out and invalidates pending invitations.

Sessions expire after 30 minutes without user interaction and after eight hours overall. Background polling does not keep you signed in. Sensitive access changes require recent verification with the administrator’s own factor. See [security.md](docs/security.md) for the exact behavior.

Setup creates `.env`, `data/master.key`, and `data/setup.token` without overwriting existing files. Secrets and runtime data are ignored by Git. Keep a separate secure copy of the master key: losing it prevents decryption of saved credentials and backup payloads.

## Docker and HTTPS

Follow [deployment.md](docs/deployment.md) for Compose, HTTPS, remote prerequisites, updates, and disaster recovery. The central services do not mount the Docker socket. Docker operations run over SSH on your Linux source/target servers.

Add a server using its SSH private key and independently verified host-key fingerprint. Scan containers, review the entire site and mounted data, then configure capture and maintenance integration before scheduling. Daily policies use the site's configured timezone. Retention applies to successful backups; failed attempts must not consume the retained successful history.

Download and Restore are separate operations. New-copy restore currently supports one compatible, unprivileged container, fresh data paths, and networking disabled. Custom mappings and multi-container restore require additional adapters. Replacement of an existing site remains blocked until the rollback and pre-replacement-backup workflow is implemented and validated. External buckets, generic proxy installation, and online database backup are extensions.

## Verification and provenance

```sh
npm run check
```

CI runs the build, automated tests, and Docker image build. These checks do not prove a real site can be recovered. See [the acceptance checklist](docs/acceptance.md).

The project uses selected role guidance from [agency-agents](https://github.com/msitarzewski/agency-agents), including [DevOps Automator](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-devops-automator.md) for reproducible deployment, secret separation, and recovery planning. These role documents are reference material.
