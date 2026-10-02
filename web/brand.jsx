import React,{createContext,useContext,useLayoutEffect,useState} from 'react';
import {flushSync} from 'react-dom';
import {Moon} from 'lucide-react';

const Theme=createContext(null);
export function ThemeProvider({children}) {
 const [theme,setTheme]=useState(()=>{
  try{const saved=localStorage.getItem('docknest-theme');if(['light','dark'].includes(saved))return saved;}catch{}
  return window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
 });
 useLayoutEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('docknest-theme',theme);}catch{}},[theme]);
 function changeTheme(next) {
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){setTheme(next);return;}
  if(document.startViewTransition){
   const transition=document.startViewTransition(()=>flushSync(()=>setTheme(next)));
   transition.ready.catch(()=>{});
  }else setTheme(next);
 }
 return <Theme.Provider value={{theme,setTheme:changeTheme}}>{children}</Theme.Provider>;
}
export function Brand({descriptive=false,dashboard=false}) {
 const {theme}=useContext(Theme);
 return <img className={descriptive?'brand-lockup descriptive':dashboard?'brand-lockup dashboard-brand':'brand-lockup'} src={`/brand/logo-tagline-${theme}.png`} alt="DockNest - Docker Backup & Restore" width="1200" height={theme==='light'?355:380}/>;
}
export function BrandIcon({name,size=20,className=''}) {
 const {theme}=useContext(Theme);
 return <img className={`brand-icon ${className}`} src={`/brand/icons/${name}-${theme}.png`} width={size} height={size} alt="" aria-hidden="true"/>;
}
export function ThemeToggle() {
 const {theme,setTheme}=useContext(Theme),dark=theme==='dark';
 return <button type="button" className="icon theme-toggle" aria-label={`Switch to ${dark?'light':'dark'} theme`} onClick={()=>setTheme(dark?'light':'dark')}>{dark?<BrandIcon name="theme" size={22}/>:<Moon size={18}/>}</button>;
}
