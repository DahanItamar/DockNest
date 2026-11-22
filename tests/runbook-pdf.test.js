// The in-house Recovery Guide PDF writer (src/runbook/pdf.js), its fonts and its bidi pass: pinned font files, the
// golden structure (xref offsets, object count, trailer), escaping (injected PDF operators stay text), right-to-left
// Hebrew mixed with Latin text and digits, the ToUnicode round trip, the "Contains secrets" mark and the limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { renderPdf, pdfString, LIMITS } from '../src/runbook/pdf.js';
import { visualOrder, paragraphLevel } from '../src/runbook/bidi.js';
import { FONT_FILES, font } from '../src/runbook/fonts.js';
import { readObjects, readLines, readText } from './pdf-text.js';

const createdAt = '2026-11-20T10:00:00.000Z';
const sample = [
  { type: 'title', title: 'Recovery Guide', subtitle: 'Made on 20 November 2026', lines: ['Keep this guide with the emergency kit.'] },
  { type: 'heading', text: 'Start here' },
  { type: 'paragraph', text: 'Get a new server first. Any Linux server with Docker works.' },
  { type: 'list', items: ['Open Storage.', { text: 'Copy this command.', command: 'git clone --branch v3.0.0 https://github.com/DahanItamar/DockNest.git' }] },
  { type: 'table', columns: ['App', 'Server', 'Last good backup'], rows: [['Shop', 'web-1', '19 November 2026']] },
];

test('the vendored fonts are the pinned files, with their licences', () => {
  const pinned = {
    'Roboto-Regular.ttf': '15256405ecb0d880678833a582760efad538ab2932318b52c8105b267d159459',
    'Roboto-Bold.ttf': '4aaf8c5b661a386998c2e70cf2b87e2440f5404e0b8fd81164f0413fb3435ec6',
    'RobotoMono-Regular.ttf': 'e4bf45837847d4abfa5a502b807a83393aa138727bdb9ea9c93fb17d53208d95',
    'NotoSansHebrew-Regular.ttf': 'e0ee753f09733337b9236221018d4bf71fd6d06c87dd76bbc83120514bc55911',
  };
  assert.deepEqual(Object.values(FONT_FILES).map(item => item.file).sort(), Object.keys(pinned).sort());
  for (const [file, sha256] of Object.entries(pinned)) assert.equal(createHash('sha256').update(readFileSync(new URL(`../assets/fonts/${file}`, import.meta.url))).digest('hex'), sha256, file);
  for (const family of ['Roboto', 'RobotoMono', 'NotoSansHebrew']) assert.match(readFileSync(new URL(`../assets/fonts/OFL-${family}.txt`, import.meta.url), 'utf8'), /SIL Open Font License, Version 1\.1/);
  assert.ok(font('hebrew').cmap.get(0x05e9) && font('regular').cmap.get(0x41) && font('mono').cmap.get(0x24), 'the character maps cover Hebrew, Latin and shell text');
});

test('golden structure: header, xref offsets of every object, object count and trailer', () => {
  const pdf = renderPdf(sample, { title: 'Recovery Guide', createdAt }), text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.7\n%'));
  assert.ok(text.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 5), 'xref\n');
  const [, first, count] = /^xref\n(\d+) (\d+)\n/.exec(text.slice(startxref));
  assert.equal(Number(first), 0);
  const entries = text.slice(startxref).split('\n').slice(2, 2 + Number(count));
  assert.equal(entries[0], '0000000000 65535 f ');
  entries.slice(1).forEach((entry, index) => {
    assert.match(entry, /^\d{10} 00000 n $/);
    assert.equal(text.slice(Number(entry.slice(0, 10)), Number(entry.slice(0, 10)) + `${index + 1} 0 obj\n`.length), `${index + 1} 0 obj\n`, `xref offset of object ${index + 1}`);
  });
  const trailer = /trailer\n<< \/Size (\d+) \/Root 1 0 R \/Info (\d+) 0 R \/ID \[<([0-9A-F]{32})> <\3>\] >>/.exec(text);
  assert.ok(trailer, 'trailer with Size, Root, Info and ID');
  assert.equal(Number(trailer[1]), Number(count));
  const objects = readObjects(pdf);
  assert.equal(objects.size, Number(count) - 1);
  assert.match(objects.get(1).dictionary, /^<< \/Type \/Catalog \/Pages 2 0 R /);
  assert.match(objects.get(2).dictionary, /\/Type \/Pages \/Kids \[[\d 0R]+\] \/Count 1 >>$/);
  const fonts = [...objects.values()].filter(object => /\/Subtype \/Type0 /.test(object.dictionary));
  assert.ok(fonts.length >= 3 && fonts.every(object => /\/Encoding \/Identity-H \/DescendantFonts \[\d+ 0 R\] \/ToUnicode \d+ 0 R/.test(object.dictionary)));
  assert.ok([...objects.values()].some(object => /\/Subtype \/CIDFontType2 .*\/CIDToGIDMap \/Identity/.test(object.dictionary)));
  for (const forbidden of ['/JavaScript', '/JS ', '/AcroForm', '/EmbeddedFile', '/Launch', '/OpenAction', '/AA ']) assert.ok(!text.includes(forbidden), forbidden);
  assert.deepEqual(renderPdf(sample, { title: 'Recovery Guide', createdAt }), pdf, 'the same input gives the same bytes');
  assert.match(readText(pdf), /Start here[\s\S]*1\.\nOpen Storage\.[\s\S]*git clone --branch v3\.0\.0/);
  assert.match(readText(pdf), /Page 1 of 1/);
  // The only links are the two DockNest credit links, real URI annotations, and nothing from the input.
  assert.deepEqual([...text.matchAll(/\/URI \(([^)]*)\)/g)].map(match => match[1]).sort(), ['https://github.com/DahanItamar/DockNest', 'https://trydocknest.com']);
  assert.equal([...text.matchAll(/\/Subtype \/Link/g)].length, 2);
  assert.match(readText(pdf), /Made with DockNest[\s\S]*github\.com\/DahanItamar\/DockNest[\s\S]*trydocknest\.com/);
});
test('sections flow on: the title shares page 1, a short section needs no page of its own, and the credit is on every page', () => {
  const filler = Array.from({ length: 36 }, (_, index) => ({ type: 'paragraph', text: `Line ${index + 1} of the guide.` }));
  const pdf = renderPdf([...sample, { type: 'heading', text: 'Next', newPage: true }, { type: 'paragraph', text: 'Short.' }, ...filler], { title: 'Recovery Guide', createdAt });
  const text = pdf.toString('latin1'), pages = Number(/\/Count (\d+) >>/.exec(text)[1]);
  assert.equal(pages, 2);
  assert.equal([...text.matchAll(/\/URI \(https:\/\/trydocknest\.com\)/g)].length, pages, 'one credit link per page');
  assert.match(readText(pdf), /Next\nShort\./);
});

test('escaping: injected PDF operators, brackets, backslashes and control characters stay text', () => {
  const nasty = [') Tj ET BT /F1 99 Tf (owned) Tj', '\\) Tj', '(((', ')))', '\\\\(', 'a\nb\rc\td\u0000e\u001f', 'endstream endobj', '>> /JavaScript (app.alert(1))', 'שלום ) Tj (', '‮evil'];
  for (let round = 0; round < 40; round++) nasty.push([...randomBytes(24)].map(byte => String.fromCharCode(byte % 3 ? 32 + byte % 95 : byte % 32)).join(''));
  for (const value of nasty) {
    const pdf = renderPdf([{ type: 'heading', text: value }, { type: 'paragraph', text: value }, { type: 'command', text: value }, { type: 'table', columns: [value], rows: [[value]] }], { title: value, createdAt });
    for (const object of readObjects(pdf).values()) {
      if (!object.stream || !/^BT |\/Span/m.test(object.stream.toString('latin1'))) continue;
      for (const line of object.stream.toString('latin1').split('\n')) {
        if (line.startsWith('BT ')) assert.match(line, /^BT [\d. ]+ rg -?[\d.]+ -?[\d.]+ Td( \/F\d [\d.]+ Tf <[0-9a-f]*> Tj)+ ET$/, 'text is glyph ids in hex only');
        else if (line.startsWith('/Span')) assert.match(line, /^\/Span <<\/ActualText (<[0-9A-F]+>|\((?:\\[0-7]{3}|\\[\\()]|[^\\()])*\))>> BDC$/);
      }
    }
    const info = pdf.toString('latin1').match(/\/Title (<[0-9A-F]+>|\((?:\\[0-7]{3}|\\[\\()]|[^\\()\x00-\x1f])*\)) \/Producer/);
    assert.ok(info, 'the title is one escaped string');
  }
  const unescape = literal => literal.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, code) => (code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : code));
  for (const value of ['plain', ') Tj', 'a\\b(c)d', 'tab\there\u0001']) assert.equal(unescape(pdfString(value)), value);
  assert.equal(pdfString('שלום'), '<FEFF05E905DC05D505DD>');
});

test('bidi: Hebrew, Latin, digits and brackets on one line come out in visual order', () => {
  assert.equal(paragraphLevel('שלום world'), 1);
  assert.equal(paragraphLevel('Backup 3 שלום'), 0);
  assert.equal(paragraphLevel('123 ...'), 0);
  const cases = [
    ['שלום world 123', 'world 123 םולש'],
    ['גרסה 3.0.0 מוכנה', 'הנכומ 3.0.0 הסרג'],
    ['אבג (דה)', '(הד) גבא'],
    ['האתר example.com עובד', 'דבוע example.com רתאה'],
    ['גיבוי 2026-11-20 הצליח', 'חילצה 2026-11-20 יוביג'],
    ['מחיר 50% הנחה', 'החנה 50% ריחמ'],
    ['Open the app חנות and check it.', 'Open the app תונח and check it.'],
    ['Restore שלום (test) now', 'Restore םולש (test) now'],
    ['Open (חנות) now', 'Open (תונח) now'],
    ['plain text only', 'plain text only'],
    ['שָׁלוֹם', 'םוֹלשָׁ'],
  ];
  for (const [logical, visual] of cases) assert.equal(visualOrder(logical), visual, logical);
  assert.equal(visualOrder('a‮b'), 'ab', 'explicit override characters are dropped');
});

test('a mixed Hebrew line is drawn as its visual glyph sequence and reads back as the logical text', () => {
  const logical = 'שלום world 123 (גרסה 3.0.0)';
  const pdf = renderPdf([{ type: 'paragraph', text: logical }, { type: 'paragraph', text: 'Plain English line.' }], { title: 'Recovery Guide', createdAt });
  const lines = readLines(pdf), drawn = lines.find(line => line.actual !== null);
  assert.equal(drawn.text, visualOrder(logical, 1), 'the glyph ids map back through ToUnicode to the visual order');
  assert.equal(drawn.actual, logical, 'ActualText gives the logical text back');
  assert.equal(lines.find(line => line.text === 'Plain English line.').actual, null);
  const objects = readObjects(pdf);
  assert.ok([...objects.values()].some(object => /\/BaseFont \/NotoSansHebrew-Regular \/Encoding \/Identity-H/.test(object.dictionary)), 'Hebrew comes from Noto Sans Hebrew');
  assert.ok(![...objects.values()].some(object => /\/BaseFont \/RobotoMono-Regular/.test(object.dictionary)), 'a font no text uses is not embedded');
});

test('"Contains secrets" is marked on every page when the guide holds login details, and only then', () => {
  const long = [{ type: 'title', title: 'Recovery Guide' }, ...Array.from({ length: 120 }, (_, index) => ({ type: 'paragraph', text: `Step ${index + 1}: open the app and check it works.` }))];
  const marked = readLines(renderPdf(long, { title: 'Recovery Guide', secrets: true, createdAt }));
  const pages = Math.max(...marked.map(line => line.page));
  assert.ok(pages >= 3);
  for (let page = 1; page <= pages; page++) {
    assert.ok(marked.some(line => line.page === page && line.text.startsWith('Contains secrets')), `page ${page} is marked`);
    assert.ok(marked.some(line => line.page === page && line.text === `Page ${page} of ${pages}`), `page ${page} is numbered`);
  }
  assert.ok(!readText(renderPdf(long, { title: 'Recovery Guide', createdAt })).includes('Contains secrets'));
});

test('limits: more than 2,000 pages is refused', () => {
  assert.equal(LIMITS.pages, 2000); assert.equal(LIMITS.bytes, 64 * 1024 * 1024);
  assert.throws(() => renderPdf(Array.from({ length: 2001 }, () => ({ type: 'pageBreak' })), { title: 'Recovery Guide', createdAt }), error => error.status === 413);
  assert.throws(() => renderPdf([{ type: 'script' }], { title: 'Recovery Guide', createdAt }), /Unknown Recovery Guide block/);
});
