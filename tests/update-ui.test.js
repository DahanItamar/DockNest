import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildBugReport,ISSUE_BASE,URL_LIMIT} from '../web/updates/report.js';
import {parseNotes,stripFrontMatter,safeHref,NOTES_LIMIT} from '../web/updates/notes-parse.js';
import {isLocking,trackFor,phaseStatuses,formatElapsed,retryDelay,highlightChips,submitMessage,REPAIR_COMMAND,STAGES,PHASES} from '../web/updates/model.js';

test('report URL has only the allow-listed fields on the constant base',()=>{
 const r=buildBugReport({version:'2.2.0',installMode:'source'}),u=new URL(r.href);
 assert.equal(u.origin+u.pathname,ISSUE_BASE);
 assert.deepEqual([...u.searchParams.keys()].sort(),['install_mode','template','title','version']);
 assert.equal(u.searchParams.get('template'),'bug-report.yml');assert.equal(u.searchParams.get('version'),'v2.2.0');assert.equal(u.searchParams.get('install_mode'),'source');
 assert.ok(r.href.length<=URL_LIMIT);
});
test('report URL drops hostile or invalid values and never copies free text',()=>{
 const hostile=buildBugReport({version:'v2.2.0 <script>alert(1)</script> host.example.com /home/user',installMode:'source\nsecret=1',email:'a@b.c',error:'boom',path:'/etc'});
 const u=new URL(hostile.href);
 assert.deepEqual([...u.searchParams.keys()].sort(),['template','title']);
 assert.equal(u.searchParams.get('title'),'Bug report: DockNest');
 for(const bad of ['host.example.com','script','/home','a@b.c','boom','/etc','secret'])assert.ok(!hostile.href.includes(bad),bad);
 assert.deepEqual([...new URL(buildBugReport({version:'v1.0.0',installMode:'image'}).href).searchParams.keys()].sort(),['install_mode','template','title','version']);
});
test('bug-report.yml field ids match the URL parameters',async()=>{
 const yml=await readFile('.github/ISSUE_TEMPLATE/bug-report.yml','utf8'),ids=[...yml.matchAll(/^\s+id: (\S+)/gm)].map(m=>m[1]);
 for(const key of ['version','install_mode'])assert.ok(ids.includes(key),key);
 assert.ok(ids.includes('what_happened'));
});
test('notes renderer builds text nodes only, drops front matter, foreign links and raw HTML',()=>{
 const md='---\nhighlights:\n  security: true\n---\n# Title\n\nHello **bold** and `code` <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [evil](https://evil.example/x) ![pic](https://github.com/x.png)\n\n- [repo](https://github.com/DahanItamar/DockNest/pull/1)\n- [doc](docs/upgrading.md)\n- [up](../../etc/passwd)\n\n```\n<script>x</script>\n```\n';
 const blocks=parseNotes(md,'v2.2.0'),json=JSON.stringify(blocks);
 assert.ok(!json.includes('highlights'));
 assert.ok(!json.includes('javascript:'));assert.ok(!json.includes('evil.example'));assert.ok(!json.includes('passwd'));
 const links=[];(function walk(n){if(Array.isArray(n))n.forEach(walk);else if(n&&typeof n==='object'){if(n.t==='link')links.push(n.href);Object.values(n).forEach(walk)}})(blocks);
 assert.deepEqual(links,['https://github.com/DahanItamar/DockNest/pull/1','https://github.com/DahanItamar/DockNest/blob/v2.2.0/docs/upgrading.md']);
 assert.ok(blocks.every(b=>['h','p','ul','pre'].includes(b.t)));
 assert.equal(blocks.find(b=>b.t==='pre').v,'<script>x</script>');
 assert.ok(json.includes('<img src=x onerror=alert(1)>'),'raw HTML stays inert text');
});
test('notes links and size cap',()=>{
 assert.equal(safeHref('https://github.com.evil.example/DahanItamar/DockNest/x','v1.0.0'),null);
 assert.equal(safeHref('https://user@github.com/DahanItamar/DockNest/x','v1.0.0'),null);
 assert.equal(safeHref('//evil.example/x','v1.0.0'),null);assert.equal(safeHref('docs/a.md',undefined),null);
 assert.equal(stripFrontMatter('no front matter'),'no front matter');
 const big=parseNotes('x'.repeat(NOTES_LIMIT*2),'v1.0.0');assert.ok(big[0].c[0].v.length<=NOTES_LIMIT);
});
test('lock view model: locking states, stages and phase statuses',()=>{
 assert.equal(isLocking({state:'running'}),true);assert.equal(isLocking({state:'needs_action'}),true);
 for(const state of ['succeeded','rolled_back','not_changed','lost','resolved'])assert.equal(isLocking({state,active:false}),false,state);
 assert.equal(isLocking(null),false);
 assert.deepEqual(trackFor({phase:'build',state:'running'}).map(s=>s.status),['complete','complete','complete','current','waiting']);
 assert.deepEqual(trackFor({phase:'rollback',state:'running',lastPhase:'build'}).map(s=>s.status),['complete','complete','complete','failed','current']);
 assert.deepEqual(trackFor({phase:'release',state:'rolled_back',lastPhase:'build'}).map(s=>s.status),['complete','complete','complete','failed','rolled-back']);
 assert.deepEqual(trackFor({phase:'done',state:'succeeded'}).map(s=>s.status),Array(5).fill('complete'));
 assert.equal(STAGES.length,5);assert.equal(phaseStatuses({phase:'start',state:'running'}).build,'complete');assert.equal(phaseStatuses({phase:'start',state:'running'}).start,'current');
 assert.equal(phaseStatuses({phase:'done',state:'rolled_back',lastPhase:'build'}).build,'failed');assert.equal(phaseStatuses({phase:'done',state:'rolled_back',lastPhase:'build'}).rollback,'complete');
 assert.ok(PHASES.every(p=>STAGES.some(s=>s.phases.includes(p))));
});
test('polling backoff, elapsed time, highlights and submit errors',()=>{
 assert.deepEqual([0,1,2,3,9].map(retryDelay),[2000,4000,8000,10000,10000]);
 assert.equal(formatElapsed(15000),'00:15');assert.equal(formatElapsed(3661000),'1:01:01');
 assert.deepEqual(highlightChips({security:true,features:3,improvements:5,fixes:0,extra:'<b>'}).map(c=>c.label),['Security fixes','3 new features','5 improvements']);
 assert.deepEqual(highlightChips({features:'3'}),[]);
 for(const code of ['REAUTH_REQUIRED','UPDATE_IN_PROGRESS','NOT_OFFERED','RECOVERY_REVIEW_REQUIRED','UPDATER_BLOCKED','UPDATER_STATE_MISMATCH','UPDATER_LOW_DISK','UPDATER_BUSY','UPDATER_REFUSED','UPDATER_RATE_LIMITED','UPDATER_UNAVAILABLE'])assert.ok(submitMessage({code,message:'raw'}).length>10&&submitMessage({code,message:'raw'})!=='raw',code);
 assert.match(submitMessage({status:401,message:'Invalid password or code.'}),/not accepted/);
});
test('the update UI never uses dangerouslySetInnerHTML or text-glyph icons',async()=>{
 for(const file of ['update-center.jsx','lock-view.jsx','dialogs.jsx','parts.jsx']){
  const text=await readFile('web/updates/'+file,'utf8');
  assert.ok(!text.includes('dangerouslySetInnerHTML'),file);
  assert.ok(!/[✓✔✕✖⚠ℹ]|\p{Extended_Pictographic}/u.test(text),file+' has an emoji or glyph icon');
 }
});
test('a state-mismatch the broker marked pin-missing names --repair; other state-mismatch reasons stay generic',()=>{
 const pin=submitMessage({code:'UPDATER_STATE_MISMATCH',status:409,data:{code:'UPDATER_STATE_MISMATCH',refusal:'state-mismatch',detail:'pin-missing'}});
 assert.match(pin,/sudo scripts\/install-updater\.sh --repair/);assert.match(pin,/Nothing was changed/);
 assert.equal(submitMessage({code:'UPDATER_STATE_MISMATCH',detail:'pin-missing'}),pin);
 for(const err of [{code:'UPDATER_STATE_MISMATCH'},{code:'UPDATER_STATE_MISMATCH',data:{detail:'other'}},{code:'UPDATER_STATE_MISMATCH',data:{}}])
  assert.equal(submitMessage(err),'DockNest cannot confirm which version is installed. Nothing was changed. Check the server and try again.');
 assert.doesNotMatch(submitMessage({code:'UPDATER_LOW_DISK',data:{detail:'pin-missing'}}),/--repair/);
});
test('the update center shows the repair command when the last refusal was a missing pin',async()=>{
 const text=await readFile('web/updates/update-center.jsx','utf8');
 assert.match(text,/notice\?\.code==='UPDATER_PIN_MISSING'/);assert.match(text,/<CodeBlock command=\{REPAIR_COMMAND\}\/>/);
 assert.equal(REPAIR_COMMAND,'sudo scripts/install-updater.sh --repair');
});
test('the updater rate-limit message names the limit and the earliest time, and the API limit message uses Retry-After',()=>{
 const now=new Date(2026,9,23,12,0,0),later=new Date(2026,9,23,14,5,0),tomorrow=new Date(2026,9,24,9,30,0);
 const hhmm=d=>d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 assert.equal(submitMessage({code:'UPDATER_RATE_LIMITED',limit:'cooldown',retryAt:later.toISOString()},now),'The updater needs a minute between runs. Try again at '+hhmm(later)+'.');
 assert.equal(submitMessage({code:'UPDATER_RATE_LIMITED',limit:'daily',retryAt:later.toISOString()},now),'The updater has reached its daily limit for updates, so nothing was changed. You can update again at '+hhmm(later)+'.');
 const next=submitMessage({code:'UPDATER_RATE_LIMITED',limit:'daily',retryAt:tomorrow.toISOString()},now);
 assert.match(next,/^The updater has reached its daily limit for updates, so nothing was changed\. You can update again at .+ at \d\d:\d\d\.$/);assert.ok(next.includes(hhmm(tomorrow)));
 assert.ok(!/few minutes/.test(submitMessage({code:'UPDATER_RATE_LIMITED'},now)),'no detail: no wrong claim about minutes');
 assert.equal(submitMessage({status:429,code:'RATE_LIMITED',retryAfter:12}),'Too many requests. Try again in 12 seconds.');
 assert.equal(submitMessage({status:429,code:'RATE_LIMITED',retryAfter:1}),'Too many requests. Try again in 1 second.');
});

