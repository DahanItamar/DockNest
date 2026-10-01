import React,{useState} from 'react';
import {readSchedule,scheduleExpression,describeSchedule,weekdays} from './schedule.js';

export function ScheduleFields({Field,initialSchedule='0 2 * * *'}){
 const [settings,setSettings]=useState(()=>readSchedule(initialSchedule));
 const expression=scheduleExpression(settings);
 const set=(field,value)=>setSettings(previous=>({...previous,[field]:value}));
 const options=count=>Array.from({length:count},(_,number)=>[String(number),String(number).padStart(2,'0')]);
 function changeFrequency(event){
  const frequency=event.target.value;
  setSettings(previous=>({...previous,frequency,...(frequency==='custom'?{custom:scheduleExpression(previous)}:{})}));
 }
 return <div className="schedule-fields">
  <Field label="Back up" aria-label="Back up" value={settings.frequency} onChange={changeFrequency} options={[[ 'daily','Every day'],['weekly','Every week'],['hourly','Every hour'],['custom','Custom cron (advanced)']]}/>
  {settings.frequency==='weekly'&&<Field label="Day of the week" aria-label="Day of the week" value={settings.weekday} onChange={event=>set('weekday',event.target.value)} options={weekdays.map((day,index)=>[String(index),day])}/>}
  {settings.frequency!=='custom'?<>
   <p>{settings.frequency==='hourly'?'Choose the minute past each hour.':'Time (24-hour clock)'}</p>
   <div className="schedule-time">{settings.frequency!=='hourly'&&<><Field label="Hour (00–23)" aria-label="Hour (00–23)" value={settings.hour} onChange={event=>set('hour',event.target.value)} options={options(24)}/><span aria-hidden="true">:</span></>}<Field label="Minute (00–59)" aria-label="Minute (00–59)" value={settings.minute} onChange={event=>set('minute',event.target.value)} options={options(60)}/></div>
   <input type="hidden" name="schedule" value={expression}/>
  </>:<Field label="Custom cron expression" aria-label="Custom cron expression" name="schedule" value={settings.custom} onChange={event=>set('custom',event.target.value)} required help="Five fields separated by spaces. A star (*) means every value. Example: 0 2 * * * runs every day at 02:00."/>}
  <p className="hint schedule-description" role="status">{describeSchedule(expression)} · in the time zone below.</p>
  <details className="cron-preview"><summary>View cron fields</summary><div className="cron-fields" aria-label="Cron field breakdown">{['Minute','Hour','Day of month','Month','Day of week'].map((label,index)=><React.Fragment key={label}>{index>0&&<span className="cron-separator" aria-hidden="true">|</span>}<div><small>{label}</small><code>{expression.trim().split(/\s+/)[index]||'—'}</code></div></React.Fragment>)}</div></details>
 </div>;
}
