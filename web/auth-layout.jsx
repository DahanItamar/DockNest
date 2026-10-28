import React,{useEffect,useId,useMemo,useState} from 'react';
import {Eye,EyeOff,CircleX} from './icons.jsx';
import {ThemeToggle} from './brand.jsx';

// Sign-in, first-run setup and enrollment share this split screen. Styles live in auth.css and are scoped to .auth-page.
export function authErrorMessage(e){
 if(e?.status===401)return 'Invalid password or code.';
 if(e?.status===429)return 'Too many attempts. Try again later.';
 return e?.message||'Something went wrong. Try again.';
}

function FloatingPaths(){
 const sets=useMemo(()=>[1,-1].map((pos,s)=>Array.from({length:20},(_,i)=>{
  const k=i*7.5*pos,j=i*9;
  return {d:`M${-380+k} ${-189-j}C${-380+k} ${-189-j} ${-312+k} ${216-j} ${152+k} ${343-j}C${616+k} ${470-j} ${684+k} ${875-j} ${684+k} ${875-j}`,width:(0.6+i*0.025).toFixed(2),opacity:(0.07+i*0.011).toFixed(3),delay:(i*2.7+s*11).toFixed(1)};
 })),[]);
 return <svg className="lg-paths" viewBox="-380 -190 1076 1060" preserveAspectRatio="xMidYMid slice" fill="none" aria-hidden="true">{sets.map((set,s)=><g key={s} className={`lg-pg lg-pg${s+1}`}>{set.map((p,i)=><path key={i} className="lg-path" d={p.d} pathLength="100" style={{strokeWidth:p.width,strokeOpacity:p.opacity}}/>)}</g>)}</svg>;
}

export function AuthLayout({children,back}){
 useEffect(()=>{
  const root=document.documentElement,sync=()=>root.classList.toggle('lg-paused',document.hidden);
  sync();document.addEventListener('visibilitychange',sync);
  return()=>{document.removeEventListener('visibilitychange',sync);root.classList.remove('lg-paused')};
 },[]);
 return <div className="auth-shell auth-page lg-t2"><div className="lg-split">
  <aside className="lg-brandpanel" aria-label="DockNest"><FloatingPaths/>
   <div className="lg-bp-top"><span className="lg-logo" role="img" aria-label="DockNest" style={{width:176}}/></div>
   <div className="lg-bp-bottom"><p className="lg-bp-line"><span className="lg-s lg-rise">Backups you can prove.</span><span className="lg-s lg-rise lg-rise2">Servers you can move.</span></p><p className="lg-bp-cap">Self-hosted Docker backup and restore</p></div>
  </aside>
  <div className="lg-left"><header className="auth-header lg-head"><span className="lg-logo lg-head-logo" role="img" aria-label="DockNest"/><ThemeToggle/></header>
   <main className="auth-main lg-formside"><div className="lg-col auth-card">{back}{children}</div></main>
  </div>
 </div></div>;
}

export function AuthField({label,help,error,...props}){
 return <label className="field"><span>{label}</span><input {...props} aria-invalid={error?'true':undefined} aria-describedby={error?'lg-err':undefined}/>{help&&<small>{help}</small>}</label>;
}

export function PasswordField({label,help,error,...props}){
 const id=useId(),[shown,setShown]=useState(false);
 return <div className="field"><label htmlFor={id}>{label}</label><div className="lg-in lg-pw"><input {...props} id={id} type={shown?'text':'password'} aria-invalid={error?'true':undefined} aria-describedby={error?'lg-err':undefined}/><button type="button" className="lg-eye" aria-label={shown?'Hide password':'Show password'} aria-pressed={shown} onClick={()=>setShown(v=>!v)}>{shown?<EyeOff size={20} stroke={1.75} aria-hidden="true"/>:<Eye size={20} stroke={1.75} aria-hidden="true"/>}</button></div>{help&&<small>{help}</small>}</div>;
}

export function AuthError({children}){
 return children?<p className="lg-err" role="alert" id="lg-err"><CircleX size={16} stroke={2} aria-hidden="true"/><span>{children}</span></p>:null;
}
