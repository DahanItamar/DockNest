import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {IconRefresh,IconCircleCheck,IconAlertTriangle,IconShieldCheck,IconClipboardCheck,IconShieldLock,IconPackageImport,IconPlugConnected,IconInfoCircle,IconChevronDown} from '@tabler/icons-react';
import {StatusLabel,AlertPanel} from '../system.jsx';
import {createUpdatesClient,LOCKED_EVENT} from './client.js';
import {UCDialog,ExtLink,CodeBlock,Notes,DOCS_ROLLBACK,DOCS_UPGRADE} from './parts.jsx';
import {ConsentDialog} from './dialogs.jsx';
import {highlightChips,HISTORY_STATUS,submitMessage,tagUrl,vv} from './model.js';
import './updates.css';

export const fmt=(value,dateOnly)=>{if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString(undefined,dateOnly?{day:'numeric',month:'short',year:'numeric'}:{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})};
const clock=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'unknown':d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})};
const TABS=[['overview','Overview',''],['whats-new','What’s new','/whats-new'],['history','History','/history']];
export const ucTabFromHash=()=>{const m=/^#\/update-center(?:\/([a-z-]+))?/.exec(location.hash);return TABS.some(t=>t[0]===m?.[1])?m[1]:'overview'};
const goTab=id=>{location.hash='#/update-center'+TABS.find(t=>t[0]===id)[2]};
const sameTag=v=>/^v\d+\.\d+\.\d+$/.test(v||'');

const summaryOf=meta=>highlightChips(meta?.highlights).map(c=>c.label).join(' · ');
const FLOW=[[IconShieldCheck,'Verify','DockNest checks the release signature. A release that fails the check is refused.'],[IconClipboardCheck,'Prepare','DockNest checks this installation and downloads the release.'],[IconShieldLock,'Protect','Backups and restores pause; running jobs finish first. DockNest then saves its own data.'],[IconPackageImport,'Install','DockNest switches to the new version, rebuilds and restarts.'],[IconCircleCheck,'Confirm','When DockNest answers a health check, paused work resumes.']];

// Start update: the shared password and a fresh code (POST /api/auth/reauth), then the request (POST /api/updates/requests).
function ConfirmUpdateDialog({client,from,version,releasedAt,jobs,retryOf,onClose,onStarted}){
 const [password,setPassword]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[authFailed,setAuthFailed]=useState(false);
 const ready=password.length>0&&code.trim().length>=6;
 async function submit(e){
  e.preventDefault();if(!ready||busy)return;
  setBusy(true);setError('');setAuthFailed(false);
  try{
   try{await client.reauth(password,code.trim())}catch(err){setAuthFailed(err.status===401);throw err}
   await client.submit(version,retryOf);
   onStarted();
  }catch(err){setError(submitMessage(err))}
  finally{setBusy(false)}
 }
 const link=tagUrl(version);
 return <UCDialog title={'Start the update to DockNest '+version+'?'} onClose={onClose} label="dialog">
  <form onSubmit={submit} noValidate>
   <div className="dlg-meta"><span className="t-caption">{releasedAt?'Released '+fmt(releasedAt,true):'From '+from}</span>{link&&<ExtLink href={link}>Release notes</ExtLink>}</div>
   <p>DockNest is unavailable for a few minutes while it restarts, and it shows only the update screen to everyone until the update ends.</p>
   <h3>What will happen</h3>
   <ol className="flow">{FLOW.map(([Icon,name,text])=><li key={name}><Icon size={20} aria-hidden="true"/><span><b>{name}.</b> {text}</span></li>)}</ol>
   {jobs.length>0&&<p className="jobs-note">Right now: {jobs.join(' and ')}. DockNest waits up to 10 minutes for them to finish. If they are still running, the update stops and nothing is changed.</p>}
   <p className="rollback-note">If the new version fails before DockNest changes its own data, DockNest returns to {from} by itself. If it fails after that, DockNest stops and a server administrator has to finish the rollback. Backups stay paused until then.</p>
   <p><ExtLink href={DOCS_ROLLBACK}>Manual rollback instructions</ExtLink></p>
   <h3>Confirm it is you</h3>
   <p>Enter the shared password and a fresh code from your authenticator.</p>
   <div className="reauth-fields">
    <label className="field"><span>Password</span><input type="password" name="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} aria-invalid={authFailed||undefined} aria-describedby={authFailed?'uc-confirm-error':undefined}/></label>
    <label className="field"><span>Authenticator code</span><input name="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)} aria-invalid={authFailed||undefined} aria-describedby={authFailed?'uc-confirm-error':undefined}/><small>6 digits, or a saved recovery code</small></label>
   </div>
   {error&&<div id="uc-confirm-error" className="dlg-alert"><AlertPanel variant="error">{error}</AlertPanel></div>}
   <div className="modal-foot"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" aria-disabled={!ready||busy||undefined} aria-describedby="uc-start-hint">{busy?'Starting…':'Start update'}</button></div>
   {!ready&&<p id="uc-start-hint" className="submit-hint">Enter your password and a 6-digit code</p>}
  </form>
 </UCDialog>;
}

function HostUpdaterCard({up,status,busy,onCheck}){
 const desc=status==='not-installed'?'Set up the host updater above to enable updates here.':up.supported===false?'Too old for this release.':'Installs DockNest updates on the DockNest host.';
 let foot;
 if(status==='not-responding')foot=<StatusLabel state="failed">Not responding{up.lastHeartbeatAt?<> {'·'} last seen {clock(up.lastHeartbeatAt)}</>:null}</StatusLabel>;
 else if(status==='blocked')foot=<StatusLabel state="needs-review">Blocked{up.version?` · v${String(up.version).replace(/^v/,'')}`:''}</StatusLabel>;
 else if(status==='not-installed')foot=<span className="t-body">Not installed</span>;
 else foot=<StatusLabel state="success">Connected{up.version?` · v${String(up.version).replace(/^v/,'')}`:''}</StatusLabel>;
 const disabled=status==='not-installed'||busy;
 return <article className="card uc-card" aria-labelledby="uc-host-title"><div className="card-body"><div className="uc-card-head"><h2 className="card-title" id="uc-host-title">Host updater</h2></div><p className="t-body uc-quiet">{desc}</p></div>
  <div className="card-footer uc-footer"><p className="foot-status">{foot}</p><button type="button" className="text link-btn" aria-disabled={disabled||undefined} aria-describedby={status==='not-installed'?'uc-host-reason':undefined} onClick={()=>{if(!disabled)onCheck()}}>{busy?'Checking…':'Check connection'}</button></div>
  {status==='not-installed'&&<span className="sr-only" id="uc-host-reason">Set up the host updater first.</span>}</article>;
}
function AutoChecksCard({data,busy,checking,onToggle}){
 const on=data.consent?.checkEnabled===true,pending=data.consent?.checkEnabled==null,who=data.consent?.decidedBy?.name;
 return <article className="card uc-card" aria-labelledby="uc-auto-title"><div className="card-body"><div className="uc-card-head"><h2 className="card-title" id="uc-auto-title">Automatic checks</h2><button type="button" role="switch" className="switch" aria-checked={on} aria-labelledby="uc-auto-title" aria-describedby="uc-auto-desc" disabled={busy} onClick={onToggle}></button></div>
  <p className="t-body uc-quiet" id="uc-auto-desc">DockNest asks GitHub for the list of releases. Nothing about your servers, sites or users is sent.{pending?' Not set up yet.':!on&&who?` Set by ${who}, ${fmt(data.consent.decidedAt,true)}.`:''}</p>
  {checking&&<p className="t-caption" id="uc-checking-note" role="status">DockNest is asking GitHub for the list of releases.</p>}</div>
  <div className="card-footer uc-footer"><p className="foot-status t-body">{on?'Checks run once a day':'Automatic checks are off'}</p><button type="button" className="text link-btn" disabled={busy} onClick={onToggle}>{on?'Turn off':'Turn on'}</button></div></article>;
}
function SetupCard({connected}){
 return <section className="setup" aria-labelledby="uc-setup-title"><h2 className="sg-title" id="uc-setup-title">Set up the host updater</h2><p className="setup-lead">You do this once per server. After that, every update is one click.</p>
  <ol className="setup-steps"><li><span className="step-n" aria-hidden="true">1</span><div><b>Run this on the DockNest host, from the DockNest folder.</b><CodeBlock command="sudo scripts/install-updater.sh"/></div></li>
  <li><span className="step-n" aria-hidden="true">2</span><div><b>Wait for the connection.</b><p className={'dn-reconnect'+(connected?' is-answered':'')} role="status">{connected?<><IconCircleCheck size={18} aria-hidden="true"/>Connected. The updater is ready, no reload needed.</>:<><IconRefresh size={18} className="dn-spin" aria-hidden="true"/>Waiting for the updater{'…'}</>}</p></div></li></ol>
  <AdvancedCli/></section>;
}
function AdvancedCli(){return <details className="advanced more"><summary><IconChevronDown size={16} aria-hidden="true"/>Advanced: update from the command line</summary><p>You can also update on the DockNest host without the updater. The script picks the newest official release itself and pauses backups first.</p><CodeBlock command="scripts/upgrade.sh"/><p><ExtLink href={DOCS_UPGRADE}>Updating with one command</ExtLink></p></details>}

function Hero({data,offer,meta,up,status,openConfirm,checking,onConsent}){
 const st=data.state,cur=vv(data.current?.version),latest=data.check?.latest,blocked=data.offer?.blocked;
 if(st==='updater-state-mismatch')return <article className="card uc-hero uc-hero-state"><span className="rel-sym warn"><IconAlertTriangle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title t-card">DockNest cannot confirm which version is installed</h2><p>The version in package.json, the release tag and the running image disagree. Nothing was changed. Check the server with these commands.</p>{['git status','git describe --tags --exact-match','docker compose images'].map(c=><CodeBlock key={c} command={c}/>)}</div></article>;
 if((st==='updater-blocked'||(blocked&&!offer))&&st!=='update-in-progress')return <article className="card uc-hero uc-hero-state"><span className="rel-sym warn"><IconAlertTriangle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title t-card">Updates are blocked</h2><p>{blocked?.message||'The last update needs manual action on the DockNest host. Updates stay blocked until the server operator resolves it: first the release command from the rollback hint, then sudo scripts/install-updater.sh --ack. The acknowledgement alone does not release the hold.'}</p><p className="code-label">Confirm on the server</p><CodeBlock command="sudo scripts/install-updater.sh --ack"/><div className="rel-links"><ExtLink href={DOCS_ROLLBACK}>Rolling back</ExtLink><button type="button" className="text" onClick={()=>goTab('history')}>View history</button></div></div></article>;
 if(st==='consent-pending')return <article className="card uc-hero uc-hero-state"><span className="rel-sym muted"><IconInfoCircle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title t-card">Update checks are not set up</h2><p>DockNest has not contacted GitHub and will not until you choose. Updates are never installed unless an administrator starts them.</p><div className="hero-actions"><button type="button" className="primary" onClick={onConsent}>Turn on checks</button></div></div></article>;
 if(st==='checks-off')return <article className="card uc-hero uc-hero-state"><span className="rel-sym muted"><IconInfoCircle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title t-card">Automatic update checks are off</h2><p>DockNest makes no requests to GitHub. Turn on automatic checks below to be told about new versions.</p><AdvancedCli/></div></article>;
 if(st==='checking'||(checking&&!offer))return <article className="card uc-hero uc-hero-state"><span className="rel-sym"><IconRefresh size={32} className="dn-spin" aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title t-card">Checking GitHub for new versions</h2><p role="status">This usually takes a few seconds. You can leave this page.</p></div></article>;
 if(!offer&&st==='check-failed')return <article className="card uc-hero uc-hero-state"><span className="rel-sym warn"><IconAlertTriangle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title t-card">DockNest could not check for new versions</h2><p>The request to GitHub did not complete{data.check?.error?': '+data.check.error:''}. Your installation is not affected and keeps running normally.{data.check?.lastSuccessAt?' The last successful check was '+fmt(data.check.lastSuccessAt)+'.':''}</p></div></article>;
 if(!offer&&data.offer?.cli)return <article className="card uc-hero uc-hero-state"><span className="rel-sym"><IconInfoCircle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title t-card">DockNest {latest?.version||'update'} needs an earlier update first</h2><p>{latest?.minUpgradeFrom?`This release needs DockNest ${latest.minUpgradeFrom} or later. `:''}Follow the section on updating with one command in the update guide; it describes the steps without a version taken from GitHub.</p><p><ExtLink href={DOCS_UPGRADE}>Update guide</ExtLink></p></div></article>;
 if(!offer){const rel=data.current?.publishedAt||(latest&&vv(latest.version)===cur?latest.publishedAt:null);return <article className="card uc-hero uc-hero-ok"><IconCircleCheck className="uc-ok-icon" size={24} aria-hidden="true"/><div className="uc-hero-text"><h2 className="t-card">DockNest is up to date</h2><span className="t-body uc-quiet">Version {cur}{rel?' · released '+fmt(rel,true):''}</span></div></article>}
 // An offer exists.
 const version=offer.version,summary=summaryOf(meta);
 const needsEarlier=data.offer?.cli,tooOld=up.present&&up.supported===false,notResponding=status==='not-responding',notInstalled=status==='not-installed'||(!up.present&&status!=='connected'&&status!=='blocked');
 let alert=null,canStart=true;
 if(needsEarlier){alert=<AlertPanel variant="info" title={`DockNest ${version} needs an earlier update first`} action={<ExtLink href={DOCS_UPGRADE}>Update guide</ExtLink>}>{(latest?.minUpgradeFrom?`This release needs DockNest ${latest.minUpgradeFrom} or later. `:'')+'Follow the section on updating with one command in the update guide.'}</AlertPanel>;canStart=false}
 else if(notInstalled){alert=<AlertPanel variant="warning" title="The host updater is not set up">Set up the host updater once below to install this version from here.</AlertPanel>;canStart=false}
 else if(tooOld){alert=<AlertPanel variant="warning" title="The host updater needs an update first">The host updater on this server is too old to install DockNest {version}.</AlertPanel>;canStart=false}
 else if(notResponding){alert=<AlertPanel variant="error" title="The host updater is not responding" action={<a href="#/update-center">Follow the steps below</a>}>Updates cannot start until it answers. Run the commands below on the DockNest host, then check the connection again.</AlertPanel>;canStart=false}
 else if(blocked){alert=<AlertPanel variant="error" title="Update blocked" action={<a href="#/update-center/history" onClick={e=>{e.preventDefault();goTab('history')}}>View history</a>}>{blocked.message||'Updates cannot start right now.'}</AlertPanel>;canStart=false}
 const date=meta?.publishedAt||latest?.publishedAt;
 return <article className="card uc-hero"><div className="uc-hero-row"><div className="uc-hero-text">
   <span className="t-caption">{canStart?'Ready to install':'Update available'}</span>
   <h2 className="t-title">DockNest {String(version).replace(/^v/,'')}</h2>
   <span className="t-body uc-quiet">{date?'Released '+fmt(date,true):''}{summary&&<>{date?' · ':''}<a href="#/update-center/whats-new" onClick={e=>{e.preventDefault();goTab('whats-new')}}>{summary}</a></>}</span></div>
  {!needsEarlier&&!notInstalled&&!tooOld&&<button type="button" className="primary" aria-disabled={!canStart||undefined} aria-describedby={alert?'uc-update-reason':undefined} onClick={()=>{if(canStart)openConfirm(version)}}>Update now</button>}</div>
  {st==='check-failed'&&<AlertPanel variant="warning" title="The last check failed">{(data.check?.error?data.check.error+'. ':'')+'This offer is the result from '+fmt(data.check?.lastSuccessAt||data.check?.checkedAt)+'.'}</AlertPanel>}
  {alert&&<div id="uc-update-reason">{alert}</div>}
  {tooOld&&<div><p className="code-label">Update the host updater</p><CodeBlock command="sudo scripts/install-updater.sh"/><p className="t-caption">Run this on the DockNest host, from the DockNest folder. This page updates itself afterwards.</p></div>}
 </article>;
}
function BeforeYouUpdate({meta}){
 const c=meta?.compatibility||{},yes=c.updatesDatabase==='yes';
 const db=yes?'Yes'+(Number.isInteger(c.fromSchema)&&Number.isInteger(c.toSchema)?`, schema v${c.fromSchema} to v${c.toSchema}`:''):c.updatesDatabase==='no'?'No':'Unknown';
 const s=meta?.downtime?.seconds,down=Number.isFinite(s)?`Estimate: about ${Math.max(1,Math.round(s/60))} min (based on your last update)`:'Estimate unavailable';
 const pauses=Array.isArray(meta?.pauses)?meta.pauses.join(', '):typeof meta?.pauses==='string'?meta.pauses:'Backups and restores';
 return <article className="card" aria-labelledby="uc-before-title"><div className="card-body"><h2 className="card-title" id="uc-before-title">Before you update</h2><dl className="def-list">{[['Database migration',db],['Downtime',down],['What pauses',pauses]].map(([k,v])=><div className="def-row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></div></article>;
}
function FixUpdater({up}){
 return <article className="card" aria-labelledby="uc-fix-title"><div className="card-body"><h2 className="card-title" id="uc-fix-title">Fix the updater</h2><AlertPanel variant="error" title="The updater is not responding">{up.lastHeartbeatAt?`It last reported at ${clock(up.lastHeartbeatAt)}. `:''}Run these on the DockNest host.</AlertPanel>
  {[['Check the updater','systemctl status docknest-updater'],['Restart it','sudo systemctl restart docknest-updater'],['Read its log','journalctl -u docknest-updater -n 50'],['Repair it','sudo scripts/install-updater.sh --repair']].map(([l,c])=><React.Fragment key={c}><h3 className="code-label">{l}</h3><CodeBlock command={c}/></React.Fragment>)}</div></article>;
}

const OUTCOME_STATE={Installed:'success','Rolled back':'needs-review','Needs manual action':'failed','Resolved on the host':'success'};
function OutcomeIcon({outcome}){const k=HISTORY_STATUS[outcome];return <StatusLabel state={OUTCOME_STATE[k]||'queued'}>{k||(String(outcome).startsWith('updater')?'Host updater updated':'Unknown')}</StatusLabel>}
function HistoryTab({client}){
 const [items,setItems]=useState(null),[next,setNext]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async cursor=>{setBusy(true);try{const r=await client.history(cursor);setItems(v=>[...(cursor?v||[]:[]),...(Array.isArray(r.items)?r.items:[])]);setNext(r.next||null);setError('')}catch(e){setError(e.message)}finally{setBusy(false)}};
 useEffect(()=>{load()},[]);
 return <article className="card"><div className="card-body"><h2 className="card-title">Update history</h2>{error&&<AlertPanel variant="error">{error}</AlertPanel>}
  {items===null&&!error?<p role="status">Loading history{'…'}</p>:items?.length?<div className="data-table-wrap hist-wrap"><table className="hist data-table"><caption className="sr-only">Update history</caption><colgroup><col className="c-ver"/><col className="c-date"/><col className="c-src"/><col className="c-status"/></colgroup><thead><tr><th scope="col">Version</th><th scope="col">Date</th><th scope="col">Source</th><th scope="col">Status</th></tr></thead><tbody>{items.map((r,i)=><tr key={(r.id||'cli')+r.version+r.at+i}><th scope="row" className="h-ver">{sameTag(r.version)?r.version:'—'}</th><td className="h-date">{fmt(r.at)}</td><td className="h-src">{r.source==='cli'?'Command line':'In-app update'}</td><td className="h-status"><OutcomeIcon outcome={r.outcome}/></td></tr>)}</tbody></table></div>:!error&&<p>No updates yet. Installed versions appear here.</p>}
  {next&&<div className="hero-actions"><button type="button" disabled={busy} onClick={()=>load(next)}>Load more</button></div>}
  <p className="t-caption uc-foot">Older versions are restored from the server command line. <ExtLink href={DOCS_ROLLBACK}>Rolling back</ExtLink></p></div></article>;
}
function WhatsNewTab({client,offer,meta,current}){
 const [own,setOwn]=useState(null),[failed,setFailed]=useState(false);
 useEffect(()=>{if(!offer)client.whatsNew().then(setOwn,()=>setFailed(true))},[client,offer]);
 const version=vv(offer?.version||own?.version)||current,markdown=offer?meta?.notesMarkdown:own?.markdown,link=tagUrl(version);
 const source=offer?meta?.notesSource:'image';
 return <>
  <article className="card notes-card"><div className="card-body"><p className={'notes-label'+(source==='github-unverified'?' warn':'')}>{source==='verified'?<><IconShieldCheck size={16} aria-hidden="true"/>Verified release notes. Checked with the release signature.</>:source==='github-unverified'?<><IconAlertTriangle size={16} aria-hidden="true"/>Unverified notes from GitHub. They were not checked with the release signature.</>:source==='image'?<><IconInfoCircle size={16} aria-hidden="true"/>These notes are included with this version of DockNest.</>:null}</p>
   <h2 className="card-title">DockNest {version}</h2>
   {markdown?<Notes markdown={markdown} tag={sameTag(version)?version:undefined}/>:<p>{offer&&!meta?'Loading release notes…':failed?'The release notes could not be loaded.':'No release notes are available for this version.'}</p>}
   {link&&<p className="notes-foot"><ExtLink href={link}>View release on GitHub</ExtLink></p>}</div></article></>;
}

export function UpdateCenter({api,activeJobs=[],retry,onRetryHandled}){
 const client=useMemo(()=>createUpdatesClient(api),[api]);
 const [data,setData]=useState(null),[error,setError]=useState(''),[tab,setTab]=useState(ucTabFromHash),[meta,setMeta]=useState(null);
 const [busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[connecting,setConnecting]=useState(false),[confirm,setConfirm]=useState(null),[consentOpen,setConsentOpen]=useState(false),[setupSeen,setSetupSeen]=useState(false);
 const tabRefs=useRef({});
 const load=useCallback(async()=>{try{const s=await client.state();setData(s);setError('')}catch(e){if(e.status!==423)setError(e.message||'Update status could not be loaded.')}},[client]);
 useEffect(()=>{load()},[load]);
 useEffect(()=>{const h=()=>setTab(ucTabFromHash());addEventListener('hashchange',h);return()=>removeEventListener('hashchange',h)},[]);
 const up=data?.updater||{},status=data?(up.status||(up.present?'connected':'not-installed')):'connected';
 const offer=data?(data.offer?.update||(data.state==='update-available'&&data.check?.latest?{version:data.check.latest.version,releaseUrl:data.check.latest.releaseUrl}:null)):null;
 const offerVersion=offer?.version;
 useEffect(()=>{setMeta(null);if(!sameTag(offerVersion))return;let off=false;client.release(offerVersion).then(r=>{if(!off)setMeta(r)},()=>{if(!off)setMeta({})});return()=>{off=true}},[client,offerVersion]);
 // The setup card polls every 5 s while open, so "Connected" appears without a reload; a running first check polls too.
 useEffect(()=>{if(!data)return;const waiting=status==='not-installed',polling=data.state==='checking';if(!waiting&&!polling)return;const t=setInterval(load,waiting?5000:3000);return()=>clearInterval(t)},[data?.state,status,load]);
 useEffect(()=>{if(status==='not-installed')setSetupSeen(true)},[status]);
 useEffect(()=>{if(retry&&data&&offer&&sameTag(offer.version)){setConfirm({version:offer.version,retryOf:retry.requestId});onRetryHandled?.()}else if(retry&&data&&!offer)onRetryHandled?.()},[retry,data,offerVersion]);
 async function toggle(){
  if(data.consent?.checkEnabled==null){setConsentOpen(true);return}
  setBusy(true);try{setData(await client.setChecks(data.consent.checkEnabled!==true));setError('')}catch(e){setError(e.message)}finally{setBusy(false)}
 }
 async function checkNow(){setChecking(true);try{setData(await client.checkNow());setError('')}catch(e){setError(e.message);if(e.code==='CHECKS_OFF')load()}finally{setChecking(false)}}
 async function checkConnection(){setConnecting(true);await load();setConnecting(false)}
 function onKey(e){const ids=TABS.map(t=>t[0]),i=ids.indexOf(tab),n=e.key==='ArrowRight'?(i+1)%ids.length:e.key==='ArrowLeft'?(i+ids.length-1)%ids.length:e.key==='Home'?0:e.key==='End'?ids.length-1:null;if(n!==null){e.preventDefault();goTab(ids[n]);tabRefs.current[ids[n]]?.focus()}}
 if(!data)return <div className="uc-page">{error?<AlertPanel variant="error" action={<button type="button" onClick={load}>Retry</button>}>{error}</AlertPanel>:<p role="status" className="loading">Loading the Update Center{'…'}</p>}</div>;
 const showSetup=status==='not-installed'||setupSeen&&status==='connected'&&offer;
 return <div className="uc-page">
  {error&&<AlertPanel variant="error">{error}</AlertPanel>}
  <div className="tabs" role="tablist" aria-label="Update Center sections" onKeyDown={onKey}>{TABS.map(([id,label])=><button key={id} ref={el=>{tabRefs.current[id]=el}} type="button" role="tab" id={'uc-tab-'+id} aria-selected={tab===id} aria-controls={'uc-panel-'+id} tabIndex={tab===id?0:-1} onClick={()=>goTab(id)}>{label}</button>)}</div>
  {TABS.map(([id])=><div key={id} role="tabpanel" id={'uc-panel-'+id} aria-labelledby={'uc-tab-'+id} tabIndex={0} hidden={tab!==id}>
   {tab===id&&id==='overview'&&<div className="uc-stack">
    {data.consent?.checkEnabled===true&&<p className="t-body uc-meta" id="uc-meta">{data.check?.checkedAt?'Last checked '+clock(data.check.checkedAt):'Not checked yet'} {'·'} <button type="button" className="text link-btn" aria-disabled={(checking||data.state==='checking')||undefined} onClick={()=>{if(!(checking||data.state==='checking'))checkNow()}}>{checking||data.state==='checking'?'Checking…':'Check now'}</button></p>}
    <Hero data={data} offer={offer} meta={meta} up={up} status={status} checking={checking} openConfirm={v=>setConfirm({version:v})} onConsent={()=>setConsentOpen(true)}/>
    {showSetup&&<article className="card uc-setup"><SetupCard connected={status==='connected'}/></article>}
    {offer&&!data.offer?.cli&&status!=='not-installed'&&!(up.present&&up.supported===false)&&status!=='not-responding'&&<BeforeYouUpdate meta={meta}/>}
    <div className="card-grid uc-split"><AutoChecksCard data={data} busy={busy} checking={checking||data.state==='checking'} onToggle={toggle}/><HostUpdaterCard up={up} status={status} busy={connecting} onCheck={checkConnection}/></div>
    {status==='not-responding'&&<FixUpdater up={up}/>}
   </div>}
   {tab===id&&id==='whats-new'&&<WhatsNewTab client={client} offer={offer} meta={meta} current={vv(data.current?.version)}/>}
   {tab===id&&id==='history'&&<HistoryTab client={client}/>}
  </div>)}
  {confirm&&<ConfirmUpdateDialog client={client} from={vv(data.current?.version)} version={confirm.version} retryOf={confirm.retryOf} releasedAt={meta?.publishedAt||data.check?.latest?.publishedAt} jobs={activeJobs} onClose={()=>setConfirm(null)} onStarted={()=>{setConfirm(null);dispatchEvent(new Event(LOCKED_EVENT))}}/>}
  {consentOpen&&<ConsentDialog client={client} onClose={()=>setConsentOpen(false)} onAnswered={s=>{if(s)setData(s);else load()}}/>}
 </div>;
}
