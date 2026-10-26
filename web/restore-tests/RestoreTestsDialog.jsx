import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown} from '../icons.jsx';
import {AlertPanel} from '../system.jsx';
import {useGuard} from '../map/MoveFlow.jsx';
import {runError,settingsError} from './restore-tests-client.js';
import {CADENCES,CPU,DEFAULT_SETTINGS,MEMORY,TIME,cpuLimit,limitFrom,memoryLimit,timeLimit,whyNoRun} from './model.js';

// One preset select plus a plain text input for "Custom". The input appears (with the page's enter motion) only on Custom.
function LimitField({label,spec,state,onChange,disabled,help,placeholder,inputMode,aria,error,focusRef}){
 const custom=state.pick==='custom',input=useRef(null);
 useEffect(()=>{if(custom&&focusRef.current===aria){focusRef.current=null;input.current?.focus()}},[custom]);
 return <label className="field"><span>{label}</span>
  <select value={state.pick} disabled={disabled} onChange={event=>{focusRef.current=event.target.value==='custom'?aria:null;onChange({...state,pick:event.target.value})}}>
   {spec.presets.map(([value,text])=><option key={value} value={String(value)}>{text}</option>)}
   <option value="custom">Custom</option>
  </select>
  {custom&&<input ref={input} type="text" inputMode={inputMode} autoComplete="off" spellCheck={false} aria-label={aria} aria-invalid={!!error} placeholder={placeholder} disabled={disabled} value={state.custom} onChange={event=>onChange({...state,custom:event.target.value})}/>}
  <small className={error?'rt-err':undefined} role={error?'alert':undefined}>{error||help}</small>
 </label>;
}

export function RestoreTestsDialog({client,site,servers,isAdmin,onClose,onSaved,onChanged,onSessionExpired}){
 const [card,setCard]=useState(null),[loaded,setLoaded]=useState(false),[loadError,setLoadError]=useState('');
 const [form,setForm]=useState(null),[startN,setStartN]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[started,setStarted]=useState(false),[tried,setTried]=useState(false),[advOpen,setAdvOpen]=useState(false);
 const focusRef=useRef(null),guard=useGuard(client);

 useEffect(()=>{
  let alive=true;
  client.card(site.id).then(next=>{if(alive){setCard(next);setLoaded(true)}}).catch(e=>{
   if(!alive)return;
   if(e.status===401){onSessionExpired?.();return}
   // No card yet (the feature is not reachable): a fresh, switched-off form.
   if(e.status===404){setCard(null);setLoaded(true)}else setLoadError(e.message||'Could not load restore tests.');
  });
  return()=>{alive=false};
 },[client,site.id]);

 useEffect(()=>{
  if(!loaded)return;
  const s={...DEFAULT_SETTINGS,...(card?.settings||{})};
  setForm({enabled:!!s.enabled,cadence:s.cadence||'weekly',serverId:s.serverId||'',allow:!!s.allowLiveServer,allowInternet:!!s.allowInternet,
   time:limitFrom(TIME,s.timeLimitMinutes),memory:limitFrom(MEMORY,s.memoryMb),cpu:limitFrom(CPU,s.cpus),path:s.probe?.path||'',probe:s.probe||null});
 },[loaded]);

 if(loadError)return <div className="modal-body"><AlertPanel variant="error" title="Could not load restore tests">{loadError}</AlertPanel><div className="modal-foot"><button type="button" onClick={onClose}>Close</button></div></div>;
 if(!form)return <div className="modal-body"><p role="status">Loading restore tests…</p></div>;

 const live=!!form.serverId&&form.serverId===site.serverId,target=servers.find(x=>x.id===form.serverId);
 const cores=Number(target?.capabilities?.cpus??target?.capabilities?.cpuCount)||null;
 const time=timeLimit(form.time),memory=memoryLimit(form.memory),cpu=cpuLimit(form.cpu,cores);
 const active=!!card?.active;
 const reason=whyNoRun({serverId:form.serverId,liveServer:live,allowLive:form.allow})||(active?'A test is already running.':'');
 const shown=(state,result)=>(tried||(state.pick==='custom'&&state.custom.trim()))?result.error:'';
 const set=patch=>{setForm(previous=>({...previous,...patch}));setStarted(false);setError('')};
 const invalid=!!(time.error||memory.error||cpu.error);

 function settingsBody(){
  const probe=form.path.trim()?{...(form.probe||{}),path:form.path.trim()}:null;
  return {enabled:form.enabled,cadence:form.cadence,serverId:form.serverId||null,allowLiveServer:live&&form.allow,allowInternet:form.allowInternet,timeLimitMinutes:time.value,memoryMb:memory.value,cpus:cpu.value,probe};
 }
 // Checks the page before anything is sent. Operators have no settings to check.
 function check(){
  setTried(true);
  if(!isAdmin)return true;
  if(invalid){setAdvOpen(true);return false}
  if(form.enabled&&!form.serverId){setError(settingsError({code:'TEST_SERVER_REQUIRED'}));return false}
  return true;
 }
 const fail=e=>{if(e.status===401){onSessionExpired?.();return}setError(e.during==='run'?runError(e):settingsError(e))};
 // guard.run shows the app's "Please confirm it is you" step when the API asks for it, then repeats the action.
 async function save(event){
  event.preventDefault();if(busy||guard.waiting||!check())return;setBusy(true);setError('');
  try{await guard.run(async()=>{await client.saveSettings(site.id,settingsBody());onSaved()},fail)}finally{setBusy(false)}
 }
 async function run(){
  if(busy||guard.waiting||reason||!check())return;setBusy(true);setError('');setStarted(false);
  try{await guard.run(async()=>{
   if(isAdmin)await client.saveSettings(site.id,settingsBody());
   try{await client.run(site.id)}catch(e){e.during='run';throw e}
   setStarted(true);setStartN(n=>n+1);onChanged?.();
  },fail)}finally{setBusy(false)}
 }

 return <form className="modal-body site-wizard rt-form" onSubmit={save} noValidate>
  {!isAdmin&&<p className="t-caption">Only an administrator can change these settings.</p>}
   <div className="sb-switch-row">
    <span className="sb-switch-text"><span id="rt-auto" className="sb-switch-label">Auto tests</span><span id="rt-auto-help" className="t-caption">Restores your latest backup and checks it.</span></span>
    <button type="button" role="switch" className="switch" aria-checked={form.enabled} aria-labelledby="rt-auto" aria-describedby="rt-auto-help" disabled={!isAdmin} onPointerDown={event=>event.preventDefault()} onClick={()=>set({enabled:!form.enabled})}></button>
   </div>
   <label className="field"><span>How often</span>
    <select value={form.cadence} disabled={!form.enabled||!isAdmin} onChange={event=>set({cadence:event.target.value})}>{CADENCES.map(([value,text])=><option key={value} value={value}>{text}</option>)}</select>
   </label>
   <label className="field"><span>Test server</span>
    <select value={form.serverId} disabled={!isAdmin} onChange={event=>set({serverId:event.target.value,allow:false})}>
     <option value="">Choose a server</option>
     {servers.map(server=><option key={server.id} value={server.id}>{server.name+(server.id===site.serverId?' (live server)':'')}</option>)}
    </select>
    <small>Pick a spare server.</small>
   </label>
   {live&&<AlertPanel variant="warning" title="Live server" action={<label className="check"><input type="checkbox" checked={form.allow} disabled={!isAdmin} onChange={event=>set({allow:event.target.checked})}/> Allow live server</label>}>Tests use this server’s CPU, memory and disk.</AlertPanel>}
   <details className="rt-adv" open={advOpen} onToggle={event=>setAdvOpen(event.currentTarget.open)}>
    <summary>Advanced settings<ChevronDown size={18} stroke={2} className="rt-chev" aria-hidden="true"/></summary>
    <LimitField label="Time limit" spec={TIME} state={form.time} onChange={time=>set({time})} disabled={!isAdmin} help="The test stops after this." placeholder="10 to 120 minutes" inputMode="numeric" aria="Custom time limit in minutes" error={shown(form.time,time)} focusRef={focusRef}/>
    <LimitField label="Memory" spec={MEMORY} state={form.memory} onChange={memory=>set({memory})} disabled={!isAdmin} help="Per container." placeholder="256 to 16384 MB" inputMode="numeric" aria="Custom memory in MB" error={shown(form.memory,memory)} focusRef={focusRef}/>
    <LimitField label="CPU" spec={CPU} state={form.cpu} onChange={cpu=>set({cpu})} disabled={!isAdmin} help="Per container." placeholder="0.5 to the server’s cores" inputMode="decimal" aria="Custom CPU in cores" error={shown(form.cpu,cpu)} focusRef={focusRef}/>
    <div className="sb-switch-row">
     <span className="sb-switch-text"><span id="rt-net" className="sb-switch-label">Allow internet</span><span id="rt-net-help" className="t-caption">Off keeps the test copy offline.</span></span>
     <button type="button" role="switch" className="switch" aria-checked={form.allowInternet} aria-labelledby="rt-net" aria-describedby="rt-net-help" disabled={!isAdmin} onPointerDown={event=>event.preventDefault()} onClick={()=>set({allowInternet:!form.allowInternet})}></button>
    </div>
    {form.allowInternet&&<AlertPanel variant="warning" title="Internet access">The test copy can reach the internet with your live keys. Email stays blocked.</AlertPanel>}
    <label className="field"><span>Health check path</span>
     <input type="text" value={form.path} disabled={!isAdmin} maxLength={200} autoComplete="off" spellCheck={false} onChange={event=>set({path:event.target.value})}/>
     <small>Optional</small>
    </label>
   </details>
  {guard.prompt&&<div className="map-root">{guard.prompt}</div>}
  {error&&<AlertPanel variant="error" title="Could not finish">{error}</AlertPanel>}
  <div className="modal-foot">
   <span key={started?'started'+startN:'idle'} className={'t-caption rt-why'+(started?' rt-done':'')} role="status">{started?'Test started.':reason}</span>
   <button type="button" onClick={onClose}>Cancel</button>
   <button type="button" disabled={busy||guard.waiting||!!reason} onClick={run}>Run test</button>
   {isAdmin&&<button type="submit" className="primary" disabled={busy||guard.waiting}>Save</button>}
  </div>
 </form>;
}
