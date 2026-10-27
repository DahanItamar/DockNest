import React,{useState} from 'react';
import {AuthLayout,AuthField,AuthError,PasswordField,authErrorMessage} from './auth-layout.jsx';

export function AdminSetup({api,Field,status,onAuth,onExit}) {
 const [enrollment,setEnrollment]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event){
  event.preventDefault();if(busy)return;setBusy(true);setError('');
  const fields=Object.fromEntries(new FormData(event.currentTarget));
  try{
   if(enrollment){const result=await api('/auth/verify',{challenge:enrollment.challenge,code:fields.code.trim()});setEnrollment(null);onAuth({authenticated:true,...result});}
   else{
    if(fields.confirmPassword!==fields.password)throw new Error('Passwords do not match.');
    const result=await api(status.setupRequired?'/auth/setup':'/auth/login',status.setupRequired?{name:fields.name,email:fields.email,password:fields.password,setupToken:fields.setupToken}:{password:fields.password,setupToken:fields.setupToken});
    if(!result.enrollmentRequired)throw new Error('Administrator setup is complete. Return to sign in.');
    setEnrollment(result);
   }
  }catch(error){setError(error.status===429?authErrorMessage(error):enrollment&&error.status===401?'Invalid code.':error.message);}finally{setBusy(false);}
 }
 return <AuthLayout><h2 className="lg-title">{enrollment?'Connect your authenticator':status.setupRequired?'Set up DockNest':'Resume administrator setup'}</h2><p className="lg-sub">{enrollment?'Scan the QR code, save your recovery codes, then confirm your authenticator.':'Create the first administrator using the private setup token from your deployment server.'}</p><form className="lg-form" onSubmit={submit}>
  {!enrollment?<>
   {status.setupRequired&&<><AuthField label="Administrator name" name="name" required maxLength={100}/><AuthField label="Administrator email" name="email" type="email" required maxLength={254}/></>}
   <PasswordField label="Setup token" name="setupToken" autoComplete="off" required help="Available only in /opt/docknest/data/setup.token on the deployment server. Never share it in chat."/>
   <PasswordField label="System password" name="password" autoComplete="new-password" minLength={4} maxLength={16} required/>
   <PasswordField label="Confirm system password" name="confirmPassword" autoComplete="new-password" minLength={4} maxLength={16} required error={error==='Passwords do not match.'}/>
  </>:<>
   <img className="auth-qr" src={enrollment.qrDataUrl} alt="Administrator authenticator setup QR"/>
   <details><summary>Manual authenticator setup</summary><code>{enrollment.secret}</code></details>
   <div className="recovery-codes"><h3 className="lg-h3">Save these one-use recovery codes privately</h3><div className="codes">{enrollment.recoveryCodes?.map(code=><code key={code}>{code}</code>)}</div></div>
   <label className="check"><input type="checkbox" required/> I saved my recovery codes securely.</label>
   <AuthField label="Authenticator code" name="code" inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={6} required error={!!error}/>
  </>}
  <AuthError>{error}</AuthError>
  <button className="primary wide" disabled={busy}>{busy?'Working…':enrollment?'Confirm administrator':'Continue setup'}</button>
 </form><button className="text enrollment-back" disabled={busy} onClick={onExit}>Back to sign in</button></AuthLayout>;
}
