// The only place that knows the alerts API (docs/alerts.md, "API"). `api` is the app's fetch helper: api(path, body, method).
// Channels hold write-only secrets: nothing here ever receives or keeps one after it is sent.
export function createAlertsClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  load:()=>api('/alerts'),
  // Credentials (the secret part of a node, reusable): { id, kind, name, config (no secrets, tokenSet / passwordSet), createdAt }
  createCredential:body=>api('/alerts/credentials',body),
  updateCredential:(credentialId,body)=>api('/alerts/credentials/'+id(credentialId),body,'PATCH'),
  deleteCredential:credentialId=>api('/alerts/credentials/'+id(credentialId),undefined,'DELETE'),
  testCredential:credentialId=>api('/alerts/credentials/'+id(credentialId)+'/test',{}),
  createChannel:body=>api('/alerts/channels',body),
  updateChannel:(channelId,body)=>api('/alerts/channels/'+id(channelId),body,'PATCH'),
  deleteChannel:channelId=>api('/alerts/channels/'+id(channelId),undefined,'DELETE'),
  test:channelId=>api('/alerts/channels/'+id(channelId)+'/test',{}),
  createRule:body=>api('/alerts/rules',body),
  updateRule:(ruleId,body)=>api('/alerts/rules/'+id(ruleId),body,'PATCH'),
  deleteRule:ruleId=>api('/alerts/rules/'+id(ruleId),undefined,'DELETE'),
  // Same check as the Update Center and the move flow (POST /api/auth/reauth)
  reauth:(password,code)=>api('/auth/reauth',{password,code})
 };
}
export const EVENT_LABEL={'backup.failed':'Backup failed','backup.succeeded':'Backup succeeded','move.finished':'Move finished','move.needs_you':'Move needs you','server.unreachable':'Server unreachable','server.disk_low':'Disk almost full','update.available':'Update available'};
const SITE=['backup.failed','backup.succeeded','move.finished','move.needs_you'];
// What each kind of source can tell you about
export const EVENTS_FOR={site:SITE,server:[...SITE,'server.unreachable','server.disk_low'],docknest:[...SITE,'server.unreachable','server.disk_low','update.available']};
// What a new line starts with: the things that need you, not the good news
export const DEFAULT_EVENTS={site:['backup.failed','move.needs_you'],server:['server.unreachable','server.disk_low','backup.failed'],docknest:['update.available','server.unreachable']};
export const KIND_LABEL={telegram:'Telegram',email:'Email'};
export const words=events=>(events||[]).filter(e=>EVENT_LABEL[e]).map(e=>EVENT_LABEL[e]).join(', ');
// The tiny label on a line: two events in words, then how many more
export function lineLabel(events){const list=(events||[]).filter(e=>EVENT_LABEL[e]);return list.length<=2?words(list):list.slice(0,2).map(e=>EVENT_LABEL[e]).join(', ')+` and ${list.length-2} more`}
export const sameSource=(rule,source)=>rule.sourceKind===source.kind&&(rule.sourceId||null)===(source.id||null);
