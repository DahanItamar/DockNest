// The remote helper ships to servers as ONE Python file (streamed over SSH, copied by boot recovery and the restore
// test reaper, put in the recovery kit as recovery/helper.py). Its source is the package remote/helper/, one module
// per domain. This joins the modules, in HELPER_MODULES order, into a single namespace, so every global, `global`
// statement and test patch behaves exactly as it did in the single file. Each module's build header (imports that
// exist only for editors) is removed. Mutable state is defined once, in common.py. See docs/remote-helper.md.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELPER_MODULES = Object.freeze(['common', 'guides', 'paths', 'databases', 'backup', 'incremental', 'net',
  'maintenance', 'discovery', 'restore', 'staging', 'move', 'install', 'restore_test', '__main__']);
const source = fileURLToPath(new URL('../remote/helper/', import.meta.url));
const OPEN = '# <build:header>', CLOSE = '# </build:header>';

export function buildHelper(directory = source) {
  const present = readdirSync(directory).filter(name => name.endsWith('.py') && name !== '__init__.py').map(name => name.slice(0, -3)).sort();
  const expected = [...HELPER_MODULES].sort();
  if (present.join() !== expected.join()) throw new Error(`remote/helper modules ${present.join(', ')} do not match HELPER_MODULES`);
  return HELPER_MODULES.map(name => {
    const text = readFileSync(join(directory, name + '.py'), 'utf8').replace(/\r\n/g, '\n');  // same bytes on every OS
    const lines = text.split('\n'), start = lines.indexOf(OPEN), end = lines.indexOf(CLOSE);
    if (start < 0 || end < start || lines.indexOf(OPEN, start + 1) >= 0) throw new Error(`remote/helper/${name}.py needs exactly one build header`);
    return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
  }).join('\n');
}

let cached;
// The helper as served to servers. Built once per process from the checked-in source, so it can never be stale.
export const helperSource = () => (cached ??= Buffer.from(buildHelper(), 'utf8'));

// Python tests and integration hosts import the built file: `import helper`.
// Never under dist/: the API serves dist/ without login, and the app itself never reads this file.
export function writeHelperBundle(directory = fileURLToPath(new URL('../build/remote/', import.meta.url))) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'helper.py');
  writeFileSync(file, helperSource());
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log('Wrote ' + writeHelperBundle(process.argv[2]));
