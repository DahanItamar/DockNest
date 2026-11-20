// The offline emergency kit tool as ONE file, for the recovery kit (recovery/emergency-open.js): a holder may have only
// that file and Node 24. Built from the checked-in sources on every export, so it can never be stale:
// src/emergency/wordlist.js, slip39.js and envelope.js each become a namespace object, and scripts/emergency-open.js
// runs on them. Sources may import only node: built-ins and each other, one import per line and one name per export
// line; anything else stops the build, so the bundled tool can never reach the network or a missing file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODULES = Object.freeze(['wordlist', 'slip39', 'envelope']);
const BUILT_INS = new Set(['node:crypto', 'node:fs/promises', 'node:path', 'node:readline']);
const read = url => readFileSync(fileURLToPath(url), 'utf8').replace(/\r\n/g, '\n');
const IMPORT = /^import \{ ([^}]+) \} from '([^']+)';$/, EXPORT = /^export (?:const|function|class) ([A-Za-z_$][\w$]*)/;

function parse(text, name) {
  const imports = [], body = [], exported = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('import ')) {
      const match = IMPORT.exec(line);
      if (!match) throw new Error(`${name}: unsupported import`);
      imports.push({ names: match[1].split(',').map(item => item.trim()), from: match[2] });
      continue;
    }
    const exportMatch = EXPORT.exec(line);
    if (exportMatch) exported.push(exportMatch[1]);
    else if (line.startsWith('export ')) throw new Error(`${name}: unsupported export`);
    body.push(exportMatch ? line.slice('export '.length) : line);
  }
  return { imports, body: body.join('\n'), exported };
}
const moduleOf = from => /^(?:\.\/|\.\.\/src\/emergency\/)([a-z0-9]+)\.js$/.exec(from)?.[1];

export function buildEmergencyTool() {
  const builtIns = new Map(), sections = [];
  const link = (imports, name) => imports.map(({ names, from }) => {
    if (BUILT_INS.has(from)) { for (const item of names) (builtIns.get(from) ?? builtIns.set(from, new Set()).get(from)).add(item); return null; }
    const target = moduleOf(from);
    if (!target || !MODULES.includes(target) || !sections.some(section => section.name === target)) throw new Error(`${name}: import of ${from} cannot be bundled`);
    return `const { ${names.join(', ')} } = ${target};`;
  }).filter(Boolean);
  for (const name of MODULES) {
    const { imports, body, exported } = parse(read(new URL(`./${name}.js`, import.meta.url)), name);
    sections.push({ name, text: `const ${name} = (() => {\n${[...link(imports, name), body].join('\n')}\nreturn { ${exported.join(', ')} };\n})();` });
  }
  const tool = parse(read(new URL('../../scripts/emergency-open.js', import.meta.url)), 'emergency-open');
  const main = [...link(tool.imports, 'emergency-open'), tool.body].join('\n');
  const header = [...builtIns].map(([from, names]) => `import { ${[...names].sort().join(', ')} } from '${from}';`);
  return ['// DockNest emergency kit tool, one-file build of scripts/emergency-open.js (src/emergency/bundle.js). Node 24, offline.', ...header, ...sections.map(section => section.text), main].join('\n');
}

let cached;
export const emergencyToolSource = () => (cached ??= Buffer.from(buildEmergencyTool(), 'utf8'));
