# DockNest design system v2 (draft)

Status: draft for owner review. Not committed. Target: 3.0.0 (built on `integration/2.16.5`).
Prototype files (uncommitted, worktree `ds-v2-boards`): `web/ds-v2/tokens-v2.css`, `web/ds-v2/prototype-overrides.css`, `web/ds-v2/sheet.html`, `web/ds-v2/token-sheet.html`, `scripts/ds-v2-boards.js`.
Boards: `scratchpad/boards-ds-v2/` (`<screen>-<viewport>-<theme>-<before|after|pair>.png`, `<screen>-overview.png`, `token-sheet-<theme>.png`, `captions.txt`).

Upstream reference roles (msitarzewski/agency-agents): UI Designer (tokens, components), UX Architect (layout grid, CSS structure), Accessibility Auditor (contrast, focus, targets), Brand Guardian (logo and hue), Content/UX Writer (copy rules). Discipline references: Linear, Stripe, Vercel Geist, Radix, Apple HIG. No branding is copied.

## 1. Principles

1. One system. Every value comes from a `--dn-*` token. No raw hex, px radius or shadow in component CSS.
2. Confident, not loud. The 2.x palette stays (owner decision): purple for actions, blue for navigation and chrome. Colour is used with purpose, at the dashboard's level, and never as gradients or glows. The dashboard is the quality bar for every other page.
3. Motion explains a change or it is removed.
4. One primary action per view. Labels are verbs.
5. Say it once, short. Helper text only where a user could get it wrong.
6. Keyboard first-class: `:focus-visible` ring, never on mouse click.
7. Upgrade-safe: legacy tokens alias to v2 until the last screen migrates; saved user state is never touched.


## 2. Audit


Scope: web/*.css (20 root + 14 subfolder files, ~2570 lines, most rules minified onto one line, so a line number = one rule line) and the 32 root .jsx plus subfolder .jsx. Screenshot names are `<screen>-<viewport>-<theme>-before.png`.

### Summary counts

| Metric | Count | Notes |
|---|---|---|
| Font-size values | 6 tokens + 3 raw clamp() + 1 inherit | 593 of ~600 declarations use tokens (good). Raw: status-page.css:8,16,17 (clamp 104-440px), restore-tests.css:19 (inherit). Tokens re-scale at 1920 and 2560 (tokens.css:29-30), so rendered sizes = 18 |
| Font-weight values | 5 (400, 500, 600, 700, 900) | 500 x109, 600 x48, 400 x26, 700 x2 (style.css:7,15), 900 x1 (status-page.css:8). Target 3 (400/500/600) |
| Border-radius | 22 distinct values (3 tokenised) | Raw: 2,3,4,6,7,8,10,12,16,27px, 50%, 999/9999px, 16px 16px 0 0, 8px 8px 0 0, 0 0 8px 8px. Literal `8px` x25 duplicates `--radius` |
| Box-shadow | 15 distinct non-none values (7 `none`) | 7 elevation shadows (blur 2/16/24/32/48/64px): style.css:14, frame.css:23, shell.css:7,10,82, dashboard.css:4, updates.css:83, map.css:100,139,173,209, connections.css:82, report.css:3. Rest are ring/focus emulation |
| Raw hex colours | 81 distinct / 110 uses | 109 in tokens.css (light + dark). Outside tokens: auth.css:31 `#000` mask; `rgb(0 0 0 / 16%)` dashboard.css:3 |
| Transition declarations | 32 distinct | 13 `none` + 5 `none!important`. Literal durations: 120,160,180,200,220,225,240,260,380,400,425ms, .3s, .6s. Two token sets: `--dur-*` 120/160/240 (tokens.css:24) vs `--dn-motion-*` 120/200/320 (updates.css:3) |
| Keyframes | 14 | theme-reveal, otp-shake/in/blink, map-spin, lg-sway (52s infinite), dn-toast-in, dn-spin, dn-pulse (infinite), dn-orbit, dn-enter (10+ users), berry-ring, berry-pop, berry-drawer. 7 `infinite` |
| Gradients | 2 linear/mask + 1 radial + 2 decorative circle sets | auth.css:31, map.css:89 (fade), map.css:4 (dot grid); circles dashboard.css:2, shell.css:13 |
| `transition:all` | 0 | clean |
| `:focus` without `-visible` | 0 real offenders | 4 `:focus{outline:none}` only on tabindex=-1 headings (map.css:32,176; updates.css:90; status-page.css:6), correct |
| `!important` | 46 | maintenance.css:9, shell.css:3, restore-tests.css:3, dashboard.css:3 |
| `.rebrand-page` override prefix | 231 uses | Base style.css -> system.css -> rebrand.css each override the last (e.g. button:active scale at style.css:4 neutralised at system.css:25) |
| Control heights | 15 distinct (20,24,30,32,34,36,40,44,48,56...) | `--control-height` 40 (44 at <=480px, tokens.css:32) overridden by 30/32/34/36 in 12 places |
| Gap values | 9 (4,8,12,16,24 + off-grid 2,6,10,14) | 25+ distinct padding combos |
| Placeholder as label | 0 hard offenders; 4 weak | all inputs have label or aria-label. Weak: map/Panels.jsx:23, restore-tests/RestoreTestsDialog.jsx:103-105 (example values) |
| Text-symbol icons in JSX | 2 `→`, 1 `−`, ~20 `—` null-cell, ~20 ` · ` joiners | No emoji, no "x" close glyphs (Tabler icons). Good |
| "site" in user-facing copy | ~190 strings (685 raw tokens incl. identifiers/classes) | "Sites & schedules" x25. "Beta": 0 in user strings (comment only, incremental/IncrementalDialog.jsx:6) |
| Long helper text | 21 text nodes >130 chars | in Copy audit |

### Top 15 worst offenders

1. Cascade stacking: style.css -> system.css -> rebrand.css redefine the same components (`button`, `.empty` x4, `.badge` x3, inputs); 231 `.rebrand-page` + 46 `!important`. style.css:3-4, system.css:24-27, rebrand.css:10-17.
2. Four `.empty` definitions (style.css:9, frame.css:16, rebrand.css:17, servers.css:14) + 10 bespoke empty classes; padding 40 vs 48.
3. Radius chaos: 22 values incl. 27px (shell.css:9), 7px/10px (shell.css:68-69), 16px sheets (connections.css:102, report.css:58, zip-export.css:12), 999 vs 9999 pills.
4. Weights 700/900 and 600-vs-500 heading mix (style.css:7,15; status-page.css:8).
5. Parallel motion systems and long motion: sidebar 425ms (shell.css:11), margin 400ms (shell.css:14), theme transition 380ms on ~20 element types (shell.css:76-78), progress .6s (job-details.css:42).
6. Decorative motion: `lg-sway` 52s (auth.css:33), `berry-ring` bell (shell.css:35,40), `dn-pulse` infinite (job-details.css:62-63), otp-shake (auth.css:101,113), theme icon scale 1.15 (shell.css:57), menu bar morph (shell.css:109-110).
7. Decorative circles/gradients: metric tiles (dashboard.css:2), sidebar storage (shell.css:13), map fade/dot grid (map.css:4,89), auth mask (auth.css:31).
8. Elevation sprawl: 7 different drop shadows (report.css:3 24/64; dialogs 12/48; popovers 8/32; menu 4/16; toast 8/24). Should be 2 tiers.
9. Touch targets <44px on mobile: shell.css:25 (30x34), dashboard.css:3,4,47 (30/32), job-details.css:18 (32), map.css:290,296 (32), map.css:312 (24 handle), rebrand.css:14 (24), rebrand.css:10,164 (40), map.css:243 (40).
10. Disabled state: opacity .45 (style.css:4), .5 (rebrand.css:52, servers.css:12, sites.css:14, tables.css:34), .65 (rebrand.css:166), flat grey fill (map.css:27); cursors not-allowed/wait/default.
11. Opacity-based text/decor: dashboard.css:25 (.9), status-page.css:5 (.9), job-details.css:52,57,59 (.5-.7), storage-report.css:42.
12. 10 alert-like implementations beside `.alert-panel` (system.css:41).
13. 21 helper paragraphs >130 chars (self-backup.jsx:64, server-wizard.jsx:29, storage-targets.jsx:79,128, shell.jsx:39, site-wizard.jsx:153,165).
14. "site" for Docker apps ~190 strings; nav label "Sites & schedules" (shell.jsx:32-33, main.jsx x20, dashboard.jsx:64,94).
15. Hover scale/rotation micro-interactions: shell.css:19,54,57; dead press scale `button:active{transform:scale(.97)}` style.css:4.

### Buttons and variants

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| `button` defined twice, second wins; `scale(.97)` on press is dead code | scale on press | style.css:3-4, system.css:24-25 | components-1440-light-before.png | Delete style.css:3-4; one `.btn` 40px (44 touch), 8px radius |
| Variants: primary x92, icon x17, danger x7, text x7, wide x3, `.icon-button` x4, `.recovery-action`, `.dn-link-button`, `.link-btn` | duplicates | style.css:5, system.css:26, rebrand.css:11,51, job-details.css:18, map.css:290,296 | components-1440-light-before.png | 4 variants: primary, secondary, danger, ghost + icon-only size |
| Heights 24/30/32/34/36/40/44/48 | control height | dashboard.css:3,4,6,47; job-details.css:18; shell.css:25; map.css:290,296; maintenance.css:30; rebrand.css:10,14,164 | dashboard-390-light-before.png | Tokens `--control-h` 40 / `--control-h-touch` 44 only |
| Mobile hit area <44 | touch target | shell.css:25, dashboard.css:3,4, job-details.css:18, map.css:290,296 | jobs-390-light-before.png | Min 44x44 via padding/::after |
| Dark `.danger` text flips to `--surface` | contrast | system.css:27 | dialog-1440-dark-before.png | `--on-danger` token |
| Colour transitions 160/180/200ms vs tokens | motion | style.css:3, system.css:25 | components-1440-light-before.png | `--dur-fast` only |
| Disabled .45/.5/.65 + 3 cursors | disabled | style.css:4, rebrand.css:52,166, servers.css:12, sites.css:14, tables.css:34, map.css:27 | form-errors-1440-light-before.png | One disabled style |
| Pagination buttons fixed 112px, accent-soft fill (differs from all other buttons) | variant | rebrand.css:162-166, tables.css:34-35 | jobs-834-light-before.png | Secondary button, compact |

### Inputs, selects, checkboxes, switches

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| Field heights 44 (style.css:10, rebrand.css:13, auth) vs search 24/40 vs 44 select with 10/14 padding | heights | style.css:10, rebrand.css:13-14, connections.css:86, dashboard.css:3 | form-errors-390-light-before.png | One 40 (44 touch) field |
| Native checkbox/radio (`width:auto;min-height:0`), map uses 20px | size/hit | style.css:10, map.css:46 | add-app-390-light-before.png | Custom 20px box, 44px label hit |
| Border transition 180ms, hover border turns accent | motion/hover | style.css:21-22 | components-1440-light-before.png | 120ms; hover = border-control |
| Placeholder as example/hint text | placeholder | map/Panels.jsx:23, restore-tests/RestoreTestsDialog.jsx:103-105, storage-targets.jsx:136-140, connections/parts.jsx:13, main.jsx:246 | storage-1440-light-before.png | Move formats to helper under label |
| Switch is solid (44 hit, 36x20 track) but focus workaround duplicated 3x | duplicate | style.css:58-76, connections.css:23, restore-tests.css:8, self-heal.css:24 | settings-1440-light-before.png | Remove per-feature overrides |
| Select picker 6px radius, 10px gap | radius | style.css:30-31 | components-1440-dark-before.png | 8px / 8px |
| `.field` margin 20px (off-grid) | spacing | style.css:10 | add-app-1440-light-before.png | 16 |
| Invalid state styled 3 ways | consistency | connections.css:32, auth.css:54, restore-tests.css | form-errors-1440-light-before.png | One `.field-error` |

### Tables and pagination

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| `th` 16/24 padding, `td` 18/24, test-step rows h40 | spacing | style.css:11, tables.css:110 | jobs-1440-light-before.png | Row 56 token, th 40, 12/16 |
| 5 table classes: `.data-table`, `.mobile-table`, `.hd-table`, `.inc-table`, `.stable-table` | duplicate | connections.css:15-18, hardening.css:16-19, incremental.css:54, tables.css | jobs-834-light-before.png | One `.table` + stacked mobile |
| Pager radius `0 0 8px 8px`, 20px padding | radius | rebrand.css:162 | jobs-1440-dark-before.png | Card radius token |
| Row hover is only bg, no focus-visible row | hover | style.css:11 | jobs-1440-light-before.png | Add row focus ring |
| Null cell glyph `—` x20 | text-symbol | job-details.jsx:16-20,114,127,143,174-177,201,208; main.jsx:81,211-253; schedule-fields.jsx:22; storage-report.jsx:57-58 | jobs-1440-light-before.png | Shared `<Empty/>` muted "Not set" |

### Cards, metric tiles, charts

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| Card variants: `.card`, `.panel`, `.dash-panel`, `.storage-card`, `.progress-card`, `.auth-card`, `.dn-card`, `.dash-metric`; border 1px vs 0; padding 16/18/20/24/32 | duplicate | system.css:51, dashboard.css:35, rebrand.css:47,91, updates.css:89, job-details.css:27 | dashboard-1440-light-before.png | One `.card` (1px border, 16/24, radius 8) |
| Metric tiles: solid purple/blue + two circles, opacity .5, 90% label | decor/contrast | dashboard.css:2-3,19,25 | dashboard-1440-light-before.png | Surface tile: number + label |
| Entrance `dn-enter` 240ms on every card/panel | motion | dashboard.css:17,35,62, system.css:73 | dashboard-1440-light-before.png | Remove (keep dialog/toast only) |
| Chart export menu 4/16 shadow; 30px buttons | shadow/touch | dashboard.css:4 | dashboard-390-light-before.png | Popover token; 44 hit |
| Legend off state = line-through + opacity .5 | contrast | dashboard.css:4 | dashboard-1440-dark-before.png | Hollow swatch, muted text |
| sr-zero opacity text, scroll tabindex | opacity | storage-report.css:18,42 | storage-1440-light-before.png | Solid muted token |

### Dialogs and sheets

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| 9 dialog classes: `dialog`, `.job-dialog`, `.cx-dialog`, `.rp-dialog`, `.map-dialog`, `.inc-dialog`, `.hd-dialog`, `.zip-dialog`, `.uc-dialog` | duplicate | frame.css:23-35, style.css:14, report.css:3,58, map.css:31,149-160, incremental.css:2, hardening.css:9, connections.css:40,102, zip-export.css:9-12 | dialog-1440-light-before.png | One dialog + bottom-sheet variant <=600px |
| Radius 8 desktop vs 16 top-only sheets; shadow 12/48 vs 24/64 | radius/shadow | frame.css:23, report.css:3,58, connections.css:102, zip-export.css:12 | dialog-390-light-before.png | One radius + `--shadow-dialog` |
| `dn-enter` 240ms entrance | motion | frame.css:25, report.css:4 | dialog-1440-dark-before.png | Opacity 120ms |
| Heading tabindex=-1 focus, outline suppressed (correct) | focus | map.css:32,176; connections/DeployKeys.jsx:18; ConnectionDialog.jsx:144 | dialog-1440-light-before.png | Keep |
| Two close-button shapes | duplicate | map.css:198, connections/DeployKeys.jsx:18 | dialog-390-light-before.png | One `<DialogClose>` |
| Footer buttons min-width 120, no stacking on mobile | touch/layout | wizards.css:11, zip-export.css:9 | dialog-390-dark-before.png | Full-width stack <=600 |

### Tabs, nav, sidebar, header

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| Three tab styles: `.tabs [role=tab]` 44px/3px (updates.css:29-31), `.map-tabs button` 40px/2px (map.css:242-243), wizard steps (wizards.css:5) | duplicate | left | settings-1440-light-before.png, map-1440-light-before.png | One `<Tabs>` 44px |
| Sidebar width 425ms, workspace margin 400ms | motion >300ms | shell.css:11,14 | dashboard-834-light-before.png | 200ms or none |
| Selected nav uses blue accent while product accent is purple | colour | shell.css:12 | dashboard-1440-light-before.png | One accent |
| Sidebar storage tile circle | decor | shell.css:13 | dashboard-1440-dark-before.png | Plain bar |
| Header icons 30x34 at <600px | touch | shell.css:25 | dashboard-390-light-before.png | 44x44 |
| Bell shake, theme rays/scale 1.15, menu morph | motion | shell.css:35,40,54-57,109-110 | dashboard-1440-light-before.png | Colour change only |
| Popovers: radius 8 vs 12, shadow 8/32 vs 4/24 | radius/shadow | shell.css:7,10,82 | dashboard-1440-light-before.png | One popover token |
| Global theme transition 380ms | motion | shell.css:76-78 | dashboard-1440-dark-before.png | Remove |

### Badges and status

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| Status UI: `.status` (icon+text, system.css:18), `.badge` x3 (style.css:11, rebrand.css:39,187), `.recovery-status` (rebrand.css:68,116,131), `.map-badge/.map-status/.map-stage` (map.css:55,119,166), `.inc-status`, `.sr-status`, `.studio-stage` | duplicate | listed | components-1440-light-before.png | One `<Status tone>` + one `<Badge>` |
| Radius 6 vs 4 vs 999 | radius | rebrand.css:39, map.css:53,137, job-details.css:41 | map-1440-light-before.png | 4px |
| Spinner 1s infinite | motion | system.css:21, map.css:60 | jobs-1440-light-before.png | Keep, respects reduced-motion |
| Text-colour pairs (warning on warning-surface, muted on surface) not verified in a contrast table | contrast | tokens.css | jobs-1440-dark-before.png | Validate all pairs on Colour board |

### Alerts, banners, toasts

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| 10 alert-like classes beside `.alert-panel` | duplicate | auth.css:59,69; copies.css:13; maintenance.css:24,33; job-details.css:5,109; map.css:117,197; frame.css:46; updates.css:20 | form-errors-1440-light-before.png | All through `AlertPanel tone` |
| Alert entrance `dn-enter` | motion | system.css:41 | form-errors-1440-dark-before.png | none |
| Button margin forced inside alert | spacing | wizards.css:12 | form-errors-390-light-before.png | Actions slot |
| Toast 8/24 shadow, 8px slide, 200ms | shadow/motion | updates.css:83-84 | dashboard-1440-light-before.png | Fade 120ms, popover shadow |

### Empty, loading, error states

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| 4 `.empty` + 10 bespoke | duplicate | style.css:9, frame.css:16, rebrand.css:17, servers.css:14, connections.css:8,98, map.css:13, self-heal.css:27, server-cleanup.css:14, storage-report.css:30-31 | apps-1440-light-before.png | One `<EmptyState>` |
| Loading = plain text with ellipsis, no spinner/skeleton | loading | configuration-files.jsx:19, connections/ConnectionsPage.jsx:38, DeployKeys.jsx:97,149, copies/SiteStorageDialog.jsx:27, incremental/IncrementalDialog.jsx:21, self-heal/SelfHealSheet.jsx:37, hardening.jsx:43 | apps-390-light-before.png | `<Loading>` |
| Status page code weight 900, clamp 104-440px | type | status-page.css:8,16-17 | settings-1440-dark-before.png | 600, fixed size |
| Inline errors lack retry | states | report/ErrorBoundary.jsx:8 | form-errors-1440-light-before.png | Retry slot |

### Steppers and wizards

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| `.site-wizard` class reused by 6 non-wizard dialogs | naming/duplicate | wizards.css:2-12, connections/ConnectionDialog.jsx:116, DeployKeys.jsx:17, copies/SiteStorageDialog.jsx:41, incremental/IncrementalDialog.jsx:36, incremental/ChainDialog.jsx:12 | add-app-1440-light-before.png | Rename `.dialog-form`; Stepper component |
| Steps are tab-styled `aria-current=step` | duplicate | wizards.css:5 | add-app-390-light-before.png | Numbered stepper, 44px |
| Launch/Move flows own `.map-dialog*` | duplicate | map/launch.css, map.css:149-160 | map-834-light-before.png | Reuse dialog |
| `→` glyph in DNS record | text-symbol | map/LaunchFlow.jsx:153, map/MoveFlow.jsx:167 | map-1440-light-before.png | Tabler arrow icon |

### Map panels

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| Nodes tabIndex=0 use `:focus-visible` (no click flash) | focus | map/MapPage.jsx:462,496,502,521,532; map.css:90,169,211 | map-1440-light-before.png | OK |
| Node shadows + 2px box-shadow rings | shadow | map.css:100,109,210,284 | map-1440-dark-before.png | Border colour only |
| Panel 360px, shadow | shadow | map.css:173 | map-834-light-before.png | Popover token |
| Delete handle 16+8 pad, hidden until hover | touch/hover | map.css:312-318 | map-390-light-before.png | Always visible on touch, 44 area |
| Dot-grid + bottom fade | decor | map.css:4,89 | map-1440-light-before.png | Flat surface |
| Mixed radii 3/4px and 40px tabs | radius | map.css:53,137,142,171,243 | map-1440-light-before.png | Shared components |
| Undo bar animated | motion | map.css:323,341 | map-1440-light-before.png | none |
| Own disabled style | disabled | map.css:27 | map-1440-dark-before.png | Shared |

### Typography

| Issue | Check | file:line | Screenshot | Fix |
|---|---|---|---|---|
| Letter-spacing in 9 forms (.04em, -.5px, 1px, .4px, .3px, .2px, -1px, -.045em, 0) + 1 uppercase | type | status-page.css:8, style.css:8, rebrand.css | components-1440-light-before.png | Drop all |
| h1 700 vs 600 elsewhere; same role 500 vs 600 | weight | style.css:7,15, dashboard.css:21, job-details.css:40 | components-1440-light-before.png | headings 600, labels 500, body 400 |
| Mono stack inline | tokens | style.css:6 | storage-1440-light-before.png | `--font-mono` |

### Copy audit

Rename rule: Docker "site" -> "app" in all user-facing strings (keep "website"/"static site" only for nginx static type). Verb-first buttons. Cap helper text at ~1 sentence (<110 chars).

| Current text | file:line | Proposed |
|---|---|---|
| Sites & schedules (nav, page title, breadcrumb, 25x) | shell.jsx:32-33, main.jsx:61,237-249,258, dashboard.jsx:64,94, report/ErrorBoundary.jsx:8 | Apps |
| Sites at a glance | dashboard.jsx:64 | Apps |
| Manage sites | dashboard.jsx:64 | Open apps |
| Sites with recovery points | dashboard.jsx:49 | Apps with backups |
| Your sites, in one place | dashboard.jsx:67 | Your apps |
| Choose a site to protect / Choose a site | dashboard.jsx:94 | Add an app |
| No sites configured yet | dashboard.jsx:94 | No apps yet |
| Your server is connected. Group the containers for your first site and set its schedule. | dashboard.jsx:94 | Pick the containers for your first app. |
| Add a Docker host to discover its containers and configure your first site. | dashboard.jsx:94 | Add a server to find its apps. |
| Connect a server, then choose the sites you want to back up. | dashboard.jsx:67 | Add a server, then pick apps to back up. |
| Expand a site to browse its recovery points. | dashboard.jsx:67 | Open an app to see its backups. |
| Site / server, Job / site | dashboard.jsx:71, main.jsx:223 | App / server, Job / app |
| Add site / Add a site / Remove site / Open site / New site | main.jsx:238,258; map/MapPage.jsx:68; recovery-pages.jsx:50; map/LaunchFlow.jsx:10,37,140-151; map/Panels.jsx:60 | Add app / Remove app / Open app / New app |
| Edit site configuration | main.jsx:230,249 | Edit app |
| Site storage | main.jsx:249 | App storage |
| Filter sites… | main.jsx:246 | Filter apps |
| Site removed. Existing backups and history are kept. | main.jsx:258 | App removed. Backups are kept. |
| Site added. Set its schedule when ready. | main.jsx:258 | App added. |
| Site configuration saved. | main.jsx:258 | Saved. |
| Maintenance design saved. Deploy it to each site. | main.jsx:254 | Design saved. Deploy it to your apps. |
| Site maintenance controls / Maintenance controls appear for each configured site. / Add a site first | main.jsx:254 | App maintenance / Add an app first |
| Verify the site is running and healthy on the remote server, and review the local recovery journal before unlocking it. | main.jsx:259 | Check the app on the server, then unlock it. |
| Type the site name to confirm | main.jsx:260, map/MoveFlow.jsx:134 | Type the app name to confirm |
| Recovery acknowledged. Site is unlocked for future jobs. | main.jsx:202 | App unlocked. |
| Site paused / Site not recorded / Site ID | job-details.jsx:96,174,198,208 | App paused / App not recorded / App ID |
| Restarting the site / Checking files while the site is paused | job-details.jsx:36,60 | Restarting the app / Checking files while the app is paused |
| Integrity confirms the encrypted file is intact. Only a restore test proves the site starts again. Use Restore on this backup and keep the isolated copy option. | job-details.jsx:176 | The file is intact. Run a restore test to prove the app starts. |
| Review the site configuration and current Docker mounts, then run readiness checks before retrying. | job-details.jsx:29 | Review the app settings and mounts, then check again. |
| Choose the sites to protect / No matching sites / Try another site name... | recovery-pages.jsx:25-27,60 | Choose apps to protect / No matching apps |
| Connect a server, discover Docker containers, and group the containers that make up each site. | recovery-pages.jsx:25 | Add a server, then group its containers into apps. |
| Backup sites / Recovery points by site / Sites and schedules | recovery-pages.jsx:27,63 | Backed-up apps / Backups by app |
| Static sites have nothing to edit | recovery-pages.jsx:41 | Static apps have nothing to edit |
| Run a backup from Sites & schedules. A recovery point appears only after the job is verified. | recovery-pages.jsx:59 | Run a backup from Apps. It appears here once verified. |
| Sites / Discover sites | servers.jsx:28,34 | Apps / Find apps |
| No sites on this server yet. / No sites left to add... / Could not look for sites on this server. | map/MapPage.jsx:69, map/Panels.jsx:44,63 | No apps on this server yet. / No more apps to add. / Could not find apps. |
| Connect a server and add a site. They will appear here, arranged automatically. | map/MapPage.jsx:354 | Add a server and an app to see them here. |
| Click a node to open it. Drag a site's line to another server to move it. | map/MapPage.jsx:548 | Click a node to open it. Drag an app's line to move it. |
| Connect every site to a server to save | map/MapPage.jsx:470 | Connect every app to a server to save |
| Docker site / nginx site · static files | map/MapPage.jsx:38, map/Panels.jsx:65 | Docker app / Static website |
| Nothing is connected yet. Drag from a server, site or DockNest to this node, or connect one below. | map/Alerts.jsx:101 | Nothing connected. Drag a server, app or DockNest here. |
| Something must be fixed before this site can launch. | map/LaunchFlow.jsx:84 | Fix this before launch. |
| The old copy keeps your site online until then. When the domain points here, DockNest gets the certificate and you are done. | map/MoveFlow.jsx:184 | The old copy stays online until the domain points here. |
| Your site is back on the old server. / Site offline about | map/MoveFlow.jsx:190,85 | Your app is back on the old server. / App offline about |
| Not possible on this server. The test copy could send real email, so check that your site does not send mail while it is being tested. | map/MoveFlow.jsx:98 | Not possible here. The test copy could send real email. |
| Empty keeps the same count as the site. | copies/SiteStorageDialog.jsx:64 | Empty keeps the app's count. |
| Incremental backups need a Docker site on a server with the latest helper. | incremental/IncrementalDialog.jsx:49 | Needs a Docker app and the latest helper. |
| Could not save the site. Try again. / Fix it in the site settings or remove the path. / Check the SQLite files in the site settings. / ...in the site settings instead. / The site is offline for about | sqlite-fix.jsx:40-46 | Could not save. Try again. / Fix it in app settings or remove the path. |
| By site / Sites by size, scrollable / Open sites | storage-report.jsx:61 | By app / Apps by size / Open apps |
| Site backups are organized by server and site. DockNest recovery kits have their own folder. | storage-targets.jsx:25 | Backups are grouped by server and app. |
| Showing the latest 1,000 site backups. Use the backup library for other recovery points. / No site backups stored here yet. / Storage sites on | storage-targets.jsx:30,32,34 | Showing the latest 1,000. Use the library for more. / No backups here yet. |
| Used by a site / Site move | server-cleanup.jsx:13 | Used by an app / App move |
| Server and site names | report/ReportProblem.jsx:20 | Server and app names |
| Upload a fresh kit to the destination selected for your site backups. / Encrypted kit stored with your site backups, in a separate folder. | self-backup.jsx:30,59 | Upload a fresh kit to your backup storage. / Stored encrypted, in its own folder. |
| Nothing about your servers, sites or users is sent. | updates/dialogs.jsx:23 | Nothing about your servers, apps or users is sent. |
| Static site, nothing to check. | hardening.jsx:44 | Static website, nothing to check. |
| Design a calm pause for your visitors, then publish it to your sites. | maintenance-studio.jsx:19 | Design a maintenance page and publish it to your apps. |
| Saving updates your design. Deploy page publishes it to a site's maintenance proxy. Enable and Disable keep their existing confirmations and health checks. | maintenance-studio.jsx:46 | Save keeps the design. Deploy page publishes it to an app. |
| Server and storage connections, accounts, schedules, backup catalog, history, master key and recovery helpers. Website backup files stay in their existing storage destinations. | self-backup.jsx:64 | Settings, accounts, schedules, history and keys. Backup files stay where they are. |
| Keep your storage sign-in details, recovery passphrase, matching DockNest image or source and private deployment configuration separately. Download the saved kit from SFTP... | self-backup.jsx:64 | Keep your storage login, passphrase and deployment config separately. |
| File integrity is checked; fresh-server Linux Docker recovery has not been validated. A single copy cannot undo an older configuration mistake after a replacement. | self-backup.jsx:64 | File integrity is checked. Fresh-server recovery is not validated yet. |
| Continue to automatically create a dedicated backup key. Copy its installation command into the server's root shell on the next step. | server-wizard.jsx:28 | Next creates a backup key. You copy its install command in the next step. |
| Open PowerShell on your PC, paste this command and press Enter. Enter your server password or key passphrase there if requested. Verify any new host fingerprint... | server-wizard.jsx:29 | Run this command in PowerShell. Verify the host fingerprint. |
| Connecting tests SSH, Python 3 and Docker access before saving. No containers are stopped or changed. If the host key is rejected... | server-wizard.jsx:29 | Tests SSH, Python 3 and Docker before saving. Nothing is changed. |
| Choose a Docker project or static nginx website. Docker projects include their services; static websites include their files without stopping nginx. | site-wizard.jsx:123 | Choose a Docker app or a static website. |
| Select the app and its database or other services. Docker project labels suggest membership; check that shared services belong in this backup. | site-wizard.jsx:136 | Select the app and its database. Check shared services. |
| Docker empties these folders whenever the container restarts, so there is nothing in them to back up. A restore recreates them empty... Keep site files and database data in persistent mounts. | site-wizard.jsx:153 | Docker clears these on restart, so they are not backed up. |
| Use when a CDN blocks automated probes. Keeps the website hostname and verifies its HTTPS certificate, while connecting to 127.0.0.1... | site-wizard.jsx:165 | Use when a CDN blocks health checks. Connects locally. |
| Backups cannot be deleted or overwritten until the date you choose, even by DockNest or by someone who steals your key. Your bucket must have Object Lock turned on... | storage-targets.jsx:79 | Backups can't be deleted before this date. Needs Object Lock on the bucket. |
| Backup files stay on the selected destination. The dashboard keeps metadata and the encryption key. Choosing another destination affects new backups; existing backups remain... | storage-targets.jsx:128 | Backups stay on this destination. A new destination applies to new backups. |
| Only the Administrator can change this password. Changing it signs out every account, including yours. Existing authenticators remain enrolled. | main.jsx:140 | Only the administrator can change this. It signs everyone out. |
| Light and dark palettes, Roboto typography, 8 px surfaces, purple and blue accents. Light, Dark and System preferences are saved... Motion follows your device's reduced motion setting. | shell.jsx:39 | Choose a theme. Saved in this browser. |
| DockNest is unavailable for a few minutes while it restarts, and it shows only the update screen to everyone until the update ends. | updates/update-center.jsx:41 | DockNest is offline for a few minutes during the update. |
| You can also update on the DockNest host without the updater. The script picks the newest official release itself and pauses backups first. | updates/update-center.jsx:85 | You can also update from the host with the script. |
| The version in package.json, the release tag and the running image disagree. Nothing was changed. Check the server with these commands. | updates/update-center.jsx:89 | Versions disagree. Nothing changed. Run these checks. |
| The host updater has not verified the installed version yet, so it refused the last update. Nothing was changed... | updates/update-center.jsx:108 | The last update was refused. Nothing changed. |
| The update record was closed without a result. The DockNest host may still be working on the update. An administrator should check the host... | updates/lock-view.jsx:90 | The update has no result. Check the host before retrying. |
| Incremental backups (beta) comment only | incremental/IncrementalDialog.jsx:6 | Drop "beta" from comment; no user-facing label to change |
| Close / Done / Got it / Return to login | various (Close x6) | Keep "Close" for dialogs; use "Done" only after a task; drop "Got it" |
| Yes, check daily / Turn on checks / Back up now | hardening.jsx, main.jsx | Check daily / Turn on checks / Back up now |

## 3. Tokens

Source: `web/ds-v2/tokens-v2.css` (prototype; product CSS untouched). Contrast: `contrast.json` (computed, 128 pairs x 2 themes, all gated pairs pass). Tables below are generated from the CSS by `gen-doc.mjs`.

### Brand decision

| | Decision |
|---|---|
| Brand (actions) | **Purple, kept from 2.x (owner decision).** `--dn-brand-*` scale; solid #5E35B1 in light (white text 8.02:1). In dark the solid is #7A53D3, because #5E35B1 is only 2.24:1 against dark surfaces. Used for primary buttons, links, focus and purple metric tiles. |
| Chrome (navigation) | **Blue, kept from 2.x.** `--dn-chrome-*` scale; solid #1268D3 (white 5.32:1). Roles: `--dn-chrome-solid`, `-text`, `-surface`, `-indicator`, `-chip`. Used for the sidebar current item, header avatar, blue metric tiles, info notices and Map paths. |
| Logo | Unchanged (`--dn-brand-logo` #1577E3). |
| Charts | Purple and blue series from the two scales; status colours only for failures. |
| Rule | Colour is used with purpose, at the same level as the dashboard; never gradients or glows. |
| Info vs brand | Info uses the blue chrome scale (`--dn-info-*`). Notices are always text + icon, so sharing the hue with links is safe. |
| Upgrade | Theme mechanism is unchanged: `localStorage['docknest-theme']` → `<html data-theme>`, dark tokens only under `:root[data-theme=dark]`. 2.16.x users keep their light/dark/system choice. Update the meta `theme-color` in brand.jsx (#673AB7 → #F6F7F9 light / #16171A dark) when shipping. |

### Colour: neutrals and brand primitives

| Token | Light | Dark |
|---|---|---|
| `--dn-neutral-1` | #FCFCFD | #0F1013 |
| `--dn-neutral-2` | #F6F7F9 | #16171A |
| `--dn-neutral-3` | #EFF1F4 | #1D1F23 |
| `--dn-neutral-4` | #E7EAEE | #24272C |
| `--dn-neutral-5` | #DEE2E7 | #2B2F35 |
| `--dn-neutral-6` | #D3D8DF | #33373E |
| `--dn-neutral-7` | #C1C8D1 | #3F444C |
| `--dn-neutral-8` | #A3ACB8 | #555B65 |
| `--dn-neutral-9` | #76808E | #737A86 |
| `--dn-neutral-10` | #5E6876 | #959CA7 |
| `--dn-neutral-11` | #4D5562 | #B0B6BF |
| `--dn-neutral-12` | #171B21 | #ECEEF2 |

| Token | Light | Dark |
|---|---|---|
| `--dn-brand-1` | #F9F7FE | #14111C |
| `--dn-brand-2` | #F3EFFC | #1A1526 |
| `--dn-brand-3` | #E9E2FA | #231A38 |
| `--dn-brand-4` | #DDD2F7 | #2B1F48 |
| `--dn-brand-5` | #CDBDF2 | #342657 |
| `--dn-brand-6` | #B8A1EC | #3F2E6A |
| `--dn-brand-7` | #9F7EEB | #4E3A84 |
| `--dn-brand-8` | #7E57D6 | #9F7EEB |
| `--dn-brand-9` | #5E35B1 | #7A53D3 |
| `--dn-brand-10` | #4F2A99 | #7E57D6 |
| `--dn-brand-11` | #5A31AB | #B79DF2 |
| `--dn-brand-12` | #2E1A5C | #E6DCFD |
| `--dn-brand-logo` | #1577E3 | same |

| Token | Light | Dark |
|---|---|---|
| `--dn-green-solid` | #16794A | #16794A |
| `--dn-green-solid-hover` | #11663D | #1A8552 |
| `--dn-green-text` | #13693F | #6FD49D |
| `--dn-green-surface` | #EAF5EF | #13261C |
| `--dn-green-border` | #A8D5BC | #25553A |
| `--dn-amber-solid` | #F0B429 | #F0B429 |
| `--dn-amber-solid-hover` | #E0A215 | #F5C24F |
| `--dn-amber-ink` | #2B1D00 | same |
| `--dn-amber-text` | #7F5300 | #F0C564 |
| `--dn-amber-surface` | #FDF5E2 | #2A2113 |
| `--dn-amber-border` | #E8CC8A | #5E4719 |
| `--dn-red-solid` | #C8302F | #C8302F |
| `--dn-red-solid-hover` | #AF2626 | #D23B3A |
| `--dn-red-text` | #B02424 | #FF9E9E |
| `--dn-red-surface` | #FCEDED | #2E1719 |
| `--dn-red-border` | #EFB3B3 | #6A2B2E |
| `--dn-teal` | #0B7F78 | #3CC2B8 |


### Colour: semantic

Backgrounds:

| Token | Light | Dark |
|---|---|---|
| `--dn-bg-app` | #F6F7F9 (neutral-2) | #0F1013 (neutral-1) |
| `--dn-bg-surface` | #FFFFFF (white) | #16171A (neutral-2) |
| `--dn-bg-subtle` | #EFF1F4 (neutral-3) | #1D1F23 (neutral-3) |
| `--dn-bg-hover` | #E7EAEE (neutral-4) | #24272C (neutral-4) |
| `--dn-bg-pressed` | #DEE2E7 (neutral-5) | #2B2F35 (neutral-5) |
| `--dn-bg-selected` | #F3EFFC (brand-2) | #231A38 (brand-3) |
| `--dn-bg-raised` | #FFFFFF (white) | #1D1F23 (neutral-3) |
| `--dn-bg-inverse` | #171B21 (neutral-12) | #ECEEF2 (neutral-12) |
| `--dn-bg-overlay` | rgb(15 18 24 / 48%) | rgb(0 0 0 / 64%) |


Text (contrast vs surface; full matrix vs app, subtle, hover, selected in contrast.json):

| Token | Light | Dark | vs bg-surface L / D |
|---|---|---|---|
| `--dn-text-primary` | #171B21 (neutral-12) | #ECEEF2 (neutral-12) | 17.28 / 15.43 |
| `--dn-text-secondary` | #4D5562 (neutral-11) | #B0B6BF (neutral-11) | 7.52 / 8.78 |
| `--dn-text-tertiary` | #5E6876 (neutral-10) | #959CA7 (neutral-10) | 5.65 / 6.48 |
| `--dn-text-link` | #5A31AB (brand-11) | #B79DF2 (brand-11) | 8.53 / 7.78 |
| `--dn-text-link-hover` | #2E1A5C (brand-12) | #E6DCFD (brand-12) | 14.8 / 13.67 |
| `--dn-brand-text` | #5A31AB (brand-11) | #B79DF2 (brand-11) | 8.53 / 7.78 |

`--dn-text-disabled` (#A3ACB8 (neutral-8) / #555B65 (neutral-8)) is WCAG-exempt (inactive controls only). `--dn-text-on-solid` and `--dn-text-on-solid-muted` sit on solid fills (below).

Borders:

| Token | Light | Dark | vs bg-surface L / D |
|---|---|---|---|
| `--dn-border-strong` | #76808E (neutral-9) | #737A86 (neutral-9) | 4 / 4.15 |
| `--dn-border` | #D3D8DF (neutral-6) | #33373E (neutral-6) | 1.43 / 1.5 |
| `--dn-border-subtle` | #E7EAEE (neutral-4) | #2B2F35 (neutral-5) | 1.21 / 1.33 |

Only `--dn-border-strong` identifies a control (inputs, selects, checkboxes, switch-off track), so it is gated at 3:1. `--dn-border` and `--dn-border-subtle` are card edges and row dividers: decorative under WCAG 1.4.11, kept quiet on purpose.

Brand and status roles:

| Token | Light | Dark |
|---|---|---|
| `--dn-brand-solid` | #5E35B1 (brand-9) | same |
| `--dn-brand-solid-hover` | #4F2A99 (brand-10) | same |
| `--dn-brand-text` | #5A31AB (brand-11) | #B79DF2 (brand-11) |
| `--dn-brand-surface` | #F3EFFC (brand-2) | #231A38 (brand-3) |
| `--dn-brand-surface-hover` | #E9E2FA (brand-3) | #2B1F48 (brand-4) |
| `--dn-brand-border` | #CDBDF2 (brand-5) | #3F2E6A (brand-6) |
| `--dn-selected-indicator` | #5E35B1 (brand-9) | #B79DF2 (brand-11) |

| Token | Light | Dark |
|---|---|---|
| `--dn-success-solid` | #16794A (green-solid) | same |
| `--dn-success-solid-hover` | #11663D (green-solid-hover) | same |
| `--dn-success-text` | #13693F (green-text) | same |
| `--dn-success-surface` | #EAF5EF (green-surface) | same |
| `--dn-success-border` | #A8D5BC (green-border) | same |
| `--dn-warning-solid` | #F0B429 (amber-solid) | same |
| `--dn-warning-solid-hover` | #E0A215 (amber-solid-hover) | same |
| `--dn-warning-text` | #7F5300 (amber-text) | same |
| `--dn-warning-surface` | #FDF5E2 (amber-surface) | same |
| `--dn-warning-border` | #E8CC8A (amber-border) | same |
| `--dn-warning-on-solid` | #2B1D00 (amber-ink) | same |
| `--dn-danger-solid` | #C8302F (red-solid) | same |
| `--dn-danger-solid-hover` | #AF2626 (red-solid-hover) | same |
| `--dn-danger-text` | #B02424 (red-text) | same |
| `--dn-danger-surface` | #FCEDED (red-surface) | same |
| `--dn-danger-border` | #EFB3B3 (red-border) | same |
| `--dn-info-solid` | #1268D3 (chrome-9) | same |
| `--dn-info-solid-hover` | #0E5BBB (chrome-10) | same |
| `--dn-info-text` | #0D56AF (chrome-11) | #86B9F7 (chrome-11) |
| `--dn-info-surface` | #EDF4FE (chrome-2) | #111C2B (chrome-2) |
| `--dn-info-border` | #B5D1F8 (chrome-5) | #224A84 (chrome-6) |


Key pairs:

| Foreground | Background | Min | Light | Dark |
|---|---|---|---|---|
| `--dn-text-on-solid` | `--dn-brand-solid` | 4.5 | 8.02 | 5.24 |
| `--dn-text-on-solid` | `--dn-brand-solid-hover` | 4.5 | 9.89 | 4.97 |
| `--dn-text-on-solid-muted` | `--dn-brand-solid` | 4.5 | 7.05 | 4.71 |
| `--dn-text-on-solid` | `--dn-danger-solid` | 4.5 | 5.36 | 5.36 |
| `--dn-text-on-solid` | `--dn-success-solid` | 4.5 | 5.43 | 5.43 |
| `--dn-warning-on-solid` | `--dn-warning-solid` | 4.5 | 8.81 | 8.81 |
| `--dn-success-text` | `--dn-success-surface` | 4.5 | 6.03 | 8.76 |
| `--dn-warning-text` | `--dn-warning-surface` | 4.5 | 6.16 | 9.71 |
| `--dn-danger-text` | `--dn-danger-surface` | 4.5 | 5.91 | 8.49 |
| `--dn-info-text` | `--dn-info-surface` | 4.5 | 6.39 | 8.41 |
| `--dn-text-tertiary` | `--dn-bg-hover` | 4.5 | 4.68 | 5.42 |
| `--dn-text-tertiary` | `--dn-bg-subtle` | 4.5 | 4.99 | 5.97 |
| `--dn-brand-text` | `--dn-bg-selected` | 4.5 | 7.54 | 7.14 |
| `--dn-border-strong` | `--dn-bg-surface` | 3 | 4 | 4.15 |
| `--dn-border-strong` | `--dn-bg-hover` | 3 | 3.32 | 3.47 |
| `--dn-switch-track-off` | `--dn-bg-surface` | 3 | 4 | 4.15 |
| `--dn-switch-thumb` | `--dn-switch-track-off` | 3 | 4 | 4.32 |
| `--dn-brand-solid` | `--dn-bg-surface` | 3 | 8.02 | 3.42 |
| `--dn-selected-indicator` | `--dn-bg-surface` | 3 | 8.02 | 7.78 |
| `--dn-success-border` | `--dn-success-surface` | decor. | 1.46 | 1.85 |
| `--dn-danger-border` | `--dn-danger-surface` | decor. | 1.57 | 1.59 |

Status borders are decorative (the alert is identified by its tinted fill, icon and text).

Warning solid carries dark ink (`--dn-warning-on-solid`, #2B1D00) in both themes: amber can't carry white text.

### Focus rule

| Spec | Value |
|---|---|
| Ring | `outline: var(--dn-focus-ring)` = 2px solid `--dn-focus-color` (#5E35B1 light / #B79DF2 dark), `outline-offset: 2px` |
| Contrast | min 6.64 (light, on hover bg) / 6.51 (dark); gate 3:1 vs every background incl. selected + brand surface |
| Trigger | `:focus-visible` only. Global `:focus:not(:focus-visible){outline:none}`. Containers use `:has(:focus-visible)`, never `:focus-within`. Text inputs show the ring on click because browsers match `:focus-visible` for them, which is correct. |
| Inset exception | Rows inside a scrolling list (e.g. `.cx-opt`, `.uc-recent-toggle`) keep `outline-offset:-2px` so the ring is not clipped. Same colour and width. |
| Never | box-shadow rings, glows, colour-only focus, `outline:none` without a replacement |

### Typography

| Token | Size / line | Role | Weight |
|---|---|---|---|
| `--dn-text-xs` | 12 / 16 | caption, table header, badge, nav group label | 400 / 500 |
| `--dn-text-sm` | 14 / 20 | body, controls, table cell (default) | 400 / 500 |
| `--dn-text-md` | 16 / 24 | card + section title, empty-state title | 600 |
| `--dn-text-lg` | 20 / 28 | dialog title | 600 |
| `--dn-text-xl` | 24 / 32 | page title (tracking -0.011em) | 600 |
| `--dn-text-2xl` | 32 / 40 | metric numerals, status code | 600 |

Weights: 400 / 500 / 600 only (no 700/900). Font: Roboto Variable; mono: ui-monospace stack. Prose max 68ch. **Large-screen type scaling (1920/2560) is dropped**: it broke fixed row heights and OS/browser zoom already does it. Only margins and card columns respond to width.

### Space, size, radius, border, elevation

| Group | Tokens |
|---|---|
| Space (4px base) | `0`=0, `0-5`=2px, `1`=4px, `2`=8px, `3`=12px, `4`=16px, `5`=20px, `6`=24px, `8`=32px, `10`=40px, `12`=48px, `16`=64px |
| Controls | sm 32 (table rows, nav), md 40 (default), touch 44 (all controls <=767px) |
| Rows | header 40, row 56, two-line 72, card footer 64 |
| Radius | sm 4 (badge, checkbox), md 6 (button, input, tab, nav item), lg 8 (card, panel, dialog, popover, toast), full (switch, avatar) |
| Border width | 1px default; 2px for selection indicators (tab underline, map domain ring) and focus |

| Elevation | Light | Dark | Use |
|---|---|---|---|
| `--dn-shadow-1` | 0 1px 2px rgb(16 24 40 / 6%) | 0 1px 2px rgb(0 0 0 / 40%) | map nodes and controls |
| `--dn-shadow-2` | 0 1px 2px rgb(16 24 40 / 6%),0 4px 12px rgb(16 24 40 / 8%) | 0 1px 2px rgb(0 0 0 / 40%),0 4px 12px rgb(0 0 0 / 32%) | popover, menu, toast, map panel |
| `--dn-shadow-3` | 0 2px 4px rgb(16 24 40 / 6%),0 12px 32px rgb(16 24 40 / 14%) | 0 2px 4px rgb(0 0 0 / 40%),0 12px 32px rgb(0 0 0 / 48%) | dialog |

Cards, panels and buttons are flat (border only). No glows, no coloured shadows, no gradients.

### Motion

| Token | Value | Use |
|---|---|---|
| `--dn-dur-fast` | 100ms | hover/press colour, border |
| `--dn-dur-base` | 150ms | switch thumb, chevron rotate, popover in, theme crossfade |
| `--dn-dur-slow` | 200ms | dialog in, sidebar collapse/slide, toast in |
| `--dn-dur-max` | 300ms | hard ceiling (progress-bar width) |
| `--dn-ease-standard` | cubic-bezier(.2,0,0,1) | state change |
| `--dn-ease-enter` / `--dn-ease-exit` | (0,0,.2,1) / (.4,0,1,1) | elements entering / leaving |

| Allowed | Banned |
|---|---|
| State-change feedback (hover, press, toggle, validation) | Decorative motion: page/card/panel entrance fades (`dn-enter` on .card/.panel/.alert-panel/.dash-*), drifting login art (`lg-sway` 52s), bell wiggle (`berry-ring`) |
| Spatial continuity: dialog open, popover, drawer/sidebar slide, panel slide, toast in | Looping except spinners and progress (`dn-pulse` timeline dot removed; `dn-spin`, `map-spin`, `dn-orbit` kept) |
| Spinners, progress bars | Bouncy or overshoot easing; anything > 300ms (sidebar 425ms, theme 380ms, Chart.js 800ms) |
| | `transition: all` (none found today; keep it that way), `transform: scale()` on :active (style.css `scale(.97)`), scale-in popovers (`berry-pop` .92) |

**prefers-reduced-motion: reduce** → every animation and transition is cut to 1ms and one iteration; the view-transition theme crossfade is off. Spinners stop; the status text still states progress. Chart.js already disables animation in JS; its default 800ms (charts.jsx) must drop to 200ms or none.

### Breakpoints and layout grid

| Range | Name | Columns | Gutter | Margin (`--dn-layout-margin`) | Card columns | Header | Controls |
|---|---|---|---|---|---|---|---|
| <=767 | mobile | 4 | 16 | 16 | 1 | 56 | 44 touch |
| 768-1279 | tablet | 8 | 24 | 24 | 2 | 64 | 40 |
| 1280-1919 | desktop | 12 | 24 | 32 | 3 | 64 | 40 |
| >=1920 | wide | 12 | 24 | 32 | 4 | 64 | 40 |

Max widths: `--dn-layout-max` 1440px (settings, detail, wizard pages), `--dn-layout-max-wide` 2400px (tables, map, dashboard), `--dn-form-max` 640px. Sidebar 256 / 72 collapsed. Existing one-off breakpoints (480, 599, 680, 899, 1023, 1199, 1440) should fold into 767/1279/1920 during migration. CSS can't read custom properties inside media queries, so `--dn-bp-*` are reference values.

### Z-index

| Token | Value | Owner today |
|---|---|---|
| `--dn-z-base` | 0 | flow |
| `--dn-z-raised` | 1 | local stacking (z 1-3) |
| `--dn-z-map-overlay` | 4 | .map-panel |
| `--dn-z-sticky` | 10 | .modal-head, sticky table heads |
| `--dn-z-dropdown` | 30 | .cx-pop, .chart-export-menu (5 → 30) |
| `--dn-z-sidebar-backdrop` | 80 | .berry-nav-backdrop |
| `--dn-z-sidebar` | 90 | .berry-sidebar |
| `--dn-z-header` | 100 | .berry-header |
| `--dn-z-drawer` | 110 | .berry-customizer, .compact-storage-details |
| `--dn-z-dialog` | 1000 | non-modal overlays (dialog uses top layer) |
| `--dn-z-fullscreen` | 2000 | .status-screen, .skip |
| `--dn-z-progress` | 2500 | .progress-view |
| `--dn-z-toast` | 3000 | .toast-wrap |

### 3.0.0 feature tokens

All map onto existing semantics. No new hues.

| Feature | Tokens | Light / Dark | Contrast gate |
|---|---|---|---|
| Map domain ring | `--dn-map-domain-ring` 2px + `--dn-map-domain-fill` + `--dn-map-domain-label` | #3F86E6 / #4C8CE6 | ring vs canvas 3.22 / 4.87 (>=3) |
| Map path panel / route highlight | `--dn-map-path` (2px stroke), `--dn-map-path-idle`, `--dn-map-dim-opacity` .4 for off-route nodes | #1268D3 / #86B9F7 | 4.7 / 8.09 |
| Map selected node | `--dn-map-node-selected` (1px ring + border) | #1268D3 / #86B9F7 | 4.7 / 8.09 |
| Keys safe: locked | `--dn-safe-locked-surface/-text/-icon` = subtle bg, primary text, success padlock | | text 15.27 / 14.21; icon 5.95 / 9.1 |
| Keys safe: unlocked | `--dn-safe-unlocked-*` = warning (open safe is a temporary exposure) | | text 6.16 / 9.71 |
| K-of-N share: pending | surface + dashed `--dn-border-strong` + secondary text | | border 4 / 4.15; text 7.52 / 8.78 |
| K-of-N share: issued | brand surface/border/text | | 7.54 / 7.14 |
| K-of-N share: confirmed | success surface/border/text | | 6.03 / 8.76 |
| Missed-run alert | `--dn-alert-missed-*` = warning; 2+ consecutive misses use danger (product rule to confirm) | | 6.16 / 9.71 |
| Restore test from off-site copy | status labels: running = info, passed = success, failed = danger; "off-site" source = neutral badge + cloud icon | | semantic text pairs |
| Portainer / Dockge import | per-row status: will import = brand text, skipped = tertiary, conflict = warning; source = neutral badge | | semantic text pairs |
| Online DB dumps | "live dump" = info badge; failure = danger | | semantic text pairs |
| Append-only SFTP | `--dn-badge-immutable-*`: the only inverse chip (near-black on light, near-white on dark) + lock icon | #171B21 / #ECEEF2 | 16.85 / 16.38 |
| Charts | `--dn-viz-1..4` backup (brand), restore (violet), unverified (teal), failed (danger); `--dn-viz-area` | | min 4.97 / 5.29 vs surface |

### Contrast summary (minimum per category)

| Category | Gate | Light min | Dark min |
|---|---|---|---|
| text | 4.5 | 4.68 (text-tertiary on bg-hover) | 5.42 (text-tertiary on bg-hover) |
| text-on-solid | 4.5 | 4.76 (text-on-solid-muted on chrome-solid) | 4.71 (text-on-solid-muted on brand-solid) |
| semantic-text | 4.5 | 5.91 (warning-text on bg-subtle) | 8.09 (info-text on bg-subtle) |
| feature-text | 4.5 | 4.99 (text-tertiary on map-canvas) | 5.97 (text-tertiary on map-canvas) |
| large-text | 3 | 5.27 (text-tertiary on bg-app) | 6.48 (text-tertiary on bg-surface) |
| ui-border | 3 | 3.32 (border-strong on bg-hover) | 3.47 (border-strong on bg-hover) |
| focus-ring | 3 | 6.64 (focus-color on bg-hover) | 6.51 (focus-color on bg-hover) |
| ui-solid-vs-surface | 3 | 5 (danger-solid on bg-app) | 3.15 (brand-solid on bg-subtle) |
| ui-state | 3 | 3.54 (switch-track-off on bg-subtle) | 3.82 (switch-track-off on bg-subtle) |
| feature-graphic | 3 | 3.22 (map-domain-ring on map-canvas) | 4.15 (share-pending-border on bg-surface) |
| data-viz | 3 | 4.97 (viz-1 on bg-surface) | 5.29 (viz-3 on bg-surface) |
| decorative | — | 1.13 (border-subtle on bg-app) | 1.33 (border-subtle on bg-surface) |

### Legacy → v2 mapping (every 2.16.x custom property)

Mechanical migration: the alias block in tokens-v2.css keeps every legacy name working. Replace usages file by file, then delete the alias line. Values marked "/" are light / dark.

| Legacy token | 2.16.x light / dark | v2 token | v2 light / dark |
|---|---|---|---|
| `--primary-light` | #E7F0FB / #242F3E | `--dn-chrome-surface` | #EDF4FE / #132843 |
| `--primary-main` | #3B82E0 / #5BA3F0 | `--dn-chrome-8` | #3F86E6 / #4C8CE6 |
| `--primary-dark` | #2F73CF / #5BA3F0 | `--dn-chrome-solid` | #1268D3 |
| `--primary-deep` | #1B5FB3 / #8DBFF5 | `--dn-chrome-text` | #0D56AF / #86B9F7 |
| `--secondary-light` | #EFEBF7 / #2E2A38 | `--dn-brand-surface` | #F3EFFC / #231A38 |
| `--secondary-main` | #6D44C4 / #C2A8FA | `--dn-brand-solid` | #5E35B1 / #7A53D3 |
| `--secondary-dark` | #5E35B1 / #BEA3F8 | `--dn-brand-solid` | #5E35B1 / #7A53D3 |
| `--secondary-deep` | #4527A0 / #D8C6FC | `--dn-brand-text` | #5A31AB / #B79DF2 |
| `--background` | #F6F4F9 / #121113 | `--dn-bg-app` | #F6F7F9 / #0F1013 |
| `--surface` | #FFFFFF / #1A191C | `--dn-bg-surface` | #FFFFFF / #16171A |
| `--surface-muted` | #FBFAFD / #201F24 | `--dn-bg-subtle` | #EFF1F4 / #1D1F23 |
| `--surface-hover` | #EFECF4 / #2B292F | `--dn-bg-hover` | #E7EAEE / #24272C |
| `--text-primary` | #38333F / #DAD7E0 | `--dn-text-primary` | #171B21 / #ECEEF2 |
| `--heading` | #1B1722 / #F4F2F7 | `--dn-text-primary` | #171B21 / #ECEEF2 |
| `--text-secondary` | #524D5E / #ABA7B5 | `--dn-text-secondary` | #4D5562 / #B0B6BF |
| `--text-muted` | #656070 / #9692A1 | `--dn-text-tertiary` | #5E6876 / #959CA7 |
| `--border-subtle` | #E2DEEA / #35323B | `--dn-border-subtle` | #E7EAEE / #2B2F35 |
| `--border-control` | #7C7889 / #706D7B | `--dn-border-strong` | #76808E / #737A86 |
| `--accent` | #5E35B1 / #BEA3F8 | `--dn-brand-solid` | #5E35B1 / #7A53D3 |
| `--accent-soft` | #EFEBF7 / #2E2A38 | `--dn-brand-surface` | #F3EFFC / #231A38 |
| `--accent-hover` | #4527A0 / #D8C6FC | `--dn-brand-solid-hover` | #4F2A99 / #7E57D6 |
| `--link` | #5E35B1 / #C2A8FA | `--dn-text-link` | #5A31AB / #B79DF2 |
| `--focus-ring` | #6D44C4 / #C2A8FA | `--dn-focus-color` | #5E35B1 / #B79DF2 |
| `--primary-foreground` | #FFFFFF | `--dn-text-on-solid` | #FFFFFF |
| `--button-primary` | #5E35B1 / #7F55DA | `--dn-brand-solid` | #5E35B1 / #7A53D3 |
| `--button-primary-hover` | #4527A0 / #6E45C8 | `--dn-brand-solid-hover` | #4F2A99 / #7E57D6 |
| `--success` | #21704A / #7ADBA7 | `--dn-success-text` | #13693F / #6FD49D |
| `--success-surface` | #E9F1ED / #293832 | `--dn-success-surface` | #EAF5EF / #13261C |
| `--warning` | #835A00 / #EBC46F | `--dn-warning-text` | #7F5300 / #F0C564 |
| `--warning-surface` | #F3EFE6 / #3B3429 | `--dn-warning-surface` | #FDF5E2 / #2A2113 |
| `--error` | #C62828 / #FFA3AE | `--dn-danger-text` | #B02424 / #FF9E9E |
| `--error-surface` | #F9EAEA / #3F2F33 | `--dn-danger-surface` | #FCEDED / #2E1719 |
| `--info` | #1B5FB3 / #80BAF5 | `--dn-info-text` | #0D56AF / #86B9F7 |
| `--info-surface` | #E8EFF7 / #2A333F | `--dn-info-surface` | #EDF4FE / #111C2B |
| `--dialog-edge` | transparent / var(--border-subtle) | `--dn-border` | #D3D8DF / #33373E |
| `--backdrop` | rgb(27 23 34 / 45%) / rgb(0 0 0 / 70%) | `--dn-bg-overlay` | rgb(15 18 24 / 48%) / rgb(0 0 0 / 64%) |
| `--shadow` | rgb(27 23 34 / 16%) / rgb(0 0 0 / 40%) | rgb(16 24 40 / 10%) | rgb(16 24 40 / 10%) |
| `--transparent` | transparent | transparent | transparent |
| `--qr-background` | #FFFFFF | `--dn-white` | #FFFFFF |
| `--storage-decoration` | #91B9EE / #37587C | `--dn-brand-surface-hover` | #E9E2FA / #2B1F48 |
| `--sidebar-storage-accent` | var(--primary-deep) | `--dn-chrome-text` | #0D56AF / #86B9F7 |
| `--sidebar-nav-accent` | var(--primary-deep) | `--dn-chrome-text` | #0D56AF / #86B9F7 |
| `--sidebar-nav-soft` | var(--primary-light) | `--dn-chrome-surface` | #EDF4FE / #132843 |
| `--metric-purple` | #5E35B1 / #402E66 | `--dn-brand-solid` | #5E35B1 / #7A53D3 |
| `--metric-purple-decoration` | #4527A0 / #30224F | `--dn-brand-solid-hover` | #4F2A99 / #7E57D6 |
| `--metric-blue` | #1B5FB3 / #184E77 | `--dn-chrome-solid` | #1268D3 |
| `--metric-blue-decoration` | #164E93 / #123D5E | `--dn-chrome-solid-hover` | #0E5BBB / #1A6FDA |
| `--metric-period` | #18549E / #27699B | `--dn-chrome-solid-hover` | #0E5BBB / #1A6FDA |
| `--on-solid` | #FFFFFF | `--dn-text-on-solid` | #FFFFFF |
| `--metric-purple-label` | #D1C4E9 | `--dn-text-on-solid-muted` | rgb(255 255 255 / 92%) |
| `--metric-blue-label` | #BBDEFB | `--dn-text-on-solid-muted` | rgb(255 255 255 / 92%) |
| `--metric-blue-soft` | #E3F2FD | `--dn-text-on-solid-muted` | rgb(255 255 255 / 92%) |
| `--chart-backup` | #9E7EB5 / #C4A4DA | `--dn-viz-1` | #7E57D6 / #9F7EEB |
| `--chart-unverified` | #4E7FC4 / #9E7EB5 | `--dn-viz-3` | #1268D3 / #4C8CE6 |
| `--chart-restore` | #5E35B1 / #BEA3F8 | `--dn-viz-2` | #4F2A99 / #B79DF2 |
| `--chart-failed` | #7A7585 / #7FAEE0 | `--dn-viz-4` | #C8302F / #FF9E9E |
| `--chart-area` | rgba(94,53,177,.25) / rgba(190,163,248,.25) | `--dn-viz-area` | rgb(94 53 177 / 12%) / rgb(159 126 235 / 18%) |
| `--header-control` | var(--primary-dark) | `--dn-text-secondary` | #4D5562 / #B0B6BF |
| `--header-control-hover` | var(--primary-deep) | `--dn-text-primary` | #171B21 / #ECEEF2 |
| `--header-profile` | var(--primary-light) | transparent | transparent |
| `--header-profile-hover` | var(--primary-light) | `--dn-bg-hover` | #E7EAEE / #24272C |
| `--header-avatar` | #1B5FB3 | `--dn-chrome-solid` | #1268D3 |
| `--header-avatar-hover` | #164E93 | `--dn-chrome-solid-hover` | #0E5BBB / #1A6FDA |
| `--alert-error-border` | #E9ADAD / #7A5359 | `--dn-danger-border` | #EFB3B3 / #6A2B2E |
| `--alert-error-text` | #AE2323 / #FFB5BE | `--dn-danger-text` | #B02424 / #FF9E9E |
| `--alert-warning-border` | #D0C09E / #72613F | `--dn-warning-border` | #E8CC8A / #5E4719 |
| `--alert-warning-text` | #734F00 / #EFD08C | `--dn-warning-text` | #7F5300 / #F0C564 |
| `--alert-info-border` | #A8C2E2 / #455D77 | `--dn-info-border` | #B5D1F8 / #224A84 |
| `--alert-info-text` | #18549E / #99C8F7 | `--dn-info-text` | #0D56AF / #86B9F7 |
| `--muted` | var(--text-muted) | `--dn-text-tertiary` | #5E6876 / #959CA7 |
| `--line` | var(--border-subtle) | `--dn-border-subtle` | #E7EAEE / #2B2F35 |
| `--cream` | var(--surface) | `--dn-bg-surface` | #FFFFFF / #16171A |
| `--sage` | var(--primary-main) | `--dn-brand-solid` | #5E35B1 / #7A53D3 |
| `--brand-accent` | var(--accent) | `--dn-brand-solid` | #5E35B1 / #7A53D3 |
| `--fs-title` | 24px | `--dn-text-xl` | 24px |
| `--lh-title` | 32px | `--dn-leading-xl` | 32px |
| `--fs-card` | 20px | `--dn-text-lg` | 20px |
| `--lh-card` | 28px | `--dn-leading-lg` | 28px |
| `--fs-section` | 16px | `--dn-text-md` | 16px |
| `--lh-section` | 24px | `--dn-leading-md` | 24px |
| `--fs-body` | 14px | `--dn-text-sm` | 14px |
| `--lh-body` | 20px | `--dn-leading-sm` | 20px |
| `--fs-caption` | 12px | `--dn-text-xs` | 12px |
| `--lh-caption` | 16px | `--dn-leading-xs` | 16px |
| `--fs-button` | 14px | `--dn-text-sm` | 14px |
| `--lh-button` | 20px | `--dn-leading-sm` | 20px |
| `--radius` | 8px | `--dn-radius-lg` | 8px |
| `--radius-input` | 8px | `--dn-radius-md` | 6px |
| `--spacing` | 8px | `--dn-space-2` | 8px |
| `--sidebar-width` | 260px | `--dn-sidebar-w` | 256px |
| `--header-height` | 88px | `--dn-header-h` | 56px |
| `--edge` | 16px | `--dn-layout-margin` | 16px |
| `--content-max` | none | `--dn-layout-max-wide` | 2400px |
| `--grid-columns` | 1 | `--dn-card-columns` | 1 |
| `--control-height` | 40px | `--dn-control-h` | 40px |
| `--row-height` | 56px | `--dn-row-h` | 56px |
| `--header-row-height` | 40px | `--dn-row-h-header` | 40px |
| `--card-footer-height` | 64px | `--dn-footer-h` | 64px |
| `--section-gap` | 24px | `--dn-section-gap` | 24px |
| `--dur-fast` | 120ms | `--dn-dur-fast` | 100ms |
| `--dur-base` | 160ms | `--dn-dur-base` | 150ms |
| `--dur-slow` | 240ms | `--dn-dur-slow` | 200ms |
| `--ease` | cubic-bezier(.2,0,0,1) | `--dn-ease-standard` | cubic-bezier(.2,0,0,1) |
| `--dn-motion-fast` | updates.css | `--dn-dur-fast` | 100ms |
| `--dn-motion-base` | updates.css | `--dn-dur-base` | 150ms |
| `--dn-motion-slow` | updates.css | `--dn-dur-slow` | 200ms |
| `--dn-ease-out` | updates.css | `--dn-ease-enter` | cubic-bezier(0,0,.2,1) |
| `--rail` (shell.css, scoped `.berry-shell`) | 260px / 72px collapsed | `--dn-sidebar-w` / `--dn-sidebar-w-collapsed` | 256px / 72px |
| `--table-row-height` (tables.css, rebrand.css, scoped `.stable-table`; read by pagination.jsx) | var(--row-height) then 76px | `--dn-row-h-2line` | 72px |
| `--header-height` (also shell.css :root, 64px <=767) | 88px / 64px | `--dn-header-h` | 56px <=767, 64px >=768 |
| `--page-height` (inline style from pagination.jsx) | runtime px | not a token | layout state; keep |
| `.auth-page` scoped re-points (auth.css: --button-primary, --accent, --link, --focus-ring, --header-control*, --primary-foreground) | var(--heading) etc. | unchanged | resolve through aliases; monochrome auth screen survives |

Notes: `charts.jsx` reads `--chart-area` and string-replaces `.25`; v2 `--dn-viz-area` has no `.25`, so the gradient flattens (fine: gradients are banned; switch to a solid area fill). `--metric-*` alias to brand solid so 2.16 markup stays legible; the prototype layer turns metric tiles into neutral cards.

## 4. Component rules

Shared state model for every interactive component:

| State | Rule |
|---|---|
| Default | Token colours only. Border `--dn-border-strong` for controls, `--dn-border-subtle` for containers. |
| Hover | One step on the neutral or brand scale (`--dn-bg-hover`, brand-10). No shadow change, no movement. `@media (hover:hover)` only. |
| Active (pressed) | One more step (`--dn-bg-pressed`). No `transform:scale`. |
| Focus-visible | `outline: var(--dn-focus-ring); outline-offset: var(--dn-focus-offset)`. Never on `:focus` alone. `outline:none` is allowed only on `:focus:not(:focus-visible)`. |
| Disabled | `--dn-text-disabled` on `--dn-bg-subtle`, `cursor:not-allowed`. No `opacity:.45` on the whole element (it fails contrast and fades icons unevenly). Explain why via adjacent text when the reason is not obvious. |
| Loading | Keep width (no layout shift); replace leading icon with the 16px spinner; `aria-busy=true`; label becomes the progressive verb ("Saving"). Disable repeat clicks. |
| Selected / current | Brand-9 indicator (2px bar or underline) plus `--dn-text-primary`. Never colour alone: add `aria-current` / `aria-selected`. |

### Button

Anatomy: [icon 16] label [trailing icon 16, rare]. Radius `--dn-radius-md`. Weight 500. `--dn-text-sm`.

| Variant | Use | Look |
|---|---|---|
| Primary | The one main action of a view or dialog | brand-9 fill, white text |
| Secondary (default `button`) | All other actions | surface fill, strong border |
| Ghost (replaces `.text`) | Low-emphasis, toolbars, table row actions | no fill, no border, text-secondary; hover bg-hover |
| Danger | Destructive confirm in a dialog only | danger solid fill; in-page delete triggers are Secondary with danger text |
| Icon | Icon only, always has `aria-label` and a tooltip | square, same height as size |

Sizes: `sm` 32px (tables, dense toolbars, desktop only), `md` 40px (default), touch 44px (auto under 768px via `--dn-control-h`). Padding x 12/16px. Min width only in dialogs footers (96px).
Do: verb label ("Back up now", "Add app"); put Primary last (right) in footers; one Primary per view.
Don't: two Primary buttons side by side; full-width buttons on desktop; gradient, glow or shadow on buttons; uppercase labels; icon-only without a label for a non-universal action.

### Input, select, textarea

Anatomy: label (above, 14/500), control, help or error text (12/400) below. Height `--dn-control-h`. Radius md. Border strong; hover brand-8; focus-visible ring (the ring, not a border colour swap).
Error: border and message in danger-text, message starts with a Tabler `alert-circle` 16 icon, `aria-invalid` + `aria-describedby`. Keep the user's input.
Do: real `<label>`; units and formats in help text ("Hours, 1 to 720"). Don't: placeholder as label; placeholder with real-looking example data; required asterisk without the legend "Required".

### Switch and checkbox

Switch = immediate effect setting (saves on toggle, shows a quiet "Saved" status). Checkbox = choice applied by a later Save/Submit. Never mix in one form. Hit area 44px; visual track 36x20. Label to the left of a switch in settings rows, to the right of a checkbox.

### List row (replaces stacked outlined buttons)

Used in Map panels, Apps cards, Storage, Servers and the domain list. Anatomy: [icon chip] title + meta line [status pill] [overflow menu] [chevron].
- The whole row is the click target that opens details: hover bg-hover, focus-visible ring, trailing Tabler `chevron-right`.
- Secondary actions (Move to…, Edit…, Delete…) live in one overflow menu per row: a 32px Ghost icon button with Tabler `dots`, `aria-label="More actions for <name>"`.
- At most one visible primary action per panel or card, as a small button or a text link with an icon (Map server card: "+ Add app").
- Status rows (such as a domain with "Needs review") use the same row with a status pill; no extra button.
- Don't: two or more bordered buttons stacked in a row or card; a "Details" button when the row itself can open details.

### Table

Header row 40px, `--dn-text-xs` 500 text-secondary, no fill colour change on desktop. Body row 56px (72px two-line). Dividers subtle. Numbers right aligned, tabular. Row hover bg-hover only when the row is clickable. Row actions: Ghost `sm` buttons, max 2 visible, rest in a "More" menu (`dots`). Under 768px: stacked labelled records (existing `.mobile-table` pattern becomes the only one).

### Card / panel

One container: surface, 1px subtle border, radius lg, **no shadow** (shadow-1 only for draggable/raised Map nodes). Head 16/600 + optional one action; body padding 24 (16 on mobile). Don't nest cards in cards; use a divider or a subtle section instead. Metric tiles (owner decision: keep the coloured purple and blue fills): one row on the grid (4 x 3 cols desktop, 2 x 2 tablet, stacked mobile), equal heights, value `--dn-text-2xl`, label xs, white text that passes AA on the fill. Other pages reuse the dashboard's coloured icon chips and header accents rather than inventing new colour uses.

### Dialog

Sizes: sm 440 (confirm), md 640 (forms), lg 880 (details). Radius lg, shadow-3, backdrop `--dn-bg-overlay`. Head: title lg/600 + close icon button. Footer: right-aligned, Secondary "Cancel" then the Primary/Danger verb. Focus moves to the first field, or to Cancel for destructive confirms. Esc closes unless a job is being started. Enter animation: 150ms opacity + 4px translate; exit 100ms; none under reduced motion.

### Tabs

Underline tabs only (one style). 40px high, text-secondary, current = text-primary + 2px brand-9 underline. Scroll horizontally on mobile, never wrap. Segmented control is a separate component for 2-4 view options (e.g. list/map), not for navigation.

### Badge / status pill

One component, `--dn-radius-sm`, 20px high, xs/500, semantic surface + semantic text + 6px dot. Statuses map 1:1: Healthy/Completed = success, Running = info (static dot; no pulsing), Warning/Missed = warning, Failed = danger, Paused/Unknown = neutral. Text always present; dot never alone.

### Alert / banner / inline notice

Three forms only: inline notice (in a panel), page banner (top of content, dismissible when informational), toast (transient). Anatomy: icon 20, title (optional, 600), one sentence, optional one action link/button. Surface + border + text from the semantic set. No coloured left border stripe plus fill plus icon at once: fill + icon is enough.

### Empty, loading, error states

- Empty: Tabler icon 24 in a neutral 40px square, title md ("No apps yet"), one sentence, one Primary action. Same component everywhere (replaces 4 `.empty` variants and 10 bespoke ones).
- Loading: skeleton rows matching final layout for lists/tables; inline 16px spinner for buttons; full-page spinner only before auth. No shimmer sweep; static skeleton at bg-subtle.
- Error: what happened + what to do + Retry button. Technical detail behind a "Details" disclosure.

### Navigation (sidebar, header)

Items 36px high (44 on touch), radius md, icon 20 + label 14/500. Current item: blue chrome soft fill + blue icon (2.x roles kept). Section labels xs/500 text-tertiary, Title Case, no uppercase tracking tricks. Nav labels and page titles use Title Case: "Apps & Schedules", "Self Backup", "Recovery Guide", "Update Center". "Self Backup" (sub-title "DockNest's own settings and keys") replaces "DockNest backup"; keep each name a single string constant so it can be renamed in one place. Mobile drawer slides 200ms enter-ease; no 425ms width animation. Header: page title lives in content, not duplicated in header.

### Toast

Bottom-right desktop, bottom full-width mobile above safe area. Max 1 line + action ("Undo"). Auto-dismiss 5s for success, persistent for errors. Enter 150ms fade+translate, exit 100ms fade.

### Stepper / wizard

Horizontal numbered steps (desktop/tablet), "Step 2 of 4 - Choose containers" text on mobile. Completed = check icon (Tabler `check`, not a text glyph). Footer: Back (Secondary, left) and Next/Finish (Primary, right). Validate on Next, keep entered data on Back.

### Map panels

Side panel: 360px fixed, surface, border-left subtle, no shadow (shadow-2 only when it overlays the canvas on tablet). Mobile: bottom sheet. Nodes: radius lg, shadow-1 only while dragging. Node selection = 2px `--dn-map-node-selected` ring, not glow. Edges: neutral-8, hover/path highlight brand-9. Layout positions are user data (see build plan).

## 5. 3.0.0 feature patterns (built on v2 from day one)

| Feature | Components used | Tokens |
|---|---|---|
| Domains on the Map (domain ring, path panel) | Map node ring, side panel with ordered path list (domain > proxy > app > container) | `--dn-map-domain-ring`, `--dn-map-path` (brand-9), path list uses table rows |
| Keys safe (padlock, keys panel) | Status pill (Locked = neutral, Unlocked = warning with time left), side panel, confirm dialog for reveal/rotate | `--dn-safe-locked-*`, `--dn-safe-unlocked-*`; padlock icons `lock` / `lock-open` |
| Recovery Guide page (was "If I'm gone" runbook) | Document layout (max 72ch), numbered sections, print stylesheet | text scale only; no new colours |
| K-of-N recovery kit flow | Wizard; share cards in a 1/2/3-column grid; states Pending (neutral), Issued (info), Confirmed (success); progress "2 of 3 shares confirmed" | `--dn-share-*` |
| Missed-run alert | Page banner (warning) + status pill "Missed" + alert channel event | warning set |
| Restore test from off-site copy | Existing restore-test flow; source selector as radio cards | none new |
| Portainer / Dockge import | Wizard: Connect > Choose stacks (table with checkboxes) > Review > Import | none new |
| Online DB dumps | Settings row with switch + method select; job type badge "DB dump" | neutral badge |
| Append-only SFTP | Immutable badge (lock icon + "Append-only") on storage target cards | neutral badge + `lock` icon; no new token |

## 6. UX rules

1. One Primary action per view. A dialog has its own single Primary.
2. Button labels are verbs or verb + noun: "Add app", "Back up now", "Delete backup". Never "OK", "Yes", "Submit", "Click here".
3. Errors say what happened and what to do: "Could not connect to 192.0.2.10. Check the SSH port and try again." Never just "Error" or a raw stack.
4. No placeholder as label. Placeholders only show format ("hh:mm"), never examples that look like data.
5. Confirmation dialog only for destructive or irreversible actions. Title = the question with the object ("Delete Demo Shop backup?"), body = the consequence in one sentence, Danger button repeats the verb ("Delete backup"). For high-impact deletes, type the name to confirm. Prefer Undo toasts for reversible actions.
6. Empty state = what this is + the one action to start.
7. Disabled actions explain themselves (inline reason or tooltip).
8. Destructive actions are never Primary-blue and never the default focused button.
9. Long-running work shows progress in place; never a blocking spinner over the whole page.

## 7. Copy rules

- Short, plain, consistent. Title Case for nav items and page titles ("Self Backup", "Recovery Guide", "Apps & Schedules"); sentence case for buttons, tabs, headings inside pages, body and helper text. Product names keep their form ("DockNest").
- Fixed names: "Self Backup" (never "DockNest backup"), "Recovery Guide" (never "runbook"), the same in nav, titles and running text.
- "App" for a Docker app or static site the user manages ("Sites" becomes "Apps" in this release; ~190 user-facing "site" strings, see audit). "Server" for the SSH host. "Backup" (noun), "back up" (verb). "Restore", "Restore test". "Storage" for targets.
- Helper text max one sentence (about 90 characters); move detail to docs links.
- No "Beta", no "Note:", no exclamation marks, no "Please", no "Successfully". "Backup saved", not "The backup was successfully saved!".
- Numbers with units and plural rules (`plural.js`); relative times under 24h, absolute dates after.
- No emoji or text-symbol icons; Tabler icons only, 16 inline / 20 in nav and headings.



## 8. CSS structure (target)

Today: 32 CSS files, cascade stacked style.css > system.css > rebrand.css, 231 `.rebrand-page` override selectors, 46 `!important`, `button` defined twice. Target, using `@layer` so order is explicit and overrides stop being needed:

```
@layer reset, tokens, base, components, patterns, screens, utilities;
web/styles/tokens.css        tokens v2 + legacy alias block (temporary)
web/styles/base.css          reset, type, focus-visible, reduced motion
web/styles/components/*.css  button, field, switch, table, card, dialog, tabs, badge, alert, toast, empty, nav, stepper
web/styles/patterns/*.css    page-head, form layout, mobile-table, wizard, map-panel
web/<screen>.css             layout only; no colours, radii or shadows
```

Lint gate (added to `npm run check` as a small Node test): no raw hex outside tokens, no `transition: all`, no `:focus{` without `-visible`, no `box-shadow` other than `var(--dn-shadow-*)`, no new `!important`, no `@keyframes` outside the allowed list (spinner, progress, skeleton).

## 9. Build plan (3.0.0, on `integration/2.16.5`)

Tokens and core components merge first, so every new 3.0.0 feature screen (domains on Map, Keys safe, runbook and recovery kit, missed-run alert, off-site restore test, Portainer/Dockge import, DB dumps, append-only SFTP) is built on v2. Small PRs, one combined reviewer each.

| # | PR | Content | Gate |
|---|---|---|---|
| 1 | Tokens v2 | `tokens-v2.css` + legacy alias block; `@layer` order; theme-color meta; Chart.js palette and animation off in `charts.jsx`. No markup change. | Contrast test (port `contrast.mjs` into tests); every screen renders; visual diff reviewed |
| 2 | Base + focus + motion | One `:focus-visible` ring, `:focus:not(:focus-visible){outline:none}`, reduced-motion rule, remove infinite/decorative keyframes (52s sway, bell shake, card fade-in), sidebar 200ms | Lint gate on; keyboard pass in `theme-browser.js` |
| 3 | Buttons, fields, switch, checkbox | Variants and sizes; remove dead `scale(.97)` and duplicate `button` rule | Component sheet diff |
| 4 | Table, badge, card, empty/loading/error | Single empty state, single badge, mobile-table everywhere | `pagination-browser.js`, `mobile-browser.js` |
| 5 | Dialog, tabs, alert/banner, toast, stepper | Merge 9 dialog classes, 10 alert classes, 3 tab styles | `zip-dialog-browser.js`, `site-setup-browser.js` |
| 6 | Shell: sidebar, header, nav | 2.x chrome colours on v2 tokens, nav copy "Apps", "Self Backup", "Recovery Guide", Title Case nav | `layout-241-browser.js`, `mobile-browser.js` |
| 7..n | Screens, one or two per PR | Dashboard, Apps, Jobs, Map, Storage, Settings, Update Center, Auth; delete `.rebrand-page` overrides as each screen moves | That screen's `*-browser.js` + board diff |
| last | Cleanup | Remove legacy alias block, unused CSS files, add README screenshots | `npm run check`, `docs:screenshots` |

Feature PRs (other lead) start after PR 5, consuming components, never new one-off CSS.

Visual regression: `scripts/ds-v2-boards.js` (committed in PR 1 as `scripts/visual-boards.js`) renders the 10 screens x 3 viewports x 2 themes from synthetic fixtures; each PR attaches before/after pairs. Existing `*-browser.js` suites keep asserting behaviour. Headless only.

No "Beta" labels anywhere (audit found none user-facing; the lint gate blocks the string in JSX).

Upgrade safety (2.16.x to 3.0.0):
- Theme: keep `localStorage['docknest-theme']` values and the `data-theme` attribute exactly; v2 only changes token values.
- Sidebar collapsed state: keep `localStorage['docknest-sidebar']`.
- Map positions: saved in node coordinate space. Do not change node `METRICS` (width, height, column gaps) in `web/map/layout.js`; v2 restyles nodes inside the same box. If a size change is ever needed, ship a coordinate migration with a test that loads a 2.16 layout fixture.
- Settings and alert rules are server data; no CSS PR touches API or schema.
- `npm run test:upgrade` (scripts/upgrade-compat.js) run on the release PR with a 2.16.4 database fixture.

## 10. Owner decisions (3.0.0)

All questions are answered; the owner gave full authority for 3.0.0.

| Topic | Decision |
|---|---|
| Palette | Keep 2.x colours: purple for actions, blue for navigation and chrome, on v2 tokens. |
| Metric tiles | Keep the coloured tiles; one aligned row, equal heights. |
| Quality bar | The dashboard; every other page is brought up to it. |
| Row pattern | Every list (Map, Apps, Storage, Servers, Backups, Jobs): the row opens details, an overflow menu holds secondary actions, one visible primary per panel. |
| Names | "Self Backup" (was "DockNest backup"), "Recovery Guide" (was runbook). Title Case for nav and page titles. |
| Density | Controls 40px desktop, 44px mobile, 32px small. No density setting. |
| Wide screens | No extra text scaling; content width is capped. |
| Motion | Decorative motion removed; only short state transitions, reduced motion respected. |

## 11. Prototype and boards

The boards render the real app with synthetic data (example.com, 192.0.2.x). In "after" mode the prototype loads `tokens-v2.css` before render, then `prototype-overrides.css` and `after-mode.js`, which apply the v2 copy, names, row pattern and one-primary rule to the DOM. These prototype files are not committed; only `web/ds-v2/tokens-v2.css` (and its contrast report) ships, as the base for PR 1.

Limits of the mock:
- The "Needs review" domain pill is mocked: no fixture has that status yet.
- Mouse-click focus can't be shown in a static capture. The keyboard and pointer test in PR 2 covers it.
- Copy changes are done as DOM text replacement. The build changes the JSX strings and checks them with the existing browser tests.
