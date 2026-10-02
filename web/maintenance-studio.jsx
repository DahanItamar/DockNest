import React,{useEffect,useMemo,useState,useRef} from 'react';
import {Monitor,Smartphone,Type,Palette,RotateCcw,Save,Columns2,AlignCenter,PanelTop} from './icons.jsx';
import {BrandIcon} from './brand.jsx';
import {maintenancePresets,normalizeMaintenance,renderMaintenancePage} from '../shared/maintenance-design.js';
import './maintenance.css';

export function MaintenanceStudio({settings,busy,onSave,children}){
 const stage=useRef(null),[availableWidth,setAvailableWidth]=useState(500);
 useEffect(()=>{const observer=new ResizeObserver(entries=>setAvailableWidth(entries[0].contentRect.width));if(stage.current)observer.observe(stage.current);return()=>observer.disconnect()},[]);
 const initial=JSON.stringify(normalizeMaintenance(settings));
 const [saved,setSaved]=useState(()=>JSON.parse(initial)),[draft,setDraft]=useState(()=>JSON.parse(initial)),[viewport,setViewport]=useState('desktop'),[tab,setTab]=useState('content');
 const previewWidth=viewport==='phone'?390:1100,previewHeight=viewport==='phone'?960:820,scale=Math.min(1,availableWidth/previewWidth);
 const dirty=JSON.stringify(draft)!==JSON.stringify(saved);
 useEffect(()=>{const next=JSON.parse(initial);setSaved(next);setDraft(previous=>JSON.stringify(previous)===JSON.stringify(saved)?next:previous);},[initial]);
 const html=useMemo(()=>renderMaintenancePage(draft,{interactive:false}),[draft]);
 const update=event=>setDraft(previous=>({...previous,[event.target.name]:event.target.value}));
 async function save(event){event.preventDefault();const result=await onSave(draft);if(result){const normalized=normalizeMaintenance(result);setSaved(normalized);setDraft(normalized);}}
 return <div className="maintenance-studio">
  <div className="studio-topline"><div><span className="studio-kicker">MAINTENANCE STUDIO</span><h2>Your message. Your stage.</h2><p>Design a calm pause for your visitors, then publish it to your sites.</p></div><span className={'studio-save-state '+(dirty?'dirty':'')}>{dirty?'Unsaved changes':'Saved design'}</span></div>
  <div className="studio-grid">
   <section className="studio-inspector panel" aria-label="Maintenance design settings">
    <header className="studio-section-head"><BrandIcon name="maintenance" size={24}/><h2>Design settings</h2></header>
    <form onSubmit={save}>
     <div className="studio-tabs" role="tablist" aria-label="Design inspector"><button type="button" role="tab" aria-selected={tab==='content'} aria-controls="studio-content" id="content-tab" onClick={()=>setTab('content')}><Type size={16}/> Content</button><button type="button" role="tab" aria-selected={tab==='appearance'} aria-controls="studio-appearance" id="appearance-tab" onClick={()=>setTab('appearance')}><Palette size={16}/> Appearance</button></div>
     <div className="studio-fields" role="tabpanel" id="studio-content" aria-labelledby="content-tab" hidden={tab!=='content'}>
      <p className="studio-field-intro">A clear message makes the wait feel considered.</p>
      <label className="field"><span>Page title</span><input aria-label="Page title" name="title" value={draft.title} onChange={update} maxLength={150} required/><small>{draft.title.length}/150 characters</small></label>
      <label className="field"><span>Visitor message</span><textarea aria-label="Visitor message" name="message" value={draft.message} onChange={update} maxLength={1000} required/><small>{draft.message.length}/1000 characters</small></label>
      <div className="studio-starting"><h3>Start with a direction</h3><p>Apply a starting point, then make it yours.</p><div className="studio-presets">{maintenancePresets.map(preset=><button type="button" key={preset.name} onClick={()=>setDraft({...preset.settings})}><span>{preset.name}</span><small>{preset.description}</small></button>)}</div></div>
     </div>
     <div className="studio-fields" role="tabpanel" id="studio-appearance" aria-labelledby="appearance-tab" hidden={tab!=='appearance'}>
      <fieldset className="studio-layouts"><legend>Composition</legend>{[['studio','Studio',Columns2],['editorial','Editorial',AlignCenter],['compact','Essential',PanelTop]].map(([value,label,Icon])=><label className={draft.layout===value?'chosen':''} key={value}><input type="radio" name="layout" value={value} checked={draft.layout===value} onChange={update}/><Icon size={24}/><span>{label}</span></label>)}</fieldset>
      <div className="studio-two-fields"><div className="field"><span>Visitor appearance</span><p>Light / Berry palette</p></div><label className="field"><span>Heading style</span><select name="typeScale" value={draft.typeScale} onChange={update}><option value="balanced">Balanced</option><option value="bold">Bold</option></select></label></div>
      <label className="field studio-color"><span>Accent color</span><span className="studio-color-control"><input aria-label="Accent color" type="color" name="color" value={draft.color} onChange={update}/><code>{draft.color.toUpperCase()}</code><span>Details &amp; highlights</span></span><small>The accent decorates the page; text keeps a readable contrast.</small></label>
      <div className="studio-type-specimen"><span className="studio-kicker">TYPE SYSTEM / ROBOTO</span><strong>A smooth return.</strong><p>Clear hierarchy. Comfortable line lengths. The same design in every composition.</p></div>
     </div>
     <footer className="studio-form-actions"><button type="button" disabled={busy||!dirty} onClick={()=>setDraft({...saved})}><RotateCcw size={16}/> Reset changes</button><button className="primary" disabled={busy} type="submit"><Save size={16}/>{busy?'Saving...':'Save design'}</button></footer>
    </form>
   </section>
   <section className="studio-canvas panel" aria-label="Maintenance live canvas">
    <header className="studio-canvas-toolbar"><div><span className="studio-kicker">LIVE CANVAS</span><h2>Visitor preview</h2></div><div className="studio-viewport" role="group" aria-label="Preview viewport"><button type="button" aria-label="Desktop preview" aria-pressed={viewport==='desktop'} onClick={()=>setViewport('desktop')}><Monitor size={18}/></button><button type="button" aria-label="Phone preview" aria-pressed={viewport==='phone'} onClick={()=>setViewport('phone')}><Smartphone size={18}/></button></div></header>
    <div ref={stage} className={'studio-stage '+viewport}><div style={{width:previewWidth*scale,height:previewHeight*scale,flexShrink:0}}><iframe style={{width:previewWidth,height:previewHeight,transform:`scale(${scale})`,transformOrigin:'top left'}} title="Maintenance visitor preview" srcDoc={html} sandbox="allow-same-origin" className="visitor-canvas" /></div></div>
    <footer className="studio-canvas-note"><span>{viewport==='phone'?'Phone / 390 px':'Desktop / 1100 px'}</span><span>Preview only</span></footer>
   </section>
  </div>
  <div className="studio-publish-note"><BrandIcon name="deploy" size={24}/><div><b>Save first. Publish when ready.</b><p>Saving updates your design. Deploy page publishes it to a site's maintenance proxy. Enable and Disable keep their existing confirmations and health checks.</p></div></div>
  {children}
 </div>;
}
