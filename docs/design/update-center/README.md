# Update Center design mockup

This folder holds a static design mockup of the planned v2.2.0 Update Center, for owner approval. It is not product code: `mockup.html` is a single self-contained file with no network requests until you click an external link. Open it in a browser and use the yellow "Design mockup" bar to switch screens, switch between light and dark, and replay the motion ("Replay motion" shows on screens that animate). A screen and theme can also be set in the address, for example `mockup.html#screen=lock-rolled-back&theme=dark` (`&still=1` stops the clock, `&details=1` opens Show details, `&drawer=1` opens the mobile drawer). The mockup follows [docs/update-center.md](../../update-center.md); where this page and that document differ, the document decides.

What it shows: the Update Center is its own sidebar item for administrators (Administration group, count badge when an update is available, Tabler circle-arrow-up). Settings keeps Appearance, Account and About. The Update Center has four tabs directly under the page header: Overview, What's new, Full changelog and History. The Automatic checks switch lives on Overview, in the left of two equal cards next to the Host updater card. While an update runs, every browser shows only one full-screen lock view. Versions are written as v2.2.0 (installed) and v2.3.0 (offered); names, dates and servers are sample data.

## Screenshots

Update Center
- `update-center-overview-light.png` and `update-center-overview-dark.png`: Overview tab. Hero card with the version pair, highlight chips, Update to v2.3.0 and What's new; the compact Before you update rows (database migration, "Estimate: about 4 min (based on your last update)", what pauses); then two equal-height cards, Automatic checks and Host updater, with one identical footer (status on the left, text action on the right).
- `update-center-whats-new-light.png`: What's new tab, the verified release notes of the offered release.
- `update-center-changelog-light.png`: Full changelog tab, "Release names from GitHub" (only the offered release shows a verified title; no release bodies).
- `update-center-history-light.png`: History tab, the aligned installation table with View details.
- `update-center-up-to-date-light.png`: up to date.
- `update-center-setup-light.png` and `update-center-setup-connected-light.png`: the one-time "Set up the host updater" card, waiting and then connected (the command-line update sits under a collapsed Advanced disclosure).
- `update-center-updater-not-responding-light.png`: the Host updater card when the updater stops answering ("Not responding · last seen 10:24"), with the fix-it commands. Time is shown only in this state.
- `update-center-blocked-light.png`: updates are blocked until the server operator runs the acknowledge command.
- `update-center-checks-light.png` and `update-center-checks-failed-light.png`: Pre-update checks, all passing and one failed.
- `update-center-start-dialog-light.png` and `update-center-start-dialog-reauth-error-dark.png`: Start update confirmation with the password and authenticator code step, and its error state.
- `update-center-history-details-light.png` and `update-center-history-manual-light.png`: History details for an installed update and for one that needs manual action (operator steps, one acknowledge command).

Lock view (the same for everyone)
- `lock-running-light.png`: Install stage in progress, with the live Activity timeline.
- `lock-reconnecting-light.png`: "Reconnecting to DockNest…" as plain text with a rotating restart icon.
- `lock-complete-light.png`: completed, with the summary checklist and Reload DockNest.
- `after-update-toast-light.png`: after the reload, the "DockNest updated to v2.3.0" toast with What's new.
- `lock-rolled-back-light.png`: rolled back, with Retry update and Open GitHub.
- `lock-manual-dark.png`: needs manual action. DockNest stays locked: no Back and no Close; generic next steps, the copyable `sudo scripts/install-updater.sh --status`, and "DockNest unlocks automatically when the host confirms."
- `mobile-lock-dark.png` and `mobile-lock-rolled-back-dark.png`: the lock view at 390 px, with stacked full-width actions.

Report a problem
- `report-problem-dialog-light.png`: "Review what will be shared" with the exact prefilled issue text, the environment option and Open GitHub.
- `report-problem-excerpt-light.png`: the optional, editable, redacted error lines ticked.
- `report-bug-dialog-light.png`: the same dialog from Settings, About, Report a bug (version and install mode only).

Settings, first sign-in and design
- `settings-appearance-light.png` and `settings-about-light.png`: Settings with the Settings sidebar, theme tiles, and the About page with Report a bug.
- `consent-light.png` (with a "What is sent" link to docs/security.md) and `whats-new-light.png`: first sign-in dialogs.
- `icons.png`: the Update Center icon set in light and dark at 20, 24 and 40 px.
- `mobile-update-center-light.png`, `mobile-update-center-tabs-light.png` and `mobile-checks-light.png`: 390 px wide; the tabs stay in one row and the split cards stack with the same footer grid; the history table stacks.

Other screens in the mockup's screen list without a screenshot here: What's new with unverified notes and with the current version, History blocked, consent already decided, automatic checks off, checks not set up, checking, check failed (with and without a cached offer), updater too old, blocked after two rollbacks, version mismatch, needs an earlier update first, recovery review required, deployment hold, history details for a rollback, the Host updater could not update itself variant (one repair command), lock view for prepare, DockNest answered, no progress reported, completed with a warning, completed with status unavailable, rolling back, rolled back twice (Retry disabled), refused and record closed, the report dialogs for manual action, refused and from History details, and Settings Account.

## Design rules used everywhere

Icons come from the Update Center icon set (`icons.png`): plain Tabler line icons at 24 px grid and 1.5 px stroke, with only Verify and Protect drawn for DockNest. Motion follows the UI Designer's `motion.css` (state changes of 120 to 320 ms, loops only while work is in progress, nothing under reduced motion, no confetti, no waveform). Colours are tokens only; geometry is 8 px.

**Type scale** (size / weight, line-height; one scale for every screen):

| Role | Size / weight | Line-height |
| --- | --- | --- |
| Page title | 24 / 700 | 1.3 |
| Dialog and offer title | 20 / 600 | 1.3 |
| Section title | 16 / 600 | 1.3 |
| Group title | 14 / 600 | 1.5 |
| Label, button, navigation | 14 / 500 | 1.5 |
| Body | 14 / 400 | 1.5 |
| Secondary (descriptions, help lines) | 13 / 400, and 13 / 500 for chips, version tokens and links | 1.5 |
| Caption | 12 / 400, and 12 / 500 for small headings | 1.5 |
| Mono (commands) | 13 / 400 | 1.5 |

Numbers use tabular figures. The product shell keeps its own sizes unchanged: 34 / 500 for dashboard numbers, 11 / 400 and 11 / 500 for the sidebar badge and health text, and 9 / 500 and 8 / 500 for the logo tagline. Values changed from the first pass: lock view title 26 to 24, row padding 14 to 16, group titles in notices 13 to 14, the Settings heading 18 to 16, row descriptions 12 to 13, line-heights 1.6 to 1.5.

**Buttons:** every action button is 44 px high with 16 px side padding, 14 / 500 text, an 18 px icon and an 8 px gap; labels never wrap and are at most three short words (the consent answer "No, keep checks off" is the owner's ruled label). One primary per row. At 480 px and below, action rows stack full width with the primary first, all the same height.

**Split-card footer:** Automatic checks and Host updater share one footer component pinned to the card bottom under the same hairline: a two-column grid (status text 13 / 400 secondary on the left, with a 16 px status icon where there is one; the text button 14 / 500 with a 16 px refresh icon on the right), 40 px action height, 53 px footer with its top padding. Measured at 1440 px: both actions' right edges sit 17 px inside their card (x 811 and 1263), centres at the same y, and text baselines match within 0.1 px; the cards are equal height. The inline text button is the one documented exception to the 44 px button rule (40 px, in line with text). At 900 px and below the cards stack and keep the grid.

**Checks run over every screen** (61 screens at 1440, 390 and 320 px, 183 captures): no button text wraps onto a second line, all 339 action buttons measure 44 px (inline text buttons excluded), buttons in the same row share height and font, every visible text uses a size and weight from the table above (or the product shell values), one main landmark per screen, no duplicate ids, no disabled control without a visible reason, no horizontal scroll.

## Notes on divergence

- Copy follows the owner's later rulings: no IP wording anywhere (the consent text says "DockNest asks GitHub for the list of releases. Nothing about your servers, sites or users is sent."), command-line update commands only under "Advanced: update from the command line", and the failed-result report action is the button "Open GitHub".
- `--text-muted` is set to #5F6C7E in the mockup so small muted text passes 4.5:1 on the grey page background. The real `web/tokens.css` change ships in PR 9.
- The "Start update" confirmation is a dialog opened from Pre-update checks; the document also describes it as part of that page, so the two read the same flow.
- "Retry update" appears only on rolled back results and is disabled after two rollbacks for the same version. There is no downgrade button anywhere.
- The lock view is public: it shows "Started 09:41" and "Update started" with no name. Names appear only in History details for administrators.

## Not mocked

These are specified in [docs/update-center.md](../../update-center.md) and not drawn here:

- The wording of each broker refusal beyond the samples (section 4, API table), and the text of the submit error codes `NOT_OFFERED`, `UPDATER_RATE_LIMITED` and `UPDATER_REFUSED`.
- Settings as an operator beyond version display, and the deep links `#/settings/...`, `#/update-center/...` (section 4, Web routes). Navigation items carry them as `data-route` only.
- How What's new renders the release notes, and the unverified notes label when there is no updater (sections 4.1 and 8). The mockup shows the verified variant.
- Reports for backups, restores, storage and server tests: the same "Review what will be shared" dialog, specified in section 7.2.
- Browser behaviour that a static page cannot prove: focus and title management on entering the lock view, live-region output, and a real update, rollback or reconnect (REQ items and the Linux integration).
