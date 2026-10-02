import {Paginated} from './pagination.jsx';
import React,{useEffect,useState} from 'react';
import {Folder,File,ArrowUp} from './icons.jsx';

export function ConfigurationFiles({api,serverId,containers,directory,onChoose,onClose,onSessionExpired}){
 const [path,setPath]=useState(directory||''),[listing,setListing]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const selected=containers.join(',');
 useEffect(()=>{
  let active=true;setLoading(true);setError('');setListing(null);
  api('/servers/'+serverId+'/project-files?containers='+encodeURIComponent(selected)+(path?'&path='+encodeURIComponent(path):'')).then(result=>{if(active)setListing(result);}).catch(error=>{if(!active)return;if(error.status===401)onSessionExpired();else setError(error.message);}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[serverId,selected,path,retry]);
 return <section className="configuration-browser" aria-label="Project configuration files">
  <header><b>Choose a file</b><button type="button" onClick={onClose}>Close file browser</button></header>
  <code className="configuration-path">{listing?.directory||path||'Detected project folder'}</code>
  <p>Open a folder to navigate. Select a file to include it in the backup.</p>
  {loading&&<p role="status">Loading folder…</p>}
  {error&&<><div className="alert" role="alert">{error}</div><button type="button" onClick={()=>setRetry(value=>value+1)}>Retry folder</button></>}
  {!loading&&listing&&<>
   {listing.parent&&<button type="button" onClick={()=>setPath(listing.parent)}><ArrowUp size={14}/> Parent folder</button>}
   <Paginated rows={listing.entries} label="Project files" resetKey={listing.directory}>{visible=><ul className="configuration-tree">{visible.map(entry=><li key={entry.path}>{entry.kind==='directory'?<button type="button" onClick={()=>setPath(entry.path)} aria-label={'Open folder '+entry.name}><Folder size={16}/>{entry.name}<span>Open folder</span></button>:<button type="button" disabled={!entry.selectable} onClick={()=>onChoose(entry.path)} aria-label={'Select file '+entry.name}><File size={16}/>{entry.name}<span>{entry.selectable?'Select file':'Unavailable'}</span></button>}</li>)}</ul>}</Paginated>
   {!listing.entries.length&&<p>This folder has no files.</p>}
   {listing.limited&&<p>Showing the first 500 entries. Open a smaller folder to find more files.</p>}
  </>}
 </section>;
}
