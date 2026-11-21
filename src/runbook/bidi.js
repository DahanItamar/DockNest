// A small Unicode bidirectional pass (UAX #9) for the Recovery Guide PDF: enough for Hebrew mixed with Latin text,
// digits and punctuation on one line. Hebrew needs no glyph shaping, so reordering is all right-to-left text needs.
// It covers the paragraph level (P2, P3), the weak types (W1-W7), the neutrals (N1, N2), the implicit levels (I1, I2),
// line reordering (L1, L2) with combining marks kept after their base, and mirrored brackets (L4). Explicit embeddings
// and isolates are not supported: their control characters are dropped, as in alert messages.

const between = (code, low, high) => code >= low && code <= high;
const MARKS = [[0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7]];
const MIRRORED = new Map([['(', ')'], [')', '('], ['[', ']'], [']', '['], ['{', '}'], ['}', '{'], ['<', '>'], ['>', '<'], ['«', '»'], ['»', '«'], ['‹', '›'], ['›', '‹']]);
export const CONTROLS = /[‪-‮⁦-⁩]/g;

export function bidiClass(character) {
  const code = character.codePointAt(0);
  if (code === 0x200e) return 'L';
  if (code === 0x200f) return 'R';
  if (MARKS.some(([low, high]) => between(code, low, high))) return 'NSM';
  if (between(code, 0x0590, 0x08ff) || between(code, 0xfb1d, 0xfdff) || between(code, 0xfe70, 0xfeff)) return 'R';
  if (between(code, 0x30, 0x39) || code === 0xb2 || code === 0xb3 || code === 0xb9) return 'EN';
  if (character === '+' || character === '-' || code === 0x2212) return 'ES';
  if ('#$%'.includes(character) || between(code, 0xa2, 0xa5) || code === 0xb0 || code === 0xb1 || code === 0x2030 || between(code, 0x20a0, 0x20cf)) return 'ET';
  if (',./:'.includes(character) || code === 0xa0 || code === 0x2044) return 'CS';
  if (character === ' ' || character === '\t' || between(code, 0x2000, 0x200a) || code === 0x3000) return 'WS';
  if (/\p{M}/u.test(character)) return 'NSM';
  if (/\p{L}/u.test(character)) return 'L';
  return 'ON';
}

// P2, P3: the first strong character decides; text without one reads left to right.
export function paragraphLevel(text) {
  for (const character of text) { const type = bidiClass(character); if (type === 'L') return 0; if (type === 'R') return 1; }
  return 0;
}
export const hasRightToLeft = text => [...text].some(character => bidiClass(character) === 'R');

// Embedding levels for one line (code points), at paragraph level `base`.
function levels(characters, base) {
  const original = characters.map(bidiClass), types = [...original], edge = base ? 'R' : 'L', count = types.length;
  for (let index = 0; index < count; index++) if (types[index] === 'NSM') types[index] = index ? types[index - 1] : edge; // W1
  const strongBefore = index => { for (let at = index - 1; at >= 0; at--) if (types[at] === 'L' || types[at] === 'R') return types[at]; return edge; };
  for (let index = 1; index < count - 1; index++) { // W4
    if ((types[index] === 'ES' || types[index] === 'CS') && types[index - 1] === 'EN' && types[index + 1] === 'EN') types[index] = 'EN';
  }
  for (let index = 0; index < count; index++) { // W5
    if (types[index] !== 'ET') continue;
    let end = index; while (end < count && types[end] === 'ET') end++;
    if ((index > 0 && types[index - 1] === 'EN') || types[end] === 'EN') types.fill('EN', index, end);
    index = end - 1;
  }
  for (let index = 0; index < count; index++) if (['ES', 'ET', 'CS'].includes(types[index])) types[index] = 'ON'; // W6
  for (let index = 0; index < count; index++) if (types[index] === 'EN' && strongBefore(index) === 'L') types[index] = 'L'; // W7
  const direction = type => (type === 'L' ? 'L' : type === 'R' || type === 'EN' ? 'R' : null);
  for (let index = 0; index < count; index++) { // N1, N2
    if (direction(types[index])) continue;
    let end = index; while (end < count && !direction(types[end])) end++;
    const before = index ? direction(types[index - 1]) : edge, after = end < count ? direction(types[end]) : edge;
    types.fill(before === after ? before : edge, index, end);
    index = end - 1;
  }
  const result = types.map(type => (base % 2 === 0 ? (type === 'R' ? base + 1 : type === 'EN' ? base + 2 : base) : (type === 'R' ? base : base + 1))); // I1, I2
  for (let index = count - 1; index >= 0 && (original[index] === 'WS' || original[index] === 'NSM'); index--) result[index] = base; // L1
  return { result, original };
}

// The line in display order (left to right), brackets mirrored inside right-to-left runs.
export function visualOrder(text, base = paragraphLevel(text)) {
  const characters = [...text.replace(CONTROLS, '')];
  if (!characters.length) return '';
  const { result, original } = levels(characters, base);
  // Clusters: a base character and the combining marks after it move together.
  let clusters = [];
  for (const [index, character] of characters.entries()) {
    const shown = result[index] % 2 && MIRRORED.has(character) ? MIRRORED.get(character) : character;
    if (original[index] === 'NSM' && clusters.length) clusters.at(-1).text += shown;
    else clusters.push({ text: shown, level: result[index] });
  }
  const highest = Math.max(...clusters.map(item => item.level)), lowestOdd = Math.min(...clusters.map(item => item.level).filter(level => level % 2), highest + 1);
  for (let level = highest; level >= lowestOdd; level--) { // L2
    const next = [];
    for (let index = 0; index < clusters.length;) {
      if (clusters[index].level < level) { next.push(clusters[index++]); continue; }
      let end = index; while (end < clusters.length && clusters[end].level >= level) end++;
      next.push(...clusters.slice(index, end).reverse());
      index = end;
    }
    clusters = next;
  }
  return clusters.map(item => item.text).join('');
}
