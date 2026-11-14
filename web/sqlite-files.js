// SQLite file lists per Docker service: grouping for the site form, merging edits back into config.services, and the
// helper messages the failed-backup view recognises. Only sqliteFiles is ever changed; sqliteVersion,
// sqliteSigtermConfirmed and engine stay as saved.

export const pathLines=text=>String(text||'').split('\n').map(line=>line.trim()).filter(Boolean);

// One group per service, except services with identical non-empty lists, which form one shared group.
export function sqliteGroups(services){
 const list=Array.isArray(services)?services:[],used=new Set(),groups=[];
 for(const service of list){
  if(used.has(service.container))continue;
  const files=Array.isArray(service.sqliteFiles)?service.sqliteFiles:[],key=JSON.stringify(files);
  const twins=files.length?list.filter(other=>!used.has(other.container)&&JSON.stringify(other.sqliteFiles||[])===key):[service];
  twins.forEach(other=>used.add(other.container));
  groups.push({key:twins.map(item=>item.container).join('|'),containers:twins.map(item=>item.container),files,version:service.sqliteVersion||'',shared:twins.length>1});
 }
 return groups;
}

// Returns an error sentence, or '' when every edited list can be saved. texts: {container: textarea text}.
export function sqliteProblem(services,texts){
 for(const service of Array.isArray(services)?services:[]){
  if(!(service.container in texts))continue;
  const paths=pathLines(texts[service.container]);
  // A saved list the person did not touch is never judged here.
  if(JSON.stringify(paths)===JSON.stringify(service.sqliteFiles||[]))continue;
  if(paths.some(path=>!/^\/[a-zA-Z0-9_./-]+$/.test(path)||path.split('/').includes('..')||path.startsWith('//')))return service.container+': use absolute paths with letters, numbers and . _ - /, one per line.';
  if(new Set(paths).size!==paths.length)return service.container+': a file is listed twice.';
  if(paths.length>30)return service.container+': list up to 30 files.';
  if(!paths.length&&service.sqliteSigtermConfirmed)return service.container+': its SIGTERM confirmation needs at least one SQLite file. Keep at least one file.';
 }
 return '';
}

// Merges edited lists into the saved services. Untouched services keep every field.
export function mergeSqliteFiles(services,texts){
 if(!Array.isArray(services))return services;
 return services.map(service=>service.container in texts?{...service,sqliteFiles:pathLines(texts[service.container])}:service);
}

export function removeSqlitePath(services,path){
 const hits=[];
 const next=(Array.isArray(services)?services:[]).map(service=>{
  if(!Array.isArray(service.sqliteFiles)||!service.sqliteFiles.includes(path))return service;
  hits.push(service.container);
  return {...service,sqliteFiles:service.sqliteFiles.filter(file=>file!==path)};
 });
 return {services:next,containers:hits};
}

// Helper messages (remote/helper/databases.py). Kinds: missing, link; the old message has no path.
export function sqliteFailure(error){
 const text=String(error||'');
 let match=text.match(/SQLite database file is missing or not a regular file: (\/[^\s]+)/);
 if(match)return {kind:'missing',path:match[1]};
 match=text.match(/SQLite database path contains a symbolic link: (\/[^\s]+)/);
 if(match)return {kind:'link',path:match[1]};
 if(/SQLite database path is unreadable or contains a symbolic link/.test(text))return {kind:'legacy',path:null};
 return null;
}
