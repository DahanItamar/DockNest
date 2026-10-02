import React,{useEffect,useRef,useState} from 'react';

import {containerName,containerGroups} from './container-groups.js';
import {normalizeDomain} from '../shared/domains.js';
import {detectedConfiguration} from './site-configuration.js';
import {ConfigurationFiles} from './configuration-files.jsx';
const containerStatus=container=>typeof container.state==='object'?container.state.status:container.state||container.State?.Status||'unknown';

export function SiteWizard({api,Field,servers,initialServer='',initialSite=null,allowFileBrowsing=false,onSaved,onCancel,onSessionExpired}) {
 const [step,setStep]=useState(initialSite?2:1),[serverId,setServerId]=useState(initialSite?.serverId||initialSite?.server_id||initialServer||(servers.length===1?servers[0].id:''));
 const [containers,setContainers]=useState([]),[primary,setPrimary]=useState(initialSite?.config.containers?.[0]||''),[additional,setAdditional]=useState(initialSite?.config.containers?.slice(1)||[]);
 const [browser,setBrowser]=useState('');
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[scan,setScan]=useState(0);
 const [settings,setSettings]=useState({probeOrigin:!!initialSite?.config.maintenance?.probeOrigin,name:initialSite?.name||'',healthUrl:initialSite?.config.healthUrl||'http://127.0.0.1:8080/',domains:initialSite?.config.domains?.join(', ')||'',shutdownProfile:initialSite?.config.shutdownProfile||'generic',stagingRoot:initialSite?.config.stagingRoot||'/var/lib/docknest',configFiles:initialSite?.config.configFiles?.join('\n')||'',composeFiles:initialSite?.config.composeFiles?.join('\n')||'',externalReferencesConfirmed:false,cleanShutdownConfirmed:!!initialSite?.config.cleanShutdownConfirmed,exclusiveSourcesConfirmed:!!initialSite?.config.exclusiveSourcesConfirmed});
 const nameEdited=useRef(!!initialSite),firstDiscovery=useRef(true),filesEdited=useRef({composeFiles:!!initialSite?.config.composeFiles?.length,configFiles:!!initialSite?.config.configFiles?.length});
 useEffect(()=>{
  let current=true;
  const preserve=firstDiscovery.current&&!!initialSite;firstDiscovery.current=false;
  setContainers([]);if(!preserve){setTemporaryReviewed(false);setPrimary('');setAdditional([]);filesEdited.current={composeFiles:false,configFiles:false};}setBrowser('');setError('');setLoading(!!serverId);
  setSettings(previous=>({...previous,...(!nameEdited.current?{name:''}:{}),...(!preserve?{composeFiles:'',configFiles:'',externalReferencesConfirmed:false,cleanShutdownConfirmed:false,exclusiveSourcesConfirmed:false}:{})}));
  if(serverId)api('/servers/'+serverId+'/discover').then(result=>{
   if(current)setContainers((result.containers||[]).filter(container=>containerName(container)));
  }).catch(error=>{
   if(!current)return;
   if(error.status===401)onSessionExpired();else setError(error.message);
  }).finally(()=>{if(current)setLoading(false);});
  return()=>{current=false;};
 },[serverId,scan]);
 const groups=containerGroups(containers);
 const siteChoices=groups.flatMap(group=>group.kind==='standalone'?group.containers.map(container=>({...group,id:'container:'+containerName(container),name:containerName(container),containers:[container]})):[group]);
 const selected=[primary,...additional].filter(Boolean);
 const detected=detectedConfiguration(containers,selected);
 const temporaryFolders=containers.filter(c=>selected.includes(containerName(c))).flatMap(c=>(c.temporaryMemoryFolders||[]).map(destination=>({container:containerName(c),destination})));
 const [temporaryReviewed,setTemporaryReviewed]=useState(!!initialSite?.config.temporaryMemoryFolders?.length);
 useEffect(()=>{
  if(loading||!selected.length)return;
  const discovery=detectedConfiguration(containers,selected);
  setSettings(previous=>({...previous,...(!filesEdited.current.composeFiles?{composeFiles:discovery.composeFiles.join('\n')}:{ }),...(!filesEdited.current.configFiles?{configFiles:discovery.configFiles.join('\n')}:{ })}));
 },[containers,primary,additional,loading]);
 function selectNames(names,title){if(names.length>30){setError('A site can include up to 30 containers. Select the services it needs individually.');return;}setTemporaryReviewed(false);setPrimary(names[0]||'');setAdditional(names.slice(1));setError('');setSettings(previous=>({...previous,...(!nameEdited.current?{name:title||names[0]||''}:{}),externalReferencesConfirmed:false,cleanShutdownConfirmed:false,exclusiveSourcesConfirmed:false}));}
 function toggleGrouped(name,checked){selectNames(checked?[...selected,name]:selected.filter(value=>value!==name),settings.name);}
 const source=containers.find(container=>containerName(container)===primary);
 const update=event=>{
  const {name,value,type,checked}=event.target;
  if(name==='name')nameEdited.current=true;
  if(name==='composeFiles'||name==='configFiles')filesEdited.current[name]=true;
  setSettings(previous=>({...previous,[name]:type==='checkbox'?checked:value}));
 };
 function chooseContainer(event){
  const value=event.target.value;setTemporaryReviewed(false);setPrimary(value);setAdditional([]);
  setSettings(previous=>({...previous,...(!nameEdited.current?{name:value}:{}),externalReferencesConfirmed:false,cleanShutdownConfirmed:false,exclusiveSourcesConfirmed:false}));
 }
 async function submit(event){
  event.preventDefault();if(busy)return;setError('');
  if(!serverId||!primary||loading)return;
  if(step===1&&error)return;
  if(step===2&&detected.compose&&!settings.composeFiles.trim()){setError('Select the Compose project file below so this site can be backed up.');return;}
  if(step<3){setStep(step+1);return;}
  setBusy(true);
  const paths=value=>value.split('\n').map(path=>path.trim()).filter(Boolean);
  const domains=settings.domains.split(',').map(normalizeDomain).filter(Boolean);
  try{
   const site=await api(initialSite?'/sites/'+initialSite.id:'/sites',{serverId,name:settings.name,config:{...initialSite?.config,containers:selected,temporaryMemoryFolders:temporaryReviewed?temporaryFolders:[],stagingRoot:settings.stagingRoot,maintenanceRequired:true,maintenanceProbeOrigin:!!settings.probeOrigin,domains,healthUrl:settings.healthUrl,...(initialSite?.config.maintenance?{maintenance:{...initialSite.config.maintenance,required:true,healthUrl:settings.healthUrl,publicUrl:domains[0]?'https://'+domains[0]:''}}:{}),shutdownProfile:settings.shutdownProfile,configFiles:paths(settings.configFiles),composeFiles:paths(settings.composeFiles),externalReferencesConfirmed:settings.externalReferencesConfirmed,cleanShutdownConfirmed:settings.cleanShutdownConfirmed,exclusiveSourcesConfirmed:settings.exclusiveSourcesConfirmed}},initialSite?'PATCH':'POST');
   onSaved(site);
  }catch(error){if(error.status===401)onSessionExpired();else setError(error.message);}finally{setBusy(false);}
 }
 return <form className="modal-body site-wizard" onSubmit={submit}>
  <ol className="wizard-steps" aria-label="Site setup steps">{['Select site','Site details','Review & add'].map((label,index)=><li key={label} aria-current={step===index+1?'step':undefined}>{index+1}. {label}</li>)}</ol>
  {step===1&&<>
   <h3>Which site do you want to back up?</h3>
   <Field label="Source server" value={serverId} onChange={event=>setServerId(event.target.value)} options={[[ '', 'Choose a server'],...servers.map(server=>[server.id,server.name+(server.note?' · '+server.note:'')])]} required/>
   {loading&&<p role="status">Loading Docker containers from this server…</p>}
   {serverId&&!loading&&!error&&<>
    {containers.length?<>
     <p>Choose the project that belongs to your site, then press Continue. Selecting a project includes all its services.</p>
     <div className="application-groups">{siteChoices.map(group=>{
      const names=group.containers.map(containerName);
      const chosen=names.length===selected.length&&names.every(name=>selected.includes(name));
      return <section className={'application-group'+(chosen?' chosen':'')} key={group.id} aria-label={group.name}>
       <header><div><h4>{group.name}</h4><p>{group.compose?'Compose project':group.kind==='swarm'?'Swarm stack · this server only':'Single container · check whether it needs a database'} <span className="count">{names.length} {names.length===1?'service':'services'}</span></p></div><button type="button" aria-label={'Select site '+group.name} aria-pressed={chosen} onClick={()=>selectNames(names,group.name)}>{chosen?'Selected':'Select site'}</button></header>
       <p className="site-services">{group.containers.map(container=>container.service||containerName(container)).join(', ')}</p>
       <details className="site-service-review"><summary>Review services in {group.name}</summary><div className="container-list">{group.containers.map(container=>{const name=containerName(container);return <label className="container-option" key={name}><input type="checkbox" aria-label={'Include '+name} checked={selected.includes(name)} disabled={!selected.includes(name)&&selected.length>=30} onChange={event=>toggleGrouped(name,event.target.checked)}/><div><b>{container.service||name}</b><small>{name} / {container.image||container.Config?.Image||'Image unavailable'}</small></div><span className="container-state">{containerStatus(container)}</span></label>;})}</div></details>
      </section>;
     })}</div>
     <div className="selection-summary" role="status"><b>{selected.length?settings.name||primary:'No site selected'}</b><span>{selected.length?selected.length+' services included: '+selected.join(', '):'Use Select site on one of the cards above.'}</span>{selected.length>0&&<button type="button" onClick={()=>selectNames([])}>Clear selection</button>}</div>
     <details className="manual-container-picker"><summary>My site needs a custom selection</summary>
     <p>Select the app and its database or other services. Docker project labels suggest membership; check that shared services belong in this backup.</p>
     <Field label="Docker container (site)" value={primary} onChange={chooseContainer} options={[[ '', 'Choose a Docker container'],...containers.map(container=>[containerName(container),containerName(container)+' · '+containerStatus(container)])]}/>
     {source&&<div className="hint"><b>{primary}</b><p>{source.image||source.Config?.Image||'Docker container'} · {containerStatus(source)}</p><p>{(source.mounts||source.Mounts)?.map(mount=>(mount.Type||mount.type)+': '+(mount.Destination||mount.destination)).join(' · ')||'Mounted data is inspected during backup preflight.'}</p></div>}
     {primary&&containers.length>1&&<details open><summary>Review selected services ({selected.length}) and add or remove containers</summary><p>Include its database or other services only when they belong to the same site.</p><div className="container-list">{containers.filter(container=>containerName(container)!==primary).map(container=>{const name=containerName(container);return <label className="container-option" key={name}><input type="checkbox" checked={additional.includes(name)} disabled={!additional.includes(name)&&selected.length>=30} onChange={event=>{setTemporaryReviewed(false);setAdditional(previous=>event.target.checked?[...previous,name]:previous.filter(value=>value!==name));}}/><div><b>{name}</b><small>{container.image||container.Config?.Image} · {containerStatus(container)}</small></div></label>;})}</div></details>}
     </details>
    </>:<p role="status">No Docker containers found. Check the selected server, or create your site’s container and refresh.</p>}
   </>}
   {serverId&&!loading&&<button type="button" onClick={()=>setScan(value=>value+1)}>{error?'Retry container discovery':'Refresh containers'}</button>}
  </>}
  {step===2&&<>
   <h3>Set up {settings.name||primary}</h3>
   <Field label="Site name" name="name" value={settings.name} onChange={update} required maxLength={100}/>
   <Field label="Application health URL" name="healthUrl" type="url" value={settings.healthUrl} onChange={update} required help="Use the URL that responds when this site is healthy, as reached from its source server."/>
   <p className="hint">The site name is filled in from your selection. Check the health URL so DockNest can tell when your site is back online after a backup.</p>
   <section className="site-files" aria-label="Backup configuration files"><h4>Configuration files to include</h4>
    {!!temporaryFolders.length&&<div className="hint"><h4>Temporary RAM folders</h4><p>{temporaryFolders.map(item=>item.container+': '+item.destination).join(' | ')}</p><p>These folders lose their contents when a container stops. Site files and database data must be in persistent mounts. The restore recreates these RAM folders empty with their original size and permissions.</p><label className="check"><input type="checkbox" checked={temporaryReviewed} onChange={event=>setTemporaryReviewed(event.target.checked)}/> Recreate these temporary folders empty on restore</label></div>}
    {detected.compose&&<p>{detected.composeFiles.length?'Detected Compose files are filled in below. Review them and any environment files before saving.':'This site uses Compose. Select its project file so DockNest can recreate it.'}</p>}
    <Field label="Compose project files (one absolute path per line)" aria-label="Compose project files (one absolute path per line)" name="composeFiles" multiline value={settings.composeFiles} onChange={update} required={detected.compose} help="Project definitions needed to recreate this site."/>
    {allowFileBrowsing&&detected.compose&&<button type="button" onClick={()=>setBrowser('composeFiles')}>Browse Compose files</button>}
    <Field label="Environment and other configuration files (one absolute path per line)" aria-label="Environment and other configuration files (one absolute path per line)" name="configFiles" multiline value={settings.configFiles} onChange={update} help="Include .env and other files needed by your project. File contents stay off this screen."/>
    {allowFileBrowsing&&detected.compose&&<button type="button" onClick={()=>setBrowser('configFiles')}>Browse configuration files</button>}
    {browser&&<ConfigurationFiles key={serverId+selected.join(',')+browser} api={api} serverId={serverId} containers={selected} directory={detected.directory} onSessionExpired={onSessionExpired} onClose={()=>setBrowser('')} onChoose={path=>{filesEdited.current[browser]=true;setSettings(previous=>({...previous,[browser]:[...new Set([...previous[browser].split('\n').filter(Boolean),path])].join('\n'),externalReferencesConfirmed:false}));setBrowser('');}}/>}
   </section>
   <details><summary>Advanced backup settings</summary>
    <Field label="Domains (comma separated)" name="domains" value={settings.domains} onChange={update} onBlur={()=>setSettings(previous=>({...previous,domains:previous.domains.split(',').map(normalizeDomain).filter(Boolean).join(', ')}))} help="Enter www.blog.example.invalid or paste https://www.blog.example.invalid. Separate multiple domains with commas. Used for the maintenance page."/>
    <Field label="Shutdown profile" name="shutdownProfile" value={settings.shutdownProfile} onChange={update} options={[[ 'generic','Generic services'],['postgres','PostgreSQL'],['mysql','MySQL']]} help="Generic requires you to verify clean shutdown in the next step. Choose a database profile only when it matches this site's database."/>
    <label className="check"><input type="checkbox" name="probeOrigin" checked={!!settings.probeOrigin} onChange={update}/> Check the website through this server's local proxy</label><p className="hint">Use when a CDN blocks automated probes. Keeps the website hostname and verifies its HTTPS certificate, while connecting to 127.0.0.1 on the source server. Verify CDN behavior separately.</p>
    <Field label="Staging directory" name="stagingRoot" value={settings.stagingRoot} onChange={update} required help="Temporary capture space on the source server. Permanent backups use the selected storage destination."/>
   </details>
  </>}
  {step===3&&<>
   <h3>Review your site</h3>
   <dl className="setup-review"><dt>Site</dt><dd>{settings.name}</dd><dt>Server</dt><dd>{servers.find(server=>server.id===serverId)?.name}</dd><dt>Containers</dt><dd>{selected.join(', ')}</dd><dt>Health check</dt><dd>{settings.healthUrl}</dd><dt>Compose files</dt><dd>{settings.composeFiles||'None selected'}</dd><dt>Other configuration</dt><dd>{settings.configFiles||'None selected'}</dd></dl>
   <label className="check"><input type="checkbox" name="externalReferencesConfirmed" checked={settings.externalReferencesConfirmed} onChange={update} required/> I reviewed external dependencies and included the configuration files and secrets needed to recreate this site.</label>
   <label className="check"><input type="checkbox" name="cleanShutdownConfirmed" checked={settings.cleanShutdownConfirmed} onChange={update} required={settings.shutdownProfile==='generic'}/> I verified that a normal stop cleanly closes the application and database writers (required for Generic).</label>
   <label className="check"><input type="checkbox" name="exclusiveSourcesConfirmed" checked={settings.exclusiveSourcesConfirmed} onChange={update} required/> No containers or processes outside this site write to its mounted data.</label>
   <p className="hint">Saving a site does not start a backup. Before the first backup, connect a storage destination and configure the source server’s maintenance proxy and readiness endpoint.</p>
  </>}
  {error&&<div className="alert" role="alert">{error}</div>}
  <div className="modal-foot"><button type="button" onClick={onCancel} disabled={busy}>Cancel</button>{step>1&&<button type="button" disabled={busy} onClick={()=>{setStep(value=>value-1);setError('');}}>Back</button>}<button className="primary" disabled={busy||loading||!primary||(step===1&&!!error)}>{busy?'Saving site…':step===3?(initialSite?'Save configuration':'Add site'):'Continue'}</button></div>
 </form>;
}
