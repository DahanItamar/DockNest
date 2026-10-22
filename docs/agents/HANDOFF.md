# Handoff

State of the project after release 2.1.0 (2026-10-22), for the next working session. Product direction lives in [docs/product](../product/roadmap.md); how upgrades and releases work lives in [docs/upgrading.md](../upgrading.md) and [docs/release-validation.md](../release-validation.md).

## Where things stand

- 2.1.0 is released: signed image `ghcr.io/dahanitamar/docknest` (`2.1.0`, `2.1`, `2`, `latest`), metadata schema 4, `minUpgradeFrom` 2.0.0.
- The release candidate passed the real upgrade validation from 2.0.0 (93/93 checks) on a Linux Docker runner.
- No open pull requests.

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

## Next: 2.2.0, the update center

Settings shows the running version, checks GitHub releases (after the one-time consent), and offers Update and, when safe, Downgrade. A full-screen progress view follows each step and survives the server restart: the open page reads a status file written by a host-side updater and reconnects automatically; other signed-in admins see a banner and backup actions pause. After success a "What's new" dialog opens once per admin. Containers keep no Docker socket: the API writes a validated request file, a host service installed once verifies the release signature and manifest, then runs `scripts/upgrade.sh --non-interactive`.

Start with a threat model and a design mockup for the owner to approve. Requirements already known:

- The nine updater requirements in [upgrading.md](../upgrading.md) (request file ownership, link refusal, official tags only, and others).
- The status directory must be owned by the user that writes it.
- Release validation must also cover upgrading from 2.1.0.

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
