// Domains take part in Map moves (docs/domains.md, "Moving apps from the Map"). Pure: the move list and the apps in, answers out.
// A domain has no move of its own: it moves with the app that owns it. Dragging a domain, a subdomain or an app onto a server
// goes through the same check (dropVerdict), so every way to start a move refuses the same things the same way.
import {ownersOf} from './domains-model.js';

// Move states that are over: the app is where it was (cancelled, switched back, failed, rolled back) or where it was moved to (done, cleaned).
export const ENDED=new Set(['done','cleaned','switched_back','failed','cancelled','rolled_back']);
export const MOVED=new Set(['done','cleaned']);
export const HINT={
 none:'This domain moves with its app. Add the app first.',
 several:'Used by several apps; move the app instead.',
 same:'It already runs on that server.',
 offline:'That server is offline.',
 running:'A move for this app is already running.',
 unknown:'DockNest cannot move this right now.'
};
const offline=server=>!server||(!!server.status&&server.status!=='connected'&&server.status!=='unchecked');

// What the Map shows for moves: apps still moving (siteId to the server they move to) and apps that finished moving.
// edit: the change someone is making on the Map right now ({siteId,targetId}), which counts as moving too.
export function moveState(moves=[],edit=null){
 const pending={},done=new Set();
 for(const m of Array.isArray(moves)?moves:[]){
  if(!m||!m.siteId)continue;
  if(MOVED.has(m.state))done.add(m.siteId);
  else if(!ENDED.has(m.state)&&m.targetServerId)pending[m.siteId]=m.targetServerId;
 }
 if(edit?.siteId&&edit.targetId)pending[edit.siteId]=edit.targetId;
 return {pending,done};
}
// The one check for every drop on a server. source: {siteId} (an app) or {domain} (a domain or subdomain).
// Returns {ok:true,siteId} or {ok:false,reason,hint}. Nothing is changed here.
export function dropVerdict({siteId,domain,rows=[],sites=[],servers=[],targetServerId,moves=[]}){
 let id=siteId;
 if(!id){
  const owners=ownersOf(domain,rows,sites);
  if(owners.length===0)return {ok:false,reason:'none',hint:HINT.none};
  if(owners.length>1)return {ok:false,reason:'several',hint:HINT.several};
  id=owners[0];
 }
 const site=sites.find(s=>s.id===id);
 if(!site)return {ok:false,reason:'unknown',hint:HINT.unknown};
 if(site.serverId===targetServerId)return {ok:false,reason:'same',hint:HINT.same};
 if(offline(servers.find(s=>s.id===targetServerId)))return {ok:false,reason:'offline',hint:HINT.offline};
 if((Array.isArray(moves)?moves:[]).some(m=>m&&m.siteId===id&&!ENDED.has(m.state)))return {ok:false,reason:'running',hint:HINT.running};
 return {ok:true,siteId:id};
}
