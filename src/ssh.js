import { Client } from 'ssh2';
import { Transform } from 'node:stream';
import { open } from './crypto.js';
import { readFile } from 'node:fs/promises';
import { sftpWriteStream } from './sftp-streams.js';
import { sftpReadStream } from './sftp-read-stream.js';
import { pipeline } from 'node:stream/promises';
const helper = new URL('../remote/helper.py', import.meta.url);
export function connect(server) {
  return new Promise((resolve,reject)=>{
    const client=new Client();
    // SSH can emit a second error while closing a rejected handshake.
    client.on('error',reject).once('ready',()=>resolve(client));
    if (!/^[a-f0-9]{64}$/i.test(server.host_key||'')) return reject(new Error('A verified SHA256 SSH host-key fingerprint is required'));
    client.connect({host:server.host,port:server.port||22,username:server.username,
      privateKey:open(server.private_key),hostHash:'sha256',hostVerifier:hash=>hash.toLowerCase()===server.host_key.toLowerCase(),readyTimeout:15000,keepaliveInterval:10000,keepaliveCountMax:10});
  });
}
export async function remote(server, request, onStage=()=>{}, onDiagnostic=()=>{}) {
 const client=await connect(server);
 try {
  const source=await readFile(helper,'utf8');
  // Send trusted code and request through stdin; a fixed loader avoids shell
  // argument limits as the helper grows. Request values never enter the command.
  const encoded=Buffer.from(source).toString('base64');
  const command = 'python3 -c "import base64,sys;exec(compile(base64.b64decode(sys.stdin.readline()),\'<docknest-helper>\',\'exec\'))"';
  return await new Promise((resolve,reject)=>{
   client.exec(command,{pty:false},(err,stream)=>{
    if(err)return reject(err);
    let buffer='',result,remoteError;
    stream.on('data',chunk=>{
     buffer+=chunk.toString();
     if(buffer.length>4*1024*1024){stream.destroy();reject(new Error('Remote output exceeds limit'));return;}
     let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const event=JSON.parse(line);if(event.stage)onStage(event.stage);if(event.diagnostic)onDiagnostic(event.diagnostic);if(event.result)result=event.result;if(event.error)remoteError=event.error;}catch{}}
    });
    stream.stderr.on('data',()=>{}); // Docker output may contain secret environment values.
    stream.once('error',reject);
    stream.once('close',code=>code===0&&result?resolve(result):reject(Object.assign(new Error(remoteError||'Remote helper failed; inspect recovery status before retrying'),{remoteReported:!!remoteError})));
    stream.end(encoded+'\n'+JSON.stringify(request)+'\n');
   });
  });
 } finally {client.end();}
}
export async function download(server,remotePath,output,onProgress=null) {
 const client=await connect(server);
 try {return await new Promise((resolve,reject)=>client.sftp((err,sftp)=>{
  if(err)return reject(err);
  const input=sftpReadStream(sftp,remotePath);
  if(onProgress){
   let done=0,total=null;sftp.stat(remotePath,(error,stats)=>{if(!error)total=stats.size;onProgress({done,total});});
   const counter=new Transform({transform(chunk,_e,cb){done+=chunk.length;onProgress({done,total});cb(null,chunk);},flush(cb){onProgress({done,total,final:true});cb();}});
   import('node:stream/promises').then(({pipeline})=>pipeline(input,counter,output)).then(resolve,reject);
   return;
  }
  import('node:stream/promises').then(({pipeline})=>pipeline(input,output)).then(resolve,reject);
 }));} finally{client.end();}
}

// Binary stdout and bounded JSON stderr use independent SSH channels. Never log
// stderr: the final in-memory manifest contains secret container configuration.
export async function remoteCaptureStream(server,request,output,onStage=()=>{},onDiagnostic=()=>{},onProgress=()=>{}) {
 const client=await connect(server);
 try {
  const encoded=Buffer.from(await readFile(helper,'utf8')).toString('base64');
  const command='python3 -c "import base64,sys;exec(compile(base64.b64decode(sys.stdin.readline()),\'<docknest-helper>\',\'exec\'))"';
  return await new Promise((resolve,reject)=>client.exec(command,{pty:false},(error,stream)=>{
   if(error)return reject(error);
   let buffer='',result,remoteError,transportError;
   stream.stderr.on('data',chunk=>{
    buffer+=chunk.toString();
    if(buffer.length>4*1024*1024){transportError=new Error('Remote control output exceeds limit');stream.destroy();reject(transportError);return;}
    let n;
    while((n=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,n);buffer=buffer.slice(n+1);
     try{const event=JSON.parse(line);if(event.stage)onStage(event.stage);if(event.diagnostic)onDiagnostic(event.diagnostic);if(event.progress)onProgress(event.progress);if(event.result)result=event.result;if(event.error)remoteError=event.error;}catch{}
    }
   });
   const storageFailed=cause=>{stream.destroy();reject(Object.assign(new Error('Direct capture storage failed; inspect recovery status before retrying'),{cause}));};
   output.once('error',storageFailed);
   const writing=pipeline(stream,output);
   writing.catch(error=>{transportError=error;stream.destroy();reject(Object.assign(new Error('Direct capture transport or storage failed; inspect recovery status before retrying'),{cause:error}));});
   stream.once('error',error=>{transportError=error;reject(Object.assign(new Error('Direct capture transport failed; inspect recovery status before retrying'),{cause:error}));});
   stream.once('close',async code=>{
    await writing.catch(()=>{});
    output.off('error',storageFailed);
    if(!transportError&&code===0&&result?.streamed&&result.manifest?.complete)return resolve(result);
    reject(Object.assign(new Error(remoteError||'Direct capture failed; inspect recovery status before retrying'),{remoteReported:!!remoteError}));
   });
   stream.end(encoded+'\n'+JSON.stringify({...request,operation:'capture-stream'})+'\n');
  }));
 } finally {client.end();}
}

export async function upload(server,localPath,remotePath) {
 const client=await connect(server);
 try{return await new Promise((resolve,reject)=>client.sftp((err,sftp)=>{
  if(err)return reject(err);
  import('node:stream/promises').then(async({pipeline})=>{
   const {createReadStream}=await import('node:fs');
   await pipeline(createReadStream(localPath),sftpWriteStream(sftp,remotePath));
  }).then(resolve,reject);
 }));}finally{client.end();}
}
export async function uploadStream(server,input,remotePath) {
 const client=await connect(server);
 try{return await new Promise((resolve,reject)=>client.sftp((error,sftp)=>{
  if(error)return reject(error);
  import('node:stream/promises').then(({pipeline})=>pipeline(input,sftpWriteStream(sftp,remotePath))).then(resolve,reject);
 }));}finally{client.end();}
}
