// S3-compatible adapter (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO ...).
// Publication semantics (see docs/storage-backends.md):
//  - openWrite streams to the temporary key with multipart upload; at most one
//    part is buffered. The object only exists once PUT/CompleteMultipartUpload
//    succeeds, which S3 defines as durable and atomic, so syncFile is a HEAD.
//  - renameFile is a server-side copy bound to the authenticated temporary object
//    with x-amz-copy-source-if-match, refuses an existing destination, applies
//    Object Lock retention when configured, verifies the destination with HEAD
//    and then removes the exact temporary version.
//  - removeFile refuses objects still under Object Lock retention (EOBJECTLOCKED).
import path from 'node:path';
import { Writable, Readable, Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { s3Request, xmlValue, xmlValues, xmlText, encode, encodeKey } from './s3-client.js';

export const scheme='s3',label='S3-compatible';
// Part sizes grow every 1,000 parts so 10,000 parts reach ~440 GB with 8 MiB
// first parts while memory stays bounded by one part.
export const limits={partSize:8*1024*1024,maxParts:10000,copyLimit:5*1024**3,copyPartSize:512*1024*1024};
const partSize=number=>limits.partSize*(1+Math.floor((number-1)/1000));
const conn=options=>({endpoint:options.endpoint,region:options.region,bucket:options.bucket,pathStyle:options.pathStyle,accessKeyId:options.accessKeyId,secretAccessKey:options.secretAccessKey});
const rootDir=options=>options.root==='/'?'':options.root.replace(/\/+$/,'');
const keyOf=value=>value.slice(1);
export function resolve(options,remote){
 const normalized=path.posix.resolve(remote);
 if(!normalized.startsWith(rootDir(options)+'/')||normalized===rootDir(options)+'/')throw new Error('Backup path is outside managed S3 storage');
 return normalized;
}
const missing=error=>error?.code==='ENOENT';
export function lockedError(retainUntil){return Object.assign(new Error('S3 Object Lock retention keeps this object until '+retainUntil+'; deletion is refused until then.'),{code:'EOBJECTLOCKED',retainUntil});}
function attributes(response){
 const header=name=>response.headers.get(name);
 const size=Number(header('content-length'));
 if(!Number.isSafeInteger(size)||size<0)throw new Error('S3 did not report a valid object size');
 return {size,mtime:new Date(header('last-modified')||0),etag:header('etag'),versionId:header('x-amz-version-id')||null,lockMode:header('x-amz-object-lock-mode')||null,retainUntil:header('x-amz-object-lock-retain-until-date')||null,legalHold:header('x-amz-object-lock-legal-hold')==='ON',isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
}
const head=(options,key)=>s3Request(conn(options),{method:'HEAD',key}).then(attributes);
export const statFile=(options,value)=>head(options,keyOf(value));
async function absent(options,key){try{await head(options,key);}catch(error){if(missing(error))return true;throw error;}return false;}
// S3 has no directories; prefixes appear with their first object.
export async function makeDirectory(){}
export async function syncFile(options,value){await statFile(options,value);}
export async function openRead(options,value,{start,end}={}){
 if((start!==undefined&&(!Number.isSafeInteger(start)||start<0))||(end!==undefined&&(!Number.isSafeInteger(end)||end<(start||0))))throw new Error('Invalid S3 read range');
 const ranged=start!==undefined||end!==undefined,headers=ranged?{range:'bytes='+(start||0)+'-'+(end===undefined?'':end)}:{};
 const response=await s3Request(conn(options),{key:keyOf(value),headers,stream:true});
 // Ranges must be honoured exactly: a full-object reply would misalign GCM offsets.
 const contentRange=response.headers.get('content-range')||'';
 if(ranged&&(response.status!==206||Number(contentRange.match(/^bytes (\d+)-/)?.[1])!==(start||0))){await response.body?.cancel();throw new Error('S3 endpoint ignored the requested byte range');}
 const expected=Number(response.headers.get('content-length'));let received=0;
 const check=new Transform({transform(chunk,_e,callback){received+=chunk.length;callback(null,chunk);},flush(callback){callback(Number.isSafeInteger(expected)&&received!==expected?new Error('S3 object ended before the requested range'):null);}});
 const body=Readable.fromWeb(response.body);body.once('error',error=>check.destroy(error));check.once('close',()=>body.destroy());
 return body.pipe(check);
}
// Streams to a temporary key. Each part waits for upload before more input is
// accepted, so memory is bounded by the current part size.
export function openWrite(options,value,{forceMultipart=false}={}){
 const key=keyOf(value),client=conn(options);
 let chunks=[],buffered=0,uploadId=null,number=0,written=0,completed=false;const parts=[];
 async function uploadPart(){
  if(!uploadId){
   const {text}=await s3Request(client,{method:'POST',key,query:{uploads:''},headers:{'content-type':'application/octet-stream'},text:true});
   uploadId=xmlText(xmlValue(text,'UploadId'));if(!uploadId)throw new Error('S3 did not start the multipart upload');
  }
  if(++number>limits.maxParts)throw new Error('Backup exceeds the S3 multipart part limit');
  const body=Buffer.concat(chunks,buffered);chunks=[];buffered=0;
  const response=await s3Request(client,{method:'PUT',key,query:{partNumber:String(number),uploadId},body,timeoutMs:600000});
  const etag=response.headers.get('etag');if(!etag)throw new Error('S3 did not acknowledge an uploaded part');
  parts.push({number,etag});
 }
 return new Writable({highWaterMark:1024*1024,
  construct(callback){absent(options,key).then(ok=>callback(ok?null:Object.assign(new Error('S3 destination object already exists'),{code:'EEXIST'})),callback);},
  write(chunk,_e,callback){chunks.push(chunk);buffered+=chunk.length;written+=chunk.length;if(buffered<partSize(number+1))return callback();uploadPart().then(()=>callback(),callback);},
  final(callback){(async()=>{
   if(!uploadId&&!forceMultipart){await s3Request(client,{method:'PUT',key,headers:{'content-type':'application/octet-stream'},body:Buffer.concat(chunks,buffered),timeoutMs:600000});chunks=[];}
   else{
    if(buffered||!parts.length)await uploadPart();
    const body=Buffer.from('<CompleteMultipartUpload>'+parts.map(part=>'<Part><PartNumber>'+part.number+'</PartNumber><ETag>'+part.etag.replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'</ETag></Part>').join('')+'</CompleteMultipartUpload>');
    await s3Request(client,{method:'POST',key,query:{uploadId},headers:{'content-type':'application/xml'},body,timeoutMs:600000});
   }
   completed=true;
   if((await head(options,key)).size!==written)throw new Error('S3 object size does not match the uploaded bytes');
  })().then(()=>callback(),callback);},
  destroy(error,callback){
   chunks=[];
   if(!uploadId||completed)return callback(error);
   s3Request(client,{method:'DELETE',key,query:{uploadId}}).catch(()=>{}).finally(()=>callback(error));
  }
 });
}
function lockHeaders(options){
 if(!options.objectLock)return {};
 return {'x-amz-object-lock-mode':options.objectLock.mode,'x-amz-object-lock-retain-until-date':new Date(Date.now()+options.objectLock.days*86400000).toISOString().replace(/\.\d{3}Z$/,'Z')};
}
// Server-side copy pinned to the source version and ETag that were authenticated.
async function copyObject(options,from,source,to,extra={}){
 const client=conn(options),copySource='/'+encode(options.bucket)+'/'+encodeKey(from)+(source.versionId&&source.versionId!=='null'?'?versionId='+encode(source.versionId):''),match={'x-amz-copy-source':copySource,'x-amz-copy-source-if-match':source.etag};
 if(source.size<=limits.copyLimit)return s3Request(client,{method:'PUT',key:to,headers:{...match,'x-amz-metadata-directive':'COPY',...extra},timeoutMs:3600000});
 const {text}=await s3Request(client,{method:'POST',key:to,query:{uploads:''},headers:{'content-type':'application/octet-stream',...extra},text:true});
 const uploadId=xmlText(xmlValue(text,'UploadId')),parts=[],size=Math.max(limits.copyPartSize,Math.ceil(source.size/limits.maxParts));
 try{
  for(let offset=0,number=1;offset<source.size;offset+=size,number++){
   const {text:part}=await s3Request(client,{method:'PUT',key:to,query:{partNumber:String(number),uploadId},headers:{...match,'x-amz-copy-source-range':'bytes='+offset+'-'+(Math.min(source.size,offset+size)-1)},text:true,timeoutMs:3600000});
   parts.push('<Part><PartNumber>'+number+'</PartNumber><ETag>'+xmlValue(part,'ETag')+'</ETag></Part>');
  }
  await s3Request(client,{method:'POST',key:to,query:{uploadId},headers:{'content-type':'application/xml'},body:Buffer.from('<CompleteMultipartUpload>'+parts.join('')+'</CompleteMultipartUpload>'),timeoutMs:3600000});
 }catch(error){await s3Request(client,{method:'DELETE',key:to,query:{uploadId}}).catch(()=>{});throw error;}
}
export async function deleteVersion(options,key,versionId){
 try{await s3Request(conn(options),{method:'DELETE',key,query:versionId?{versionId}:{}});}
 catch(error){
  // Providers word a locked-version refusal differently (AWS: AccessDenied, MinIO: InvalidRequest), so
  // classify by the object's own retention headers rather than by error code.
  if(versionId&&[400,403].includes(error.s3Status)){
   const attrs=await head(options,key).catch(()=>null);
   if(attrs?.legalHold)throw Object.assign(new Error('S3 Object Lock legal hold prevents deletion.'),{code:'EOBJECTLOCKED',retainUntil:null});
   if(attrs?.retainUntil&&Date.parse(attrs.retainUntil)>Date.now())throw lockedError(attrs.retainUntil);
  }
  throw error;
 }
}
export async function renameFile(options,fromValue,toValue,{lock=true}={}){
 const from=keyOf(fromValue),to=keyOf(toValue),source=await head(options,from);
 if(!await absent(options,to))throw Object.assign(new Error('S3 destination object already exists'),{code:'EEXIST'});
 const extra=lock?lockHeaders(options):{};
 await copyObject(options,from,source,to,extra);
 const published=await head(options,to);
 if(published.size!==source.size)throw new Error('S3 published object size does not match the authenticated upload');
 if(extra['x-amz-object-lock-mode']&&(published.lockMode!==extra['x-amz-object-lock-mode']||!(Date.parse(published.retainUntil)>=Date.parse(extra['x-amz-object-lock-retain-until-date'])-1000)))throw new Error('S3 Object Lock retention was not applied to the published object');
 // The published copy is durable; a leftover temporary object is only wasted space.
 try{await deleteVersion(options,from,source.versionId);}catch{/* Removed later by cleanup or bucket lifecycle rules. */}
}
export async function removeFile(options,value){
 const key=keyOf(value),attrs=await head(options,key);
 if(attrs.legalHold)throw Object.assign(new Error('S3 Object Lock legal hold prevents deletion.'),{code:'EOBJECTLOCKED',retainUntil:null});
 if(attrs.retainUntil&&Date.parse(attrs.retainUntil)>Date.now())throw lockedError(attrs.retainUntil);
 await deleteVersion(options,key,attrs.versionId);
}
export async function removeDirectory(options,value){
 for(const name of ['payload.enc.partial','payload.enc']){try{await removeFile(options,value+'/'+name);}catch(error){if(!missing(error))throw error;}}
}
// Lists object keys below a managed directory as storage references' values.
export async function list(options,value){
 const files=[];let token;
 do{
  const query={'list-type':'2',prefix:keyOf(value).replace(/\/?$/,'/')};if(token)query['continuation-token']=token;
  const {text}=await s3Request(conn(options),{query,text:true});
  for(const item of xmlValues(text,'Contents'))files.push({value:'/'+xmlText(xmlValue(item,'Key')),size:Number(xmlValue(item,'Size'))});
  token=xmlValue(text,'IsTruncated')==='true'?xmlText(xmlValue(text,'NextContinuationToken')):null;
 }while(token);
 return files;
}
export async function readiness(options){try{await s3Request(conn(options),{method:'HEAD'});}catch(error){if(error.s3Status===404)throw Object.assign(new Error('The S3 bucket does not exist at this endpoint.'),{status:400});throw error;}}
// Bucket-level Object Lock state: {enabled, defaultRetention} or null when unsupported.
async function lockConfiguration(options){
 try{const {text}=await s3Request(conn(options),{query:{'object-lock':''},text:true});return {enabled:xmlValue(text,'ObjectLockEnabled')==='Enabled',defaultRetention:/<DefaultRetention>/.test(text)};}
 catch(error){
  if(error.s3Code==='ObjectLockConfigurationNotFoundError'||(error.s3Status===404&&error.s3Code!=='NoSuchBucket'))return {enabled:false,defaultRetention:false};
  // Providers without the API, or keys without permission to read it: unknown, not fatal unless requested.
  if(error.s3Status===501||['NotImplemented','AccessDenied','MethodNotAllowed'].includes(error.s3Code))return null;
  throw error;
 }
}
export async function test(options){
 const lock=await lockConfiguration(options);
 if(options.objectLock&&!lock?.enabled)throw Object.assign(new Error(lock?'Object Lock is not enabled on this bucket. Create the bucket with Object Lock enabled or turn off immutable copies.':'Object Lock configuration could not be verified for this bucket.'),{status:400});
 // Default retention would also lock temporary uploads and probes, making them undeletable.
 if(lock?.defaultRetention)throw Object.assign(new Error('Remove the bucket default retention rule. DockNest applies Object Lock retention to published backups only.'),{status:400});
 const temporary=rootDir(options)+'/.docknest-probe-'+randomUUID(),published=temporary+'.verified',content=Buffer.from('DockNest storage probe');
 try{
  await new Promise((resolve,reject)=>{const output=openWrite(options,temporary,{forceMultipart:true});output.once('error',reject).once('finish',resolve);output.end(content);});
  if((await statFile(options,temporary)).size!==content.length)throw new Error('Storage write verification failed');
  await renameFile(options,temporary,published,{lock:false});
  const read=async range=>{const parts=[];for await(const chunk of await openRead(options,published,range))parts.push(chunk);return Buffer.concat(parts).toString();};
  if(await read()!==content.toString())throw new Error('Storage read verification failed');
  if(await read({start:9,end:15})!=='storage')throw new Error('Storage ranged read verification failed');
  await removeFile(options,published);
  if(!await absent(options,keyOf(published)))throw new Error('Storage delete verification failed');
  return {connected:true,writeVerified:true,multipartVerified:true,copyVerified:true,readVerified:true,rangeVerified:true,deleteVerified:true,objectLock:options.objectLock?'enabled':lock?.enabled?'available':'not-requested'};
 }finally{for(const value of [temporary,published]){try{await removeFile(options,value);}catch(error){if(!missing(error))throw error;}}}
}
export async function capacity(options,{managedBytes=0}={}){
 // Object storage has no fixed size to report; usage is DockNest's own tracked bytes.
 return {used:managedBytes,total:null,available:null,unbounded:true,capacitySource:'object-storage',estimated:false,backend:'s3',targetId:options.id,name:options.name||'S3 bucket'};
}
