export function storageConnectionError(error,{hostRejected=false,phase='ssh'}={}){
 if(hostRejected)return 'Storage host fingerprint does not match. Verify the fingerprint for the selected SSH port before retrying.';
 if(error?.level==='client-authentication')return 'Storage authentication failed. Check the Storage Box username and its own password (not your Hetzner account password), or the authorized SSH key.';
 if(error?.code==='ENOTFOUND'||error?.code==='EAI_AGAIN')return 'Storage hostname could not be resolved. Check the hostname and try again.';
 if(error?.code==='ECONNREFUSED')return 'Storage connection was refused. Check the port and whether that service is enabled.';
 if(error?.code==='ETIMEDOUT'||error?.level==='client-timeout')return 'Storage connection timed out. Check External Reachability and network access to the selected port.';
 if(phase==='sftp')return 'SSH authentication succeeded, but SFTP could not start. Check SFTP access for this account and port.';
 return 'Storage SSH connection failed before SFTP started. Check access and SSH compatibility for the selected port.';
}
