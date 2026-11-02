// The only place that knows the launch API (docs/launch-site.md, "API"). `api` is the app's fetch helper: api(path, body, method).
export function createLaunchClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  // Reads the server and, for Git, does a ls-remote only. Nothing is created.
  check:(serverId,body)=>api('/servers/'+id(serverId)+'/launch/check',body),
  // Needs a fresh sign-in check (REAUTH_REQUIRED). Answers 202 {launch:{id}}.
  start:(serverId,body)=>api('/servers/'+id(serverId)+'/launch',body),
  get:launchId=>api('/launches/'+id(launchId)),
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
// "Check again" starts the check and the refresh again.
export const LAUNCH_STOP=new Set(['waiting_dns','done','failed','cancelled','removed','needs_attention']);
export const LAUNCH_STEPS=[['check','Check'],['fetch','Fetch source'],['build','Build'],['start','Start'],['check_health','Health check'],['web','nginx and certificate'],['first_backup','First backup'],['restore_test','Restore test scheduled']];
export const STEP_LABEL=Object.fromEntries([...LAUNCH_STEPS,['certificate','Certificate'],['save','Save site'],['teardown','Clean up']]);

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

export const friendlyLaunch=e=>({
 SERVER_BUSY:'This server is busy with another job. Try again when it finishes.',
 LAUNCH_RUNNING:'A launch is already running on this server.',
 SLUG_EXISTS:'A site with this name already exists on the server.',
 REAUTH_REQUIRED:'Please confirm it is you first.'
}[e?.code]||e?.message||'Something went wrong.');

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
