import React,{useState} from 'react';
import {IconBox,IconDatabase} from '@tabler/icons-react';
import {StatusLabel,OverflowMenu} from '../system.jsx';
import {Paginated} from '../pagination.jsx';
import {addTargets} from './model.js';
import './backup-coverage.css';

const STATUS={'backed-up':['success','Backed up'],pending:['running','First backup pending'],'not-backed-up':['needs-review','Not backed up'],skipped:['queued','Skipped']};

// The one quiet detail after the status: which app, why it is skipped, or what uses the volume.
function detail(item){
 if(item.status==='backed-up'||item.status==='pending')return item.app?.name||'';
 if(item.status==='skipped')return item.note||'';
 if(item.kind==='volume')return item.usedBy?.length?'Used by '+item.usedBy.join(', '):'No container uses it';
 return '';
}

// What clicking the row does. Not backed up: Add app. Backed up or pending: open that app. Skipped: the menu.
function actionOf(item){
 if((item.status==='backed-up'||item.status==='pending')&&item.app)return 'open';
 if(item.status==='not-backed-up'&&addTargets(item).length)return 'add';
 return item.status==='not-backed-up'||item.status==='skipped'?'menu':null;
}
const HINT={add:'Add app',open:'Open'};

function Row({item,onAdd,onOpen,onSkip,onUnskip}){
 const [menu,setMenu]=useState(false),action=actionOf(item),[state,label]=STATUS[item.status],Icon=item.kind==='volume'?IconDatabase:IconBox,text=detail(item);
 const menuItems=item.status==='not-backed-up'?[{label:'Skip',onSelect:()=>onSkip(item)}]:item.status==='skipped'?[{label:'Unskip',onSelect:()=>onUnskip(item)}]:[];
 const click={add:()=>onAdd(item),open:()=>onOpen(item),menu:()=>setMenu(open=>!open)}[action];
 const body=<>
  <Icon className="bc-kind" size={24} stroke={1.5} aria-hidden="true"/>
  <span className="bc-text"><b title={item.name}>{item.name}</b><span className="bc-status"><StatusLabel state={state}>{label}</StatusLabel>{text&&<span className="t-caption" title={text}>{text}</span>}</span></span>
  {HINT[action]&&<span className="bc-hint">{HINT[action]}</span>}
 </>;
 return <li className="bc-row">
  {action?<button type="button" className="bc-main" onClick={click}>{body}</button>:<div className="bc-main">{body}</div>}
  {menuItems.length>0&&<OverflowMenu label={'More actions for '+item.name} items={menuItems} open={menu} onOpenChange={setMenu}/>}
 </li>;
}

// One compact row per container or volume, in the order they need attention. Eight to a page keeps a phone short.
export function CoverageRows({items,resetKey,...actions}){
 return <Paginated rows={items} label="Containers and volumes" pageSize={8} resetKey={resetKey}>{visible=><ul className="bc-rows">{visible.map(item=><Row key={item.kind+':'+item.name} item={item} {...actions}/>)}</ul>}</Paginated>;
}
