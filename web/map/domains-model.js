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
  if(r==='no-route')return out(`No proxy on ${srv} has this domain.`,{reason:`Visitors reach ${srv}, but nothing there sends this domain to ${siteName}.`,next:`Add the domain to the proxy on ${srv} and send it to ${siteName}, then check again.`});
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
// What the Map's layout needs: where each domain sits (the server its DNS answers with), and why it has none.
export function layoutDomains(view,serverIds){
 const g=view?.groups||{},place={};
 for(const [id,list] of Object.entries(g.servers||{}))for(const d of list)place[d]=id;
 const nowhere=new Set(g.pointsNowhere||[]);
 return (view?.domains||[]).map(r=>({id:r.domain,serverId:nowhere.has(r.domain)?null:serverIds.has(place[r.domain])?place[r.domain]:null,loose:nowhere.has(r.domain)?'nowhere':'unplaced'}));
}
// Line classes by the worst step: st-ok, st-wn, st-er, st-nc (not checked, dashed).
export const lineState=s=>({success:'ok','needs-review':'wn',failed:'er',queued:'nc',running:'nc'}[s]||'nc');
// Move review (A13): the API sends the domain warnings with id "domains". Each gets its own amber note, apart from the joined warnings.
export const isDomainWarning=w=>w?.id==='domains'&&!w.advanced;
