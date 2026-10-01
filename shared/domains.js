// Accept a copied website address while keeping domain metadata hostname-only.
export function normalizeDomain(value) {
 const input=value.trim();
 if(/^https?:\/\//i.test(input)){
  try{
   const url=new URL(input);
   if(url.username||url.password)return input;
   return url.hostname.toLowerCase();
  }catch{return input;}
 }
 return input.replace(/\/$/,'').toLowerCase();
}
