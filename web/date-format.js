// Presentation only: keep API timestamps and storage paths in their original formats.
export function formatDate(value,{shortTime=false,dateOnly=false,utc=false}={}){
 if(!value)return '—';
 const date=new Date(value);if(Number.isNaN(date.getTime()))return '—';
 const read=part=>date[(utc?'getUTC':'get')+part]();
 const calendar=[String(read('Date')).padStart(2,'0'),String(read('Month')+1).padStart(2,'0'),read('FullYear')].join('/');
 return dateOnly?calendar:calendar+' | '+date.toLocaleTimeString(undefined,shortTime?{hour:'2-digit',minute:'2-digit'}:undefined);
}
