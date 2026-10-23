// 2.4.1 problem reports: what the "What happened?" field of an issue may be prefilled with.
// 1. A message that EXACTLY equals a DockNest-authored constant (catalogue-data.js) is mapped through the list, so the
//    text that goes into the URL comes from the constant, never from the server string.
// 2. Any other error text is only used when the person ticks "Include the error message" (redacted, 40 lines / 2 KiB).
import {CATALOGUE} from './catalogue-data.js';
export {CATALOGUE};
// The plain explanation sentences DockNest shows above an error. They are constants too.
export const EXPLAIN=Object.freeze({
 plan:'The capture plan no longer matched the plan checked before capture.',
 redis:'The helper could not confirm a graceful Redis shutdown for this attempt.',
 sqlite:'The database health check took longer than this site allows.',
 generic:'The worker reported this error for the attempt.',
 server:'The server connection test failed.',
 storage:'The storage connection test failed.',
 selfBackup:'The DockNest backup failed.',
});
export const EXPLANATIONS=Object.freeze(Object.values(EXPLAIN));
export const catalogued=message=>(typeof message==='string'?CATALOGUE.find(entry=>entry===message)||null:null);
// "<explanation> <catalogue message>", built from the two constants, or null when the message is not in the catalogue.
export function whatHappened(message,explanation){
 const entry=catalogued(message);
 if(!entry)return null;
 const sentence=EXPLANATIONS.find(item=>item===explanation);
 return sentence?sentence+' '+entry:entry;
}
export const whatHappenedOk=value=>typeof value==='string'&&CATALOGUE.some(entry=>value===entry||EXPLANATIONS.some(sentence=>value===sentence+' '+entry));
