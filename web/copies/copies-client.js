// The only place that knows the storage-per-site and backup-copy routes (docs/backup-copies.md, API contract v1).
// `api` is the app's fetch helper: api(path, body, method). scripts/copies-browser.js mocks these routes.
export function createCopiesClient(api){
 const id=encodeURIComponent;
 return {
  siteStorage:siteId=>api('/sites/'+id(siteId)+'/storage'),
  saveSiteStorage:(siteId,body)=>api('/sites/'+id(siteId)+'/storage',body,'PUT'),
  destinations:()=>api('/storage-targets'),
  retryCopy:(backupId,targetId)=>api('/backups/'+id(backupId)+'/copies/'+id(targetId)+'/retry',{}),
  removeDestination:targetId=>api('/storage-targets/'+id(targetId),null,'DELETE'),
  deleteCopies:(targetId,{includePinned,includeLastPackages}={})=>api('/storage-targets/'+id(targetId)+'/copies/delete',{...(includePinned?{includePinned:true}:{}),...(includeLastPackages?{includeLastPackages:true}:{})}),
  reauth:(password,code)=>api('/auth/reauth',{password,code})
 };
}
