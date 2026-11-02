// The only place that knows the Safe Edit API (docs/safe-edit.md, "API"). `api` is the app's fetch helper:
// api(path, body, method). Field names are assumptions until the backend lands; see the notes next to each call.
export function createSafeEditClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  // View: {kind:'compose'|'container', envFile, files:[{path,sha256,text}], env:[{file,key,set}],
  //  ports:[{service,container,host|null,file,line,editable,reason}], images:[{service,image,file,line,editable,reason}],
  //  tabs:{compose|environment|ports|image:{usable,reason}}}. Answers 403 REAUTH_REQUIRED without a recent re-check.
  load:siteId=>api('/sites/'+id(siteId)+'/edit'),
  // change: {files?:[{path,sha256,text}], env?:[{file,key,value}]} -> {token, diff, summary, warnings} or 422 {code, error}.
  // diff: [{path, lines:[{n, type:'add'|'del'|'ctx', text}]}]; summary: {backupFirst, healthUrl, rollback, dataRollback};
  // warnings: [{code, title, text}]
  review:(siteId,change)=>api('/sites/'+id(siteId)+'/edit/review',change),
  // 202 {edit:{id}}; 403 REAUTH_REQUIRED; 409 SITE_BUSY | MOVE_RUNNING | EDIT_RUNNING
  apply:(siteId,token)=>api('/sites/'+id(siteId)+'/edit/apply',{token}),
  // {id, siteId, state, result, reason, failedStep, backupId, steps:[{step,state,startedAt,finishedAt,detail}]}
  get:editId=>api('/site-edits/'+id(editId)),
  // {items:[{id,state,result,reason,createdAt,finishedAt,changes:{fields:[]}}], next}
  history:(siteId,cursor)=>api('/sites/'+id(siteId)+'/edits'+(cursor?'?cursor='+id(cursor):'')),
  cancel:editId=>api('/site-edits/'+id(editId)+'/cancel',{}),
  // Assumed route: re-runs a failed rollback.
  retryRollback:editId=>api('/site-edits/'+id(editId)+'/retry',{}),
  reauth:(password,code)=>api('/auth/reauth',{password,code})
 };
}

export const ACTIVE=new Set(['queued','running','checking','rolling_back']);
export const TABS=['Compose','Environment','Ports','Image'];
export const STEP_TEXT={backup:'Back up',prepare:'Prepare',apply:'Apply',check_health:'Check health',finish:'Finish',roll_back:'Roll back'};
export const STATUS_LINE={backup:'Backing up…',prepare:'Getting ready…',apply:'Applying the change…',check_health:'Checking the site…',finish:'Finishing…',roll_back:'Rolling back…'};
const FRIENDLY={
 SITE_BUSY:'This site is busy right now. Try again soon.',
 MOVE_RUNNING:'This site is being moved. Wait for the move to finish.',
 EDIT_RUNNING:'Another change to this site is still running.',
 TOKEN_EXPIRED:'The review expired. Review the change again.'
};
export const friendlyError=e=>FRIENDLY[e?.code]||e?.message||'Something went wrong.';

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

// Guided edits make the same text edit as typing it in Compose. A line is only edited when it still holds what the
// server reported, so a hand edit in the Compose tab turns the row into "Edit this in Compose".
const esc=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
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
export const validPort=v=>/^\d{1,5}$/.test(String(v))&&Number(v)>=1&&Number(v)<=65535;
export const validKey=k=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)&&!/^(COMPOSE_|DOCKER_|BUILDKIT_)/.test(k);
