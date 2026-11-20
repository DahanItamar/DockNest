import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const evidence=JSON.parse(await readFile(process.argv[2],'utf8'));
for(const [name,key] of [['nodeChecks','NODE_CHECKS'],['privacyChecks','PRIVACY_CHECKS'],['browserChecks','BROWSER_CHECKS']])evidence[name]=process.env[key]==='success'?'passed':'failed';
if(evidence.release!==process.env.GITHUB_SHA)throw new Error('Release evidence mismatch');
// MongoDB runs once per tested major in its own CI matrix job (INTEGRATION_ONLY=mongo); each leaves one evidence file.
const mongoRoot=process.argv[3];
if(mongoRoot){
 evidence.mongo=[];
 for(const entry of await readdir(mongoRoot,{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const run=JSON.parse(await readFile(join(mongoRoot,entry.name,'linux-integration.json'),'utf8'));
  if(run.release!==process.env.GITHUB_SHA||run.only!=='mongo'||run.onlyResult!=='passed')throw new Error('MongoDB release evidence mismatch');
  evidence.mongo.push(...run.mongo);
 }
}
await writeFile('data/qa/controlled-beta.json',JSON.stringify(evidence,null,2)+'\n');
