import {readFile,writeFile} from 'node:fs/promises';
const evidence=JSON.parse(await readFile(process.argv[2],'utf8'));
for(const [name,key] of [['nodeChecks','NODE_CHECKS'],['privacyChecks','PRIVACY_CHECKS'],['browserChecks','BROWSER_CHECKS']])evidence[name]=process.env[key]==='success'?'passed':'failed';
if(evidence.release!==process.env.GITHUB_SHA)throw new Error('Release evidence mismatch');
await writeFile('data/qa/controlled-beta.json',JSON.stringify(evidence,null,2)+'\n');
