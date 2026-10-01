export const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export function readSchedule(expression='0 2 * * *'){
 const fields=expression.trim().split(/\s+/);
 const [minute,hour,day,month,weekday]=fields;
 const numeric=(value,max)=>/^\d{1,2}$/.test(value)&&Number(value)<=max;
 const base={frequency:'custom',hour:'2',minute:'0',weekday:'1',custom:expression};
 if(fields.length!==5||!numeric(minute,59)||day!=='*'||month!=='*')return base;
 if(hour==='*'&&weekday==='*')return {...base,frequency:'hourly',minute:String(Number(minute))};
 if(!numeric(hour,23))return base;
 if(weekday==='*')return {...base,frequency:'daily',minute:String(Number(minute)),hour:String(Number(hour))};
 if(numeric(weekday,7))return {...base,frequency:'weekly',minute:String(Number(minute)),hour:String(Number(hour)),weekday:String(Number(weekday)%7)};
 return base;
}
export function scheduleExpression(settings){
 if(settings.frequency==='custom')return settings.custom;
 if(settings.frequency==='hourly')return `${settings.minute} * * * *`;
 return `${settings.minute} ${settings.hour} * * ${settings.frequency==='weekly'?settings.weekday:'*'}`;
}
export function describeSchedule(expression){
 if(!expression)return 'No schedule';
 const s=readSchedule(expression),clock=String(s.hour).padStart(2,'0')+':'+String(s.minute).padStart(2,'0');
 if(s.frequency==='daily')return 'Every day at '+clock;
 if(s.frequency==='weekly')return 'Every '+weekdays[Number(s.weekday)]+' at '+clock;
 if(s.frequency==='hourly')return 'Every hour at minute '+String(s.minute).padStart(2,'0');
 return 'Custom cron: '+expression;
}
