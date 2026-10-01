import React,{createContext,useContext,useLayoutEffect,useState} from 'react';
import {flushSync} from 'react-dom';
import {Sun,Moon} from 'lucide-react';

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
export function Brand({descriptive=false}) {
 const {theme}=useContext(Theme);
 return <img className={descriptive?'brand-lockup descriptive':'brand-lockup'} src={`/brand/logo-${descriptive?'tagline':'horizontal'}-${theme}.svg`} alt={descriptive?'DockNest — Docker Backup & Restore':'DockNest'} width={descriptive?360:160} height={descriptive?105:45}/>;
}
export function ThemeToggle() {
 const {theme,setTheme}=useContext(Theme),dark=theme==='dark';
 return <button type="button" className="icon theme-toggle" aria-label={`Switch to ${dark?'light':'dark'} theme`} onClick={()=>setTheme(dark?'light':'dark')}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button>;
}
