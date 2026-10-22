export function storageConnectionError(error,{hostRejected=false,phase='ssh'}={}){
 if(hostRejected)return 'Storage host fingerprint does not match. Verify the fingerprint for the selected SSH port before retrying.';
 if(error?.level==='client-authentication')return 'Storage authentication failed. Check the Storage Box username and its own password (not your Hetzner account password), or the authorized SSH key.';
 if(error?.code==='ENOTFOUND'||error?.code==='EAI_AGAIN')return 'Storage hostname could not be resolved. Check the hostname and try again.';
 if(error?.code==='ECONNREFUSED')return 'Storage connection was refused. Check the port and whether that service is enabled.';
 if(error?.code==='ETIMEDOUT'||error?.level==='client-timeout')return 'Storage connection timed out. Check External Reachability and network access to the selected port.';
 if(phase==='sftp')return 'SSH authentication succeeded, but SFTP could not start. Check SFTP access for this account and port.';
 return 'Storage SSH connection failed before SFTP started. Check access and SSH compatibility for the selected port.';
}
// Problem-report classes (docs/update-center.md section 13). Returned next to today's message as `errorClass`; the
// message and status code stay as they are. Fixed lists only: anything else is `other`.
export const SFTP_ERROR_CLASSES=Object.freeze(['host-key-mismatch','auth-failed','dns','refused','timeout','sftp-start','other']);
export const S3_ERROR_CLASSES=Object.freeze(['AccessDenied','NoSuchBucket','InvalidAccessKeyId','SignatureDoesNotMatch','AuthorizationHeaderMalformed','PermanentRedirect','InvalidBucketName','ObjectLockConfigurationNotFoundError','NotImplemented','MethodNotAllowed','NotFound','SlowDown','InternalError','ServiceUnavailable','RequestTimeTooSkewed','Unreachable','other']);
export const SERVER_CHECKS=Object.freeze(['ssh','host-key','python','docker']);
export const SERVER_ERROR_CLASSES=Object.freeze(['host-key-mismatch','auth-failed','dns','refused','timeout','not-found','helper-error','other']);
// SSH transport class shared by SFTP storage and server connection tests.
export function sshErrorClass(error,{hostRejected=false}={}){
 if(hostRejected)return 'host-key-mismatch';
 if(error?.level==='client-authentication')return 'auth-failed';
 if(error?.code==='ENOTFOUND'||error?.code==='EAI_AGAIN')return 'dns';
 if(error?.code==='ECONNREFUSED')return 'refused';
 if(error?.code==='ETIMEDOUT'||error?.level==='client-timeout')return 'timeout';
 return 'other';
}
export function storageErrorClass(error,{hostRejected=false,phase='ssh'}={}){
 const ssh=sshErrorClass(error,{hostRejected});
 return ssh==='other'&&phase==='sftp'?'sftp-start':ssh;
}
export const s3ErrorClass=code=>S3_ERROR_CLASSES.includes(code)?code:'other';
// The additive JSON fields the API error handler may add: only values from the fixed lists above.
export function reportErrorFields(error){
 const out={};
 if(!error||typeof error!=='object')return out;
 if(error.s3Code!==undefined||error.s3Status!==undefined)out.errorClass=s3ErrorClass(error.s3Code);
 else if(SFTP_ERROR_CLASSES.includes(error.errorClass)||SERVER_ERROR_CLASSES.includes(error.errorClass))out.errorClass=error.errorClass;
 if(SERVER_CHECKS.includes(error.check))out.check=error.check;
 return out;
}
// Server connection test: which check failed and its class, from the error's structure only (never its text).
export function serverTestFailure(error){
 if(error?.hostKeyRejected===true)return {check:'host-key',errorClass:'host-key-mismatch'};
 if(error?.level||['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT','ECONNRESET','EHOSTUNREACH','ENETUNREACH'].includes(error?.code))return {check:'ssh',errorClass:sshErrorClass(error)};
 if(error?.exitCode===127)return {check:'python',errorClass:'not-found'};
 if(error?.remoteReported===true)return {check:'docker',errorClass:'helper-error'};
 if(Number.isInteger(error?.exitCode))return {check:'python',errorClass:'other'};
 return {check:'ssh',errorClass:'other'};
}
