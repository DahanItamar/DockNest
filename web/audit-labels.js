// Readable audit trail: action codes become short labels and actor ids become display names.
// The raw code stays available in the details dialog; the table never shows a raw id.
const ACTIONS={
 'auth.login':'Signed in','auth.login_failed':'Sign-in failed','auth.logout':'Signed out','auth.reauth':'Re-authenticated','auth.setup':'Administrator set up','auth.enrolled':'Account enrolled',
 'updater.requested':'Update requested','updater.refused':'Update refused','updater.finished':'Update finished','updater.acknowledged':'Updater acknowledged','updater.resolved':'Update resolved',
 'update.consent':'Update check choice saved','update.settings':'Update settings changed',
 'job.superseded':'Job superseded','job.recovery_acknowledged':'Recovery acknowledged',
 'backup.enqueue':'Backup queued','backup.completed':'Backup completed','backup.failed':'Backup failed','site.storage_update':'Site storage changed','backup.pin':'Backup pin changed','backup.download':'Backup downloaded','backup.download_zip':'Backup downloaded as zip',
 'backup.scrub.enqueue':'Integrity check queued','backup.scrub.completed':'Integrity check completed','backup.scrub.failed':'Integrity check failed',
 'restore.enqueue':'Restore queued','restore.completed':'Restore completed','restore.failed':'Restore failed',
 'server.create':'Server added','server.update':'Server updated','server.details_updated':'Server details updated','server.test':'Server tested','server.connected':'Server connected','server.key_prepared':'Server key prepared',
 'site.create':'Site added','site.update':'Site updated','site.removed':'Site removed','policy.update':'Schedule updated',
 'storage.connected':'Storage connected','storage.selected':'Storage selected','storage.test':'Storage tested',
 'maintenance.design':'Maintenance page designed','maintenance.set':'Maintenance mode changed',
 'access.invitation_created':'Invitation created','access.invitation_revoked':'Invitation revoked','access.account_revoked':'Account revoked','access.universal_password_changed':'Shared password changed',
 'retention.deferred':'Retention deferred','retention.failed':'Retention failed','retention.reconciliation_pending':'Retention check pending','schedule.invalid':'Schedule invalid',
 'boot_recovery.installed':'Boot recovery installed','publication.reconciled':'Publication reconciled','publication.reconciliation_pending':'Publication check pending','publication.completed_package_review_required':'Publication needs review',
};
export function auditActionLabel(code){
 if(typeof code!=='string'||!code)return 'Unknown action';
 if(ACTIONS[code])return ACTIONS[code];
 const words=code.replace(/[._-]+/g,' ').trim();
 return words?words.charAt(0).toUpperCase()+words.slice(1):'Unknown action';
}
const SYSTEM={system:'System',worker:'Worker',scheduler:'Scheduler',administrator:'Administrator',anonymous:'Not signed in'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function auditActorLabel(actor,actors={}){
 if(!actor)return 'System';
 if(actors&&actors[actor])return actors[actor];
 if(SYSTEM[String(actor).toLowerCase()])return SYSTEM[String(actor).toLowerCase()];
 return UUID.test(actor)||actor.length>40?'Unknown user':actor;
}
