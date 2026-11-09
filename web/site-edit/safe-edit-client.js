// The only place that knows the Safe Edit API (docs/safe-edit.md, "API"; src/site-edits/routes.js, views.js, diff.js).
// `api` is the app's fetch helper: api(path, body, method).
export function createSafeEditClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  // {kind:'compose'|'container', files:[{path,sha256,text}], env:[{file,keys:[{key,set}]}],
  //  services:[{name,image,ports:[{host,container,protocol,hostIp}],frozen,healthcheck}],
  //  usable:{compose,env,ports,image}, reasons:{tab:{code,message}}}. 403 REAUTH_REQUIRED without a recent re-check.
  load:siteId=>api('/sites/'+id(siteId)+'/edit'),
  // change: {files?:[{path,sha256,text}], env?:[{file,key,value}], containerChanges?:{image?,ports?}}
  // -> {token, diff:{files:[{path,hunks}],env:[{file,key,change,value}]}, summary, warnings:[{code,message,port?}]} or 422 {code,error}
  review:(siteId,change)=>api('/sites/'+id(siteId)+'/edit/review',change),
  // timeLimitSeconds: 60 to 600 (the server's default is 120 when left out).
  // 202 {edit:{id}}; 403 REAUTH_REQUIRED; 409 SITE_BUSY | MOVE_RUNNING | EDIT_RUNNING
  apply:(siteId,token,timeLimitSeconds)=>api('/sites/'+id(siteId)+'/edit/apply',{token,...(timeLimitSeconds?{timeLimitSeconds}:{})}),
  // The review of undoing one finished edit's Compose replace (same answer as review, plus undoOf);
  // 409 UNDO_CHANGED | UNDO_NEWER | UNDO_UNAVAILABLE. Apply it with apply().
  undoReview:editId=>api('/site-edits/'+id(editId)+'/undo/review',{}),
  // {id,state,result,reason,backupId,steps:[{step,label,state,startedAt,finishedAt,detail}],actions:{cancel,retry,restoreBackup},restore}
  get:editId=>api('/site-edits/'+id(editId)),
  // {items:[{id,state,result,changed:[],env:{added,replaced,removed},createdAt}], nextCursor}
  history:(siteId,cursor)=>api('/sites/'+id(siteId)+'/edits'+(cursor?'?cursor='+id(cursor):'')),
  cancel:editId=>api('/site-edits/'+id(editId)+'/cancel',{}),
  retryRollback:editId=>api('/site-edits/'+id(editId)+'/retry',{}),
  restoreBackup:editId=>api('/site-edits/'+id(editId)+'/restore-backup',{}),
  reauth:(password,code)=>api('/auth/reauth',{password,code})
 };
}

export const ACTIVE=new Set(['queued','running','checking','rolling_back']);
export const TABS=['Compose','Environment','Ports','Image'];
export const TAB_KEY={Compose:'compose',Environment:'env',Ports:'ports',Image:'image'};
export const STEP_TEXT={backup:'Back up',prepare:'Prepare',apply:'Apply',check_health:'Check health',finish:'Finish',roll_back:'Roll back'};
export const STATUS_LINE={backup:'Backing up…',prepare:'Getting ready…',apply:'Applying the change…',check_health:'Checking the site…',finish:'Finishing…',roll_back:'Rolling back…'};
const FRIENDLY={
 SITE_BUSY:'This site is busy right now. Try again soon.',
 MOVE_RUNNING:'This site is being moved. Wait for the move to finish.',
 EDIT_RUNNING:'Another change to this site is still running.',
 REVIEW_EXPIRED:'This review expired. Review the change again.',
 UNDO_NEWER:'A newer change was made. Undo that one first.',
 UNDO_UNAVAILABLE:'This change cannot be undone.',
 RATE_LIMITED:'Too many changes for this site. Try again later.'
};
export const friendlyError=e=>FRIENDLY[e?.code]||e?.message||'Something went wrong.';

// Review warnings: a short title in front of the server's sentence.
const WARNING_TITLE={PUBLIC_PORT:'New published port',INLINE_SECRETS:'Secrets in the file',LARGE_DATA_COPY:'Large data copy',NO_HEALTH_CHECK:'No health check',ENV_REMOVED:'Variable removed',ENV_SHARED:'Shared variable'};
export const warningView=w=>({title:WARNING_TITLE[w.code]||'Check this',text:w.code==='PUBLIC_PORT'?w.message+' Check your firewall.':w.message});
// The apply time limit (Advanced settings on Review): whole seconds, 60 to 600, default 120.
export const LIMIT={min:60,max:600,default:120};
export const validLimit=v=>/^\d{1,3}$/.test(String(v).trim())&&Number(v)>=LIMIT.min&&Number(v)<=LIMIT.max;
export const limitText=s=>s%60===0?`${s/60} minute${s===60?'':'s'}`:`${s} seconds`;
const COPY_BYTES_PER_SECOND=20*1024*1024;// the server's conservative copy speed (src/site-edits/state.js COPY)
const gb=n=>n>=1024**3?(n/1024**3).toFixed(1)+' GB':Math.max(1,Math.round(n/1024**2))+' MB';
// Warnings the chosen limit adds: a long wait, or a limit shorter than copying the data would take.
export function limitWarnings(seconds,dataBytes){
 if(!validLimit(seconds))return [];
 const s=Number(seconds),out=[];
 if(s>300)out.push({code:'LONG_LIMIT',title:'Longer wait',text:`The site can stay offline for up to ${limitText(s)} before it rolls back.`});
 if(Number.isFinite(dataBytes)&&dataBytes>0&&dataBytes/COPY_BYTES_PER_SECOND>s)out.push({code:'SHORT_LIMIT',title:'Short time limit',text:`Copying ${gb(dataBytes)} of data may need more than ${s} seconds. If it does not finish, the change rolls back.`});
 return out;
}
// "9 Nov, 09:12": when something happened, in the viewer's own format.
export const whenText=iso=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleString([],{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})};
export const healthText=health=>({url:'The health URL answers',docker:'Docker health check'}[health]||'Running and stable');

// Steps shown in the timeline: the prepare step only when it matters, roll back only once it starts.
export function visibleSteps(edit){
 const steps=Array.isArray(edit?.steps)?edit.steps:[];
 return steps.filter(s=>s.state!=='skipped'&&!(s.step==='roll_back'&&s.state==='pending')&&!(s.step==='prepare'&&s.state!=='failed'&&s.state!=='running'));
}
export const percent=edit=>{const s=(edit?.steps||[]).filter(x=>x.step!=='roll_back'&&x.step!=='prepare');return s.length?Math.round(100*s.filter(x=>x.state==='done').length/s.length):0};
export const runningStep=edit=>(edit?.steps||[]).find(s=>s.state==='running')?.step;
// How a finished edit is shown: applying | done | rolled | attention | failed | cancelled.
export function outcomeOf(edit){
 if(!edit)return 'loading';
 if(edit.state==='needs_attention')return 'attention';
 if(ACTIVE.has(edit.state))return 'applying';
 return {applied:'done',rolled_back:'rolled',failed:'failed',cancelled:'cancelled'}[edit.result]||'failed';
}
export const historyChanges=e=>{
 if(e.undoOf)return 'Undid a change';
 const names=[...(e.changed||[]).map(p=>String(p).replace(/^services\./,'')),...['added','replaced','removed'].flatMap(k=>e.env?.[k]||[])];
 return names.length?names.slice(0,3).join(', ')+(names.length>3?' and more':''):'Changed the site';
};

// ---- Guided edits: ports and image make the same text edit as typing it in Compose.
const esc=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const indent=l=>l.match(/^\s*/)[0].length;
const blank=l=>/^\s*(#.*)?$/.test(l);
// Lines of one service block, or null when the service is not found exactly once.
function serviceBlock(lines,name){
 const root=lines.findIndex(l=>/^services:\s*(#.*)?$/.test(l));
 if(root<0)return null;
 let end=lines.length;
 for(let i=root+1;i<lines.length;i++)if(!blank(lines[i])&&indent(lines[i])===0){end=i;break}
 const hits=[];
 for(let i=root+1;i<end;i++)if(new RegExp('^\\s+["\']?'+esc(name)+'["\']?:\\s*(#.*)?$').test(lines[i]))hits.push(i);
 if(hits.length!==1)return null;
 const start=hits[0],base=indent(lines[start]);let stop=end;
 for(let i=start+1;i<end;i++)if(!blank(lines[i])&&indent(lines[i])<=base){stop=i;break}
 return {start,stop};
}
// Where a service's image and published ports live in the files. Anything ambiguous or interpolated is left out, and
// the row then says "Edit this in Compose".
export function locate(files,service){
 const found=[];
 for(const f of files){
  if(typeof f.text!=='string')continue;
  const lines=f.text.split('\n'),block=serviceBlock(lines,service.name);
  if(block)found.push({file:f.path,lines,block});
 }
 if(found.length!==1)return {image:null,ports:service.ports.map(()=>null)};
 const {file,lines,block}=found[0];
 const inBlock=i=>i>block.start&&i<block.stop;
 const kids=lines.map((l,i)=>inBlock(i)&&!blank(l)?i:-1).filter(i=>i>=0),child=kids.length?indent(lines[kids[0]]):-1;
 const imageLines=kids.filter(i=>indent(lines[i])===child&&/^\s*image:\s*\S/.test(lines[i]));
 const image=imageLines.length===1&&!/\$\{?[A-Za-z_]/.test(lines[imageLines[0]])?{file,line:imageLines[0]+1}:null;
 // Only list items under the service's own `ports:` key count.
 const portKeys=kids.filter(i=>indent(lines[i])===child&&/^\s*ports:\s*(#.*)?$/.test(lines[i]));
 const items=new Set();
 if(portKeys.length===1){for(let i=portKeys[0]+1;i<block.stop;i++){if(blank(lines[i]))continue;if(indent(lines[i])<=child)break;if(/^\s*-/.test(lines[i]))items.add(i)}}
 const ports=service.ports.map(p=>{
  if(p.host==null)return null;
  const re=new RegExp('(^|[^\\d])'+esc(p.host)+':'+esc(p.container)+'(?!\\d)');
  const hits=[...items].filter(i=>re.test(lines[i])&&!/\$\{?[A-Za-z_]/.test(lines[i]));
  return hits.length===1?{file,line:hits[0]+1}:null;
 });
 return {image,ports};
}
export function setHostPort(text,line,container,from,to){
 const lines=text.split('\n'),current=lines[line-1];
 if(current==null)return null;
 const re=new RegExp('(^|[^\\d])'+esc(from)+':'+esc(container)+'(?!\\d)');
 if(!re.test(current))return null;
 lines[line-1]=current.replace(re,(_,pre)=>pre+to+':'+container);
 return lines.join('\n');
}
export function setImage(text,line,from,to){
 const lines=text.split('\n'),current=lines[line-1],m=current?.match(/^(\s*image:\s*["']?)(.*?)(["']?\s*)$/);
 if(!m||m[2]!==from)return null;
 lines[line-1]=m[1]+to+m[3];
 return lines.join('\n');
}
export const validPort=v=>/^[1-9]\d{0,4}$/.test(String(v))&&Number(v)<=65535;
export const validKey=k=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)&&!/^(COMPOSE_|DOCKER_|BUILDKIT_)/.test(k);
