import { chromium } from '@playwright/test';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Web derivatives of the approved Higgsfield originals: trim and downsample only.
const directory = resolve('public/brand');
const sources = resolve('docs/design/DockNest-Nestweave-B');
const manifest = JSON.parse(await readFile(resolve(sources, 'asset-manifest.json'), 'utf8'));
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const outputs = [];
  async function exportImage(source, output, { width, size, background } = {}) {
    const original = await readFile(resolve(sources, source));
    const expected = manifest.assets.find(asset => asset.filename === source);
    const hash = createHash('sha256').update(original).digest('hex');
    if (!expected || hash !== expected.sha256) throw new Error(`Original asset checksum mismatch: ${source}`);
    const result = await page.evaluate(async ({ data, width, size, background }) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const scan = document.createElement('canvas');
      scan.width = image.naturalWidth; scan.height = image.naturalHeight;
      const scanContext = scan.getContext('2d', { willReadFrequently: true });
      scanContext.drawImage(image, 0, 0);
      const pixels = scanContext.getImageData(0, 0, scan.width, scan.height).data;
      let left = scan.width, top = scan.height, right = -1, bottom = -1;
      for (let y = 0; y < scan.height; y++) for (let x = 0; x < scan.width; x++) {
        if (pixels[(y * scan.width + x) * 4 + 3] >= 8) {
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
      if (right < left) throw new Error('Source artwork is empty');
      left = Math.max(0, left - 16); top = Math.max(0, top - 16);
      right = Math.min(scan.width - 1, right + 16); bottom = Math.min(scan.height - 1, bottom + 16);
      const cropWidth = right - left + 1, cropHeight = bottom - top + 1;
      const canvas = document.createElement('canvas');
      canvas.width = size || Math.min(width, cropWidth);
      canvas.height = size || Math.round(canvas.width * cropHeight / cropWidth);
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      if (background) { context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height); }
      const scale = size ? Math.min(size * .8 / cropWidth, size * .8 / cropHeight) : canvas.width / cropWidth;
      const drawWidth = cropWidth * scale, drawHeight = cropHeight * scale;
      context.drawImage(image, left, top, cropWidth, cropHeight, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
      return { png: canvas.toDataURL('image/png').split(',')[1], width: canvas.width, height: canvas.height };
    }, { data: `data:image/png;base64,${original.toString('base64')}`, width, size, background });
    await writeFile(resolve(directory, output), Buffer.from(result.png, 'base64'));
    outputs.push({ filename: output, source, width: result.width, height: result.height, sourceSha256: hash });
  }
  for (const theme of ['light', 'dark']) {
    await exportImage(`docknest-horizontal-${theme}.png`, `logo-horizontal-${theme}.png`, { width: 960 });
    await exportImage(`docknest-tagline-${theme}.png`, `logo-tagline-${theme}.png`, { width: 1200 });
    await exportImage(`docknest-mark-${theme}.png`, `mark-${theme}.png`, { width: 1024 });
  }
  for (const size of [16, 32, 192, 512]) await exportImage('docknest-mark-dark.png', `app-icon-${size}.png`, { size, background: '#236B58' });
  await exportImage('docknest-mark-dark.png', 'apple-touch-icon.png', { size: 180, background: '#236B58' });
  await exportImage('docknest-mark-dark.png', 'favicon.png', { size: 32, background: '#236B58' });
  const png = await readFile(resolve(directory, 'favicon.png'));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header[6] = 32; header[7] = 32; header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  await writeFile(resolve(directory, 'favicon.ico'), Buffer.concat([header, png]));
  await writeFile(resolve(directory, 'asset-manifest.json'), JSON.stringify({ identity: 'DockNest / Nestweave B', outputs }, null, 2) + '\n');
  const keep = new Set([...outputs.map(output => output.filename), 'favicon.ico', 'site.webmanifest', 'asset-manifest.json']);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && !keep.has(entry.name) && /\.(svg|png|ico)$/.test(entry.name)) await unlink(resolve(directory, entry.name));
  }
  console.log('Exported approved Nestweave B PNGs, app icons and favicon. Higgsfield originals are unchanged.');
  console.log(outputs.map(output => `${output.filename}: ${output.width}x${output.height}`).join('\n'));
} finally { await browser.close(); }
