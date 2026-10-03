# Mobile layouts

Notifications are constrained to the phone viewport instead of being positioned relative to the bell. Their height is limited to the visible screen, with vertical scrolling when the screen is too short to fit the content.

At widths up to 680 pixels, Jobs, Audit, Access, maintenance controls and activity-chart data display table rows as labeled records. All values and actions remain available without horizontal scrolling. Column headers and explicit table roles preserve table semantics; desktop tables and their pagination remain unchanged. Mobile pages use natural content height instead of reserving empty space for shorter last pages.

Run `npm run check` and `npm run test:mobile`. The browser check serves built assets on loopback with mocked APIs and verifies notifications, long text, expanded audit/job details, pagination and table geometry at 320, 390 and 680 pixels, plus the desktop table layout. Screenshots are saved in `test-results/mobile/`. This check does not validate real backup or restore operations or certify assistive-technology compatibility.

Upstream role references used: [Frontend Developer](https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-frontend-developer.md) for reusable responsive components and semantic structure; [Reality Checker](https://github.com/msitarzewski/agency-agents/blob/main/testing/testing-reality-checker.md) for browser evidence and clear verification limits. No subagents were spawned.
