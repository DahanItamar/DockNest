import {containerName} from './container-groups.js';
export const containerLabels=container=>({...container.Config?.Labels,...container.Labels,...container.labels});
const safePath=path=>typeof path==='string'&&/^\/[a-zA-Z0-9_./-]+$/.test(path)&&!path.split('/').includes('..');
export function detectedConfiguration(containers,names){
 const selected=containers.filter(container=>names.includes(containerName(container)));
 const unique=values=>[...new Set(values.filter(safePath))];
 return {
  compose: selected.some(container=>containerLabels(container)['com.docker.compose.project']),
  composeFiles:unique(selected.flatMap(container=>container.backupConfiguration?.composeFiles||String(containerLabels(container)['com.docker.compose.project.config_files']||'').split(',').map(value=>value.trim()))),
  configFiles:unique(selected.flatMap(container=>container.backupConfiguration?.configFiles||[])),
  directory:selected.map(container=>container.backupConfiguration?.directory||containerLabels(container)['com.docker.compose.project.working_dir']).find(safePath)||'',
 };
}
