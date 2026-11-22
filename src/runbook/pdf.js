// A minimal PDF 1.7 writer for the Recovery Guide (docs/recovery-guide.md "PDF"). It only writes; it parses no input.
// Layout: a title page, headings, paragraphs, numbered lists, simple tables and monospaced command boxes, with automatic
// page breaks, a header and a footer with page numbers on every page, and a "Contains secrets" mark on every page when
// the guide holds login details. Text uses the embedded TrueType fonts as Type0/CIDFontType2 with Identity-H and a
// ToUnicode map, so it can be selected and searched; right-to-left lines are reordered by bidi.js and carry their
// logical text as ActualText. Every text is written as glyph ids in hex, and every other string through pdfString(), so
// no byte of input ever becomes a PDF operator. No JavaScript, forms, embedded files or actions. The only links are the
// two DockNest credit links in the footer (fixed addresses, never from input).
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { font } from './fonts.js';
import { visualOrder, paragraphLevel, hasRightToLeft, CONTROLS } from './bidi.js';

export const LIMITS = Object.freeze({ pages: 2000, bytes: 64 * 1024 * 1024 });
const PAGE = { width: 595.28, height: 841.89, margin: 56, top: 62, bottom: 56 };
// Spacing steps: 4 within a block, 8 between blocks, 16 and 24 before headings.
export const CREDIT = { text: 'Made with DockNest', links: [{ label: 'github.com/DahanItamar/DockNest', url: 'https://github.com/DahanItamar/DockNest' }, { label: 'trydocknest.com', url: 'https://trydocknest.com' }] };
const WIDTH = PAGE.width - 2 * PAGE.margin;
const STYLES = {
  title: { font: 'bold', size: 24, lead: 28 },
  subtitle: { font: 'regular', size: 12, lead: 16 },
  h1: { font: 'bold', size: 16, lead: 20, before: 24, after: 8 },
  h2: { font: 'bold', size: 12, lead: 16, before: 16, after: 4 },
  body: { font: 'regular', size: 10.5, lead: 14, after: 8 },
  cell: { font: 'regular', size: 9, lead: 12 },
  head: { font: 'bold', size: 9, lead: 12 },
  mono: { font: 'mono', size: 8.5, lead: 12 },
  small: { font: 'regular', size: 8, lead: 10 },
};
const COLORS = { link: '0.05 0.27 0.65', text: '0.13 0.15 0.18', muted: '0.42 0.45 0.5', warning: '0.62 0.25 0.02', secret: '0.72 0.07 0.1', box: '0.94 0.95 0.97', rule: '0.82 0.84 0.87' };
const FALLBACK = ['regular', 'hebrew'];
const tooLarge = () => Object.assign(new Error('The Recovery Guide is too large to make as a PDF. Choose fewer apps.'), { status: 413 });
const number = value => (Math.round(value * 100) / 100).toString();

// The one escaping function for PDF strings: printable ASCII as a literal string with \, ( and ) escaped and control
// characters as octal escapes; anything else as UTF-16BE hex with a byte order mark.
export function pdfString(value) {
  const text = String(value);
  if ([...text].every(character => character.codePointAt(0) < 0x80)) {
    return '(' + text.replace(/[\\()]/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, character => '\\' + character.charCodeAt(0).toString(8).padStart(3, '0')) + ')';
  }
  const bytes = Buffer.from('\ufeff' + text, 'utf16le');
  for (let index = 0; index < bytes.length; index += 2) [bytes[index], bytes[index + 1]] = [bytes[index + 1], bytes[index]];
  return '<' + bytes.toString('hex').toUpperCase() + '>';
}

// The font and glyph for one character: the style's font, then Roboto, then Noto Sans Hebrew, else a "?".
function glyphFor(character, preferred) {
  const code = character.codePointAt(0);
  for (const key of [preferred, ...FALLBACK]) { const face = font(key), id = face.cmap.get(code); if (id) return { key, id, face }; }
  const face = font(preferred); return { key: preferred, id: face.cmap.get(0x3f) ?? 0, face };
}
function measure(text, style) {
  let total = 0;
  for (const character of text) { const { id, face } = glyphFor(character, style.font); total += face.widths[id] * style.size / face.unitsPerEm; }
  return total;
}
// A command box: a list item's box (the narrowest) holds lines up to COMMAND_WIDTH. Commands are folded to fit before
// they get here (src/runbook/commands.js); a command line is never re-wrapped, as that would break it when copied.
const BOX = { pad: 8, indent: 20 }, COMMAND_WIDTH = WIDTH - BOX.indent - 2 * BOX.pad;
export const commandFits = line => measure(line, STYLES.mono) <= COMMAND_WIDTH;

class Layout {
  constructor() { this.pages = []; this.used = new Map(); this.newPage(); }
  newPage() {
    if (this.pages.length >= LIMITS.pages) throw tooLarge();
    this.page = []; this.pages.push(this.page); this.y = PAGE.height - PAGE.top;
  }
  ensure(height) { if (this.y - height < PAGE.bottom) this.newPage(); }
  left() { return this.y - PAGE.bottom; }
  width(text, style) { return measure(text, style); }
  // Logical lines that fit `width`; a word longer than a line is broken between characters.
  wrap(text, style, width) {
    const lines = [];
    for (const paragraph of String(text).replace(CONTROLS, '').replace(/\t/g, ' ').split('\n')) {
      let line = '';
      for (const token of paragraph.split(/(\s+)/).filter(Boolean)) {
        if (this.width(line + token, style) <= width) { line += token; continue; }
        if (line.trim()) lines.push(line.trimEnd());
        line = /^\s+$/.test(token) ? '' : token;
        while (this.width(line, style) > width) {
          let cut = line.length - 1; while (cut > 1 && this.width(line.slice(0, cut), style) > width) cut--;
          lines.push(line.slice(0, cut)); line = line.slice(cut);
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }
  // One line at the current baseline. `reorder` false keeps logical order (command boxes: what is copied is what runs).
  line(text, style, { x = PAGE.margin, width = WIDTH, align = 'left', color = COLORS.text, base = 0, reorder = true } = {}) {
    const shown = reorder ? visualOrder(text, base) : text.replace(CONTROLS, '');
    if (!shown) return;
    const runs = [];
    for (const character of shown) {
      const { key, id } = glyphFor(character, style.font);
      if (!this.used.has(key)) this.used.set(key, new Map());
      if (!this.used.get(key).has(id)) this.used.get(key).set(id, character);
      if (runs.at(-1)?.key === key) runs.at(-1).ids.push(id); else runs.push({ key, ids: [id] });
    }
    const left = align === 'right' ? x + width - this.width(shown, style) : x;
    const actual = reorder && hasRightToLeft(text);
    if (actual) this.page.push(`/Span <</ActualText ${pdfString(text)}>> BDC`);
    this.page.push(`BT ${color} rg ${number(left)} ${number(this.y)} Td` + runs.map(run => ` /F${fontIndex(run.key)} ${style.size} Tf <${run.ids.map(id => id.toString(16).padStart(4, '0')).join('')}> Tj`).join('') + ' ET');
    if (actual) this.page.push('EMC');
  }
  rect(x, y, width, height, color) { this.page.push(`${color} rg ${number(x)} ${number(y)} ${number(width)} ${number(height)} re f`); }
  rule(y) { this.page.push(`${COLORS.rule} RG 0.6 w ${PAGE.margin} ${number(y)} m ${number(PAGE.margin + WIDTH)} ${number(y)} l S`); }

  paragraph(text, style = STYLES.body, { indent = 0, color, after = style.after ?? 0 } = {}) {
    const base = paragraphLevel(text), width = WIDTH - indent;
    for (const line of this.wrap(text, style, width)) {
      this.ensure(style.lead); this.y -= style.lead;
      this.line(line, style, { x: PAGE.margin + indent, width, align: base ? 'right' : 'left', base, color });
    }
    this.y -= after;
  }
  heading(text, level) {
    const style = level === 1 ? STYLES.h1 : STYLES.h2;
    this.ensure(style.before + style.lead + STYLES.body.lead * 3);
    this.y -= style.before; this.paragraph(text, style);
  }
  // `wrap`: a value box (a login detail), whose long lines may wrap; a command line that does not fit is an error.
  commandLines(text, indent = 0, wrap = false) {
    const style = STYLES.mono, width = WIDTH - indent - 2 * BOX.pad, lines = [];
    for (const line of String(text).split('\n')) {
      if (!wrap && measure(line, style) > width) throw new Error('A Recovery Guide command is wider than its box');
      this.wrap(line, style, width).forEach((part, index) => lines.push(index ? '  ' + part : part));
    }
    return lines;
  }
  command(text, indent = 0, { wrap = false } = {}) {
    const style = STYLES.mono, pad = BOX.pad, lines = this.commandLines(text, indent, wrap);
    this.ensure(style.lead * Math.min(lines.length, 3) + pad * 2);
    this.rect(PAGE.margin + indent, this.y - pad, WIDTH - indent, pad, COLORS.box); this.y -= pad;
    for (const line of lines) {
      if (this.y - style.lead < PAGE.bottom) this.newPage();
      this.rect(PAGE.margin + indent, this.y - style.lead, WIDTH - indent, style.lead, COLORS.box);
      this.y -= style.lead - 3; this.line(line, style, { x: PAGE.margin + indent + pad, reorder: false }); this.y -= 3;
    }
    this.rect(PAGE.margin + indent, this.y - pad, WIDTH - indent, pad, COLORS.box); this.y -= pad + STYLES.body.after;
  }
  list(items) {
    const indent = 20;
    items.forEach((item, index) => {
      const entry = typeof item === 'string' ? { text: item } : item, label = `${index + 1}.`, base = paragraphLevel(entry.text), style = STYLES.body;
      const lines = this.wrap(entry.text, style, WIDTH - indent);
      // A small step (text and its command box) stays on one page; a big one may break.
      const need = lines.length * style.lead + (entry.command ? this.commandLines(entry.command, base ? 0 : indent).length * STYLES.mono.lead + 2 * BOX.pad + 12 : 0);
      if (need <= 160) this.ensure(need);
      lines.forEach((line, row) => {
        this.ensure(style.lead); this.y -= style.lead;
        if (!row) this.line(label, STYLES.body, base ? { x: PAGE.margin + WIDTH - indent + 4, width: indent - 4 } : { x: PAGE.margin });
        this.line(line, style, { x: base ? PAGE.margin : PAGE.margin + indent, width: WIDTH - indent, align: base ? 'right' : 'left', base });
      });
      this.y -= 4;
      if (entry.command) this.command(entry.command, base ? 0 : indent);
    });
    this.y -= STYLES.body.after;
  }
  table(columns, rows) {
    const width = WIDTH / columns.length, pad = 4;
    const height = (cells, style) => Math.max(...cells.map(cell => this.wrap(cell, style, width - 2 * pad).length)) * style.lead + 2 * pad;
    const row = (cells, style, fill) => {
      const tall = height(cells, style), top = this.y;
      if (fill) this.rect(PAGE.margin, top - tall, WIDTH, tall, fill);
      cells.forEach((cell, index) => {
        const base = paragraphLevel(cell), x = PAGE.margin + index * width + pad;
        this.y = top - pad;
        for (const line of this.wrap(cell, style, width - 2 * pad)) { this.y -= style.lead; this.line(line, style, { x, width: width - 2 * pad, align: base ? 'right' : 'left', base }); }
      });
      this.y = top - tall; this.rule(this.y);
    };
    const header = () => row(columns, STYLES.head, COLORS.box);
    this.ensure(height(columns, STYLES.head) + (rows[0] ? height(rows[0].map(String), STYLES.cell) : 0)); header();
    for (const cells of rows.map(item => item.map(String))) {
      if (this.y - height(cells, STYLES.cell) < PAGE.bottom) { this.newPage(); header(); }
      row(cells, STYLES.cell);
    }
    this.y -= STYLES.body.after * 2;
  }
  // The title block opens the first page; the guide goes on right below it (no page of its own).
  titlePage({ title, subtitle, lines = [] }) {
    this.paragraph(title, STYLES.title, { after: 4 });
    if (subtitle) this.paragraph(subtitle, STYLES.subtitle, { color: COLORS.muted, after: 8 });
    for (const line of lines) this.paragraph(line);
    this.rule(this.y + 4); this.y -= 8;
  }
}

// A section that asks for a new page gets one only when less than this much of the page is left, so no page is left half empty.
const NEW_PAGE_BELOW = 120;
const FONT_ORDER = ['regular', 'bold', 'mono', 'hebrew'];
const fontIndex = key => FONT_ORDER.indexOf(key) + 1;

// Header and footer of page `index` of `total`, drawn over the page content.
function frame(layout, index, total, { header, secrets }) {
  const saved = [layout.page, layout.y];
  layout.page = []; layout.y = PAGE.height - 34;
  if (secrets) {
    layout.rect(0, PAGE.height - 22, PAGE.width, 22, COLORS.secret);
    layout.y = PAGE.height - 15; layout.line('Contains secrets: login details to your backup storage. Keep this file like a password.', STYLES.small, { color: '1 1 1', width: WIDTH });
    layout.y = PAGE.height - 40;
  }
  layout.line(header, STYLES.small, { color: COLORS.muted, base: paragraphLevel(header), align: paragraphLevel(header) ? 'right' : 'left' });
  layout.y = 34; layout.line(`Page ${index + 1} of ${total}`, STYLES.small, { color: COLORS.muted, align: 'right' });
  // The credit: fixed text and two real links (rectangles under the words, underlined).
  const links = []; let x = PAGE.margin;
  layout.line(CREDIT.text, STYLES.small, { color: COLORS.muted, x }); x += measure(CREDIT.text, STYLES.small) + 8;
  for (const link of CREDIT.links) {
    const width = measure(link.label, STYLES.small);
    layout.line(link.label, STYLES.small, { color: COLORS.link, x, reorder: false });
    layout.page.push(`${COLORS.link} RG 0.5 w ${number(x)} ${number(layout.y - 2)} m ${number(x + width)} ${number(layout.y - 2)} l S`);
    links.push({ rect: [x, layout.y - 4, x + width, layout.y + 8], url: link.url }); x += width + 8;
  }
  const ops = layout.page; [layout.page, layout.y] = saved;
  return { ops, links };
}

function toUnicode(map) {
  const entries = [...map].sort((a, b) => a[0] - b[0]), hex = text => Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase();
  const blocks = [];
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.map(([id, character]) => `<${id.toString(16).padStart(4, '0').toUpperCase()}> <${hex(character)}>`).join('\n')}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

// document: [{ type: 'title' | 'heading' | 'paragraph' | 'list' | 'command' | 'table' | 'pageBreak', ... }]
// options: { title, header, secrets, createdAt (ISO) }. Returns the PDF bytes; throws a 413 error beyond LIMITS.
export function renderPdf(document, { title, header = title, secrets = false, createdAt = new Date().toISOString() }) {
  const layout = new Layout();
  for (const block of document) {
    if (block.type === 'title') layout.titlePage(block);
    else if (block.type === 'heading') { if (block.newPage && layout.left() < NEW_PAGE_BELOW && layout.y < PAGE.height - PAGE.top) layout.newPage(); layout.heading(block.text, block.level ?? 1); }
    else if (block.type === 'paragraph') layout.paragraph(block.text, STYLES.body, { color: COLORS[block.tone] });
    else if (block.type === 'list') layout.list(block.items);
    else if (block.type === 'command') layout.command(block.text, 0, { wrap: block.wrap });
    else if (block.type === 'table') layout.table(block.columns, block.rows);
    else if (block.type === 'pageBreak') layout.newPage();
    else throw new Error('Unknown Recovery Guide block');
  }
  while (layout.pages.length > 1 && !layout.pages.at(-1).length) layout.pages.pop();
  const total = layout.pages.length, frames = layout.pages.map((_, index) => frame(layout, index, total, { header, secrets }));

  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  const stream = (dictionary, data) => { const packed = deflateSync(data); return Buffer.concat([Buffer.from(`<< ${dictionary ? dictionary + ' ' : ''}/Length ${packed.length} /Filter /FlateDecode >>\nstream\n`), packed, Buffer.from('\nendstream')]); };
  add(null); add(null); // 1: catalog, 2: page tree (filled in below)
  const info = add(`<< /Title ${pdfString(title)} /Producer (DockNest) /CreationDate (D:${createdAt.replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
  const resources = [];
  for (const key of FONT_ORDER.filter(item => layout.used.has(item))) {
    const face = font(key), glyphs = layout.used.get(key), scale = 1000 / face.unitsPerEm;
    const file = add(stream(`/Length1 ${face.bytes.length}`, face.bytes));
    const descriptor = add(`<< /Type /FontDescriptor /FontName /${face.name} /Flags ${face.fixedPitch ? 33 : 32} /FontBBox [${face.bbox.map(value => Math.round(value * scale)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(face.ascent * scale)} /Descent ${Math.round(face.descent * scale)} /CapHeight ${Math.round(face.ascent * scale)} /StemV 80 /FontFile2 ${file} 0 R >>`);
    const widths = [...glyphs.keys()].sort((a, b) => a - b).map(id => `${id} [${Math.round(face.widths[id] * scale)}]`).join(' ');
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${face.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${widths}] >>`);
    const unicode = add(stream('', Buffer.from(toUnicode(glyphs))));
    resources.push(`/F${fontIndex(key)} ${add(`<< /Type /Font /Subtype /Type0 /BaseFont /${face.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${unicode} 0 R >>`)} 0 R`);
  }
  const kids = layout.pages.map((ops, index) => {
    const contents = add(stream('', Buffer.from([...ops, ...frames[index].ops].join('\n'))));
    const annotations = frames[index].links.map(link => add(`<< /Type /Annot /Subtype /Link /Rect [${link.rect.map(number).join(' ')}] /Border [0 0 0] /F 4 /A << /S /URI /URI ${pdfString(link.url)} >> >>`));
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << ${resources.join(' ')} >> >> /Contents ${contents} 0 R /Annots [${annotations.map(item => `${item} 0 R`).join(' ')}] >>`);
  });
  objects[0] = '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.map(kid => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [];
  let length = chunks[0].length;
  objects.forEach((body, index) => {
    const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
    offsets.push(length); chunks.push(bytes); length += bytes.length;
    if (length > LIMITS.bytes) throw tooLarge();
  });
  const id = createHash('sha256').update(Buffer.concat(chunks)).digest('hex').slice(0, 32).toUpperCase();
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${length}\n%%EOF\n`));
  const output = Buffer.concat(chunks);
  if (output.length > LIMITS.bytes) throw tooLarge();
  return output;
}
