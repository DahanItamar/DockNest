# Purple logo preview

Preview-only assets for the exact current DockNest bird and lettering in #673AB7.

logo-purple-full.png preserves the native docs/media/logo-blue.png canvas at 2171 × 724. logo-purple-web.png (2015 × 395) and mark-purple.png (476 × 395) preserve their production source canvas sizes and every alpha byte. Only RGB color changes; glyphs and their spacing are never redrawn. Favicon and app files downsample this unchanged mark for size previews.

Open preview.html to compare light and dark surfaces and icon sizes. The user approved promotion to candidate website/browser/app assets on 2026-10-03; production deployment remains on hold for safety validation. The original blue masters remain unchanged.

The built-in imagegen tool was used for the purple color-edit draft. Its output was 2173 × 724, so the final exact assets retain the original source alpha and dimensions, with deterministic RGB correction to #673AB7. verification.json records source hashes, output hashes, canvas sizes and zero changed alpha pixels.

Prompt: Change only every visible logo pixel to #673AB7; keep the exact bird silhouette, DockNest letterforms, font, italics, kerning, counters, edges, proportions, relative layout and transparent canvas. No redesign, new typeface, gradients or new shadows.

To reproduce final previews: node docs/design/logo-purple-preview/export-preview.mjs.
