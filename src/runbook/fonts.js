// The fonts the Recovery Guide PDF embeds (assets/fonts/, docs/recovery-guide.md "PDF"). Only fonts that ship with
// DockNest are read, never a font from a user, and only the tables the writer needs: cmap (characters to glyphs), hmtx
// (advance widths), head (units per em, bounding box), hhea (ascent, descent, metric count) and maxp (glyph count).
import { readFileSync } from 'node:fs';

export const FONT_FILES = Object.freeze({
  regular: { file: 'Roboto-Regular.ttf', name: 'Roboto-Regular' },
  bold: { file: 'Roboto-Bold.ttf', name: 'Roboto-Bold' },
  mono: { file: 'RobotoMono-Regular.ttf', name: 'RobotoMono-Regular', fixedPitch: true },
  hebrew: { file: 'NotoSansHebrew-Regular.ttf', name: 'NotoSansHebrew-Regular' },
});

function tables(bytes) {
  if (bytes.readUInt32BE(0) !== 0x00010000) throw new Error('Not a TrueType font');
  const found = new Map();
  for (let index = 0, count = bytes.readUInt16BE(4); index < count; index++) {
    const entry = 12 + index * 16, offset = bytes.readUInt32BE(entry + 8), length = bytes.readUInt32BE(entry + 12);
    if (offset + length > bytes.length) throw new Error('Truncated font table');
    found.set(bytes.toString('latin1', entry, entry + 4), bytes.subarray(offset, offset + length));
  }
  for (const name of ['cmap', 'hmtx', 'head', 'hhea', 'maxp']) if (!found.has(name)) throw new Error(`Font has no ${name} table`);
  return found;
}

// Format 12 (full Unicode) when the font has it, else format 4 (Basic Multilingual Plane), both from the Windows platform.
function characterMap(cmap) {
  const subtables = [];
  for (let index = 0, count = cmap.readUInt16BE(2); index < count; index++) {
    const entry = 4 + index * 8;
    subtables.push({ platform: cmap.readUInt16BE(entry), encoding: cmap.readUInt16BE(entry + 2), table: cmap.subarray(cmap.readUInt32BE(entry + 4)) });
  }
  const pick = subtables.find(item => item.platform === 3 && item.encoding === 10 && item.table.readUInt16BE(0) === 12) ?? subtables.find(item => item.platform === 3 && item.encoding === 1 && item.table.readUInt16BE(0) === 4);
  if (!pick) throw new Error('Font has no Unicode character map');
  const map = new Map(), table = pick.table;
  if (table.readUInt16BE(0) === 12) {
    for (let group = 0, count = table.readUInt32BE(12); group < count; group++) {
      const at = 16 + group * 12, start = table.readUInt32BE(at), end = table.readUInt32BE(at + 4), glyph = table.readUInt32BE(at + 8);
      for (let code = start; code <= end; code++) map.set(code, glyph + code - start);
    }
    return map;
  }
  const segments = table.readUInt16BE(6) / 2, ends = 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment++) {
    const end = table.readUInt16BE(ends + segment * 2), start = table.readUInt16BE(starts + segment * 2), delta = table.readInt16BE(deltas + segment * 2), range = table.readUInt16BE(ranges + segment * 2);
    for (let code = start; code <= end && code !== 0xffff; code++) {
      const glyph = range ? table.readUInt16BE(ranges + segment * 2 + range + (code - start) * 2) : code;
      const id = range && glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      if (id) map.set(code, id);
    }
  }
  return map;
}

export function parseFont(bytes) {
  const found = tables(bytes), head = found.get('head'), hhea = found.get('hhea'), hmtx = found.get('hmtx');
  const metrics = hhea.readUInt16BE(34), glyphs = found.get('maxp').readUInt16BE(4), widths = new Uint16Array(glyphs);
  for (let glyph = 0; glyph < glyphs; glyph++) widths[glyph] = hmtx.readUInt16BE(Math.min(glyph, metrics - 1) * 4);
  return {
    bytes, glyphs, widths, cmap: characterMap(found.get('cmap')),
    unitsPerEm: head.readUInt16BE(18),
    bbox: [head.readInt16BE(36), head.readInt16BE(38), head.readInt16BE(40), head.readInt16BE(42)],
    ascent: hhea.readInt16BE(4), descent: hhea.readInt16BE(6),
  };
}

const loaded = new Map();
export function font(key) {
  if (!loaded.has(key)) {
    const spec = FONT_FILES[key];
    loaded.set(key, { key, ...spec, ...parseFont(readFileSync(new URL(`../../assets/fonts/${spec.file}`, import.meta.url))) });
  }
  return loaded.get(key);
}
