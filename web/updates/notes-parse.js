// Release notes: a text-only renderer model (docs/update-center.md section 8). Builds plain nodes from a fixed subset:
// headings 1-3, paragraphs, "-" lists, **bold**, `code`, fenced code and links. No HTML is ever produced or interpreted.
export const NOTES_LIMIT = 64 * 1024;
const REPO = 'https://github.com/DahanItamar/DockNest';
export function stripFrontMatter(text) {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}
// Only links into the DockNest repository become anchors. A relative link points at the same file at the release tag.
export function safeHref(raw, tag) {
  const url = String(raw ?? '');
  if (/^https:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && !u.port && (u.pathname === '/DahanItamar/DockNest' || u.pathname.startsWith('/DahanItamar/DockNest/'))) return u.href;
    } catch { /* not a URL */ }
    return null;
  }
  if (!/^[A-Za-z0-9._\-/#]+$/.test(url) || url.startsWith('//') || url.startsWith('/') || url.split('/').some(part => part === '..') || !/^v\d+\.\d+\.\d+$/.test(tag || '')) return null;
  return REPO + '/blob/' + tag + '/' + url.replace(/^\.\//, '');
}
export function parseInline(text, tag, depth = 0) {
  const out = [];
  let buf = '', i = 0;
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  while (i < text.length) {
    if (depth < 3 && text.startsWith('**', i)) {
      const j = text.indexOf('**', i + 2);
      if (j > i + 2) { flush(); out.push({ t: 'bold', c: parseInline(text.slice(i + 2, j), tag, depth + 1) }); i = j + 2; continue; }
    }
    if (text[i] === '`') {
      const j = text.indexOf('`', i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'code', v: text.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (text[i] === '[' && text[i - 1] !== '!') {
      const m = /^\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/.exec(text.slice(i, i + 720));
      if (m) {
        flush();
        const href = safeHref(m[2], tag);
        out.push(href ? { t: 'link', href, c: [{ t: 'text', v: m[1] }] } : { t: 'text', v: m[1] });
        i += m[0].length; continue;
      }
    }
    buf += text[i++];
  }
  flush();
  return out;
}
export function parseNotes(markdown, tag) {
  const text = stripFrontMatter(String(markdown ?? '').slice(0, NOTES_LIMIT)).replace(/\r\n?/g, '\n');
  const blocks = [], lines = text.split('\n');
  let paragraph = [], list = null;
  const endParagraph = () => { if (paragraph.length) blocks.push({ t: 'p', c: parseInline(paragraph.join(' '), tag) }); paragraph = []; };
  const endList = () => { if (list) blocks.push(list); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      endParagraph(); endList();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { endParagraph(); endList(); blocks.push({ t: 'h', level: heading[1].length, c: parseInline(heading[2], tag) }); continue; }
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (item) { endParagraph(); (list ||= { t: 'ul', items: [] }).items.push(parseInline(item[1], tag)); continue; }
    if (!line.trim()) { endParagraph(); endList(); continue; }
    endList(); paragraph.push(line.trim());
  }
  endParagraph(); endList();
  return blocks;
}
