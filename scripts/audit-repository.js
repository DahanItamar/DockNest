import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

// Reports paths and categories only, never matched credentials or private values.
const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean),findings=[];
// Protocol-defined special-purpose ranges that policy text must be able to name; they are not infrastructure.
const protocolReserved=(a,b,c)=>(a===169&&b===254)||(a===100&&b>=64&&b<=127)||(a===192&&b===0&&c===0)||(a===198&&(b===18||b===19))||a>=224;
const allowedAddress=value=>{
 const [a,b,c]=value.split('.').map(Number);
 return a===0||a===10||a===127||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===192&&b===0&&c===2)||(a===198&&b===51&&c===100)||(a===203&&b===0&&c===113)||protocolReserved(a,b,c)||['1.1.1.1','8.8.8.8','255.255.255.255'].includes(value);
};
for(const path of paths){
 if(path!=='.env.example'&&/(^|\/)(\.env(?:\..*)?|master\.key|setup\.token|id_rsa|id_ed25519|[^/]+\.(?:pem|p12|pfx|sqlite|db|enc))$/i.test(path))findings.push({path,category:'credential or runtime file'});
 let data;try{data=await readFile(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
 if(data.subarray(0,8192).includes(0))continue;
 const text=data.toString('utf8');
 if(/(?:[A-Z]:[\\/]Users[\\/][^\s/\\]+|[A-Z]:[\\/]Dev[\\/]repos[\\/])/i.test(text))findings.push({path,category:'personal workstation path'});
 if([...text.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)/g)].some(match=>!allowedAddress(match[0])))findings.push({path,category:'non-example IP address'});
 if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{32}/.test(text))findings.push({path,category:'private key material'});
}
if(findings.length){console.error(JSON.stringify(findings,null,2));process.exitCode=1;}
else console.log('Tracked repository privacy checks passed: '+paths.length+' files.');
assert.ok(!paths.some(path=>path.startsWith('data/')),'Local audit data must remain untracked');
