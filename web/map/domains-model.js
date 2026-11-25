// What the Map shows for a domain (docs/domains.md). Pure: GET /api/domains rows in, plain sentences and states out.
// The API sends one state per step (ok, warn, fail, unknown), a reason code and safe parameters; the wording lives here.
export const HOP_ORDER=['dns','proxy','app','certificate'];
export const HOP_NAME={domain:'Domain',dns:'DNS',proxy:'Proxy',app:'App',certificate:'Certificate'};
const STATE={ok:'success',warn:'needs-review',fail:'failed',unknown:'queued'};
const RANK={failed:3,'needs-review':2,success:1,queued:0};
export const WORD={success:'OK','needs-review':'Needs review',failed:'Failed',queued:'Not checked',running:'Checking…'};
const PROXY={nginx:'nginx',npm:'Nginx Proxy Manager',caddy:'Caddy',traefik:'Traefik'};
const proxyName=v=>PROXY[v]||(typeof v==='string'&&v?v:'The proxy');
const WHEN=new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:'numeric'});
const day=v=>{const d=new Date(v);return isNaN(d)?'':WHEN.format(d)};

// "3 hours ago, during a backup". Old results keep their time and are never refreshed in the background.
const TRIGGER={manual:'when you checked',discover:'during a scan',readiness:'during a readiness check',backup:'during a backup',move:'before a move preview'};
export function checkedText(row,now=Date.now()){
 if(!row?.checkedAt)return '';
 const ms=now-Date.parse(row.checkedAt),m=Math.max(0,Math.round(ms/60000));
 const h=Math.round(m/60),ago=m<1?'just now':m<60?m+(m===1?' minute':' minutes')+' ago':m<48*60?h+(h===1?' hour':' hours')+' ago':Math.round(m/1440)+' days ago';
 return 'Checked '+ago+(TRIGGER[row.trigger]?', '+TRIGGER[row.trigger]:'');
}

// The sentence for one step: { state (the app's status word), detail, reason, next, link ('connections' | null) }.
export function hopText(name,hop,ctx={}){
 const {serverName=()=>'the server',siteName='the app'}=ctx;
 const p=hop?.params||{},srv=serverName(p.serverId??ctx.serverId),state=STATE[hop?.state]||'queued',r=hop?.reason;
 const out=(detail,extra={})=>({state,detail,reason:'',next:'',link:null,...extra});
 if(!hop)return {state:'queued',detail:'Not checked yet',reason:'',next:'',link:null};
 if(r==='not-checked')return out('Not checked yet');
 if(r==='skipped')return out('Not checked, because an earlier step failed.');
 if(name==='dns'){
  const at=p.address||(p.addresses||[])[0]||'';
  if(r==='points-to-server')return out(`${(p.addresses||[]).join(', ')} (${srv}), the same on both public resolvers.`);
  if(r==='cloudflare-origin')return out(`Behind Cloudflare’s proxy. The record in Cloudflare points to ${p.address} (${srv}).`);
  if(r==='no-record')return out('No DNS record found.',{reason:'Neither public resolver has an A or AAAA record for this domain.',next:'Add an A record at your DNS provider that points to the address of your server, then check again.'});
  if(r==='wrong-record')return out(`The record points to ${at}.`,{reason:`${at} is not the address of any server connected to DockNest, so visitors do not reach your app.`,next:'Change the A record at your DNS provider to the address of the server that runs this app, then check again.'});
  if(r==='cloudflare-proxied')return out('Behind Cloudflare’s proxy.',{reason:'Public DNS shows Cloudflare’s addresses, so DockNest cannot see where the record really points.',next:'Save a Cloudflare token in Connections so DockNest can read the record.',link:'connections'});
  if(r==='cloudflare-token-expired')return out('Behind Cloudflare’s proxy.',{reason:'The saved Cloudflare token has expired, so DockNest cannot read the record.',next:'Create a new token in Cloudflare and save it again in Connections.',link:'connections'});
  if(r==='cloudflare-token-limited')return out('Behind Cloudflare’s proxy.',{reason:'The saved Cloudflare token cannot read DNS records'+((p.missing||[]).length?' (it lacks '+p.missing.join(', ')+')':'')+'.',next:'Create a token that can read DNS records in Cloudflare and save it again in Connections.',link:'connections'});
  if(r==='cgnat')return out(`DNS names ${at}, which is not one of your servers.`,{reason:`${srv} has only private addresses, so it may sit behind your internet provider’s shared address (CGNAT) or a home router. DockNest cannot tell.`,next:'If visitors should reach it from the internet, forward ports 80 and 443 to the server or use a tunnel. If you use Tailscale, this is expected.'});
  if(r==='dns-unreachable')return out('Not checked, no public DNS resolver answered.',{next:'Check again in a minute.'});
 }
 if(name==='proxy'){
  const px=proxyName(p.proxy),up=p.upstream||'';
  if(r==='routed')return out(`${px} on ${srv} sends it to ${up}${p.appServerId?` on ${serverName(p.appServerId)}`:''}.`);
  if(r==='static')return out(`${px} on ${srv} serves this static site.`);
  if(r==='static-no-app')return out(`${px} on ${srv} serves it as a static site${p.root?` from ${p.root}`:''}.`,{next:'Add it as a static app to back it up.',link:'add-static'});
  if(r==='tunnel')return out('Through Cloudflare Tunnel.',{reason:`A cloudflared container runs on ${srv}, so visitors can reach the app through the tunnel without a proxy rule.`});
  if(r==='no-route')return out(`No proxy on ${srv} has this domain.`,{reason:`No proxy rule on ${srv} routes this domain to the app “${siteName}”.`,next:'Add a proxy rule for this domain that points to the app’s container, then check again.'});
  if(r==='routes-elsewhere')return out(`${px} on ${srv} sends it to ${up||'another target'}.`,{reason:`That target is not a container of ${siteName}.`,next:`Change the route to the port ${siteName} publishes, then check again.`});
  if(r==='proxy-stopped')return out(`${px} on ${srv} has the route, but it is not running.`,{next:`Start ${px} on ${srv}, then check again.`});
  if(r==='no-app')return out(`${px} on ${srv} sends it to ${up||'something'}, which is not one of your apps.`,{next:'If that is an app you want to back up, add it to DockNest.'});
  if(r==='route-unknown')return out(`${px==='The proxy'?'DockNest':px} could not show every route on ${srv}.`,{reason:'A container could not be read, or a Traefik rule is not one DockNest understands, so a route may exist that is not listed.',next:'Check again. If this stays, test the server connection.'});
  if(r==='incomplete')return out(`${px} on ${srv} sends it to ${up||'the app'}.`,{reason:'This list may be incomplete: some containers on the server could not be read.',next:'Check again. If this stays, test the server connection.'});
 }
 if(name==='app'){
  const c=p.container||'a container';
  if(r==='running')return out(`${siteName}, its containers are running.`);
  if(r==='static')return out(`${siteName}, static files served by nginx.`);
  if(r==='no-app')return out('No app of yours serves this domain.',{next:'Add the app to DockNest, or remove the route.'});
  if(r==='stopped')return out(`${siteName}, container ${c} is stopped.`,{next:`Start ${c} on ${srv}, then check again.`});
  if(r==='unhealthy')return out(`${siteName}, container ${c} is unhealthy.`,{next:`Look at the logs of ${c} on ${srv}, then check again.`});
  if(r==='missing')return out(`${siteName}, container ${c} does not exist on ${srv}.`,{next:'Start the app again, or edit the app in DockNest to match.'});
  if(r==='starting')return out(`${siteName}, container ${c} is still starting.`,{next:'Check again in a minute.'});
 }
 if(name==='certificate'){
  const until=p.notAfter?day(p.notAfter):'';
  if(r==='valid')return out(`${p.name||'Certificate'}, valid until ${until}.`);
  if(r==='expires-soon')return out(`${p.name||'Certificate'} expires on ${until}, in ${p.days} ${p.days===1?'day':'days'}.`,{next:'Certbot renews it on its own. If it does not, run certbot renew on the server.'});
  if(r==='expired')return out(`${p.name||'Certificate'} expired on ${until}.`,{reason:'Browsers warn visitors about this domain.',next:`Run certbot renew on ${srv}, then check again.`});
  if(r==='not-covered')return out(`The certificate ${p.name||''} does not cover this domain.`,{next:'Get a certificate that includes this domain, then check again.'});
  if(r==='no-certificate')return out('No certificate found for this domain.',{next:'Get one with certbot on the server, then check again.'});
  if(r==='renewal-port80')return out(`${p.name||'Certificate'}, valid until ${until}, renewal failed.`,{reason:`Renewal failed: port 80 is closed on ${srv}, so Let’s Encrypt could not reach it.`,next:'Open port 80 in the firewall, then check again.'});
  if(r==='renewal-dns')return out(`${p.name||'Certificate'}, valid until ${until}, renewal failed.`,{reason:'Renewal failed because of a DNS problem: Let’s Encrypt could not find this domain.',next:'Fix the DNS record above, then check again.'});
  if(r==='renewal-rate-limited')return out(`${p.name||'Certificate'}, valid until ${until}, renewal failed.`,{reason:'Let’s Encrypt refused because there were too many requests.',next:'Wait a day, then run certbot renew on the server.'});
  if(r==='renewal-failed')return out(`${p.name||'Certificate'}, valid until ${until}, renewal failed.`,{reason:'Certbot could not renew it.',next:`Run certbot renew on ${srv} and read its message.`});
  if(r==='managed-by-proxy')return out(`${proxyName(p.proxy)} keeps its own certificates, so DockNest does not read them.`);
  if(r==='not-readable')return out('DockNest could not read the certificate on the server.',{reason:p.name?`The configured file ${p.name} is not a certbot certificate.`:'',next:''});
 }
 return out(state==='success'?'OK':'Needs a look.');
}

// One entry per step for the path panel: the Domain row first, then the four steps.
export function pathRows(row,ctx={}){
 const domain={k:'domain',state:'success',detail:ctx.siteName&&row.siteId?`Part of ${ctx.siteName}.`:row.domain,reason:'',next:'',link:null};
 const never=!row.hops;
 return [domain,...HOP_ORDER.map(k=>({k,...hopText(k,never?null:row.hops[k],{...ctx,serverId:row.serverId})}))];
}
// The status of the whole domain: its worst step (a step that was not checked does not count), "Not checked" when never checked.
export function domainStatus(row,{checking=false,error=''}={}){
 if(checking)return 'running';
 if(!row?.hops)return 'queued';
 let worst='queued';
 for(const k of HOP_ORDER){const s=STATE[row.hops[k]?.state]||'queued';if(RANK[s]>RANK[worst])worst=s}
 if(error&&RANK[worst]<RANK['needs-review'])worst='needs-review';
 return worst;
}
// Registrable domain (the name someone buys): the last two labels, or three under a common two-part public suffix.
// This is a short list on purpose (no network, no big table); a suffix that is missing only means a subdomain of it is drawn
// straight to the server, as before. Documented in docs/domains.md.
const SUFFIX2=new Set(['co.il','org.il','net.il','ac.il','gov.il','muni.il','co.uk','org.uk','ac.uk','gov.uk','me.uk','ltd.uk','plc.uk','com.au','net.au','org.au','edu.au','gov.au','co.nz','org.nz','net.nz','co.za','org.za','co.jp','ne.jp','or.jp','co.in','net.in','org.in','com.br','net.br','org.br','com.mx','com.ar','com.tr','com.cn','net.cn','org.cn','com.hk','com.sg','com.tw','co.kr','co.id','com.ua','com.pl','com.es']);
export function registrableOf(name){
 const labels=String(name||'').toLowerCase().split('.').filter(Boolean);
 if(labels.length<=2)return labels.join('.');
 return labels.slice(-(SUFFIX2.has(labels.slice(-2).join('.'))?3:2)).join('.');
}
// Apps that own a domain: the apps that list it, plus the app the API routed it to. Zero (no app), one, or several.
export function ownersOf(name,rows,sites=[]){
 const ids=new Set(sites.filter(site=>(Array.isArray(site?.config?.domains)?site.config.domains:[]).includes(name)).map(site=>site.id));
 const row=(Array.isArray(rows)?rows.find(r=>r.domain===name):rows?.[name]);
 if(row?.siteId&&sites.some(site=>site.id===row.siteId))ids.add(row.siteId);
 return [...ids].sort();
}
const labelsOf=name=>String(name||'').toLowerCase().split('.').filter(Boolean);
// One node per name people think of as one domain. "www.x" is an alias of "x" when both are on the Map and the same app owns both
// (ownerKey), so the www name is shown inside the node and moves with it; a www name of another app stays its own node.
// Returns {nodes:[{id,aliases:[],names:[]}], nodeOf:{name:nodeId}} in the order of the rows.
export function groupDomains(rows=[],ownerKey=()=>''){
 const names=new Set(rows.map(r=>r.domain)),nodeOf={},nodes=[],byId={};
 for(const r of rows){
  const d=r.domain,root=d.startsWith('www.')&&names.has(d.slice(4))&&ownerKey(d)===ownerKey(d.slice(4))?d.slice(4):d;
  nodeOf[d]=root;
  if(root===d){const n={id:d,aliases:[],names:[d]};nodes.push(n);byId[d]=n}
 }
 for(const r of rows){const d=r.domain,root=nodeOf[d];if(root!==d){byId[root].aliases.push(d);byId[root].names.push(d)}}
 const parentOf={};
 for(const n of nodes){const t=treeParent(n.id,byId,()=>true);if(t.parent)parentOf[n.id]=t.parent}
 return {nodes,parentOf,nodeOf};
}
// The parent of a name on the Map: the nearest ancestor that is a node and passes sameSide(ancestor), never going above the registrable
// domain (so a public suffix such as co.il is never a parent). partOf: the nearest ancestor that is on the Map but on another side.
export function treeParent(id,byId,sameSide){
 const need=labelsOf(registrableOf(id)).length;let labels=labelsOf(id),partOf=null;
 while(labels.length>need){
  labels=labels.slice(1);const c=labels.join('.');
  if(labels.length<need)break;
  if(byId[c]){if(sameSide(c))return {parent:c,partOf:null};partOf=partOf||c}
 }
 return {parent:null,partOf};
}
// The status of a merged node: the worst of its names.
export function groupStatus(names,rowOf,statusOf){
 let worst='queued';
 for(const n of names){const r=rowOf[n];if(!r)continue;const s=statusOf(r);if(s==='running')return s;if(RANK[s]>RANK[worst])worst=s}
 return worst;
}
// What the Map's layout needs: one entry per node (aliases merged), where it sits and its parent node.
// Where: the server its DNS answers with; while its app is moving, the server the app moves to (pending, dashed); once the app has moved, the
// app's own server. A domain with no app, or several apps, is always placed by DNS. The parent is the nearest ancestor on the SAME server
// (so a line never crosses to another server's domain); an ancestor on another server only gives a quiet "part of" caption.
// ctx: {sites:[], pending:{siteId:targetServerId}, done:Set(siteIds)}
export function layoutDomains(view,serverIds,ctx={}){
 const g=view?.groups||{},place={},rows=view?.domains||[],sites=ctx.sites||[],pending=ctx.pending||{},done=ctx.done||new Set();
 for(const [id,list] of Object.entries(g.servers||{}))for(const d of list)place[d]=id;
 const nowhere=new Set(g.pointsNowhere||[]),ownerKey=d=>ownersOf(d,rows,sites).join(','),grouped=groupDomains(rows,ownerKey);
 const placed=grouped.nodes.map(n=>{
  const owners=ownersOf(n.id,rows,sites),site=owners.length===1?sites.find(x=>x.id===owners[0]):null;
  let serverId=nowhere.has(n.id)?null:serverIds.has(place[n.id])?place[n.id]:null,moving=false;
  if(serverId&&site){
   if(pending[site.id]&&serverIds.has(pending[site.id])&&pending[site.id]!==serverId){serverId=pending[site.id];moving=true}
   else if(done.has(site.id)&&serverIds.has(site.serverId))serverId=site.serverId;
  }
  const loose=nowhere.has(n.id)?'nowhere':'unplaced';
  return {id:n.id,aliases:n.aliases,serverId,loose,pending:moving,ownerSiteId:site?site.id:null,side:serverId||'loose:'+loose};
 });
 const byId=Object.fromEntries(placed.map(d=>[d.id,d]));
 return placed.map(d=>{const t=treeParent(d.id,byId,c=>byId[c].side===d.side&&byId[c].pending===d.pending);return {id:d.id,aliases:d.aliases,parentId:t.parent,partOf:t.partOf,serverId:d.serverId,loose:d.loose,pending:d.pending,ownerSiteId:d.ownerSiteId}});
}
// Line classes by the worst step: st-ok, st-wn, st-er, st-nc (not checked, dashed).
export const lineState=s=>({success:'ok','needs-review':'wn',failed:'er',queued:'nc',running:'nc'}[s]||'nc');
// Move review (A13): the API sends the domain warnings with id "domains". Each gets its own amber note, apart from the joined warnings.
export const isDomainWarning=w=>w?.id==='domains'&&!w.advanced;
