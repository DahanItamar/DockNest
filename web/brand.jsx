import React,{createContext,useContext,useLayoutEffect,useEffect,useState,useRef} from 'react';
import {flushSync} from 'react-dom';
import brandAsset from './brand-assets.json';
import {IconSun,IconDashboard,IconServer,IconStack2,IconArchive,IconActivity,IconDatabase,IconCalendarTime,IconDownload,IconLockDown,IconPin,IconRestore,IconInfoCircle,IconRefresh,IconUsers,IconTool,IconShieldCheck,IconEdit,IconTrash,IconCloudUpload,IconPlayerPause,IconPlayerPlay,IconHistory,IconTerminal2,IconCircleArrowUp} from '@tabler/icons-react';

const Theme=createContext(null);
export const useTheme=()=>useContext(Theme);
const validPreference=value=>['light','dark','system'].includes(value)?value:'light';
const resolveTheme=value=>value==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):value;
export function ThemeProvider({children}){
 const [preference,setPreference]=useState(()=>validPreference(document.documentElement.dataset.preference||document.documentElement.dataset.theme));
 const [theme,setTheme]=useState(()=>document.documentElement.dataset.theme==='dark'?'dark':'light');
 const transition=useRef(null),timer=useRef(null),storageKey=useRef('docknest-theme'),currentTheme=useRef(theme),currentPreference=useRef(preference);
 function apply(next){
  next=validPreference(next);const resolved=resolveTheme(next);currentPreference.current=next;
  setPreference(next);const update=()=>setTheme(resolved);
  if(resolved===currentTheme.current){update();return}
  currentTheme.current=resolved;
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&document.startViewTransition){
   transition.current?.skipTransition();
   const current=document.startViewTransition(()=>flushSync(update));transition.current=current;
   // Skipping an overlapping transition rejects ready even when the update succeeds.
   current.ready.catch(()=>{});
   current.finished.then(()=>{if(transition.current===current)transition.current=null}).catch(()=>{});
  }else{
   if(!matchMedia('(prefers-reduced-motion: reduce)').matches){document.documentElement.classList.add('theme-changing');clearTimeout(timer.current);timer.current=setTimeout(()=>document.documentElement.classList.remove('theme-changing'),420)}
   update();
  }
 }
 function changePreference(next){try{localStorage.setItem(storageKey.current,validPreference(next));localStorage.setItem('docknest-theme',validPreference(next))}catch{}apply(next)}
 function bindUser(id){
  const key=id?'docknest-theme:user:'+id:'docknest-theme';if(key===storageKey.current)return;storageKey.current=key;
  try{const saved=localStorage.getItem(key);if(saved!==null)changePreference(saved)}catch{}
 }
 useLayoutEffect(()=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.preference=preference;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#182131':'#673AB7')},[theme,preference]);
 useEffect(()=>{
  const sync=e=>{if(e.key===storageKey.current||(storageKey.current==='docknest-theme'&&e.key==='docknest-theme'))apply(e.newValue)};
  const device=matchMedia('(prefers-color-scheme: dark)'),follow=()=>{if(currentPreference.current==='system')apply('system')};
  addEventListener('storage',sync);device.addEventListener('change',follow);return()=>{removeEventListener('storage',sync);device.removeEventListener('change',follow)};
 },[]);
 useEffect(()=>()=>{clearTimeout(timer.current);transition.current?.skipTransition();document.documentElement.classList.remove('theme-changing')},[]);
 return <Theme.Provider value={{theme,preference,setTheme:changePreference,setPreference:changePreference,bindUser}}>{children}</Theme.Provider>;
}
export function ThemePreferences(){const {preference,setPreference}=useTheme();return <fieldset className="theme-preferences"><legend>Appearance</legend><div className="theme-options">{['light','dark','system'].map(value=><label key={value} className={preference===value?'selected':''}><input type="radio" name="appearance" value={value} checked={preference===value} onChange={()=>setPreference(value)}/><span>{value[0].toUpperCase()+value.slice(1)}</span></label>)}</div><p>System follows your device. Your selection is remembered for your account in this browser.</p></fieldset>}
export function Brand(){const {theme}=useTheme();return <span className="brand-lockup"><img className="brand-image" src={theme==='dark'?brandAsset.darkSrc:brandAsset.src} srcSet={theme==='dark'?brandAsset.darkSrcSet:brandAsset.srcSet} sizes="(max-width:599px) 108px, 176px" width={brandAsset.width} height={brandAsset.height} alt="DockNest"/><small>Docker Backup &amp; Restore</small></span>}
export function ThemeToggle(){const {theme,setTheme}=useTheme(),dark=theme==='dark',label=`Switch to ${dark?'light':'dark'} theme`;return <button type="button" className="theme-toggle" aria-label={label} title={label} onClick={()=>setTheme(dark?'light':'dark')}><svg className={`theme-symbol ${theme}`} width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><g className="theme-sun"><g className="sun-rays"><path fillRule="evenodd" d="m12 1.7 2.3 3.2 3.9-.2-.2 3.9 3.2 2.3-3.2 2.3.2 3.9-3.9-.2-2.3 3.2-2.3-3.2-3.9 .2 .2-3.9-3.2-2.3 3.2-2.3-.2-3.9 3.9.2L12 1.7Zm0 5.5a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z"/></g><circle cx="12" cy="10.9" r="2"/></g><g className="theme-moon"><path d="M14.5 2.6A9.2 9.2 0 1 0 21.4 15 7.2 7.2 0 0 1 14.5 2.6Z"/><g className="moon-star"><circle cx="18.7" cy="5.3" r="1.7"/><circle cx="21.3" cy="9.4" r=".8"/></g></g></svg></button>}
export function NotificationSymbol(){return <svg className="notification-symbol" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M12 2.4c-3.6 0-6.2 2.8-6.2 6.5v3.4L4.4 16a1 1 0 0 0 .9 1.4h13.4a1 1 0 0 0 .9-1.4l-1.4-3.7V8.9c0-3.7-2.6-6.5-6.2-6.5Zm-2.9 6c0-1.7 1.2-2.9 2.9-2.9v1.7c-.7 0-1.2.5-1.2 1.2v2.8H9.1V8.4Z"/><path d="M8.6 19c.6 1.7 1.7 2.6 3.4 2.6s2.8-.9 3.4-2.6H8.6Z"/></svg>}
const icons={overview:IconDashboard,server:IconServer,sites:IconStack2,backups:IconArchive,jobs:IconActivity,storage:IconDatabase,schedule:IconCalendarTime,download:IconDownload,'encrypted-download':IconLockDown,pin:IconPin,restore:IconRestore,details:IconInfoCircle,refresh:IconRefresh,theme:IconSun,access:IconUsers,maintenance:IconTool,readiness:IconShieldCheck,edit:IconEdit,remove:IconTrash,deploy:IconCloudUpload,pause:IconPlayerPause,resume:IconPlayerPlay,audit:IconHistory,terminal:IconTerminal2,update:IconCircleArrowUp};
export function BrandIcon({name,size=20,className='',inverse=false}){const Icon=icons[name]||IconInfoCircle;return <Icon size={size} stroke={1.5} className={'brand-icon '+className} aria-hidden="true" style={inverse?{color:'#FFFFFF'}:undefined}/>}
