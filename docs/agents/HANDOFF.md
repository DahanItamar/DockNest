# Handoff

State of the project on 2026-10-22: release 2.1.0 is out and 2.2.0 is in integration. For the next working session. Product direction lives in [docs/product](../product/roadmap.md); how upgrades and releases work lives in [docs/upgrading.md](../upgrading.md) and [docs/release-validation.md](../release-validation.md).

## Where things stand

- 2.1.0 is released: signed image `ghcr.io/dahanitamar/docknest` (`2.1.0`, `2.1`, `2`, `latest`), metadata schema 4, `minUpgradeFrom` 2.0.0.
- The release candidate passed the real upgrade validation from 2.0.0 (93/93 checks) on a Linux Docker runner.
- 2.2.0 work is in pull requests against `integration/2.2.0` (see below).

## How the work is organised

- One branch and pull request per section of work, one commit per section, conventional commit messages. `main` is protected by five required checks: privacy, check, browser, linux-integration, controlled-beta-gate.
- Merge only when the pull request and the latest `main` run are both green. The only exception is a pull request that fixes a red `main`, after its cause is verified.
- Releases: no public release candidates. Merge the release pull request with the final version, wait for `Verify`, run the release-validation workflow from `main` with the merge commit as `candidate`, then tag that commit `vX.Y.Z`. `release.yml` refuses pre-release tags and any tag without both green runs. See the release order in [release-validation.md](../release-validation.md#release-order).
- Schema changes are new numbered migrations in `src/migrations.js`; mark purely additive ones `compatible: true` so older releases can still run on the database.
- Agents work in narrow roles from agency-agents ([README](README.md)): authors write code; independent QA and design reviewers verify without editing; a QA lead merges their findings into tickets for the authors. Security, data safety and architecture use the strongest model at high effort; features use a mid-tier model at high effort; review uses a mid-tier model at medium effort.
- UI must match the design system: shared Tabler icons and tokens, light and dark, 390 px mobile, no emoji and no text characters used as icons.

## Owner decisions

- Update check: ask once at the first admin login, then daily only if accepted; no outbound call before that.
- Updates are installed only when an admin clicks Update; never unattended.
- Primary user: the web agency owner managing several client servers.
- Licence: AGPL-3.0 with DCO sign-off; funding through sponsors and paid setup or support.

## Current state: 2.2.0 in integration

2.2.0 is being built on `integration/2.2.0`; feature pull requests merge there after a combined independent review, and one `integration/2.2.0` to `main` pull request runs every required check. Nothing is tagged. `main` and the latest release are still 2.1.0.

- On the branch: migration 5 and release history, the self-backup hold, disk retention and exit 4 after compatible migrations in `scripts/upgrade.sh`, the signed release manifest, the opt-in update check, the verify flags and the on-`main` and signature check, the host updater (`updater/broker.py`, `scripts/install-updater.sh`, the `docknest_updater` volume), upgrade requests with the public progress endpoint and the 423 update lock, the Update Center page, Report a bug and `TRUST_PROXY`.
- Docs written from the code: [upgrading.md](../upgrading.md) (host updater, lock, retention, flags, the 2.1.x hop), [security.md](../security.md), the draft [2.2.0 release notes](../releases/2026-10-22-v2.2.0.md) and the CHANGELOG `[Unreleased]` section. The version bump and the README "Latest version" row belong to the release pull request.
- Still to do for 2.2.0: the read-only API routes the page already calls (`releases/:version`, `whats-new`, `whats-new/seen`), the release-validation changes that start from 2.1.0 and exercise the updater and retention (update-center.md section 11, PR 12), the release pull request, then the private release validation on a Linux Docker runner. Until that run passes, no document may call the updater, the cleanup or the 2.1.x to 2.2.0 hop validated, and real backup and restore stay unvalidated without Linux Docker integration.
- Design: [update-center.md](../update-center.md), [updater-threat-model.md](../updater-threat-model.md), mockup in [design/update-center](../design/update-center/README.md). Downgrades stay a command-line task (owner decision, 2026-10-22).

## Next: 2.3.0 scope (deferred from 2.2.0)

- The broker `check` action and the Pre-update checks page (D19).
- Broker self-update (D6, I38 to I44) from the signed `updater` block; until then `sudo scripts/install-updater.sh --repair` reinstalls the broker.
- Full changelog tab and History details, and the Activity timeline.
- **Open GitHub** reports for failed updates (reason, environment, excerpt) and problem reports across DockNest (update-center.md section 13).
- Rollout: the owner upgrades 2.1.x to 2.2.0 with `scripts/upgrade.sh` after taking a recovery kit, runs `sudo scripts/install-updater.sh` once, then installs 2.3.0 from the Update Center as the first real in-app update.

## Backlog

- Retention can delete the latest backup whose isolated restore passed; keep it as it keeps the latest application-checked one (top product priority).
- A "Run a restore test" action next to untested or failed levels, opening the restore dialog in isolated-copy mode.
- A failed restore attempt (for example an SSH error) marks the application level as failed instead of not run (engine change).
- The API still returns `status: "Verified"` for backups.
- Storage: show locked backups in the library; a provider preset selector for S3; reuse one SFTP session per batch of operations, which also avoids running out of local ports on Windows during repeated test runs.
- Accessibility: dialogs do not return focus to the button that opened them; the dashboard "Open library" link contrast is 3.5:1 in light theme.
- Probe threads can outlive a timed-out probe and send a late request to an already validated address.
- Release validation seeds 2.0.0 data instead of capturing a real site, and does not cover image mode.
- S3 storage stays beta until a full Linux backup and restore over S3 passes.
- 2.3.0: restructure `src/` and `web/` into modules, add formatting and linting in one isolated commit listed in `.git-blame-ignore-revs`, adopt release-please, remove dead code, and turn [README.md](README.md) into a short team handbook.
