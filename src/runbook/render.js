// One Recovery Guide PDF from the inventory: the download (src/runbook/routes.js) and the copy next to the kit
// (src/runbook/copy.js) are made the same way.
import { readFileSync } from 'node:fs';
import { buildGuide, guideBlocks, formatDate } from './guide.js';
import { renderPdf } from './pdf.js';

export const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export function guidePdf(inventory, { appIds, include, madeAt }) {
  const guide = buildGuide(inventory, { appIds, include, version: VERSION, madeAt });
  return renderPdf(guideBlocks(guide), { title: guide.title, header: `Recovery Guide, made ${formatDate(madeAt)}`, secrets: guide.secrets, createdAt: madeAt });
}
