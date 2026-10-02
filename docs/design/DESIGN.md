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
