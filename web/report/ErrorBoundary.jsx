import React from 'react';
import {ReportProblem} from './ReportProblem.jsx';
import {buildAppErrorReport,errorName} from './builders.js';

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
  return <section className="rp-crash" role="alert" aria-labelledby="rp-crash-title">
   <h2 id="rp-crash-title">This page stopped working</h2>
   <p>Your backups and settings are safe. Reload the page, or tell us what happened.</p>
   <div className="rp-actions"><button type="button" className="primary" onClick={()=>location.reload()}>Reload page</button><ReportProblem build={build} summary="Unexpected app error"/></div>
   <p className="t-caption">Unexpected app error · shares only the page name and the error type</p>
  </section>;
 }
}
