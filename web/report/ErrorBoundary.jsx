import React from 'react';
import {ReportProblem} from './ReportProblem.jsx';
import {buildAppErrorReport,errorName} from './builders.js';
import {StatusPage} from '../status-page.jsx';
import {RefreshCw} from '../icons.jsx';

// Route names as the app knows them, mapped to the fixed ids of app-error.yml.
export const ROUTE_IDS={Overview:'overview',Servers:'servers','Sites & schedules':'sites',Backups:'backups',Jobs:'jobs',Audit:'audit',Maintenance:'maintenance',Storage:'storage','DockNest backup':'self-backup','Update Center':'update-center',Access:'access','System health':'system-health'};
export const routeId=route=>ROUTE_IDS[route]||'other';

// "This page stopped working": catches a render error in one area. The report keeps only the route id, the area and
// the error name (TypeError and similar). The message and the stack never leave this component.
export class AppErrorBoundary extends React.Component{
 constructor(props){super(props);this.state={name:null}}
 static getDerivedStateFromError(error){return {name:errorName(error)}}
 componentDidCatch(){/* Nothing is logged or sent: messages and stacks can hold names, addresses or data. */}
 render(){
  if(this.state.name===null)return this.props.children;
  const route=routeId(this.props.route),area=this.props.area||'page',name=this.state.name;
  const build=(facts,opts)=>buildAppErrorReport({...facts,...opts,route,area,error:name});
  return <StatusPage code="500" level={2} role="alert" className="rp-crash" title="This page stopped working" footnote="Unexpected app error · shares only the page name and the error type"
   actions={<button type="button" className="primary" onClick={()=>location.reload()}><RefreshCw size={18} stroke={1.75} aria-hidden="true"/>Reload page</button>} aside={<ReportProblem build={build} label="Report this problem" className="text status-link" summary="Unexpected app error"/>}>
   Your backups and settings are safe. Reload the page, or tell us what happened.
  </StatusPage>;
 }
}
