// The only place that knows the restore-test API (docs/restore-tests.md, "API contract"; src/restore-tests/routes.js).
// `api` is the app's fetch helper: api(path, body, method). scripts/restore-tests-browser.js mocks these routes, and
// with REAL_API=1 runs the same screens against the real API.
export function createRestoreTestsClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  // The site's card: {settings, last, active, items, next}. `cursor` pages through `items`.
  card:(siteId,cursor)=>api('/sites/'+id(siteId)+'/restore-tests'+(cursor?'?cursor='+id(cursor):'')),
  // Administrator only. Takes the settings fields without nextDueAt and skipReason.
  // REVERIFY_REQUIRED (turning on live server or internet) is raised as REAUTH_REQUIRED, the code the app's re-verify prompt (useGuard) reacts to.
  saveSettings:(siteId,settings)=>api('/sites/'+id(siteId)+'/restore-tests/settings',settings,'PUT').catch(e=>{if(e?.code==='REVERIFY_REQUIRED')e.code='REAUTH_REQUIRED';throw e}),
  // The shared password and a fresh authenticator code, as everywhere else.
  reauth:(password,code)=>api('/auth/reauth',{password,code}),
  // Administrators and operators. Optional backupId. Returns {id, jobId}.
  run:(siteId,backupId)=>api('/sites/'+id(siteId)+'/restore-tests',backupId?{backupId}:{}),
  detail:testId=>api('/restore-tests/'+id(testId)),
  cancel:testId=>api('/restore-tests/'+id(testId)+'/cancel',{}),
  // Administrator only: retries clean-up of a needs_cleanup test.
  cleanup:testId=>api('/restore-tests/'+id(testId)+'/cleanup',{}),
  // Administrator only: a needs_cleanup test is acknowledged through its job's recovery route, with the site name,
  // and only when the test server reports nothing left (409 LEFTOVERS otherwise).
  acknowledge:(jobId,siteName)=>api('/jobs/'+id(jobId)+'/recovery',{confirmation:siteName,reviewedRemoteRecovery:true})
 };
}

// Contract vocabulary.
export const RESULTS=['passed','failed','couldnt_run','cancelled'];
export const ACTIVE_STATES=new Set(['queued','running','cleaning']);
export const JOB_TYPE='restore-test';
export const STEP_KEYS=['check_space','copy_backup','restore_copy','start_containers','check_health','clean_up'];
export const STEP_LABELS={check_space:'Check space',copy_backup:'Copy backup',restore_copy:'Restore copy',start_containers:'Start containers',check_health:'Check health',clean_up:'Clean up'};
export const MANUAL_TESTS_PER_DAY=6;

// A test job carries its test id in details (object or JSON string).
export function testIdOf(job){
 let d=job?.details;if(typeof d==='string'){try{d=JSON.parse(d)}catch{d=null}}
 return d&&typeof d==='object'?d.testId||null:null;
}
export const isTestJob=job=>job?.type===JOB_TYPE;

// Plain sentences for the codes the screens react to. A code the API sends with its own sentence keeps that sentence.
const SETTINGS_ERRORS={
 TEST_SERVER_REQUIRED:'Choose a test server first.',
 LIVE_SERVER_NOT_ALLOWED:'Allow live server to use that server.',
 REAUTH_REQUIRED:'Confirm it is you first, then save again.',
 PROBE_STATIC:'A static site has no container to check.',
 CPUS_ABOVE_SERVER:'The test server has fewer cores than that.'
};
const RUN_ERRORS={
 TEST_ACTIVE:'A test is already running for this site.',
 NO_VERIFIED_BACKUP:'This site has no verified backup yet.',
 SITE_BUSY:'This site is busy right now. Try again soon.',
 NO_TEST_SERVER:'Choose a test server first.',
 EXTERNAL_STORAGE:'This site needs external storage that a restore test cannot attach.'
};
export const settingsError=e=>SETTINGS_ERRORS[e?.code]||e?.message||'Could not save. Try again.';
// TOO_MANY_TESTS shows the API's own limit message.
export const runError=e=>e?.code==='TOO_MANY_TESTS'?(e.message||'You have reached the limit of '+MANUAL_TESTS_PER_DAY+' tests for this site today.'):RUN_ERRORS[e?.code]||e?.message||'Could not start the test. Try again.';
