import {ENGINE_IDS,engineLabel} from '../shared/database-engines.js';
import {imageLooksLikeDatabase} from '../shared/database-image.js';
// The Databases block of the app settings (docs/online-dumps.md). Which engine can keep running comes from the capability
// list the API reports (state.databaseEngines, from shared/database-engines.js); nothing here names an engine as incapable.
const IMAGE_WORDS=[['mariadb','mariadb'],['mysql','mysql'],['postgres','postgres'],['redis','redis'],['valkey','redis'],['mongo','mongo']];
export const engineOfImage=image=>{
 if(!imageLooksLikeDatabase(image)&&!/(^|[/])valkey([:@]|$)/.test(String(image||'').toLowerCase()))return null;
 const name=String(image||'').toLowerCase().split('@')[0].split('/').at(-1).split(':')[0];
 return (IMAGE_WORDS.find(([word])=>name.includes(word))||IMAGE_WORDS.find(([word])=>String(image).toLowerCase().includes(word))||[])[1]||null;
};
// The databases of the selected containers: the declared engine of a saved service, else the image name.
export function detectDatabases({selected,containers=[],services=[],engines=[]}){
 const known=new Map(engines.map(item=>[item.id,item]));
 return selected.flatMap(name=>{
  const service=services.find(item=>item.container===name),container=containers.find(item=>(item.name||item.Name||'').replace(/^\//,'')===name),image=container?.image||container?.Config?.Image;
  const id=service&&service.engine!=='auto'?service.engine:engineOfImage(image);
  if(!id||!ENGINE_IDS.includes(id))return [];
  const capability=known.get(id);
  return [{container:name,engine:id,label:capability?.label||engineLabel(id),version:service?.version||'',database:service?.database||'',onlineCopy:capability?.onlineCopy===true,reason:capability?.reason||'has no online copy yet'}];
 });
}
export const rowTitle=db=>[db.label+(db.version?' '+db.version:''),db.database].filter(Boolean).join(', ');
// One row's state: 'online' (green), 'stopped' (stopped for a file copy), 'stopped-see' (it will stop, a warning below says why)
// or 'always' (the engine has no online copy, whatever the switch says).
export function rowState(db,{on,incremental=false,fallbacks=[]}){
 if(!db.onlineCopy)return 'always';
 if(!on)return 'stopped';
 return incremental||fallbacks.some(item=>item.container===db.container)?'stopped-see':'online';
}
export const rowText=(db,state)=>state==='online'?'Online copy, stays running':state==='always'?'Always stopped for a file copy. '+db.label+' '+db.reason+'.':state==='stopped-see'?'Stopped for a file copy (see below)':'Stopped for a file copy';
// The switch is off and disabled only when no detected database can take an online copy (a saved "on" can still be turned off).
export const switchDisabled=(databases,on)=>!on&&!databases.some(db=>db.onlineCopy);
export const covers=engines=>{const names=engines.filter(item=>item.onlineCopy).map(item=>item.label);return names.length>1?names.slice(0,-1).join(', ')+' and '+names.at(-1):names[0]||'no engine';};
export const reviewText=(databases,on)=>on&&databases.some(db=>db.onlineCopy)?'Online copy: the database keeps running':'Stopped for a file copy';
