# DockNest X.Y.Z

<!--
Copy this file to docs/releases/YYYY-MM-DD-vX.Y.Z.md (a vX.Y.md file also covers the X.Y.0 release).
scripts/release-manifest.js finds the notes by that file-name suffix and the image bundles them, so keep the name.
Keep the sections in this order. Write "None." for a section with nothing to say instead of deleting it.
Only state what the code, CHANGELOG.md and the docs prove. Use mock data in examples.
-->

Released YYYY-MM-DD. [Full changelog](../../CHANGELOG.md).

## Summary

Two or three lines: what this release is for and who should upgrade, in plain language.

## What's new

- **Feature name.** What it does for the user, in one or two sentences.

## Improved

- Behavior that already existed and now works better.

## Fixed

- What was wrong, in terms the user would have noticed, and what happens now.

## Security

- Security-relevant changes. Write "None." if there are none. Security reports go through [SECURITY.md](../../SECURITY.md).

## Upgrade notes

Read these before upgrading. Number the steps that need action; say plainly when nothing needs doing.
The upgrade and rollback commands are in [docs/upgrading.md](../upgrading.md).

1. What changes for an existing installation and what to do about it.

## Known limits

- What this release does not do or does not yet prove. Include beta features and anything announced for a later version.

## Validation

What was actually tested for this release, where (link the workflow or document), and what that testing does not cover.
Never describe real backup or restore as validated without a Linux Docker integration run; see [release validation](../release-validation.md).

- **Tested:** ...
- **Not covered:** ...
