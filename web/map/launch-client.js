// The only place that knows the launch API (docs/launch-site.md, "API"). `api` is the app's fetch helper: api(path, body, method).
export function createLaunchClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  // Reads the server and, for Git, does a ls-remote only. Nothing is created.
  check:(serverId,body)=>api('/servers/'+id(serverId)+'/launch/check',body),
  // Needs a fresh sign-in check (REAUTH_REQUIRED). Answers 202 {launch:{id}}.
  start:(serverId,body)=>api('/servers/'+id(serverId)+'/launch',body),
  get:launchId=>api('/launches/'+id(launchId)),
  // Open launches of one server: running, waiting for DNS, needing attention, or done within the 24 hours Remove launch is offered.
  forServer:serverId=>api('/servers/'+id(serverId)+'/launch'),
  cancel:launchId=>api('/launches/'+id(launchId)+'/cancel',{}),
  // Runs the certificate step again once the domain points here (also the "Try again" of a failed certificate).
  checkDns:launchId=>api('/launches/'+id(launchId)+'/check-dns',{}),
  // Tries the teardown of a launch that needs attention again.
  retry:launchId=>api('/launches/'+id(launchId)+'/retry',{}),
  // Within 24 hours of the launch; needs a fresh sign-in check.
  remove:launchId=>api('/launches/'+id(launchId)+'/remove',{}),
  deployKeys:()=>api('/deploy-keys'),
  // Same check as the Update Center and the move flow (POST /api/auth/reauth).
  reauth:(password,code)=>api('/auth/reauth',{password,code}),
  install:(serverId,pkg)=>api('/servers/'+id(serverId)+'/install',{package:pkg}),
  job:jobId=>api('/jobs/'+id(jobId))
 };
}

// Launch states that stop the refresh. waiting_dns stops too: nothing polls while the domain is not pointing here;
// "Check again" starts the check and the refresh again. A launch that is being removed, or has a step queued or
// running (the certificate after Check again), keeps refreshing.
export const LAUNCH_STOP=new Set(['waiting_dns','done','failed','cancelled','removed','needs_attention']);
export const busyLaunch=l=>!!l&&((l.steps||[]).some(s=>['queued','running'].includes(s.state))||!!l.removing)&&!['failed','cancelled','removed','needs_attention'].includes(l.state);
export const settled=l=>!!l&&LAUNCH_STOP.has(l.state)&&!busyLaunch(l);
export const STEP_LABEL={check:'Check',fetch:'Fetch source',build:'Build',start:'Start',check_health:'Health check',web:'nginx',certificate:'Certificate',save:'Save site',first_backup:'First backup',maintenance:'Maintenance page',teardown:'Clean up'};
export const LAUNCH_STEPS=Object.entries(STEP_LABEL).filter(([k])=>k!=='teardown');
const STATUS_LINE_UNUSED={check:'Checking the server…',fetch:'Fetching the source…',build:'Building the image…',start:'Starting the containers…',check_health:'Waiting for the site to answer…',web:'Setting up nginx…',certificate:'Getting the certificate…',save:'Saving the site…',first_backup:'Running the first backup…',teardown:'Cleaning up…'};
// The sentence under the progress bar: the step that is running now.
export const statusLine=l=>l?.statusLine||'Starting…';
// Check rows as the engine answers them: {title, status: ok|block, value}. A failing row says "Needs fixing"; its own
// sentence is in the panel above.
export function checkRows(result){
 const rows=(result?.checks||[]).map(c=>({id:c.id,title:c.title||c.id,state:c.status==='ok'?'success':'failed',value:c.status==='ok'?(c.value&&c.value.length<=24?c.value:'Fine'):'Needs fixing'}));
 if(result?.dns)rows.push({id:'dns',title:'DNS',state:result.dns.pointsHere?'success':'needs-review',value:result.dns.pointsHere?'Points here':'Not yet'});
 return rows;
}
// Why a check cannot go on: the engine's blockers, then the Compose gate's refusals.
const GATE_TEXT={NO_WEB:'No service serves the website. Choose the web service.',WEB_SERVICE_INVALID:'The web service was not found in this Compose file.',BUILD_SETTING_REFUSED:'A build setting in this Compose file is not allowed.',ENV_FILE_REFUSED:'An env_file in this Compose file is not allowed.',PATH_REFUSED:'A path in this Compose file leaves the site folder.',SYNTAX_REFUSED:'This Compose file uses something DockNest does not allow.'};
export function blockersOf(result){
 const out=[...(result?.blockers||[])].filter(Boolean);
 for(const r of result?.gate?.refusals||[])out.push((GATE_TEXT[r.code]||'The Compose file asks for something DockNest does not allow')+(r.service?` (${r.service})`:''));
 return out;
}
// A check row's status word from the server, as the shared status states.
export function rowState(status){
 return {ok:'success',success:'success',info:'success',block:'failed',fail:'failed',failed:'failed',missing:'failed',warn:'needs-review',checking:'running',running:'running'}[status]||'queued';
}
export const STATE_WORD={success:'Fine',failed:'Needs fixing',running:'Checking','needs-review':'Warning',queued:'Waiting'};

// Compose service names without a YAML parser: the keys one level below the top-level `services:`.
export function serviceNames(text){
 const lines=String(text||'').split(/\r?\n/);let at=-1,indent=-1;const out=[];
 for(const line of lines){
  if(!line.trim()||/^\s*#/.test(line))continue;
  const lead=line.match(/^ */)[0].length;
  if(at<0){if(lead===0&&/^services\s*:\s*$/.test(line))at=0;continue}
  if(lead===0)break;
  if(indent<0)indent=lead;
  const m=lead===indent&&line.trim().match(/^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*:\s*$/);
  if(m&&!out.includes(m[1]))out.push(m[1]);
 }
 return out;
}
export const ENV_KEY=/^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENV_REFUSED=/^(COMPOSE_|DOCKER_|BUILDKIT_)/;
export const domainOk=d=>/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(String(d||'').trim().toLowerCase());

// The server answers every refusal with one plain sentence; use it as it is.
export const friendlyLaunch=e=>e?.code==='REAUTH_REQUIRED'?'Please confirm it is you first.':e?.message||'Something went wrong.';
export const sshUrl=u=>/^(ssh:\/\/|[a-z_][a-z0-9_-]*@)/i.test(String(u||'').trim());

export const clock=v=>{const d=new Date(v);return isNaN(d)?'':d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})};
export function elapsed(from,to=Date.now()){
 const a=Date.parse(from),b=typeof to==='number'?to:Date.parse(to);
 if(!Number.isFinite(a)||!Number.isFinite(b))return '';
 const s=Math.max(0,Math.round((b-a)/1000));
 if(s<60)return s+' s';
 return Math.floor(s/60)+' min'+(s%60?' '+(s%60)+' s':'');
}
// "3 hours ago", "yesterday".
export function agoText(v,now=Date.now()){
 const s=Math.max(0,Math.round((now-Date.parse(v))/1000));if(!Number.isFinite(s))return '';
 if(s<60)return 'just now';
 const m=Math.round(s/60);if(m<60)return m+(m===1?' minute':' minutes')+' ago';
 const h=Math.round(m/60);if(h<24)return h+(h===1?' hour':' hours')+' ago';
 const d=Math.round(h/24);return d===1?'yesterday':d+' days ago';
}
// "today 09:14", "tomorrow 09:14", else the date.
export function untilText(v,now=Date.now()){
 const d=new Date(v);if(isNaN(d))return '';
 const day=new Date(d).setHours(0,0,0,0),today=new Date(now).setHours(0,0,0,0),time=d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
 return day===today?'today '+time:day===today+864e5?'tomorrow '+time:d.toLocaleDateString([],{day:'numeric',month:'short'})+' '+time;
}
// One line for a launch in a list.
export const stateText=l=>l.removing?'Removing':({queued:'Launching',running:'Launching',waiting_dns:'Waiting for DNS',needs_attention:'Needs your attention',done:'Live'}[l.state]||'Launch');

// The check and launch request body for the source form (shared by the check and the launch).
export function bodyOf(form){
 const base={domain:form.domain.trim().toLowerCase(),...(form.allowPrivate?{allowPrivate:true}:{})};
 return form.tab==='git'?{source:'git',repo:{url:form.repo.trim(),ref:form.ref.trim()||'main',composePath:form.composePath.trim()},...(form.keyId&&sshUrl(form.repo)?{deployKeyId:form.keyId}:{}),...base}
  :{source:'compose',compose:form.compose,...(form.service||serviceNames(form.compose)[0]?{webService:form.service||serviceNames(form.compose)[0]}:{}),...base};
}
// The launch request body: the source, the chosen web service and container port, the environment values, the restore
// test server, and the confirmations the engine requires (clean shutdown always, trust for Git or builds).
export function startBody(form,{service,port,testServerId,trust}){
 return {...bodyOf(form),...(service?{webService:service}:{}),webPort:Number(port),...(form.env.length?{env:Object.fromEntries(form.env.map(r=>[r.key,r.value]))}:{}),...(testServerId!==undefined?{testServerId}:{}),cleanShutdownConfirmed:true,...(trust?{trustConfirmed:true}:{})};
}
