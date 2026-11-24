// One age formatter for the whole app: "Passed 3 days ago", "proven 3 days ago", "1 week ago".
// Ages for the overview: "just now", "5 minutes ago", "yesterday", "2 days ago", "1 week ago".
export function age(iso,now=Date.now()){
 const t=Date.parse(iso);if(!Number.isFinite(t))return '';
 const s=Math.max(0,(now-t)/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);
 const n=(v,w)=>v+' '+w+(v===1?'':'s')+' ago';
 if(m<1)return 'just now';
 if(m<60)return n(m,'minute');
 if(h<24)return n(h,'hour');
 if(d===1)return 'yesterday';
 if(d<7)return n(d,'day');
 if(d<30)return n(Math.floor(d/7),'week');
 if(d<365)return n(Math.floor(d/30),'month');
 return n(Math.floor(d/365),'year');
}
