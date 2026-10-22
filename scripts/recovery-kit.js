import { readFile,lstat } from 'node:fs/promises';
import { exportRecoveryKit,restoreRecoveryKit,updateRunningMessage } from '../src/recovery-kit.js';
// --ignore-updater (restore only) skips the running-update guard, for disaster recovery when the updater status is
// known to be wrong. DOCKNEST_UPDATER_STATUS points the guard at another status directory, such as the volume's host path.
const args=process.argv.slice(2).filter(arg=>arg!=='--ignore-updater'),ignoreUpdater=args.length!==process.argv.length-2;
const [operation,path,passphraseFile]=args;
try{
 if(!['export','restore'].includes(operation)||!path||(ignoreUpdater&&operation!=='restore'))throw new Error('Usage: node scripts/recovery-kit.js export OUTPUT.dkit [PRIVATE_PASSPHRASE_FILE] | restore [--ignore-updater] INPUT.dkit NEW_DIRECTORY PRIVATE_PASSPHRASE_FILE');
 const credentialFile=operation==='restore'?args[3]:passphraseFile;
 let passphrase;
 if(credentialFile){const info=await lstat(credentialFile);if(!info.isFile()||info.isSymbolicLink()||info.size>4096||(process.platform!=='win32'&&(info.mode&0o077)))throw new Error('Use a regular private passphrase file, mode 0600');passphrase=(await readFile(credentialFile,'utf8')).trimEnd();}
 else{if(process.stdin.isTTY)throw new Error('Pipe the passphrase through stdin or use a private passphrase file');const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>4096)throw new Error('Passphrase input exceeds limit');chunks.push(chunk);}passphrase=Buffer.concat(chunks).toString().trimEnd();}
 let result;
 if(operation==='export'){const {db}=await import('../src/db.js'),{config}=await import('../src/config.js');try{result=await exportRecoveryKit({database:db,masterKey:config.masterKey,output:path,passphrase,release:process.env.DOCKNEST_RELEASE||'unknown'});}finally{db.close();}}
 else{
  if(!passphraseFile)throw new Error('New recovery directory required');
  if(ignoreUpdater)console.error('WARNING: --ignore-updater: restoring without checking for a running DockNest update. Do not put the restored state in service while an update is running.');
  result=await restoreRecoveryKit({input:path,directory:passphraseFile,passphrase,ignoreUpdater,...(process.env.DOCKNEST_UPDATER_STATUS?{updaterStatus:process.env.DOCKNEST_UPDATER_STATUS}:{})});
 }
 console.log(JSON.stringify(result));
}catch(error){console.error(['Recovery kit authentication failed','Manager snapshot validation failed'].includes(error.message)||error.status===409?error.message+(error.message===updateRunningMessage?' If no update is running, retry with --ignore-updater.':''):'Recovery kit operation failed. Check arguments, private paths, passphrase and storage capacity.');process.exitCode=1;}
