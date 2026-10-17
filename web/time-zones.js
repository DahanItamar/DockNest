// Common time zones that cover most hosting locations. A saved zone outside the
// list stays selectable so existing schedules keep working.
export const COMMON_TIME_ZONES=['UTC','Pacific/Honolulu','America/Anchorage','America/Los_Angeles','America/Denver','America/Chicago','America/Mexico_City','America/New_York','America/Toronto','America/Sao_Paulo','America/Argentina/Buenos_Aires','Atlantic/Azores','Europe/London','Europe/Lisbon','Africa/Lagos','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Rome','Europe/Amsterdam','Africa/Cairo','Africa/Johannesburg','Europe/Athens','Europe/Kyiv','Asia/Jerusalem','Europe/Istanbul','Europe/Moscow','Asia/Dubai','Asia/Kolkata','Asia/Bangkok','Asia/Singapore','Asia/Shanghai','Asia/Hong_Kong','Asia/Tokyo','Asia/Seoul','Australia/Perth','Australia/Sydney','Pacific/Auckland'];
function offset(zone){
 try{
  const name=new Intl.DateTimeFormat('en-US',{timeZone:zone,timeZoneName:'longOffset'}).formatToParts(new Date()).find(part=>part.type==='timeZoneName')?.value||'GMT';
  const match=name.match(/GMT([+-]\d{2}):?(\d{2})?/);if(!match)return {text:'UTC+00:00',minutes:0};
  return {text:`UTC${match[1]}:${match[2]||'00'}`,minutes:(match[1][0]==='-'?-1:1)*(Math.abs(Number.parseInt(match[1],10))*60+Number.parseInt(match[2]||'0',10))};
 }catch{return null;}
}
// [value,label] pairs sorted by current UTC offset, e.g. ['Asia/Jerusalem','Jerusalem (UTC+03:00)'].
export function timeZoneOptions(current){
 return [...new Set([...COMMON_TIME_ZONES,current].filter(Boolean))].map(zone=>({zone,offset:offset(zone)})).filter(item=>item.offset)
  .sort((a,b)=>a.offset.minutes-b.offset.minutes||a.zone.localeCompare(b.zone))
  .map(({zone,offset:o})=>[zone,`${zone==='UTC'?'UTC':zone.split('/').pop().replace(/_/g,' ')} (${o.text})`]);
}
