// Linked apps for the UI (docs/linked-apps.md). Pure helpers over servers[].appLinks from /api/state; nothing here
// changes or starts anything.
import {linksOfApp} from '../../shared/app-links.js';
import {plural} from '../plural.js';

const NO_LINKS={links:[],unowned:[],hubs:[]};

export const appLinksOf=(servers,site)=>servers.find(server=>server.id===site?.serverId)?.appLinks||null;
export const linksOf=(servers,site)=>site?linksOfApp(appLinksOf(servers,site),site.id):NO_LINKS;

// Every pair of linked apps on every server, for the Map lines. Hubs are never drawn.
export const linkPairs=servers=>servers.flatMap(server=>(server.appLinks?.links||[]).map(({appIds:[a,b],kind})=>({id:a+'~'+b,a,b,kind})));

// not scanned yet | damaged stored data | partial scan | complete scan
export function scanState(appLinks){
 if(!appLinks)return 'never';
 if(!appLinks.checkedAt)return appLinks.partial?'damaged':'never';
 return appLinks.partial?'partial':'ok';
}

const folderOrVolume=via=>via.startsWith('/')?'folder':'volume';
export function reasonOf({kind,via},otherName){
 if(kind==='volume')return `Shares the ${folderOrVolume(via)} ${via} with ${otherName}`;
 if(kind==='database')return `Shares the database ${via} with ${otherName}`;
 if(kind==='link')return `Connected to ${otherName} through ${via}`;
 return `On the network ${via} with ${otherName}`;
}
export const hubLine=({network,appIds})=>{const others=appIds.length-1;return `On the shared network ${network} with ${others} other ${plural(others,'app')}`};
export const unownedLine=({container})=>`Uses ${container}, which no app backs up`;

const list=names=>names.length<3?names.join(' and '):names.slice(0,-1).join(', ')+' and '+names[names.length-1];
// The phone list caption: "Linked to Shop and Wiki", or '' when the app has no links.
export function linkSummary(links,nameOf){
 const names=links.map(link=>nameOf(link.otherAppId)).filter(Boolean);
 return names.length?'Linked to '+list(names):'';
}

const ENDING={
 backup:{link:', so back up both to keep the copies matching.',unowned:', so its data is not in this copy.'},
 move:{link:', so moving only one can break it.',unowned:', so it stays behind when this app moves.'},
 restore:{link:', so the test copy may not work without it.',unowned:', so the test copy may not work without it.'},
};
const tie=({kind,via})=>kind==='volume'?`shares the ${folderOrVolume(via)} ${via} with`:kind==='database'?`shares the database ${via} with`:`is connected through ${via} to`;
// One plain sentence per risk, only for links that warn and for containers no app backs up:
// {id, before, app: {id,name}|null, after}. The app is shown as a text link to its page.
export function warningsFor(appLinks,site,nameOf,action){
 const {links,unowned}=linksOfApp(appLinks,site.id),end=ENDING[action];
 return [
  ...links.filter(link=>link.warns).map(link=>({id:link.appIds.join('~'),before:`${site.name} ${tie(link)} `,app:{id:link.otherAppId,name:nameOf(link.otherAppId)},after:end.link})),
  ...unowned.map(entry=>({id:'unowned:'+entry.container,before:`${site.name} uses ${entry.container}, which no app backs up`,app:null,after:end.unowned})),
 ].filter(item=>!item.app||item.app.name);
}
