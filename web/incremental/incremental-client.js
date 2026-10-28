// The only place that knows the incremental-backup routes (docs/incremental-backups.md, API contract for 2.12.0).
// `api` is the app's fetch helper: api(path, body, method). scripts/incremental-browser.js mocks these routes.
export function createIncrementalClient(api){
 const id=encodeURIComponent;
 return {
  get:siteId=>api('/sites/'+id(siteId)+'/incremental'),
  save:(siteId,body)=>api('/sites/'+id(siteId)+'/incremental',body,'PUT'),
  backup:siteId=>api('/sites/'+id(siteId)+'/backup',{}),
  remove:backupId=>api('/backups/'+id(backupId),null,'DELETE')
 };
}
// The chain download is a plain file download of the encrypted packages plus ORDER.txt.
export const chainDownloadUrl=backupId=>'/api/backups/'+encodeURIComponent(backupId)+'/chain-download';
