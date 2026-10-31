# Contributing to DockNest

Thanks for helping. DockNest protects other people's data, so changes are judged by one question first: does recovery stay correct and safe?

## Before you start

- **Bugs:** open an issue with the bug template. Include your DockNest version, Node.js version, host OS and what you expected.
- **Features:** open an issue first and describe the problem you want to solve. A short discussion before code saves both of us time.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

You need **Node.js 24+** and **Python 3.9+**.

```sh
npm ci
npm run setup
npm run build
npm start          # API and dashboard
npm run worker     # backup worker, in a second terminal
npm run dev:web    # frontend development server
```

## Checks

Run these before you open a pull request:

```sh
npm run check        # builds the UI, runs Node and Python tests
npm run audit:repo   # privacy checks: no credentials, private addresses or workstation paths
```

The remote helper is edited as modules in `remote/helper/` and shipped as one built `helper.py`; read [docs/remote-helper.md](docs/remote-helper.md) before changing it.

If you change capture, restore, SSH or SFTP code, also run the Linux integration suite (needs Docker):

```sh
npm run test:integration
```

CI runs all of these on every pull request, plus browser tests and a Gitleaks scan of the full history. A pull request is merged only when CI passes.

## Pull requests

- Keep each pull request focused on one change.
- Add or update tests for behavior you change. Recovery code needs a test that fails without your fix.
- Use mock data only, in code, tests, docs and screenshots. Use reserved domains (`example.invalid`) and documentation IP ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`).
- Never commit `.env` files, keys, databases, backups or real server details. See [repository privacy](docs/repository-privacy.md).
- Update the relevant docs when behavior changes.
- Fill in the **Release note** line of the pull request template: one plain sentence for dashboard users, or "None".
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and pull request titles, for example `fix(restore): reject archives with absolute paths`.

## Release checklist

A release pull request (version bump) is not complete until all of these are done:

1. **Version.** Bump `package.json` (and the lockfile) so `scripts/release-manifest.js` accepts the tag.
2. **Release notes.** Copy [docs/releases/TEMPLATE.md](docs/releases/TEMPLATE.md) to `docs/releases/YYYY-MM-DD-vX.Y.Z.md` (a `vX.Y.md` file also covers the `X.Y.0` release; the file-name suffix is how `scripts/release-manifest.js` finds the notes). Build it from the "Release note" lines of the merged pull requests: short, for dashboard users, no CI or internals. Set the four highlights in the front matter (the template explains the strict format); a malformed block fails the release before anything is built.
3. **Changelog.** Move the [Unreleased] entries in `CHANGELOG.md` under the new version (Keep a Changelog format) and link the notes file. The changelog is the detailed, technical record.
4. **README.** Update the features and screenshots for anything new (`npm run docs:screenshots`, synthetic data only). The version badge follows the latest GitHub release by itself.
5. **What was tested.** The release pull request description states what was tested and what was not. Backup, restore and move claims need a Linux Docker integration run.

## Safety rules for recovery code

- Fail closed. If DockNest can't prove a step is safe, it must stop and say why.
- Never replace a live site automatically. Restores go to isolated copies.
- Never weaken encryption, authentication or host key pinning to make a test pass.

## License

By contributing, you agree that your contributions are licensed under the [GNU Affero General Public License v3.0](LICENSE).
