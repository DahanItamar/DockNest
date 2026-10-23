## What this changes

<!-- One focused change. Link the issue it closes: "Closes #123". -->

## Release note

<!--
One line for the people who use the dashboard. It goes into the next release notes almost as written.
Name things the way the screen names them; no file names, tests or internals.
Keep one heading and delete the others. Write "None" for changes users never see (CI, tests, refactoring).
-->

- **New:** 
- **Better:** 
- **Fixed:** 
- **Security:** 
- **Before you update:** <!-- only if users must do something -->

## How it was tested

- [ ] `npm run check` passes
- [ ] `npm run audit:repo` passes
- [ ] `npm run test:integration` passes (required for capture, restore, move, SSH or SFTP changes)
- [ ] New or changed behavior has a test
- [ ] Screenshots attached for visible changes (desktop and phone, light and dark)

## Safety

- [ ] Uses mock data only (no real credentials, addresses, backups or customer data)
- [ ] Recovery still fails closed and never replaces a live site automatically
- [ ] `CHANGELOG.md` has an entry under [Unreleased]
- [ ] Docs updated where behavior changed
