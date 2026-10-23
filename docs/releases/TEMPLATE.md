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

Write for the person who uses the dashboard, not for developers. These notes appear in the Update Center and on the
GitHub release. Keep them short: one line per bullet, plain words, named the way the screen names things.
- Start from the "Release note" lines of the merged pull requests (.github/pull_request_template.md).
- Say what the user can now do, see or stop worrying about. Not how it was built or tested.
- No CI, test suites, command-line flags, file names, schema numbers or pull request numbers. Those belong in
  CHANGELOG.md and in the release pull request, which must still state what was tested (a Linux Docker integration
  run for any backup, restore or move claim; see docs/release-validation.md).
- Delete a section that has nothing to say. Keep the order.
- Only state what the code proves. A beta or limited feature says so in its bullet.

The front matter above becomes the signed `highlights` in docknest-release.json, shown in the Update Center.
It is parsed strictly, and the release fails on any mistake: the first line is exactly ---, then exactly these four
lines in any order, then a closing ---. security is true or false (true when there is a Security section);
features, improvements and fixes are whole numbers from 0 to 99 (the number of bullets in New, Better and Fixed).
No other keys, comments, quotes or blank lines. Delete the whole block, both --- lines included, to publish
without highlights. The front matter is removed from the GitHub release text.
-->

One sentence: what this update brings you.

## New

- **Feature name.** What you can do with it, in one line.

## Better

- Something you already used that now works better.

## Fixed

- What you would have noticed, and what happens now.

## Security

- What is now protected, in one line. Every install should update.

## Before you update

- Only when you must do something, or when something changes for you after updating.
