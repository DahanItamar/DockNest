// 2.4.1 problem reports: what the "What happened?" field of an issue may be prefilled with.
// 1. A message that EXACTLY equals a DockNest-authored constant (catalogue-data.js) is mapped through the list, so the
//    text that goes into the URL comes from the constant, never from the server string.
// 2. Any other error text is only used when the person ticks "Include the error message" (redacted, 40 lines / 2 KiB).
import {CATALOGUE} from './catalogue-data.js';
export {CATALOGUE};
// Wording used before the sites -> apps rename. Job errors stored by older versions still carry it, so it is matched too.
// It stays out of CATALOGUE: that list only holds text DockNest code still emits.
const LEGACY=Object.freeze([
 "Site already has active work or unresolved recovery",
 "Site already has active work",
 "Site already has an active job or unresolved recovery",
 "This site was removed from active sites.",
 // Self Backup was called "DockNest backup" before 2.16.5; errors stored by older versions still carry it.
 "A DockNest backup is already queued or running.",
 "DockNest backup requires the selected SFTP destination",
 "No successful DockNest backup is available yet.",
 "Set up DockNest self-backup first.",
 "Unable to read the saved DockNest backup. Check storage access and file integrity.",
 "Wait for the current DockNest backup before changing its settings.",
 "Wait for the current DockNest backup before changing the split.",
]);
// The plain explanation sentences DockNest shows above an error. They are constants too.
export const EXPLAIN=Object.freeze({
 plan:'The capture plan no longer matched the plan checked before capture.',
 redis:'The helper could not confirm a graceful Redis shutdown for this attempt.',
 sqlite:'The database health check took longer than this app allows.',
 generic:'The worker reported this error for the attempt.',
 server:'The server connection test failed.',
 storage:'The storage connection test failed.',
 selfBackup:'The Self Backup failed.',
});
export const EXPLANATIONS=Object.freeze(Object.values(EXPLAIN));
export const catalogued=message=>(typeof message==='string'?CATALOGUE.find(entry=>entry===message)||LEGACY.find(entry=>entry===message)||null:null);
// "<explanation> <catalogue message>", built from the two constants, or null when the message is not in the catalogue.
export function whatHappened(message,explanation){
 const entry=catalogued(message);
 if(!entry)return null;
 const sentence=EXPLANATIONS.find(item=>item===explanation);
 return sentence?sentence+' '+entry:entry;
}
export const whatHappenedOk=value=>typeof value==='string'&&[...CATALOGUE,...LEGACY].some(entry=>value===entry||EXPLANATIONS.some(sentence=>value===sentence+' '+entry));
