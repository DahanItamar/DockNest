// Safe Edit review diff (docs/safe-edit.md, "API"). Pure: no database, SSH or clock.
// - File diffs are line based with 3 lines of context, computed here from the loaded originals and the reviewed
//   candidates. The Compose editor may show values the file already holds (administrator plus re-verification), so a
//   Compose diff shows its text; environment values never appear: an env change is a row with `value: '(changed)'`.
// - No YAML or diff library is added: common prefix and suffix are trimmed, the middle is an LCS when it is small and a
//   plain "replaced block" when it is not (still exact, only less fine-grained).
export const CONTEXT_LINES = 3;
export const MASK = '(changed)';
const LCS_CELLS = 4_000_000;

export const splitLines = text => {
  const value = String(text ?? '');
  if (value === '') return [];
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

// Edit script between two line arrays: [{ type: 'context'|'remove'|'add', text }].
export function lineScript(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const head = before.slice(0, start).map(text => ({ type: 'context', text }));
  const tail = before.slice(endBefore).map(text => ({ type: 'context', text }));
  const a = before.slice(start, endBefore), b = after.slice(start, endAfter);
  let middle;
  if (!a.length || !b.length || a.length * b.length > LCS_CELLS) {
    middle = [...a.map(text => ({ type: 'remove', text })), ...b.map(text => ({ type: 'add', text }))];
  } else {
    // Classic LCS table on the changed middle only.
    const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    middle = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { middle.push({ type: 'context', text: a[i] }); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) middle.push({ type: 'remove', text: a[i++] });
      else middle.push({ type: 'add', text: b[j++] });
    }
    while (i < a.length) middle.push({ type: 'remove', text: a[i++] });
    while (j < b.length) middle.push({ type: 'add', text: b[j++] });
  }
  return [...head, ...middle, ...tail];
}

// Hunks in the unified-diff sense, line numbers 1-based. An unchanged file has no hunks.
export function hunks(beforeText, afterText, context = CONTEXT_LINES) {
  const script = lineScript(splitLines(beforeText), splitLines(afterText));
  const changed = script.map((line, index) => (line.type === 'context' ? -1 : index)).filter(index => index >= 0);
  if (!changed.length) return [];
  const ranges = [];
  for (const index of changed) {
    const from = Math.max(0, index - context), to = Math.min(script.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to); else ranges.push({ from, to });
  }
  const result = [];
  for (const { from, to } of ranges) {
    let oldLine = 1, newLine = 1;
    for (let k = 0; k < from; k++) { if (script[k].type !== 'add') oldLine++; if (script[k].type !== 'remove') newLine++; }
    const lines = script.slice(from, to + 1);
    result.push({ oldStart: oldLine, oldLines: lines.filter(line => line.type !== 'add').length, newStart: newLine, newLines: lines.filter(line => line.type !== 'remove').length, lines });
  }
  return result;
}

// The diff the Review screen shows. `originals`: [{ path, text }] as loaded; `files`: the candidates; `envChanges`:
// what the helper's verdict reports per key. Environment values are never read here, so none can leak.
export function reviewDiff({ originals = [], files = [], env = [] }) {
  const byPath = new Map(originals.map(file => [file.path, file.text]));
  const fileDiffs = files.map(file => ({ path: file.path, hunks: hunks(byPath.get(file.path) ?? '', file.text) })).filter(file => file.hunks.length);
  const envRows = env.map(entry => ({ file: entry.file, key: entry.key, change: entry.remove ? 'removed' : entry.existed ? 'replaced' : 'added', value: entry.remove ? null : MASK }));
  return { files: fileDiffs, env: envRows };
}

// Keys whose name suggests a secret, holding an inline value in a Compose file: Review suggests moving them to
// Environment ("Move secrets to Environment"). Only key names are returned, never the values.
const SECRET_NAME = /(PASS(WORD|WD)?|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
export function inlineSecretKeys(text) {
  const keys = new Set();
  for (const line of splitLines(text)) {
    const match = /^\s*-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*(.*)$/.exec(line);
    if (!match || !SECRET_NAME.test(match[1])) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (value && !/^\$\{?[A-Za-z_][A-Za-z0-9_]*/.test(value) && !value.startsWith('#')) keys.add(match[1]);
  }
  return [...keys].sort();
}
