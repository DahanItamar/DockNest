import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Run in the built image with /data bound to a restricted host directory.
await mkdir('/data', {recursive:true,mode:0o700});
for (const [file,encoding] of [['master.key','base64'],['setup.token','base64url']]) {
 try { await writeFile('/data/'+file,randomBytes(32).toString(encoding)+'\n',{flag:'wx',mode:0o600}); }
 catch(error) { if(error.code!=='EEXIST')throw error; }
}
if(Buffer.from((await readFile('/data/master.key','utf8')).trim(),'base64').length!==32)throw new Error('Existing master key is invalid and was preserved.');
console.log('Production secret files are ready in /data. Existing files were preserved; no secret values are printed.');
