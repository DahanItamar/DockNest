// The only place that knows the Connections and alert node API (docs/alert-channels.md, "API"). `api` is the app's fetch
// helper: api(path, body, method). Secrets go out once, in a create or a replace; views never carry them back, only
// `<key>Set` flags, so nothing here ever holds a saved secret.
export function createConnectionsClient(api){
 const id=x=>encodeURIComponent(x);
 return {
  list:()=>api('/connections'),
  providers:()=>api('/connections/providers'),
  create:body=>api('/connections',body),
  update:(connectionId,body)=>api('/connections/'+id(connectionId),body,'PATCH'),
  remove:connectionId=>api('/connections/'+id(connectionId),undefined,'DELETE'),
  test:connectionId=>api('/connections/'+id(connectionId)+'/test',{}),
  testValues:body=>api('/connections/test',body),
  settings:body=>api('/connections/settings',body,'PUT'),
  // Same check as the Update Center and the move flow (POST /api/auth/reauth)
  reauth:(password,code)=>api('/auth/reauth',{password,code})
 };
}

// "2 min ago", "1 hour ago", "yesterday", "3 days ago", then the date.
export function ago(value,now=Date.now()){
 const at=Date.parse(value);if(!Number.isFinite(at))return '';
 const s=Math.max(0,Math.round((now-at)/1000));
 if(s<60)return 'just now';
 const m=Math.round(s/60);if(m<60)return m+' min ago';
 const h=Math.round(m/60);if(h<24)return h===1?'1 hour ago':h+' hours ago';
 const d=Math.round(h/24);if(d===1)return 'yesterday';if(d<30)return d+' days ago';
 return new Date(at).toLocaleDateString([],{day:'numeric',month:'short',year:'numeric'});
}

// The "Last test" cell: Delivered (Accepted for WhatsApp and Teams, which only learn the service took it), Failed or
// Not tested, plus what still needs doing for a Connection the upgrade could not complete.
export function testState(connection,provider){
 const v=connection.values||{};
 if(connection.secretReadable===false)return {state:'needs-review',text:'Enter the login again'};
 if(connection.provider==='telegram'&&!v.chatId)return {state:'needs-review',text:'Add the chat ID'};
 if(connection.provider==='email'&&!(v.to||[]).length)return {state:'needs-review',text:'Add recipients'};
 if(connection.lastTest==='ok')return {state:'success',text:(provider?.testNote?'Accepted':'Delivered')+' · '+ago(connection.lastTestAt)};
 if(connection.lastTest==='failed')return {state:'failed',text:'Failed · '+ago(connection.lastTestAt)};
 return {state:'queued',text:'Not tested'};
}
export const usedByText=connection=>(connection.usedBy||[]).length?connection.usedBy.map(n=>n.name).join(', '):'Not used';
// The table shows the first node and a count; the full list goes in the title.
export const usedByShort=connection=>{const n=(connection.usedBy||[]).map(x=>x.name);return n.length>1?`${n[0]} and ${n.length-1} more`:n[0]||'Not used'};
export const GROUPS={common:'Popular',advanced:'Advanced'};
// The template languages people use most; anything else is "Add custom".
export const LANGUAGES=[['en','English (en)'],['en_US','English, US (en_US)'],['en_GB','English, UK (en_GB)'],['es','Spanish (es)'],['pt_BR','Portuguese, Brazil (pt_BR)'],['de','German (de)'],['fr','French (fr)'],['it','Italian (it)'],['nl','Dutch (nl)'],['he','Hebrew (he)'],['ar','Arabic (ar)'],['hi','Hindi (hi)'],['id','Indonesian (id)'],['tr','Turkish (tr)']];
export const SECURITY=[['starttls','STARTTLS (usually port 587)'],['tls','TLS (usually port 465)']];
