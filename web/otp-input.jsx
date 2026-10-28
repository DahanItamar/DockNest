import React,{useRef,useState,useEffect} from 'react';

// Six digit boxes drawn over ONE real input, so paste, OS autofill, Backspace, arrows, Home and End are native.
export function OtpInput({value,onChange,onComplete,invalid,disabled,length=6,label='Authentication code',describedBy,inputRef}){
 const own=useRef(null),ref=inputRef||own,[pos,setPos]=useState(0),[focused,setFocused]=useState(false);
 const sync=()=>{const el=ref.current;if(el)setPos(el.selectionStart??el.value.length)};
 useEffect(()=>{sync()},[value]);
 useEffect(()=>{if(!disabled)ref.current?.focus()},[disabled]);
 const change=e=>{
  const next=e.target.value.replace(/\D/g,'').slice(0,length);
  onChange(next);
  if(next.length===length&&next!==value)onComplete?.(next);
 };
 const active=Math.min(pos,length-1);
 return <div className={'otp'+(invalid?' otp-invalid':'')} onClick={()=>ref.current?.focus()}>
  <div className="otp-boxes" aria-hidden="true">{[0,1].map(g=><React.Fragment key={g}>{g===1&&<span className="otp-dash"/>}<span className="otp-group">{Array.from({length:length/2},(_,k)=>{
   const i=g*(length/2)+k,on=focused&&!disabled&&(i===active);
   return <span key={i} className={'otp-box'+(on?' otp-active':'')+(value[i]?' otp-filled':'')}>{value[i]&&<span className="otp-digit" key={value[i]+i}>{value[i]}</span>}{on&&!value[i]&&<span className="otp-caret"/>}</span>;
  })}</span></React.Fragment>)}</div>
  <input ref={ref} className="otp-input" name="code" value={value} onChange={change} onSelect={sync} onKeyUp={sync} onFocus={()=>{setFocused(true);sync()}} onBlur={()=>setFocused(false)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" aria-label={label} aria-invalid={invalid?'true':undefined} aria-describedby={describedBy} disabled={disabled} autoFocus/>
 </div>;
}
