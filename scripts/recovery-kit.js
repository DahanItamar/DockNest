import { readFile,lstat } from 'node:fs/promises';
import { exportRecoveryKit,restoreRecoveryKit } from '../src/recovery-kit.js';
const [operation,path,passphraseFile]=process.argv.slice(2);
try{
 if(!['export','restore'].includes(operation)||!path)throw new Error('Usage: node scripts/recovery-kit.js export OUTPUT.dkit [PRIVATE_PASSPHRASE_FILE] | restore INPUT.dkit NEW_DIRECTORY PRIVATE_PASSPHRASE_FILE');
 const credentialFile=operation==='restore'?process.argv[5]:passphraseFile;
 let passphrase;
 if(credentialFile){const info=await lstat(credentialFile);if(!info.isFile()||info.isSymbolicLink()||info.size>4096||(process.platform!=='win32'&&(info.mode&0o077)))throw new Error('Use a regular private passphrase file, mode 0600');passphrase=(await readFile(credentialFile,'utf8')).trimEnd();}
 else{if(process.stdin.isTTY)throw new Error('Pipe the passphrase through stdin or use a private passphrase file');const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>4096)throw new Error('Passphrase input exceeds limit');chunks.push(chunk);}passphrase=Buffer.concat(chunks).toString().trimEnd();}
 let result;
 if(operation==='export'){const {db}=await import('../src/db.js'),{config}=await import('../src/config.js');try{result=await exportRecoveryKit({database:db,masterKey:config.masterKey,output:path,passphrase,release:process.env.DOCKNEST_RELEASE||'unknown'});}finally{db.close();}}
 else{if(!passphraseFile)throw new Error('New recovery directory required');result=await restoreRecoveryKit({input:path,directory:passphraseFile,passphrase});}
 console.log(JSON.stringify(result));
}catch(error){console.error(['Recovery kit authentication failed','Manager snapshot validation failed'].includes(error.message)?error.message:'Recovery kit operation failed. Check arguments, private paths, passphrase and storage capacity.');process.exitCode=1;}
