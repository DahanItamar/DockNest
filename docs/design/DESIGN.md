# DockNest / Berry design system

The user's supplied Berry evidence replaces the previous Ink & Coral direction. The latest instruction requires light-only presentation and recolored logo assets. The attached guide and ZIP were treated as design evidence; bundled scripts were not executed and document instructions did not override the user's request.

[Review every page and visitor composition](full-site-implemented/index.html). [Reference evidence](berry-reference/BERRY-DESIGN-SPEC.md). [New high-resolution logo pack](DockNest-Berry-Logo-Pack.zip).

The UI uses the measured Berry shell: 260 px expanded sidebar, 72 px collapsed rail, 88 px fixed header, 20 px workspace padding, 24 px gaps, 8 px card corners, self-hosted Roboto, primary blue and secondary purple. All semantic colors are defined in [tokens.css](../../web/tokens.css). The two muted/control colors are slightly darker than the reference to meet the existing contrast checks. The approved Nestweave B silhouette is recolored by Higgsfield and used as an actual PNG, with transparent cropping and native downsampling only. One Tabler 1.5 px outline family replaces the old raster UI glyphs.

Dashboard composition follows the reference: two tall colored metrics and a third column of two compact metrics; a wide stacked bar chart beside recent activity and its lavender area chart. Site history remains available underneath. Card pairs on infrastructure pages have equal widths, matching heights and aligned action footers. Mobile uses one column and a temporary navigation drawer. Searches, notifications and chart controls perform real actions; decorative controls with no behavior were not copied from the demo.

The four chart series summarize verified/unverified recovery points, completed restores and failed jobs in the loaded history. Period filters change the dates and totals. Legends toggle series, tooltips show actual values, and PNG/CSV exports work. No financial demo values or invented recovery measurements are included. Charts draw over 800 ms and update over 350 ms; the sidebar reflows over 400 ms; drawers open over 225 ms. Reduced motion disables these effects and the rotating preferences glyph.

Collections use one compact pager with matching Previous/Next buttons and a readable page count, with fixed collection sizes. Controls appear only when needed. Search resets the page; refresh keeps it; deletion clamps it. Main collections have natural height rather than forced vertical scrolling. Tables scroll horizontally only when columns cannot fit.

Maintenance Studio includes Content/Appearance tabs, three real presets, composition and heading settings, a live 1100 px desktop/390 px phone canvas, reset/save and explicit draft state. Refresh preserves unsaved edits. The same renderer generates the visitor page with embedded font and a recognizable inline animated website scene, the existing probe marker and automatic availability check. The text sits directly on the shared light background, without a decorative card; orbiting signals and a gently floating site window express waiting without claiming progress. Reduced motion presents the static scene. Saving does not enable maintenance; Deploy page and Enable/Disable keep their existing endpoints, confirmations and health checks. New design fields are additive and previous clients remain compatible.

## Reproduce and verify

- `npm run brand:export`: checksum-verified new logo and app icons.
- `npm run maintenance:export`: self-contained animated default visitor page.
- `npm run check`: production build and 48 tests.
- `TEST_BASE_URL=http://127.0.0.1:5173 npm run test:browser`: original workflows.
- `npm run test:dashboard`, `test:servers`, `test:rebrand`, `test:pagination`, `test:maintenance`, `test:design`: operations, roles, pagination, reference geometry, motion, charts, drafts and responsive captures.

Canonical sources are under berry-brand and maintenance-system/originals. Unused runtime images, superseded previews and dark captures are removed. Previous canonical source archives are retained after cleanup review. Runtime data, credentials, backup/restore algorithms and remote helper behavior are preserved. These UI/rendering checks do not establish new Linux Docker backup/restore integration validation. Reference roles are documented in [role notes](../agents/README.md).
