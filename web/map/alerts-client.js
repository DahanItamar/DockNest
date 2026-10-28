// The Map's side of the alert API (docs/alert-channels.md, "API"). `api` is the app's fetch helper: api(path, body, method).
// A node is one provider plus one Connection; its secrets live in the Connection (web/connections/), never here.
export function createAlertsClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  // { nodes, rules, connections (no secrets), providers, events, sourceKinds, limits, settings, role }
  load:()=>api('/alerts'),
  createNode:body=>api('/alerts/nodes',body),
  updateNode:(nodeId,body)=>api('/alerts/nodes/'+id(nodeId),body,'PATCH'),
  deleteNode:nodeId=>api('/alerts/nodes/'+id(nodeId),undefined,'DELETE'),
  testNode:nodeId=>api('/alerts/nodes/'+id(nodeId)+'/test',{}),
  createRule:body=>api('/alerts/rules',body),
  updateRule:(ruleId,body)=>api('/alerts/rules/'+id(ruleId),body,'PATCH'),
  deleteRule:ruleId=>api('/alerts/rules/'+id(ruleId),undefined,'DELETE'),
  // Same check as the Update Center and the move flow (POST /api/auth/reauth)
  reauth:(password,code)=>api('/auth/reauth',{password,code})
 };
}
export const EVENT_LABEL={'backup.failed':'Backup failed','backup.succeeded':'Backup succeeded','move.finished':'Move finished','move.needs_you':'Move needs you','server.unreachable':'Server unreachable','server.disk_low':'Disk almost full','update.available':'Update available','restore_test.failed':'Restore test failed','restore_test.couldnt_run':'Restore test couldn’t run','restore_test.recovered':'Restore test passed again','restore_test.needs_you':'Restore test needs clean-up','backup.copy_failed':'Backup copy failed','backup.copy_recovered':'Backup copy recovered','backup.copy_gave_up':'Backup copy gave up'};
const SITE=['backup.failed','backup.succeeded','backup.copy_failed','backup.copy_recovered','backup.copy_gave_up','move.finished','move.needs_you','restore_test.failed','restore_test.couldnt_run','restore_test.recovered','restore_test.needs_you'];
// What each kind of source can tell you about
export const EVENTS_FOR={site:SITE,server:[...SITE,'server.unreachable','server.disk_low'],docknest:[...SITE,'server.unreachable','server.disk_low','update.available']};
// What a new line starts with (docs/alert-channels.md, "Screens"): the things that need you, not the good news.
export const DEFAULT_EVENTS={site:['backup.failed','restore_test.failed'],server:['backup.failed','restore_test.failed','server.unreachable','server.disk_low'],docknest:['backup.failed','restore_test.failed','server.unreachable','server.disk_low','update.available']};
export const words=events=>(events||[]).filter(e=>EVENT_LABEL[e]).map(e=>EVENT_LABEL[e]).join(', ');
// The tiny label on a line: two events in words, then how many more
export function lineLabel(events){const list=(events||[]).filter(e=>EVENT_LABEL[e]);return list.length<=2?words(list):list.slice(0,2).map(e=>EVENT_LABEL[e]).join(', ')+` and ${list.length-2} more`}
export const nodeOf=rule=>rule.nodeId||rule.channelId;
export const sameSource=(rule,source)=>rule.sourceKind===source.kind&&(rule.sourceId||null)===(source.id||null);
// How many different sources send to a node (what a delete stops).
export const sourcesOf=(rules,nodeId)=>new Set(rules.filter(r=>nodeOf(r)===nodeId).map(r=>r.sourceKind+':'+(r.sourceId||''))).size;
