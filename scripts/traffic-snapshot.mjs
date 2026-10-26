// Weekly GitHub traffic snapshot. GitHub keeps only 14 days of traffic, so run this at least every 2 weeks.
// Usage: node scripts/traffic-snapshot.mjs [output-folder] [owner/repo]
// Needs the GitHub CLI (`gh`), signed in with push access to the repo. Node standard library only.
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const folder=process.argv[2]||join(process.env.USERPROFILE||homedir(),'DockNest-traffic');
const repo=process.argv[3]||'DahanItamar/DockNest';
const gh=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const snapshot={takenAt:new Date().toISOString(),repo};
try{
 snapshot.views=gh(`repos/${repo}/traffic/views`);
 snapshot.clones=gh(`repos/${repo}/traffic/clones`);
 snapshot.referrers=gh(`repos/${repo}/traffic/popular/referrers`);
 snapshot.paths=gh(`repos/${repo}/traffic/popular/paths`);
 snapshot.stars=gh(`repos/${repo}`).stargazers_count;
}catch(e){
 console.error('Could not read traffic with gh: '+(e.stderr?.toString().trim()||e.message));
 process.exit(1);
}
mkdirSync(folder,{recursive:true});
const file=join(folder,`traffic-${snapshot.takenAt.slice(0,10)}.json`);
writeFileSync(file,JSON.stringify(snapshot,null,2)+'\n');
console.log(`Saved ${file}: ${snapshot.stars} stars, ${snapshot.views.uniques} unique visitors, ${snapshot.clones.uniques} unique cloners (last 14 days).`);
