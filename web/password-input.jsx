import React,{forwardRef,useCallback,useLayoutEffect,useRef,useState} from 'react';

// A real <input type="password"> with its mask drawn by an overlay, so each new dot can pop in.
// The input stays the focusable, autofillable, pasteable element; only its glyphs are transparent.
const COPY=['paddingLeft','paddingRight','borderLeftWidth','fontFamily','fontSize','fontWeight','letterSpacing','lineHeight'];
export const PasswordInput=forwardRef(function PasswordInput({reveal=false,className,onChange,...props},fwd){
 const own=useRef(null),[len,setLen]=useState(0),[box,setBox]=useState(null),ready=useRef(false);
 const set=useCallback(el=>{own.current=el;if(typeof fwd==='function')fwd(el);else if(fwd)fwd.current=el},[fwd]);
 const sync=()=>{const el=own.current;if(el)setLen(el.value.length)};
 useLayoutEffect(()=>{
  const el=own.current;if(!el)return;
  const cs=getComputedStyle(el);setBox(Object.fromEntries(COPY.map(k=>[k,cs[k]])));
  sync();ready.current=true;
  const auto=e=>{if(e.animationName==='pw-autofill')sync()};
  el.addEventListener('animationstart',auto);el.addEventListener('input',sync);el.addEventListener('change',sync);
  return()=>{el.removeEventListener('animationstart',auto);el.removeEventListener('input',sync);el.removeEventListener('change',sync)};
 },[]);
 useLayoutEffect(sync);
 const mask=!reveal&&box;
 return <span className="pw-wrap">
  <input {...props} ref={set} type={reveal?'text':'password'} className={['pw-in',mask&&'pw-masked',className].filter(Boolean).join(' ')} onChange={onChange}/>
  {mask&&<span className="pw-dots" aria-hidden="true" style={{...box,paddingLeft:`calc(${box.paddingLeft} + ${box.borderLeftWidth})`,paddingRight:box.paddingRight}}>{Array.from({length:len},(_,i)=><span key={i} className="pw-dot">{'•'}</span>)}</span>}
 </span>;
});
