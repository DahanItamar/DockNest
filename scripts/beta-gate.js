import {readFile} from 'node:fs/promises';
import {betaGate} from '../src/beta-gate.js';
try{const [file,release]=process.argv.slice(2),evidence=JSON.parse(await readFile(file,'utf8'));const result=betaGate(evidence,{release,requireHostReboot:process.argv.includes('--require-host-reboot')});console.log(JSON.stringify(result,null,2));if(!result.allowed)process.exitCode=1;}catch{console.error('Beta gate needs a sanitized evidence file and exact commit.');process.exitCode=1;}
