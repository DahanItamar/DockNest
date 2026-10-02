import React,{createContext,useContext,useLayoutEffect} from 'react';
import {IconMoon,IconSun,IconDashboard,IconServer,IconStack2,IconArchive,IconActivity,IconDatabase,IconCalendarTime,IconDownload,IconLockDown,IconPin,IconRestore,IconInfoCircle,IconRefresh,IconUsers,IconTool,IconShieldCheck,IconEdit,IconTrash,IconCloudUpload,IconPlayerPause,IconPlayerPlay,IconHistory,IconTerminal2} from '@tabler/icons-react';

const Theme=createContext(null);
export const useTheme=()=>useContext(Theme);
export function ThemeProvider({children}){useLayoutEffect(()=>{document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';try{localStorage.removeItem('docknest-theme')}catch{}},[]);return <Theme.Provider value={{theme:'light'}}>{children}</Theme.Provider>;}
export function Brand(){return <span className="brand-lockup"><img className="brand-image" src="/brand/logo.png" width="1200" height="399" alt="DockNest"/><small>Docker Backup &amp; Restore</small></span>}
const icons={overview:IconDashboard,server:IconServer,sites:IconStack2,backups:IconArchive,jobs:IconActivity,storage:IconDatabase,schedule:IconCalendarTime,download:IconDownload,'encrypted-download':IconLockDown,pin:IconPin,restore:IconRestore,details:IconInfoCircle,refresh:IconRefresh,theme:IconSun,access:IconUsers,maintenance:IconTool,readiness:IconShieldCheck,edit:IconEdit,remove:IconTrash,deploy:IconCloudUpload,pause:IconPlayerPause,resume:IconPlayerPlay,audit:IconHistory,terminal:IconTerminal2};
export function BrandIcon({name,size=20,className='',inverse=false}){const Icon=icons[name]||IconInfoCircle;return <Icon size={size} stroke={1.5} className={'brand-icon '+className} aria-hidden="true" style={inverse?{color:'#FFFFFF'}:undefined}/>}
