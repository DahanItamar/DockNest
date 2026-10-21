// Minimal S3 REST client: AWS Signature Version 4 with node:crypto and fetch.
// Every payload is a Buffer, so x-amz-content-sha256 is the real body hash and
// the provider rejects altered bodies. Credentials never appear in errors.
import { createHash, createHmac } from 'node:crypto';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
// RFC 3986 encoding as required by SigV4; S3 object paths are encoded once.
export const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export const encodeKey=key=>key.split('/').map(encode).join('/');
export const isLoopback=hostname=>['localhost','127.0.0.1','[::1]','::1'].includes(hostname);
export function endpointUrl(conn,key=''){
 const base=new URL(conn.endpoint),prefix=base.pathname.replace(/\/+$/,'');
 // Plain HTTP is accepted only on loopback (local MinIO and tests); signed requests and metadata need TLS elsewhere.
 if(base.protocol!=='https:'&&!(base.protocol==='http:'&&isLoopback(base.hostname)))throw Object.assign(new Error('S3 endpoints must use HTTPS (plain HTTP is allowed only on loopback).'),{status:400});
 if(conn.pathStyle)return new URL(base.origin+prefix+'/'+encode(conn.bucket)+(key?'/'+encodeKey(key):''));
 return new URL(base.protocol+'//'+conn.bucket+'.'+base.host+prefix+'/'+encodeKey(key));
}
export function sign(conn,{method,url,headers,payloadHash,date=new Date()}){
 const amzDate=date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''),day=amzDate.slice(0,8),scope=day+'/'+conn.region+'/s3/aws4_request';
 const all={...Object.fromEntries(Object.entries(headers).map(([name,value])=>[name.toLowerCase(),String(value).trim().replace(/\s+/g,' ')])),host:url.host,'x-amz-date':amzDate,'x-amz-content-sha256':payloadHash};
 const names=Object.keys(all).sort(),signed=names.join(';');
 const query=[...url.searchParams].map(([name,value])=>[encode(name),encode(value)]).sort(([a,x],[b,y])=>a<b?-1:a>b?1:x<y?-1:x>y?1:0).map(([name,value])=>name+'='+value).join('&');
 const canonical=[method,url.pathname,query,names.map(name=>name+':'+all[name]+'\n').join(''),signed,payloadHash].join('\n');
 const key=hmac(hmac(hmac(hmac('AWS4'+conn.secretAccessKey,day),conn.region),'s3'),'aws4_request');
 const signature=createHmac('sha256',key).update(['AWS4-HMAC-SHA256',amzDate,scope,sha256(canonical)].join('\n')).digest('hex');
 const {host:_host,...sent}=all;
 return {...sent,authorization:'AWS4-HMAC-SHA256 Credential='+conn.accessKeyId+'/'+scope+', SignedHeaders='+signed+', Signature='+signature};
}
export const xmlValue=(xml,tag)=>xml.match(new RegExp('<'+tag+'>([\\s\\S]*?)</'+tag+'>'))?.[1];
export const xmlValues=(xml,tag)=>[...xml.matchAll(new RegExp('<'+tag+'>([\\s\\S]*?)</'+tag+'>','g'))].map(match=>match[1]);
export const xmlText=value=>value?.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const messages={NoSuchBucket:'The S3 bucket does not exist at this endpoint.',AccessDenied:'S3 access was denied. Check the access key permissions for this bucket and prefix.',InvalidAccessKeyId:'S3 access key ID was not recognised by the endpoint.',SignatureDoesNotMatch:'S3 rejected the request signature. Check the secret access key and region.',AuthorizationHeaderMalformed:'S3 rejected the request region. Check the configured region.',PermanentRedirect:'The bucket is served from another endpoint or region. Check the endpoint and addressing style.',XAmzContentSHA256Mismatch:'S3 detected a corrupted upload body.',PreconditionFailed:'The S3 object changed during publication.',NoSuchUpload:'The S3 multipart upload no longer exists.'};
// Provider statuses never reach DockNest clients: configuration problems are 400, anything else 502.
const configCodes=new Set(['NoSuchBucket','InvalidAccessKeyId','SignatureDoesNotMatch','AccessDenied','AuthorizationHeaderMalformed','PermanentRedirect','ObjectLockConfigurationNotFoundError','InvalidBucketName']);
export function s3Error(s3Status,code){
 // HEAD responses carry no error body; a bare 403 is an authorization failure.
 if(!code&&s3Status===403)code='AccessDenied';
 const safe=/^[A-Za-z]{1,64}$/.test(code||'')?code:undefined;
 const error=new Error(messages[safe]||'S3 request failed ('+(safe||'HTTP '+s3Status)+').');
 return Object.assign(error,{s3Status,s3Code:safe,status:configCodes.has(safe)?400:502,code:s3Status===404&&safe!=='NoSuchBucket'?'ENOENT':safe==='AccessDenied'?'EACCES':'ES3'});
}
const retryable=status=>status===500||status===502||status===503||status===504;
// Sends one signed request. Responses are returned unread unless `text` is requested.
export async function s3Request(conn,{method='GET',key='',query={},headers={},body,text=false,stream=false,timeoutMs=120000,attempts=3}={}){
 const url=endpointUrl(conn,key);
 for(const [name,value] of Object.entries(query))url.searchParams.set(name,value);
 const payload=body===undefined?Buffer.alloc(0):body,payloadHash=sha256(payload);
 for(let attempt=1;;attempt++){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  let response;
  try{response=await fetch(url,{method,headers:sign(conn,{method,url,headers,payloadHash}),body:['GET','HEAD'].includes(method)?undefined:payload,signal:controller.signal,redirect:'manual'});}
  catch(error){clearTimeout(timer);if(attempt<attempts)continue;throw Object.assign(new Error(error?.name==='AbortError'?'S3 request timed out.':'S3 endpoint could not be reached. Check the endpoint URL and network access.'),{code:'ES3UNREACHABLE',s3Code:'Unreachable',status:error?.name==='AbortError'?504:400});}
  // Streams keep their own lifetime; only the time to response headers is bounded.
  if(stream&&response.ok){clearTimeout(timer);return response;}
  try{
   const raw=method==='HEAD'?'':await response.text();
   if(retryable(response.status)&&attempt<attempts){await new Promise(resolve=>setTimeout(resolve,200*attempt));continue;}
   // CopyObject and CompleteMultipartUpload may report failure inside a 200 body.
   const failure=!response.ok||/^\s*(?:<\?xml[^>]*>\s*)?<Error>/.test(raw);
   if(failure)throw s3Error(response.status,xmlValue(raw,'Code')||(response.status===404?'NotFound':undefined));
   return text?{response,text:raw}:response;
  }finally{clearTimeout(timer);}
 }
}
