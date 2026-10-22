---
security: false
features: 0
improvements: 0
fixes: 0
---
# DockNest X.Y.Z

<!--
Copy this file to docs/releases/YYYY-MM-DD-vX.Y.Z.md (a vX.Y.md file also covers the X.Y.0 release).
scripts/release-manifest.js finds the notes by that file-name suffix and the image bundles them, so keep the name.
Keep the sections in this order. Write "None." for a section with nothing to say instead of deleting it.
Only state what the code, CHANGELOG.md and the docs prove. Use mock data in examples.

The front matter above becomes the signed `highlights` in docknest-release.json, shown as chips in the Update Center.
It is parsed strictly, and the release fails on any mistake: the first line is exactly ---, then exactly these four
lines in any order, then a closing ---. security is true or false (true when the Security section lists a fix);
features, improvements and fixes are whole numbers from 0 to 99 (the number of bullets in What's new, Improved and
Fixed). No other keys, comments, quotes or blank lines. Delete the whole block, both --- lines included, to publish
without highlights. The front matter is removed from the GitHub release text.
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
