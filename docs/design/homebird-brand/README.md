# DockNest / Homebird logo assets

The approved identity pairs a blue bird with angled DockNest lettering. The transparent raster master is 2172 × 724 pixels; the cropped horizontal logo is 2015 × 395 pixels. Runtime wordmarks, browser icons and phone home-screen icons derive from the same master. [Source checksum](asset-manifest.json).

[View the preview](index.html) · [Download the logo pack](DockNest-Homebird-Logo-Pack.zip)

Exports in [public/brand](../../../public/brand) include transparent logo/mark PNGs, 600/1200px WebP wordmarks, 16/32/48px favicons, a multi-resolution ICO, an opaque 180px Apple touch icon, 192/512px app icons and a protected 512px maskable icon. Root browser and Apple icon fallbacks use the same mark.

Preserve proportions and clear space. Use the bird alone for small browser/app tiles and the full lockup for headers. Keep the slogan as separate live text. Avoid stretching or added shadows.

Palette: blue `#1E88E5` / `#2196F3`, violet `#5E35B1` / `#673AB7`, ink `#121926` and white. These are raster assets, not vector masters.

Rebuild with `npm run brand:export`. In Safari, choose Share → Add to Home Screen. Existing shortcuts may retain cached icons and need to be added again. Metadata/image contracts have browser verification; native iPhone behavior has not been device-tested.
