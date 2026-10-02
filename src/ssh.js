import { Client } from 'ssh2';
import { open } from './crypto.js';
import { readFile } from 'node:fs/promises';
import { sftpWriteStream } from './sftp-streams.js';
import { sftpReadStream } from './sftp-read-stream.js';
const helper = new URL('../remote/helper.py', import.meta.url);
export function connect(server) {
  return new Promise((resolve,reject)=>{
    const client=new Client();
    // SSH can emit a second error while closing a rejected handshake.
    client.on('error',reject).once('ready',()=>resolve(client));
    if (!/^[a-f0-9]{64}$/i.test(server.host_key||'')) return reject(new Error('A verified SHA256 SSH host-key fingerprint is required'));
    client.connect({host:server.host,port:server.port||22,username:server.username,
      privateKey:open(server.private_key),hostHash:'sha256',hostVerifier:hash=>hash.toLowerCase()===server.host_key.toLowerCase(),readyTimeout:15000,keepaliveInterval:10000});
  });
}
export async function remote(server, request, onStage=()=>{}) {
 const client=await connect(server);
 try {
  const source=await readFile(helper,'utf8');
  // Only trusted helper source appears in this fixed command; all inputs use stdin JSON.
  const encoded=Buffer.from(source).toString('base64');
  const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  return await new Promise((resolve,reject)=>{
   client.exec(command,{pty:false},(err,stream)=>{
    if(err)return reject(err);
    let buffer='',result,remoteError;
    stream.on('data',chunk=>{
     buffer+=chunk.toString();
     if(buffer.length>4*1024*1024){stream.destroy();reject(new Error('Remote output exceeds limit'));return;}
     let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const event=JSON.parse(line);if(event.stage)onStage(event.stage);if(event.result)result=event.result;if(event.error)remoteError=event.error;}catch{}}
    });
    stream.stderr.on('data',()=>{}); // Docker output may contain secret environment values.
    stream.once('error',reject);
    stream.once('close',code=>code===0&&result?resolve(result):reject(Object.assign(new Error(remoteError||'Remote helper failed; inspect recovery status before retrying'),{remoteReported:!!remoteError})));
    stream.end(JSON.stringify(request)+'\n');
   });
  });
 } finally {client.end();}
}
export async function download(server,remotePath,output) {
 const client=await connect(server);
 try {return await new Promise((resolve,reject)=>client.sftp((err,sftp)=>{
  if(err)return reject(err);
  const input=sftpReadStream(sftp,remotePath);
  import('node:stream/promises').then(({pipeline})=>pipeline(input,output)).then(resolve,reject);
 }));} finally{client.end();}
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
