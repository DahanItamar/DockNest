const requiredEngines=['postgres','mysql','mariadb'];
export function betaGate(evidence,{release,requireHostReboot=false}={}){
 const blockers=[];
 if(!evidence||evidence.formatVersion!==2||evidence.status!=='passed')blockers.push('Passing versioned Linux evidence is required');
 if(!/^[a-f0-9]{40}$/.test(release||'')||evidence?.release!==release)blockers.push('Evidence must match the exact deployment commit');
 const age=Date.now()-Date.parse(evidence?.at);if(!Number.isFinite(age)||age<0||age>7*86400000)blockers.push('Evidence must be less than seven days old');
 for(const engine of requiredEngines){const check=evidence?.engines?.find(item=>item.engine===engine);if(!check||!/^\d+\.\d+(?:\.\d+)?$/.test(check.version)||!/^sha256:[a-f0-9]{64}$/.test(check.imageId)||!check.digests?.some(digest=>/@sha256:[a-f0-9]{64}$/.test(digest))||!['native-version','native-clean-shutdown','isolated-data-restore','live-source-preserved'].every(name=>check.checks?.includes(name)))blockers.push('Missing native capture/restore evidence for '+engine);}
 const redis=evidence?.redis;
 if(redis?.status!=='passed'||!/^7\.4\.\d+$/.test(redis.version)||!/^sha256:[a-f0-9]{64}$/.test(redis.imageId)||!redis.digests?.some(digest=>/@sha256:[a-f0-9]{64}$/.test(digest))||!['native version','clean shutdown consistency','network-none named-key recovery','source live-change preserved','real SIGKILL rejection and source recovery'].every(check=>redis.checks?.includes(check)))blockers.push('Missing native Redis capture/restore and forced-kill evidence');
 const legacy=evidence?.legacyCompatibility;
 if(!legacy?.historicalCapture||!legacy.originalMetadataPreserved||legacy.formatVersion!==1||legacy.automaticApplicationStatus!=='not-tested'||!/^[a-f0-9]{40}$/.test(legacy.helperRevision||''))blockers.push('Real pre-M1 backup compatibility evidence is required');
 for(const required of ['M1: actual Linux nested/tmpfs mounts block before stop; NFS/CIFS mount-table policy fixtures pass','M2/M3: mixed-engine capture and isolated native data checks','M2: forced native database kill rejects consistency and recovers source','M4: Linux boot journal driver recovers native source after simulated boot identity change','M4: independent Linux root archive rejects manager-uid deletion'])if(!evidence?.milestones?.includes(required))blockers.push('Missing milestone evidence: '+required);
 if(evidence?.nodeChecks!=='passed')blockers.push('Build, upgrade, journal and independent kit checks must pass');
 if(evidence?.privacyChecks!=='passed')blockers.push('Sanitized repository and full-history secret checks must pass');
 if(evidence?.browserChecks!=='passed')blockers.push('Browser checks must pass');
 if(requireHostReboot&&evidence?.hostReboot!=='passed')blockers.push('Real source-host reboot and systemd recovery drill is required');
 return {allowed:blockers.length===0,blockers,scope:'controlled beta; matching tested versions, local source filesystems and qualified backup destinations',bootRecovery:requireHostReboot?'requires verified host reboot':'opt-in experimental; simulated-boot driver tested'};
}
