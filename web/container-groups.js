export const containerName=container=>container.name||container.Name?.replace(/^\//,'')||container.id||container.Id;
export function containerGroups(containers){
 const groups=new Map();
 for(const container of containers){
  const labels=container.labels||container.Config?.Labels||{};
  const project=labels['com.docker.compose.project'];
  if(!project){if(!groups.has('standalone:'))groups.set('standalone:',{id:'standalone:',name:'Ungrouped containers',compose:false,containers:[]});groups.get('standalone:').containers.push(container);continue;}
  if(!groups.has(project))groups.set(project,{id:'compose:'+project,name:project,compose:true,containers:[]});
  groups.get(project).containers.push({...container,service:labels['com.docker.compose.service']||''});
 }
 return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
