// The only place that knows the self-heal API (docs/self-heal.md, "API"; src/self-heal/routes.js). `api` is the app's fetch helper: api(path, body, method).
//  GET /sites/:id/self-heal -> {available, enabled, maxRestarts, windowMinutes, limits, canEdit, watched:[{name,project,service,health,found}],
//    stream:{state:'connected'|'connecting'|'off', reason, notWatching}, note, events:{items:[{id,at,container,kind,reasonCode,reason}], nextCursor}}
//  PUT /sites/:id/self-heal {enabled, maxRestarts, windowMinutes} -> the same card. Errors: 400 INVALID, 403, 404, 409 SITE_REMOVED, 422 NO_HEALTHCHECK, 502 UNREACHABLE.
//  GET /self-heal/events?siteId=&after= -> {items, nextCursor}
export function createSelfHealClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  load:siteId=>api('/sites/'+id(siteId)+'/self-heal'),
  save:(siteId,{enabled,maxRestarts,windowMinutes})=>api('/sites/'+id(siteId)+'/self-heal',{enabled,maxRestarts,windowMinutes},'PUT'),
  events:(siteId,after)=>api('/self-heal/events?siteId='+id(siteId)+(after?'&after='+id(after):''))
 };
}
