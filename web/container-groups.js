export const containerName=container=>container.name||container.Name?.replace(/^\//,'')||container.id||container.Id;
export function containerGroups(containers){
 const groups=new Map();
 for(const container of containers){
  const labels={...container.Config?.Labels,...container.Labels,...container.labels};
  const project=labels['com.docker.compose.project'];
  const stack=labels['com.docker.stack.namespace'];
  const kind=project?'compose':stack?'swarm':'standalone';
  const name=project||stack||'Ungrouped containers';
  const id=kind+':'+(project||stack||'');
  if(!groups.has(id))groups.set(id,{id,name,kind,compose:kind==='compose',containers:[]});
  groups.get(id).containers.push({...container,service:labels['com.docker.compose.service']||labels['com.docker.swarm.service.name']||''});
 }
 return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
