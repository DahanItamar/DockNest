import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {IconCircleArrowUp,IconArrowRight,IconRefresh,IconCircleCheck,IconAlertTriangle,IconRotate,IconBan,IconShieldCheck,IconClipboardCheck,IconShieldLock,IconPackageImport,IconPlugConnected,IconInfoCircle,IconSparkles,IconChevronDown} from '@tabler/icons-react';
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

function Chips({chips}){return chips.length?<ul className="dn-chips" aria-label="Highlights">{chips.map(c=><li key={c.id}><a className="dn-chip" href="#/update-center/whats-new"><IconSparkles size={16} aria-hidden="true"/>{c.label}</a></li>)}</ul>:null}
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
   <div className="dlg-meta"><span className="vchange"><span className="vtok">{from}</span><IconArrowRight size={16} aria-hidden="true"/><span className="vtok new">{version}</span></span>{releasedAt&&<small>Released {fmt(releasedAt,true)}</small>}{link&&<ExtLink href={link}>Release notes</ExtLink>}</div>
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
   {error&&<p id="uc-confirm-error" className="form-error" role="alert"><IconAlertTriangle size={16} aria-hidden="true"/>{error}</p>}
   <div className="modal-foot"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" aria-disabled={!ready||busy||undefined} aria-describedby="uc-start-hint">{busy?'Starting…':'Start update'}</button></div>
   {!ready&&<p id="uc-start-hint" className="submit-hint">Enter your password and a 6-digit code</p>}
  </form>
 </UCDialog>;
}

function HostUpdaterCard({up,status,busy,onCheck}){
 const desc=status==='not-installed'?'Set up the host updater above to enable updates here.':up.supported===false?'Too old for this release.':'Installs DockNest updates on the DockNest host.';
 let foot;
 if(status==='not-responding')foot=<span className="hs-warn"><IconAlertTriangle size={16} aria-hidden="true"/>Not responding{up.lastHeartbeatAt?<> {'·'} last seen {clock(up.lastHeartbeatAt)}</>:null}</span>;
 else if(status==='blocked')foot=<span className="hs-warn"><IconAlertTriangle size={16} aria-hidden="true"/>Blocked{up.version?` · v${String(up.version).replace(/^v/,'')}`:''}</span>;
 else if(status==='not-installed')foot=<span>Not installed</span>;
 else foot=<span className="hs-ok"><IconPlugConnected size={16} aria-hidden="true"/>Connected{up.version?` · v${String(up.version).replace(/^v/,'')}`:''}</span>;
 const disabled=status==='not-installed'||busy;
 return <article className="uc-card" aria-labelledby="uc-host-title"><div className="card-head"><h2 className="card-title" id="uc-host-title">Host updater</h2></div><p className="card-desc">{desc}</p>
  <div className="card-foot2"><p className="foot-status">{foot}</p><button type="button" className="text foot-act" aria-disabled={disabled||undefined} aria-describedby={status==='not-installed'?'uc-host-reason':undefined} onClick={()=>{if(!disabled)onCheck()}}><IconRefresh size={16} aria-hidden="true"/>{busy?'Checking…':'Check connection'}</button></div>
  {status==='not-installed'&&<span className="sr-only" id="uc-host-reason">Set up the host updater first.</span>}</article>;
}
function AutoChecksCard({data,busy,checking,onToggle,onCheck}){
 const on=data.consent?.checkEnabled===true,pending=data.consent?.checkEnabled==null,who=data.consent?.decidedBy?.name;
 return <article className="uc-card" aria-labelledby="uc-auto-title"><div className="card-head"><h2 className="card-title" id="uc-auto-title">Automatic checks</h2><button type="button" role="switch" className="switch" aria-checked={on} aria-labelledby="uc-auto-title" aria-describedby="uc-auto-desc" disabled={busy} onClick={onToggle}></button></div>
  <p className="card-desc" id="uc-auto-desc">DockNest asks GitHub for the list of releases. Nothing about your servers, sites or users is sent.{pending?<span className="row-note"> Not set up yet.</span>:!on&&who?<span className="row-note"> Set by {who}, {fmt(data.consent.decidedAt,true)}.</span>:null}</p>
  {checking&&<p className="card-note" id="uc-checking-note" role="status">DockNest is asking GitHub for the list of releases.</p>}
  <div className="card-foot2"><p className="foot-status">{on?(data.check?.checkedAt?'Last checked '+fmt(data.check.checkedAt):'Not checked yet'):'Automatic checks are off'}</p>{on?<button type="button" className="text foot-act" aria-disabled={checking||undefined} aria-describedby={checking?'uc-checking-note':undefined} onClick={()=>{if(!checking)onCheck()}}><IconRefresh size={16} aria-hidden="true"/>{checking?'Checking…':'Check now'}</button>:<span/>}</div></article>;
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
 if(st==='updater-state-mismatch')return <article className="uc-card uc-hero"><span className="rel-sym warn"><IconAlertTriangle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title">DockNest cannot confirm which version is installed</h2><p>The version in package.json, the release tag and the running image disagree. Nothing was changed. Check the server with these commands.</p>{['git status','git describe --tags --exact-match','docker compose images'].map(c=><CodeBlock key={c} command={c}/>)}</div></article>;
 if((st==='updater-blocked'||(blocked&&!offer))&&st!=='update-in-progress')return <article className="uc-card uc-hero"><span className="rel-sym warn"><IconAlertTriangle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title">Updates are blocked</h2><p>{blocked?.message||'The last update needs manual action on the DockNest host. Updates stay blocked until the server operator resolves it: first the release command from the rollback hint, then sudo scripts/install-updater.sh --ack. The acknowledgement alone does not release the hold.'}</p><p className="code-label">Confirm on the server</p><CodeBlock command="sudo scripts/install-updater.sh --ack"/><div className="rel-links"><ExtLink href={DOCS_ROLLBACK}>Rolling back</ExtLink><button type="button" className="text" onClick={()=>goTab('history')}>View history</button></div></div></article>;
 if(st==='consent-pending')return <article className="uc-card uc-hero"><span className="rel-sym muted"><IconInfoCircle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title">Update checks are not set up</h2><p>DockNest has not contacted GitHub and will not until you choose. Updates are never installed unless an administrator starts them.</p><div className="hero-actions"><button type="button" className="primary" onClick={onConsent}>Turn on checks</button></div></div></article>;
 if(st==='checks-off')return <article className="uc-card uc-hero"><span className="rel-sym muted"><IconInfoCircle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title">Automatic update checks are off</h2><p>DockNest makes no requests to GitHub. Turn on automatic checks below to be told about new versions.</p><AdvancedCli/></div></article>;
 if(st==='checking'||(checking&&!offer))return <article className="uc-card uc-hero"><span className="rel-sym"><IconRefresh size={32} className="dn-spin" aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title">Checking GitHub for new versions</h2><p role="status">This usually takes a few seconds. You can leave this page.</p></div></article>;
 if(!offer&&st==='check-failed')return <article className="uc-card uc-hero"><span className="rel-sym warn"><IconAlertTriangle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title">DockNest could not check for new versions</h2><p>The request to GitHub did not complete{data.check?.error?': '+data.check.error:''}. Your installation is not affected and keeps running normally.{data.check?.lastSuccessAt?' The last successful check was '+fmt(data.check.lastSuccessAt)+'.':''}</p></div></article>;
 if(!offer&&data.offer?.cli)return <article className="uc-card uc-hero"><span className="rel-sym"><IconInfoCircle size={32} aria-hidden="true"/></span><div className="hero-main"><h2 className="rel-title">DockNest {latest?.version||'update'} needs an earlier update first</h2><p>{latest?.minUpgradeFrom?`This release needs DockNest ${latest.minUpgradeFrom} or later. `:''}Follow the section on updating with one command in the update guide; it describes the steps without a version taken from GitHub.</p><p><ExtLink href={DOCS_UPGRADE}>Update guide</ExtLink></p></div></article>;
 if(!offer)return <article className="uc-card uc-hero"><span className="rel-sym ok"><IconCircleCheck size={32} aria-hidden="true"/></span><div className="hero-main"><div className="lead-line"><span className="vtok new">{cur}</span></div><h2 className="rel-title">You are running the latest version</h2><p>DockNest {cur} is the newest release.{data.check?.nextCheckAt?' The next check runs '+fmt(data.check.nextCheckAt)+'.':''}</p></div></article>;
 // An offer exists.
 const version=offer.version,chips=highlightChips(meta?.highlights);
 const needsEarlier=data.offer?.cli,tooOld=up.present&&up.supported===false,notResponding=status==='not-responding',notInstalled=status==='not-installed'||(!up.present&&status!=='connected'&&status!=='blocked');
 let title='A new version is available',body=`DockNest ${version} is ready to install. Review what changes before you start.`,reason=null,canStart=true;
 if(needsEarlier){title=`DockNest ${version} needs an earlier update first`;body=(latest?.minUpgradeFrom?`This release needs DockNest ${latest.minUpgradeFrom} or later. `:'')+'Follow the section on updating with one command in the update guide; it describes the steps without a version taken from GitHub.';canStart=false}
 else if(notInstalled){body=`DockNest ${version} is ready. Set up the host updater once to install it from here.`;canStart=false}
 else if(tooOld){title='The host updater needs an update first';body=`DockNest ${version} is available, but the host updater on this server is too old to install it.`;canStart=false}
 else if(notResponding){title='The host updater is not responding';body='Updates cannot start until it answers. Follow the steps below on the DockNest host, then check the connection again.';reason='The host updater is not responding.';canStart=false}
 else if(blocked){reason=blocked.message||'Updates cannot start right now.';canStart=false}
 const date=meta?.publishedAt||latest?.publishedAt;
 return <article className="uc-card uc-hero"><span className="rel-sym"><IconCircleArrowUp size={40} aria-hidden="true"/></span><div className="hero-main">
  <div className="lead-line"><span className="vchange"><span className="vtok">{cur}</span><IconArrowRight size={16} aria-hidden="true"/><span className="vtok new">{version}</span></span>{date&&<small>Released {fmt(date,true)}</small>}</div>
  <h2 className="rel-title">{title}</h2><p>{body}</p>
  {!needsEarlier&&<Chips chips={chips}/>}
  {st==='check-failed'&&<div className="inline-note" role="status"><IconAlertTriangle size={18} aria-hidden="true"/><div><b>The last check failed</b><p>{data.check?.error?data.check.error+'. ':''}This offer is the result from {fmt(data.check?.lastSuccessAt||data.check?.checkedAt)}.</p></div></div>}
  {reason&&<p className="reason-line" id="uc-update-reason">{reason}</p>}
  {needsEarlier?<p><ExtLink href={DOCS_UPGRADE}>Update guide</ExtLink></p>:<div className="hero-actions">
   {!notInstalled&&!tooOld&&<button type="button" className="primary" aria-disabled={!canStart||undefined} aria-describedby={reason?'uc-update-reason':undefined} onClick={()=>{if(canStart)openConfirm(version)}}><IconCircleArrowUp size={18} aria-hidden="true"/>Update to {version}</button>}
   <button type="button" onClick={()=>goTab('whats-new')}>What{'’'}s new</button></div>}
  {tooOld&&<><p className="code-label">Update the host updater</p><CodeBlock command="sudo scripts/install-updater.sh"/><p className="setup-lead">Run this on the DockNest host, from the DockNest folder. This page updates itself afterwards.</p></>}
 </div></article>;
}
function BeforeYouUpdate({meta}){
 const c=meta?.compatibility||{},yes=c.updatesDatabase==='yes';
 const db=yes?'Yes'+(Number.isInteger(c.fromSchema)&&Number.isInteger(c.toSchema)?`, schema v${c.fromSchema} to v${c.toSchema}`:''):c.updatesDatabase==='no'?'No':'Unknown';
 const s=meta?.downtime?.seconds,down=Number.isFinite(s)?`Estimate: about ${Math.max(1,Math.round(s/60))} min (based on your last update)`:'Estimate unavailable';
 const pauses=Array.isArray(meta?.pauses)?meta.pauses.join(', '):typeof meta?.pauses==='string'?meta.pauses:'Backups and restores';
 return <article className="uc-card" aria-labelledby="uc-before-title"><h2 className="card-title" id="uc-before-title">Before you update</h2><dl className="crow-wrap">{[['Database migration',db],['Downtime',down],['What pauses',pauses]].map(([k,v])=><div className="crow" key={k}><dt className="lbl">{k}</dt><dd className="val">{v}</dd></div>)}</dl></article>;
}
function FixUpdater({up}){
 return <article className="uc-card" aria-labelledby="uc-fix-title"><h2 className="card-title" id="uc-fix-title">Fix the updater</h2><div className="inline-note" role="status"><IconAlertTriangle size={18} aria-hidden="true"/><div><b>The updater is not responding</b><p>{up.lastHeartbeatAt?`It last reported at ${clock(up.lastHeartbeatAt)}. `:''}Run these on the DockNest host.</p></div></div>
  {[['Check the updater','systemctl status docknest-updater'],['Restart it','sudo systemctl restart docknest-updater'],['Read its log','journalctl -u docknest-updater -n 50'],['Repair it','sudo scripts/install-updater.sh --repair']].map(([l,c])=><React.Fragment key={c}><h3 className="code-label">{l}</h3><CodeBlock command={c}/></React.Fragment>)}</article>;
}

function OutcomeIcon({outcome}){const k=HISTORY_STATUS[outcome];const cls=k==='Installed'?'is-installed':k==='Rolled back'?'is-rolled-back':k==='Needs manual action'?'is-manual':'is-not-changed';const Icon=k==='Installed'?IconCircleCheck:k==='Rolled back'?IconRotate:k==='Needs manual action'?IconAlertTriangle:IconBan;return <span className={'dn-outcome '+cls}><Icon size={18} aria-hidden="true"/>{k||(String(outcome).startsWith('updater')?'Host updater updated':'Unknown')}</span>}
function HistoryTab({client}){
 const [items,setItems]=useState(null),[next,setNext]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async cursor=>{setBusy(true);try{const r=await client.history(cursor);setItems(v=>[...(cursor?v||[]:[]),...(Array.isArray(r.items)?r.items:[])]);setNext(r.next||null);setError('')}catch(e){setError(e.message)}finally{setBusy(false)}};
 useEffect(()=>{load()},[]);
 return <article className="uc-card"><h2 className="card-title">Update history</h2>{error&&<div className="alert" role="alert">{error}</div>}
  {items===null&&!error?<p role="status">Loading history{'…'}</p>:items?.length?<table className="hist"><caption className="sr-only">Update history</caption><colgroup><col className="c-ver"/><col className="c-date"/><col className="c-src"/><col className="c-status"/></colgroup><thead><tr><th scope="col">Version</th><th scope="col">Date</th><th scope="col">Source</th><th scope="col">Status</th></tr></thead><tbody>{items.map((r,i)=><tr key={(r.id||'cli')+r.version+r.at+i}><th scope="row" className="h-ver">{sameTag(r.version)?r.version:'—'}</th><td className="h-date">{fmt(r.at)}</td><td className="h-src">{r.source==='cli'?'Command line':'In-app update'}</td><td className="h-status"><OutcomeIcon outcome={r.outcome}/></td></tr>)}</tbody></table>:!error&&<p>No updates yet. Installed versions appear here.</p>}
  {next&&<div className="hero-actions"><button type="button" disabled={busy} onClick={()=>load(next)}>Load more</button></div>}
  <p className="footnote"><IconInfoCircle size={14} aria-hidden="true"/><span>Older versions are restored from the server command line. <ExtLink href={DOCS_ROLLBACK}>Rolling back</ExtLink></span></p></article>;
}
function WhatsNewTab({client,offer,meta,current}){
 const [own,setOwn]=useState(null),[failed,setFailed]=useState(false);
 useEffect(()=>{if(!offer)client.whatsNew().then(setOwn,()=>setFailed(true))},[client,offer]);
 const version=vv(offer?.version||own?.version)||current,markdown=offer?meta?.notesMarkdown:own?.markdown,link=tagUrl(version);
 const source=offer?meta?.notesSource:'image';
 return <>
  {offer&&<Chips chips={highlightChips(meta?.highlights)}/>}
  <article className="uc-card notes-card"><p className={'notes-label'+(source==='github-unverified'?' warn':'')}>{source==='verified'?<><IconShieldCheck size={16} aria-hidden="true"/>Verified release notes. Checked with the release signature.</>:source==='github-unverified'?<><IconAlertTriangle size={16} aria-hidden="true"/>Unverified notes from GitHub. They were not checked with the release signature.</>:source==='image'?<><IconInfoCircle size={16} aria-hidden="true"/>These notes are included with this version of DockNest.</>:null}</p>
   <h2 className="card-title">DockNest {version}</h2>
   {markdown?<Notes markdown={markdown} tag={sameTag(version)?version:undefined}/>:<p>{offer&&!meta?'Loading release notes…':failed?'The release notes could not be loaded.':'No release notes are available for this version.'}</p>}
   {link&&<p className="notes-foot"><ExtLink href={link}>View release on GitHub</ExtLink></p>}</article></>;
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
 if(!data)return <div className="uc-page">{error?<div className="alert" role="alert">{error}<button type="button" onClick={load}>Retry</button></div>:<p role="status" className="loading">Loading the Update Center{'…'}</p>}</div>;
 const showSetup=status==='not-installed'||setupSeen&&status==='connected'&&offer;
 return <div className="uc-page">
  {error&&<div className="alert" role="alert"><IconAlertTriangle size={18} aria-hidden="true"/>{error}</div>}
  <div className="tabs" role="tablist" aria-label="Update Center sections" onKeyDown={onKey}>{TABS.map(([id,label])=><button key={id} ref={el=>{tabRefs.current[id]=el}} type="button" role="tab" id={'uc-tab-'+id} aria-selected={tab===id} aria-controls={'uc-panel-'+id} tabIndex={tab===id?0:-1} onClick={()=>goTab(id)}>{label}</button>)}</div>
  {TABS.map(([id])=><div key={id} role="tabpanel" id={'uc-panel-'+id} aria-labelledby={'uc-tab-'+id} tabIndex={0} hidden={tab!==id}>
   {tab===id&&id==='overview'&&<div className="uc-stack">
    <Hero data={data} offer={offer} meta={meta} up={up} status={status} checking={checking} openConfirm={v=>setConfirm({version:v})} onConsent={()=>setConsentOpen(true)}/>
    {showSetup&&<article className="uc-card"><SetupCard connected={status==='connected'}/></article>}
    {offer&&!data.offer?.cli&&status!=='not-installed'&&!(up.present&&up.supported===false)&&status!=='not-responding'&&<BeforeYouUpdate meta={meta}/>}
    <div className="uc-split"><AutoChecksCard data={data} busy={busy} checking={checking||data.state==='checking'} onToggle={toggle} onCheck={checkNow}/><HostUpdaterCard up={up} status={status} busy={connecting} onCheck={checkConnection}/></div>
    {status==='not-responding'&&<FixUpdater up={up}/>}
   </div>}
   {tab===id&&id==='whats-new'&&<WhatsNewTab client={client} offer={offer} meta={meta} current={vv(data.current?.version)}/>}
   {tab===id&&id==='history'&&<HistoryTab client={client}/>}
  </div>)}
  {confirm&&<ConfirmUpdateDialog client={client} from={vv(data.current?.version)} version={confirm.version} retryOf={confirm.retryOf} releasedAt={meta?.publishedAt||data.check?.latest?.publishedAt} jobs={activeJobs} onClose={()=>setConfirm(null)} onStarted={()=>{setConfirm(null);dispatchEvent(new Event(LOCKED_EVENT))}}/>}
  {consentOpen&&<ConsentDialog client={client} onClose={()=>setConsentOpen(false)} onAnswered={s=>{if(s)setData(s);else load()}}/>}
 </div>;
}
