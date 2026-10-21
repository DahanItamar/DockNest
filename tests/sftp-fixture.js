// Synthetic, loopback-only SFTP storage for transfer and browser verification.
import ssh2 from 'ssh2';
const {Server,utils}=ssh2,constants=utils.sftp;
import { randomBytes,createHash,generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
// ssh2's generateKeyPairSync('ed25519') strips leading zero bytes from the public key, so about 1 in 256 keys
// is "Malformed OpenSSH private key". Encode the OpenSSH container here from node:crypto key material instead.
const field=value=>{const bytes=Buffer.from(value),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Buffer.concat([length,bytes]);};
export function generateHostKey(){
 const {d,x}=generateKeyPairSync('ed25519').privateKey.export({format:'jwk'}),seed=Buffer.from(d,'base64url'),publicKey=Buffer.from(x,'base64url'),name='ssh-ed25519';
 const check=randomBytes(4),body=Buffer.concat([check,check,field(name),field(publicKey),field(Buffer.concat([seed,publicKey])),field('')]);
 const padding=Buffer.from(Array.from({length:(8-body.length%8)%8},(_,index)=>index+1)),count=Buffer.alloc(4);count.writeUInt32BE(1);
 const blob=Buffer.concat([Buffer.from('openssh-key-v1\0'),field('none'),field('none'),field(''),count,field(Buffer.concat([field(name),field(publicKey)])),field(Buffer.concat([body,padding]))]);
 return '-----BEGIN OPENSSH PRIVATE KEY-----\n'+blob.toString('base64').match(/.{1,70}/g).join('\n')+'\n-----END OPENSSH PRIVATE KEY-----\n';
}
export async function startSftpFixture(){
 const host={private:generateHostKey()},password=randomBytes(32).toString('base64url');
 const files=new Map(),directories=new Set(['/']),clients=new Set(),events=[];
 const faults={writes:false,fsync:false,rename:false,remove:false,corruptReads:false};
 const attrs=file=>({mode:directories.has(file)?0o40700:0o100600,uid:1000,gid:1000,size:files.get(file)?.length||0,atime:1,mtime:1});
 const server=new Server({hostKeys:[host.private]},client=>{
  clients.add(client);client.on('error',()=>{}).on('close',()=>clients.delete(client));
  client.on('authentication',context=>context.username==='fixture'&&context.method==='password'&&context.password===password?context.accept():context.reject());
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();session.on('sftp',accept=>{
    const stream=accept(),handles=new Map();let counter=0;
    // The fixture advertises fsync in ssh2's VERSION packet; requests below
    // use its public SFTP server API. This override is confined to the fixture.
    const protocol=stream._protocol,send=protocol.channelData;
    protocol.channelData=function(channel,packet){
     if(channel===stream.outgoing.id&&packet.length===9&&packet[4]===2){
      const name=Buffer.from('fsync@openssh.com'),value=Buffer.from('1'),extension=Buffer.alloc(8+name.length+value.length);
      extension.writeUInt32BE(name.length);name.copy(extension,4);extension.writeUInt32BE(value.length,4+name.length);value.copy(extension,8+name.length);
      packet=Buffer.concat([packet,extension]);packet.writeUInt32BE(packet.length-4);
     }
     return send.call(this,channel,packet);
    };
    const status=(request,code=constants.STATUS_CODE.OK)=>stream.status(request,code);
    const known=file=>files.has(file)||directories.has(file);
    const fileFor=handle=>handle.length===4?handles.get(handle.readUInt32BE()):undefined;
    for(const operation of ['STAT','LSTAT'])stream.on(operation,(request,file)=>known(file)?stream.attrs(request,attrs(file)):status(request,constants.STATUS_CODE.NO_SUCH_FILE));
    stream.on('REALPATH',(request,file)=>known(file)?stream.name(request,[{filename:path.posix.resolve(file),longname:file,attrs:attrs(file)}]):status(request,constants.STATUS_CODE.NO_SUCH_FILE));
    stream.on('MKDIR',(request,file)=>{if(known(file))return status(request,constants.STATUS_CODE.FAILURE);if(!directories.has(path.posix.dirname(file)))return status(request,constants.STATUS_CODE.NO_SUCH_FILE);directories.add(file);status(request);});
    stream.on('OPEN',(request,file,flags)=>{
     if(flags&constants.OPEN_MODE.CREAT){if(files.has(file)&&(flags&constants.OPEN_MODE.EXCL))return status(request,constants.STATUS_CODE.FAILURE);if(!directories.has(path.posix.dirname(file)))return status(request,constants.STATUS_CODE.NO_SUCH_FILE);files.set(file,Buffer.alloc(0));}
     if(!files.has(file))return status(request,constants.STATUS_CODE.NO_SUCH_FILE);
     const handle=Buffer.alloc(4);handle.writeUInt32BE(counter++);handles.set(handle.readUInt32BE(),file);stream.handle(request,handle);
    });
    stream.on('WRITE',(request,handle,offset,bytes)=>{
     const file=fileFor(handle);if(!file||faults.writes)return status(request,constants.STATUS_CODE.FAILURE);
     const previous=files.get(file),next=Buffer.alloc(Math.max(previous.length,Number(offset)+bytes.length));previous.copy(next);bytes.copy(next,Number(offset));files.set(file,next);events.push({operation:'write',file});status(request);
    });
    stream.on('READ',(request,handle,offset,length)=>{
     const file=fileFor(handle);if(!file)return status(request,constants.STATUS_CODE.FAILURE);
     const data=Buffer.from(files.get(file).subarray(Number(offset),Number(offset)+length));if(!data.length)return status(request,constants.STATUS_CODE.EOF);
     if(faults.corruptReads)data[0]^=1;stream.data(request,data);
    });
    stream.on('FSTAT',(request,handle)=>{const file=fileFor(handle);file?stream.attrs(request,attrs(file)):status(request,constants.STATUS_CODE.FAILURE);});
    stream.on('FSETSTAT',request=>status(request));
    stream.on('CLOSE',(request,handle)=>{handles.delete(handle.readUInt32BE());status(request);});
    stream.on('EXTENDED',(request,name)=>{events.push({operation:'fsync'});status(request,name==='fsync@openssh.com'&&!faults.fsync?constants.STATUS_CODE.OK:constants.STATUS_CODE.FAILURE);});
    stream.on('RENAME',(request,from,to)=>{
     if(faults.rename||!files.has(from)||files.has(to))return status(request,constants.STATUS_CODE.FAILURE);
     files.set(to,files.get(from));files.delete(from);events.push({operation:'rename',from,to});status(request);
    });
    stream.on('REMOVE',(request,file)=>{if(faults.remove)return status(request,constants.STATUS_CODE.FAILURE);if(!files.has(file))return status(request,constants.STATUS_CODE.NO_SUCH_FILE);files.delete(file);events.push({operation:'remove',file});status(request);});
   });
  }));
 });
 server.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>server.once('listening',resolve).once('error',reject));
 return {files,faults,events,options:{host:'127.0.0.1',port:server.address().port,username:'fixture',password,hostKey:createHash('sha256').update(utils.parseKey(host.private).getPublicSSH()).digest('hex')},async close(){for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));}};
}
