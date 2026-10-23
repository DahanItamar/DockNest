# DockNest interface design

The interface uses light and dark blue/violet palettes, approved Homebird identity, self-hosted Roboto and consistent outline icons. Shared semantic colors and spacing live in [tokens.css](../../web/tokens.css). The shell has a 260px expanded sidebar, 72px collapsed rail, 88px header and 8px card corners.

Light is the default for a new browser. Settings offer Light / Dark / System; System follows device appearance without overwriting that choice. A bare sun/moon control in the header provides a quick override. Choices are saved per account in local browser storage and synchronized between tabs for that account. They do not synchronize across devices. The local bootstrap applies it before React paints, including on sign-in/setup/enrollment screens. Deep navy dark surfaces use brighter blue/violet foregrounds, separate filled-button colors, readable status tones and the existing blue wordmark. Charts use the same palette without changing their data, legends or exports. The sun rays rotate gently on hover; moon orbit dots lift slightly. Theme changes crossfade over 380 ms; browsers without View Transitions fade surface colors. Reduced motion disables those effects. Maintenance visitor pages retain their independently saved design.

Charts summarize loaded recovery points and jobs. Period controls, legends, tooltips and PNG/CSV exports are functional. Reduced motion disables chart transitions, sidebar motion and hover animation. Card pairs have equal columns, matching heights and aligned actions; mobile uses one column and a navigation drawer.

Backup pagination measures available viewport space and collapsed site summaries to choose its row count. Partial pages retain that space so navigation stays in place. Resizing preserves the first visible site. Expanded histories remain in normal document flow. Sites and Servers retain four-card pages, while Jobs and Audit retain ten-row pages. Controls appear only when needed, without row-count dropdowns or sliders. Search resets the page, refresh preserves it and shrinking collections clamp it.

Maintenance Studio provides three presets and desktop/phone previews. Saving does not activate maintenance. Its self-contained visitor renderer preserves health recovery behavior, embedded typography and reduced-motion support.

The header holds branding and useful controls; there is no duplicate bottom status strip. See the [logo guide](homebird-brand/README.md) and [mock screenshots](../media/README.md).

A System health heartbeat sits above storage, using a full-width waveform when expanded and a compact pulse in the collapsed rail. Blue means fresh API data, an online worker and no latest job needing attention; purple identifies connection/worker trouble or failed/recovery-required work. The sweep stops if the API becomes stale and respects reduced motion. Text and accessible labels explain each state. The collapsed rail also shows a capacity ring with used and total amounts; its storage details appear on hover or keyboard focus and dismiss with Escape. Unknown capacity is explicitly marked rather than shown as an empty percentage. This reports observed manager health, not a continuous check of every remote website or storage destination.

The compact storage readout uses actual stored and total amounts, rather than an unexplained percentage.

Verify with `npm run check` and the existing browser suites. Interface checks alone do not establish Linux recovery.

## 2.3.0 system

Shared foundation in `web/tokens.css` (tokens), `web/system.css` (primitives) and `web/system.jsx` (components). Pages use these; they do not define their own sizes.

Type scale (size / line height / weight), on an 8px rhythm: page title 24/32/600 (`.t-title`), card title 20/28/600 (`.t-card`), section 16/24/500 (`.t-section`), body 14/20/400 (`.t-body`), caption 12/16/400 (`.t-caption`), button 14/20/500. Tokens are `--fs-*` and `--lh-*`. From 1920px every step goes up one size (body 15); from 2560px body is 16.

Breakpoints: edge padding `--edge` is 16px below 768, 24px at 768-1439, 32px from 1440. From 1920 `--edge` is 40px (48px from 2560), and the content grows with the window up to 2200px at 2560, 2800px at 3200 and 3400px at 3840 (centred; side margins stay under 200px with the rail expanded or collapsed). `--section-gap` is 24px: card lists keep it between the last row of cards and the pager on every page. List pages have one funnel filter above the list (no header search); Audit and Jobs size to the viewport (at least 10 rows). Overview metrics are a 3 x 2 grid from 1024px. `.card-grid` has 1 column below 768, 2 at 768-1439, 3 at 1440-1919, 4 from 1920.

Primitives:
- `StatusLabel` (`.status .status-{success|running|queued|failed|needs-review}`): 16px icon plus text in the semantic colour, weight 500, no background, border or dot. The running icon rotates unless reduced motion is set.
- Switch: every `button[role=switch]` is a 36x20 pill with a 16px knob and a 160ms knob transition; the button keeps a 44px hit area.
- Buttons: 40px high (44px at 480px and below), 14/20 500, no wrapping. `.primary`, default secondary, `.danger`. `IconButton` (`.icon-button`): 40x40, no border or background, soft `--surface-hover` on hover and focus, always has an `aria-label`.
- `AlertPanel` (`.alert-panel .alert-{error|warning|info}`): tinted surface, 1px border, icon, bold title, text, optional action link. Error and warning use `role="alert"`, info uses `role="status"`.
- Card (`.card`, `.card-body`, `.card-footer`): 8px radius, 1px `--border-subtle`. The footer is 64px with a top border and right-aligned actions; cards in `.card-grid` stretch to equal height.
- Data table (`.data-table` in `.data-table-wrap`): fixed layout, 40px header in caption style on `--surface-muted`, 56px rows with one bottom line, tabular numbers, `.num` for right-aligned numeric columns, ellipsis on overflow. Below 768px it scrolls inside its own box.
- Definition rows (`.def-list > .def-row > dt + dd`): caption label left, value right, full-width separators.

Motion: durations `--dur-fast` 120ms, `--dur-base` 160ms, `--dur-slow` 240ms and one easing `--ease`. Cards, panels and alert panels enter with opacity and a 4px rise. All animation and transitions in the primitives are off under `prefers-reduced-motion`.

## Problem reports (2.4.0)

`web/report/` (`ReportProblem.jsx`, `report.css`) follows the approved design. **Open GitHub** is a secondary button inside red failure `AlertPanel`s, next to the primary next action (`.rp-actions`, identical 40px buttons, stacked full width at 480px and below); About uses **Report a bug**. The "Review what will be shared" dialog has a three-step strip (Review here, Open GitHub, Describe and submit there), a **Shared** definition list with the exact title and values, the environment checkbox (on by default), a **Never shared** list, the amber public-issue note and a footer with Cancel and Open GitHub (external-link icon). It renders at the document root; its body scrolls between a fixed header and footer; at 480px and below it becomes a bottom sheet with 44px full-width buttons, Open GitHub first. The app error boundary shows "This page stopped working" with Reload page and Open GitHub. Tokens and the type scale only; light and dark; the enter motion is off under reduced motion.
