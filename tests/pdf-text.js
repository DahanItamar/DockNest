// Test helper: reads back the PDFs src/runbook/pdf.js writes (its own fixed layout only, not PDF in general). Objects
// by number, inflated streams, each font's ToUnicode map, and the text of every page in drawing order, decoded from the
// glyph ids. Used to check what a Recovery Guide PDF says, and that a secret never appears in it.
import { inflateSync } from 'node:zlib';

export function readObjects(pdf) {
  const objects = new Map(), text = pdf.toString('latin1');
  for (const match of text.matchAll(/(?:^|\n)(\d+) 0 obj\n/g)) {
    const start = match.index + match[0].length, end = text.indexOf('\nendobj\n', start), body = text.slice(start, end);
    const head = body.indexOf('\nstream\n');
    objects.set(Number(match[1]), head < 0 ? { dictionary: body } : { dictionary: body.slice(0, head), stream: inflateSync(pdf.subarray(start + head + 8, start + body.lastIndexOf('\nendstream'))) });
  }
  return objects;
}

const utf16 = hex => { const bytes = Buffer.from(hex, 'hex'); return bytes.swap16().toString('utf16le').replace(/^﻿/, ''); };
export function unicodeMaps(objects) {
  const maps = new Map();
  for (const object of objects.values()) {
    const font = /\/Subtype \/Type0 \/BaseFont \/([\w-]+).*\/ToUnicode (\d+) 0 R/.exec(object.dictionary);
    if (!font) continue;
    const map = new Map();
    for (const [, glyph, value] of objects.get(Number(font[2])).stream.toString('latin1').matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) map.set(glyph, utf16(value));
    maps.set(font[1], map);
  }
  return maps;
}

// Every drawn line of every page: { page, text (as shown, left to right), actual (ActualText, if any) }.
export function readLines(pdf) {
  const objects = readObjects(pdf), maps = unicodeMaps(objects), lines = [];
  const pageObjects = [...objects.values()].filter(object => /\/Type \/Page /.test(object.dictionary));
  pageObjects.forEach((page, index) => {
    const fonts = new Map([...page.dictionary.matchAll(/\/F(\d) (\d+) 0 R/g)].map(([, name, ref]) => [name, maps.get(/\/BaseFont \/([\w-]+)/.exec(objects.get(Number(ref)).dictionary)[1])]));
    const content = objects.get(Number(/\/Contents (\d+) 0 R/.exec(page.dictionary)[1])).stream.toString('latin1');
    let actual = null;
    for (const line of content.split('\n')) {
      const span = /^\/Span <<\/ActualText (<[0-9A-F]+>|\((?:\\.|[^\\)])*\))>> BDC$/.exec(line);
      if (span) { actual = span[1].startsWith('<') ? utf16(span[1].slice(1, -1)) : span[1].slice(1, -1).replace(/\\(.)/g, '$1'); continue; }
      if (line === 'EMC') { actual = null; continue; }
      if (!line.startsWith('BT ')) continue;
      let text = '';
      for (const [, name, glyphs] of line.matchAll(/\/F(\d) [\d.]+ Tf <([0-9a-f]*)> Tj/g)) for (const glyph of glyphs.match(/.{4}/g) ?? []) text += fonts.get(name).get(glyph.toUpperCase()) ?? '�';
      lines.push({ page: index + 1, text, actual });
    }
  });
  return lines;
}
// The whole text a reader would find: the logical text of each line (ActualText when present).
export const readText = pdf => readLines(pdf).map(line => line.actual ?? line.text).join('\n');
