// Recovery Guide client (docs/recovery-guide.md "API"). The PDF is made on the server and downloaded as a file;
// nothing about it is kept in the browser.
async function csrfToken(){
 const response=await fetch('/api/auth/status',{credentials:'same-origin'});
 return (await response.json().catch(()=>({}))).csrfToken||'';
}
export const PDF_FAILED='The PDF could not be created. Nothing was saved. Try again.';
export function pdfBody({apps,include}){
 return {apps,include:{addresses:!!include.addresses,logins:!!include.logins,commands:!!include.commands,tests:!!include.tests,schedules:!!include.schedules,notes:!!include.notes}};
}
// Resolves with a Blob. Rejects with an Error whose .code is REAUTH_REQUIRED when a fresh sign-in check is needed.
export async function createPdf(options){
 const response=await fetch('/api/runbook/pdf',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','x-csrf-token':await csrfToken()},body:JSON.stringify(pdfBody(options))});
 if(!response.ok){
  const data=await response.json().catch(()=>({}));
  throw Object.assign(new Error(data.error||PDF_FAILED),{status:response.status,code:data.code});
 }
 return response.blob();
}
export function saveBlob(blob,name='recovery-guide.pdf'){
 const url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export const reauth=(api,password,code)=>api('/auth/reauth',{password,code});
