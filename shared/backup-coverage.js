// One container, or one static website folder, belongs to one app. Discovery leaves out what active apps on a server
// already back up and the API refuses a second app for it. Sites are {id,name,serverId,config}, active ones only.
const unique=owners=>[...new Map(owners.map(owner=>[owner.siteId,owner])).values()];
const plural=(count,one,many)=>count===1?one:many;

// What the apps on one server back up, by container name and by static website folder. An app being edited does not
// count against itself, and what it already had on this server (keep: its saved config) stays free for it, so an install
// whose apps already overlap stays editable. Each container has one owner: when older apps share one, the last listed.
export function coverageIndex(sites,serverId,{exceptSiteId,keep}={}){
 const containers=new Map(),roots=new Map(),kept=new Set(keep?.containers||[]);
 for(const site of sites){
  if(site.serverId!==serverId||site.id===exceptSiteId)continue;
  const owner={siteId:site.id,name:site.name};
  for(const name of site.config?.containers||[])if(!kept.has(name))containers.set(name,owner);
  if(site.config?.kind==='static'&&site.config.documentRoot&&site.config.documentRoot!==keep?.documentRoot)roots.set(site.config.documentRoot,owner);
 }
 return {containers,roots};
}

// Containers split into the ones still free and the ones other apps cover, with those apps.
export function splitGroup(containers,index,nameOf=name=>name){
 const free=[],covered=[];
 for(const container of containers)(index.containers.has(nameOf(container))?covered:free).push(container);
 return {free,covered,owners:unique(covered.map(container=>index.containers.get(nameOf(container))))};
}

// Discovered choices ({kind,documentRoot,containers}) minus what is covered: a choice with nothing free is hidden, a
// partly covered one keeps its free containers and lists the rest under covered.
export function availableChoices(choices,index,nameOf){
 const shown=[],hidden=[];
 for(const choice of choices){
  if(choice.kind==='static'){const owner=index.roots.get(choice.documentRoot);if(owner)hidden.push({...choice,owners:[owner]});else shown.push(choice);continue;}
  const {free,covered,owners}=splitGroup(choice.containers,index,nameOf),next={...choice,containers:free,covered,owners};
  (free.length?shown:hidden).push(next);
 }
 return {shown,hidden};
}

// What a configuration would take from other apps.
export function overlaps(config,index){
 const {covered,owners}=splitGroup(config.containers||[],index);
 const root=config.kind==='static'&&index.roots.get(config.documentRoot);
 return root?{items:[...covered,config.documentRoot],owners:unique([...owners,root])}:{items:covered,owners};
}

export const ownerNames=owners=>owners.map(owner=>owner.name).join(', ');
export const hiddenOwners=hidden=>unique(hidden.flatMap(choice=>choice.owners));
export const overlapMessage=({items,owners})=>`${items.join(', ')} ${plural(items.length,'is','are')} already backed up in ${ownerNames(owners)}. Edit ${plural(owners.length,'that app','those apps')} instead.`;
export const coveredCaption=({covered,owners})=>`${covered.length} more ${plural(covered.length,'service','services')} already backed up in ${ownerNames(owners)}`;
export function hiddenCaption(hidden){
 const owners=hiddenOwners(hidden),shown=owners.slice(0,3),more=owners.length-shown.length;
 return `Hidden because other apps already back them up: ${ownerNames(shown)}${more?` and ${more} more`:''}.`;
}
