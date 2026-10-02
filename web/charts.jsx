import React,{useEffect,useRef,useState} from 'react';
import Chart from 'chart.js/auto';
import {IconDownload} from '@tabler/icons-react';
import {useTheme} from './brand.jsx';
import {bucketActivity} from './chart-data.js';
export {bucketActivity} from './chart-data.js';
export function ActivityChart({s,period}){
 const ref=useRef(null),chart=useRef(null),lastDraw=useRef(null),{theme}=useTheme(),[hidden,setHidden]=useState([]),[menu,setMenu]=useState(false);
 const data=bucketActivity(s,period),key=JSON.stringify(data);
 useEffect(()=>{
  const colors=getComputedStyle(document.documentElement),muted=colors.getPropertyValue('--text-muted').trim(),line=colors.getPropertyValue('--border-subtle').trim();
  const instance=new Chart(ref.current,{type:'bar',data:{labels:data.labels,datasets:data.series.map(series=>({label:series.label,data:series.values,backgroundColor:series.color,barPercentage:.625,categoryPercentage:.8,borderRadius:0}))},options:{responsive:true,maintainAspectRatio:false,animation:matchMedia('(prefers-reduced-motion: reduce)').matches?false:{duration:800},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{enabled:true}},scales:{x:{stacked:true,grid:{display:false},ticks:{color:muted,font:{family:'Roboto Variable',size:12},maxTicksLimit:12},border:{color:line}},y:{stacked:true,beginAtZero:true,suggestedMax:1,ticks:{precision:0,color:muted,font:{family:'Roboto Variable',size:12}},grid:{color:line},border:{display:false}}}}});
  hidden.forEach(index=>instance.setDatasetVisibility(index,false));lastDraw.current=key+JSON.stringify(hidden);chart.current=instance;return()=>{instance.destroy();chart.current=null};
 },[theme]);
 useEffect(()=>{const instance=chart.current;if(!instance||lastDraw.current===key+JSON.stringify(hidden))return;lastDraw.current=key+JSON.stringify(hidden);instance.data.labels=data.labels;instance.data.datasets.forEach((dataset,i)=>{dataset.data=data.series[i].values;instance.setDatasetVisibility(i,!hidden.includes(i))});instance.options.animation=matchMedia('(prefers-reduced-motion: reduce)').matches?false:{duration:350};instance.update()},[key,hidden,theme]);
 function exportData(type){
  let url,filename='docknest-activity-'+period+'.'+type;
  if(type==='png')url=chart.current.toBase64Image();else{const rows=[['Period',...data.series.map(x=>x.label)],...data.labels.map((label,i)=>[label,...data.series.map(x=>x.values[i])])];const csv=rows.map(row=>row.map(x=>'"'+String(x).replaceAll('"','""')+'"').join(',')).join('\n');url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}))}
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();if(type==='csv')setTimeout(()=>URL.revokeObjectURL(url),0);setMenu(false);
 }
 return <div className="berry-chart"><div className="chart-export"><button className="icon" aria-label="Export activity chart" aria-expanded={menu} onClick={()=>setMenu(!menu)}><IconDownload size={18}/></button>{menu&&<div className="chart-export-menu"><button onClick={()=>exportData('png')}>Download PNG</button><button onClick={()=>exportData('csv')}>Download CSV</button></div>}</div><div className="activity-chart-canvas"><canvas ref={ref} role="img" aria-label={'Stacked activity chart: '+data.labels.map((label,i)=>label+': '+data.series.map(x=>x.label+' '+x.values[i]).join(', ')).join('; ')} /></div><div className="chart-legend" role="group" aria-label="Chart series">{data.series.map((series,i)=><button key={series.label} aria-pressed={!hidden.includes(i)} onClick={()=>setHidden(old=>old.includes(i)?old.filter(x=>x!==i):[...old,i])}><span style={{background:series.color}}/>{series.label}</button>)}</div><details className="chart-data"><summary>View chart data</summary><div className="table-wrap"><table><caption>Activity totals for the selected period</caption><thead><tr><th>Period</th>{data.series.map(x=><th key={x.label}>{x.label}</th>)}</tr></thead><tbody>{data.labels.map((label,i)=><tr key={label}><td>{label}</td>{data.series.map(x=><td key={x.label}>{x.values[i]}</td>)}</tr>)}</tbody></table></div></details></div>;
}
export function Sparkline({values,labels=[],color='#FFFFFF',area=false,label='Capture history'}){
 const ref=useRef(),{theme}=useTheme(),key=JSON.stringify(values);
 useEffect(()=>{const instance=new Chart(ref.current,{type:'line',data:{labels:labels.length?labels:values.map((_,i)=>String(i+1)),datasets:[{label,data:values,borderColor:color,borderWidth:area?1:3,pointRadius:0,pointHitRadius:12,tension:.4,fill:area,backgroundColor:context=>{if(!area)return'transparent';const gradient=context.chart.ctx.createLinearGradient(0,0,0,95);gradient.addColorStop(0,'rgba(69,39,160,.4)');gradient.addColorStop(1,'rgba(69,39,160,.1)');return gradient}}]},options:{responsive:true,maintainAspectRatio:false,animation:matchMedia('(prefers-reduced-motion: reduce)').matches?false:{duration:800},plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:false,beginAtZero:true}},interaction:{mode:'index',intersect:false}}});return()=>instance.destroy()},[key,theme,color,area,label]);
 return <div className="berry-sparkline"><canvas ref={ref} role="img" aria-label={label+': '+values.join(', ')}/></div>;
}
