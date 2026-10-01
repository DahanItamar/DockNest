import { chromium } from '@playwright/test';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Rasterize our editable SVG artwork; no redraw or raster upscaling.
const directory = resolve('public/brand');
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  async function render(name, output, width, height, scale = 1) {
    const svg = await readFile(resolve(directory, name), 'utf8');
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
    try {
      const page = await context.newPage();
      await page.setContent('<style>html,body{margin:0;background:transparent}img{display:block;width:100%;height:100%}</style><img src="data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') + '">');
      await page.locator('img').evaluate(image => image.decode());
      await page.screenshot({ path: resolve(directory, output), omitBackground: true });
    } finally { await context.close(); }
  }
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.svg'))) {
    const svg = await readFile(resolve(directory, name), 'utf8');
    const width = Number(svg.match(/\bwidth="(\d+)"/)[1]);
    const height = Number(svg.match(/\bheight="(\d+)"/)[1]);
    if (name === 'app-icon.svg') {
      for (const size of [16, 32, 192, 512]) await render(name, `app-icon-${size}.png`, size, size);
      await render(name, 'apple-touch-icon.png', 180, 180);
    } else {
      await render(name, name.replace('.svg', '.png'), width, height, name === 'favicon.svg' ? 1 : 4);
    }
  }
  const png = await readFile(resolve(directory, 'favicon.png'));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header[6] = 32; header[7] = 32; header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  await writeFile(resolve(directory, 'favicon.ico'), Buffer.concat([header, png]));
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 2 });
  const lockup = async theme => 'data:image/svg+xml;base64,' + Buffer.from(await readFile(resolve(directory, `logo-tagline-${theme}.svg`))).toString('base64');
  await page.setContent(`<style>body{margin:0;display:grid;grid-template-columns:1fr 1fr;font:16px system-ui}section{height:720px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;background:#e8ecf0;color:#253240}section+section{background:#252c35;color:#e1e7ed}img{width:480px;height:auto}</style><section><img src="${await lockup('light')}"><p>DockNest · Light</p></section><section><img src="${await lockup('dark')}"><p>DockNest · Dark</p></section>`);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.screenshot({ path: resolve(directory, 'DockNest-Brand-Preview.png') });
  console.log('Exported transparent PNGs at 4× SVG dimensions, icons, favicon and brand preview.');
} finally { await browser.close(); }
