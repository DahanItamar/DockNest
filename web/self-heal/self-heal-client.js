// The only place that knows the self-heal API (docs/self-heal.md, "API"). `api` is the app's fetch helper: api(path, body, method).
// Assumed shapes (backend built in parallel):
//  GET /sites/:id/self-heal -> {enabled, maxRestarts, windowMinutes, watched:[{name}], stream:{state:'connected'|'connecting'|'off', reason?}, events:[{id, container, kind, reason?, at}], next?}
//  PUT /sites/:id/self-heal {enabled, maxRestarts, windowMinutes} -> the same card; 422 {code:'NO_HEALTHCHECK'}
//  GET /self-heal/events?siteId=&after= -> {events:[...], next?}
export function createSelfHealClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  load:siteId=>api('/sites/'+id(siteId)+'/self-heal'),
  save:(siteId,{enabled,maxRestarts,windowMinutes})=>api('/sites/'+id(siteId)+'/self-heal',{enabled,maxRestarts,windowMinutes},'PUT'),
  events:(siteId,after)=>api('/self-heal/events?siteId='+id(siteId)+(after?'&after='+id(after):''))
 };
}
