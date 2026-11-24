// Release build only (scripts/build-helper-runtime.sh): writes the helper runtime image ID and the SHA-256 of its tar
// into shared/helper-runtime.js, in the working copy that goes into the DockNest image. Both values are validated first;
// anything else is refused and nothing is written. The committed file keeps null, so a source build fails closed.
//   node scripts/pin-helper-runtime.js --image-id sha256:<64 hex> --tar-sha256 <64 hex> [--file path]
//   node scripts/pin-helper-runtime.js --id-from-tar helper-runtime.tar     (prints the image ID of a docker save tar)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname } from 'node:path';
import { IMAGE_ID_PATTERN, TAR_SHA256_PATTERN, isLayerList } from '../shared/helper-runtime.js';

const defaultFile = fileURLToPath(new URL('../shared/helper-runtime.js', import.meta.url));

export function pinText(text, imageId, tarSha256, layers) {
  if (!isLayerList(layers)) throw new Error('The layers must be a list of sha256 values.');
  if (!IMAGE_ID_PATTERN.test(String(imageId))) throw new Error('The image ID must be sha256: followed by 64 lowercase hex characters.');
  if (!TAR_SHA256_PATTERN.test(String(tarSha256))) throw new Error('The tar checksum must be 64 lowercase hex characters.');
  const line = name => new RegExp(`^export const ${name} = (?:null|'[^']*'|\\[[^\\]]*\\]);`, 'm');
  let out = text;
  for (const [name, value] of [['HELPER_RUNTIME_IMAGE_ID', `'${imageId}'`], ['HELPER_RUNTIME_TAR_SHA256', `'${tarSha256}'`], ['HELPER_RUNTIME_LAYERS', JSON.stringify(layers).replaceAll('"', "'")]]) {
    if (!line(name).test(out)) throw new Error(`${name} was not found in the expected form.`);
    out = out.replace(line(name), () => `export const ${name} = ${value};`);
  }
  return out;
}

// The image ID of `docker save` output is the SHA-256 of the image configuration, named by manifest.json. This reads
// only that name (tar -xOf, fixed argv) and refuses anything that is not exactly one image.
export function imageIdFromTar(tarPath) {
  const out = spawnSync('tar', ['-xOf', basename(tarPath), 'manifest.json'], { cwd: dirname(tarPath), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (out.status !== 0) throw new Error('The tar has no manifest.json.');
  const manifest = JSON.parse(out.stdout);
  if (!Array.isArray(manifest) || manifest.length !== 1 || typeof manifest[0]?.Config !== 'string') throw new Error('The tar must hold exactly one image.');
  const match = /^(?:blobs\/sha256\/)?([a-f0-9]{64})(?:\.json)?$/.exec(manifest[0].Config);
  if (!match) throw new Error('The image configuration is not named by its SHA-256.');
  return 'sha256:' + match[1];
}

// The layer IDs (rootfs diff IDs) of the one image in a docker save tar: read from its configuration blob.
export function layersFromTar(tarPath) {
  const run = member => spawnSync('tar', ['-xOf', basename(tarPath), member], { cwd: dirname(tarPath), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const manifest = run('manifest.json');
  if (manifest.status !== 0) throw new Error('The tar has no manifest.json.');
  const config = JSON.parse(manifest.stdout)?.[0]?.Config;
  if (typeof config !== 'string' || !/^(?:blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}\.json)$/.test(config)) throw new Error('The image configuration is not named by its SHA-256.');
  const blob = run(config);
  if (blob.status !== 0) throw new Error('The tar has no image configuration.');
  const layers = JSON.parse(blob.stdout)?.rootfs?.diff_ids;
  if (!isLayerList(layers)) throw new Error('The image configuration lists no valid layers.');
  return layers;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    if (value('--id-from-tar')) console.log(imageIdFromTar(value('--id-from-tar')));
    else if (value('--layers-from-tar')) console.log(JSON.stringify(layersFromTar(value('--layers-from-tar'))));
    else {
      const file = value('--file') ?? defaultFile;
      writeFileSync(file, pinText(readFileSync(file, 'utf8'), value('--image-id'), value('--tar-sha256'), JSON.parse(value('--layers') ?? 'null')));
      console.log('Pinned the helper runtime image ' + value('--image-id'));
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
