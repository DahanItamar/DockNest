// Synthetic, loopback-only S3-compatible endpoint (path-style) for adapter tests.
// It independently verifies SigV4 signatures and body hashes, and models multipart
// uploads, server-side copies, ranges, versions and Object Lock retention.
import http from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const mac=(key,value)=>createHmac('sha256',key).update(value).digest();
const rfc3986=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const xml=(status,code)=>({status,body:'<?xml version="1.0" encoding="UTF-8"?><Error><Code>'+code+'</Code><Message>synthetic</Message></Error>'});
export async function startS3Fixture({bucket='docknest-fixture',region='us-east-1',objectLock=false,defaultRetention=false}={}){
 const credentials={accessKeyId:'AKIAFIXTURE'+randomBytes(4).toString('hex').toUpperCase(),secretAccessKey:randomBytes(30).toString('base64')};
 const objects=new Map(),uploads=new Map(),requests=[],faults={ignoreRange:false,copyError:false,status:null,delayMs:0,minioLockError:false};
 const state={objectLock,defaultRetention};
 function verify(request,url,body){
  const auth=request.headers.authorization||'',match=auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/);
  if(!match)return 'AccessDenied';
  const [,akid,day,signedRegion,signedHeaders,signature]=match;
  if(akid!==credentials.accessKeyId)return 'InvalidAccessKeyId';
  if(signedRegion!==region)return 'AuthorizationHeaderMalformed';
  const amzDate=request.headers['x-amz-date'],payloadHash=request.headers['x-amz-content-sha256'];
  if(!amzDate?.startsWith(day)||!signedHeaders.split(';').includes('host')||!signedHeaders.split(';').includes('x-amz-content-sha256'))return 'AccessDenied';
  if(payloadHash!==sha(body))return 'XAmzContentSHA256Mismatch';
  const query=[...url.searchParams].map(([k,v])=>[rfc3986(k),rfc3986(v)]).sort(([a,x],[b,y])=>a<b?-1:a>b?1:x<y?-1:x>y?1:0).map(([k,v])=>k+'='+v).join('&');
  const headers=signedHeaders.split(';').map(name=>name+':'+String(request.headers[name]??'').trim().replace(/\s+/g,' ')+'\n').join('');
  const canonical=[request.method,url.pathname,query,headers,signedHeaders,payloadHash].join('\n');
  const key=mac(mac(mac(mac('AWS4'+credentials.secretAccessKey,day),region),'s3'),'aws4_request');
  const expected=createHmac('sha256',key).update(['AWS4-HMAC-SHA256',amzDate,day+'/'+region+'/s3/aws4_request',sha(canonical)].join('\n')).digest('hex');
  return expected===signature?null:'SignatureDoesNotMatch';
 }
 const etag=bytes=>'"'+createHash('md5').update(bytes).digest('hex')+'"';
 const locked=object=>object.legalHold||(object.retainUntil&&Date.parse(object.retainUntil)>Date.now());
 function store(key,bytes,headers){
  const object={body:bytes,etag:etag(bytes),versionId:state.objectLock?randomUUID():null,modified:new Date()};
  if(headers['x-amz-object-lock-mode']){if(!state.objectLock)return xml(400,'InvalidRequest');object.lockMode=headers['x-amz-object-lock-mode'];object.retainUntil=headers['x-amz-object-lock-retain-until-date'];}
  else if(state.defaultRetention){object.lockMode='COMPLIANCE';object.retainUntil=new Date(Date.now()+86400000).toISOString();}
  objects.set(key,object);return {status:200,headers:{etag:object.etag,...(object.versionId?{'x-amz-version-id':object.versionId}:{})},body:''};
 }
 function objectHeaders(object){return {'content-length':String(object.body.length),etag:object.etag,'last-modified':object.modified.toUTCString(),...(object.versionId?{'x-amz-version-id':object.versionId}:{}),...(object.lockMode?{'x-amz-object-lock-mode':object.lockMode,'x-amz-object-lock-retain-until-date':object.retainUntil}:{})};}
 function copySource(headers){
  const [source,query]=decodeURIComponent(headers['x-amz-copy-source']).split('?versionId=');
  const key=source.replace('/'+bucket+'/',''),object=objects.get(key);
  if(!object||(query&&object.versionId!==query))return {error:xml(404,'NoSuchKey')};
  if(headers['x-amz-copy-source-if-match']&&headers['x-amz-copy-source-if-match']!==object.etag)return {error:xml(412,'PreconditionFailed')};
  return {object};
 }
 function handle(request,url,body){
  const path=decodeURIComponent(url.pathname),q=url.searchParams,h=request.headers;
  if(!path.startsWith('/'+bucket))return xml(404,'NoSuchBucket');
  const key=path.slice(bucket.length+2);
  if(!key){
   if(request.method==='HEAD')return {status:200,body:''};
   if(q.has('object-lock'))return state.objectLock?{status:200,body:'<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled>'+(state.defaultRetention?'<Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>1</Days></DefaultRetention></Rule>':'')+'</ObjectLockConfiguration>'}:xml(404,'ObjectLockConfigurationNotFoundError');
   if(q.get('list-type')==='2'){const prefix=q.get('prefix')||'',keys=[...objects.keys()].filter(name=>name.startsWith(prefix)).sort();return {status:200,body:'<ListBucketResult><IsTruncated>false</IsTruncated>'+keys.map(name=>'<Contents><Key>'+name+'</Key><Size>'+objects.get(name).body.length+'</Size></Contents>').join('')+'</ListBucketResult>'};}
   return xml(400,'InvalidRequest');
  }
  const object=objects.get(key);
  if(request.method==='HEAD')return object?{status:200,headers:objectHeaders(object),body:''}:{status:404,body:''};
  if(request.method==='GET'){
   if(!object)return xml(404,'NoSuchKey');
   const range=h.range?.match(/^bytes=(\d+)-(\d*)$/);
   if(!range||faults.ignoreRange)return {status:200,headers:objectHeaders(object),body:object.body};
   const start=Number(range[1]),end=Math.min(range[2]?Number(range[2]):object.body.length-1,object.body.length-1);
   if(start>=object.body.length)return xml(416,'InvalidRange');
   const slice=object.body.subarray(start,end+1);
   return {status:206,headers:{...objectHeaders(object),'content-length':String(slice.length),'content-range':'bytes '+start+'-'+end+'/'+object.body.length},body:slice};
  }
  if(request.method==='POST'&&q.has('uploads')){const uploadId=randomUUID();uploads.set(uploadId,{key,parts:new Map(),headers:{...h}});return {status:200,body:'<InitiateMultipartUploadResult><UploadId>'+uploadId+'</UploadId></InitiateMultipartUploadResult>'};}
  if(request.method==='POST'&&q.has('uploadId')){
   const upload=uploads.get(q.get('uploadId'));if(!upload)return xml(404,'NoSuchUpload');
   const listed=[...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)].map(([,n,e])=>[Number(n),e.replace(/&quot;/g,'"')]);
   if(!listed.length||listed.some(([n,e])=>upload.parts.get(n)?.etag!==e))return {status:200,body:'<Error><Code>InvalidPart</Code></Error>'};
   uploads.delete(q.get('uploadId'));const result=store(key,Buffer.concat(listed.map(([n])=>upload.parts.get(n).body)),upload.headers);
   return {...result,body:'<CompleteMultipartUploadResult><ETag>&quot;multipart&quot;</ETag></CompleteMultipartUploadResult>'};
  }
  if(request.method==='PUT'&&q.has('uploadId')){
   const upload=uploads.get(q.get('uploadId'));if(!upload)return xml(404,'NoSuchUpload');
   let bytes=body;
   if(h['x-amz-copy-source']){const {object:source,error}=copySource(h);if(error)return error;const [,a,b]=h['x-amz-copy-source-range'].match(/bytes=(\d+)-(\d+)/);bytes=source.body.subarray(Number(a),Number(b)+1);}
   const part={body:Buffer.from(bytes),etag:etag(bytes)};upload.parts.set(Number(q.get('partNumber')),part);
   return h['x-amz-copy-source']?{status:200,body:'<CopyPartResult><ETag>'+part.etag+'</ETag></CopyPartResult>'}:{status:200,headers:{etag:part.etag},body:''};
  }
  if(request.method==='PUT'&&h['x-amz-copy-source']){
   if(faults.copyError)return {status:200,body:'<Error><Code>InternalError</Code></Error>'};
   const {object:source,error}=copySource(h);if(error)return error;
   const result=store(key,Buffer.from(source.body),h);return {...result,body:result.status===200?'<CopyObjectResult><ETag>'+source.etag+'</ETag></CopyObjectResult>':result.body};
  }
  if(request.method==='PUT')return store(key,Buffer.from(body),h);
  if(request.method==='DELETE'&&q.has('uploadId')){uploads.delete(q.get('uploadId'));return {status:204,body:''};}
  if(request.method==='DELETE'){
   if(!object)return {status:204,body:''};
   if(q.has('versionId')&&q.get('versionId')!==object.versionId)return {status:204,body:''};
   if(locked(object))return faults.minioLockError?xml(400,'InvalidRequest'):xml(403,'AccessDenied');
   objects.delete(key);return {status:204,body:''};
  }
  return xml(405,'MethodNotAllowed');
 }
 const server=http.createServer((request,response)=>{
  const chunks=[];
  request.on('data',chunk=>chunks.push(chunk)).on('end',()=>{
   const body=Buffer.concat(chunks),url=new URL(request.url,'http://'+request.headers.host);
   requests.push({method:request.method,path:decodeURIComponent(url.pathname),query:Object.fromEntries(url.searchParams),headers:{...request.headers},size:body.length});
   const forced=faults.status&&{status:faults.status.status,body:faults.status.code?xml(faults.status.status,faults.status.code).body:''};
   const denied=verify(request,url,body),result=forced?forced:denied?xml(denied==='XAmzContentSHA256Mismatch'?400:403,denied):handle(request,url,body);
   const send=()=>{response.writeHead(result.status,result.headers||{});response.end(request.method==="HEAD"?undefined:result.body);};faults.delayMs?setTimeout(send,faults.delayMs):send();
  });
 });
 server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));
 const endpoint='http://127.0.0.1:'+server.address().port;
 return {objects,uploads,requests,faults,state,credentials,options:{endpoint,region,bucket,pathStyle:true,...credentials},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
