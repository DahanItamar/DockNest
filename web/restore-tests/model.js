// Pure helpers for the restore-test screens: presets, custom value checks, plain summaries.
export const CADENCES=[['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']];

export const TIME={min:10,max:120,def:30,presets:[[15,'15 min'],[30,'30 min'],[60,'1 hour'],[120,'2 hours']],unit:'minutes'};
export const MEMORY={min:256,max:16384,def:1024,presets:[[512,'512 MB'],[1024,'1 GB'],[2048,'2 GB'],[4096,'4 GB'],[8192,'8 GB']],unit:'MB'};
export const CPU={min:0.5,def:1,presets:[[0.5,'Half a core'],[1,'1 core'],[2,'2 cores'],[4,'4 cores']],unit:'cores'};

export const DEFAULT_SETTINGS={enabled:false,cadence:'weekly',serverId:null,allowLiveServer:false,allowInternet:false,timeLimitMinutes:TIME.def,memoryMb:MEMORY.def,cpus:CPU.def,probe:null,nextDueAt:null,skipReason:null};

// A limit is edited as {pick:'30'|'custom', custom:''}. A saved value that is not a preset opens as Custom.
export function limitFrom(spec,value){
 const v=value==null?spec.def:Number(value);
 return spec.presets.some(([n])=>n===v)?{pick:String(v),custom:''}:{pick:'custom',custom:String(v)};
}
const wholeNumber=/^\d{1,6}$/,decimal=/^\d{1,3}([.,]\d{1,2})?$/;
// Returns {value, error}. Custom text is a plain input, so it is checked here, not by the browser.
export function limitValue(spec,state,{coresMax=null,integer=true}={}){
 if(state.pick!=='custom')return {value:Number(state.pick),error:''};
 const text=String(state.custom||'').trim();
 const top=spec===CPU?coresMax:spec.max;
 const range=spec===CPU?(top!=null?'Enter 0.5 to '+top+' cores.':'Enter 0.5 or more.'):'Enter '+spec.min+' to '+spec.max+' '+spec.unit+'.';
 if(!text||!(integer?wholeNumber:decimal).test(text))return {value:null,error:range};
 const n=Number(text.replace(',','.'));
 if(!Number.isFinite(n)||n<spec.min||(top!=null&&n>top))return {value:null,error:range};
 return {value:n,error:''};
}
export const timeLimit=state=>limitValue(TIME,state);
export const memoryLimit=state=>limitValue(MEMORY,state);
export const cpuLimit=(state,cores)=>limitValue(CPU,state,{coresMax:cores,integer:false});

// Why Run test is off: the caption in the footer. Empty when allowed.
export function whyNoRun({serverId,liveServer,allowLive}){
 if(!serverId)return 'Choose a test server to run one.';
 if(liveServer&&!allowLive)return 'Allow live server to run one.';
 return '';
}

// Ages for the overview: "just now", "5 minutes ago", "yesterday", "2 days ago", "1 week ago".
export function age(iso,now=Date.now()){
 const t=Date.parse(iso);if(!Number.isFinite(t))return '';
 const s=Math.max(0,(now-t)/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
 const n=(v,w)=>v+' '+w+(v===1?'':'s')+' ago';
 if(m<1)return 'just now';
 if(m<60)return n(m,'minute');
 if(h<24)return n(h,'hour');
 if(d===1)return 'yesterday';
 if(d<7)return n(d,'day');
 if(d<30)return n(Math.floor(d/7),'week');
 if(d<365)return n(Math.floor(d/30),'month');
 return n(Math.floor(d/365),'year');
}
// "Daily at 02:00": the overview shows schedules in this short style.
export const shortSchedule=text=>String(text||'').replace(/^Every day at /,'Daily at ');

const RESULT_LABEL={passed:['Passed','success'],failed:['Failed','failed'],couldnt_run:['Couldn’t run','needs-review'],cancelled:['Cancelled','queued']};
// What the "Last test" column shows. Always derived from the card, so the summary equals the latest test.
export function summaryOf(card){
 if(card?.active)return {kind:'active',label:'Testing now',state:'running'};
 const last=card?.last;
 if(!last)return {kind:'none',label:'Not tested',state:'queued'};
 const [label,state]=RESULT_LABEL[last.result]||['Not tested','queued'];
 return {kind:last.result||'none',label,state,at:last.finishedAt};
}
export const failedPlain=last=>last?.reason||'The restored copy did not come back.';

// Per-backup status from backup.restoreTest {status:'passed'|'failed'|'not-tested'}.
export function backupTest(backup){
 const s=backup?.restoreTest?.status;
 return s==='passed'?{label:'Passed',state:'success'}:s==='failed'?{label:'Failed',state:'failed'}:{label:'Not tested',state:'queued'};
}

// Steps for the job timeline.
export function stepDuration(step){
 if(!step.startedAt||!step.finishedAt)return step.state==='running'?'…':'';
 const s=Math.max(0,Math.round((Date.parse(step.finishedAt)-Date.parse(step.startedAt))/1000));
 return s<60?s+' s':Math.round(s/60)+' min';
}
export const clockOf=iso=>{const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})};
