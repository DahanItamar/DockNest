import { Readable } from 'node:stream';

// Keep requests bounded and deliver their results in file order, even if SFTP
// completes them out of order. Only a small window lives in manager memory.
export function sftpReadStream(sftp,file,{start=0,end}={}){
 if(!Number.isSafeInteger(start)||start<0||(end!==undefined&&(!Number.isSafeInteger(end)||end<start)))throw new Error('Invalid SFTP read range');
 const chunkSize=64*1024,windowSize=16;
 let handle,position=start,next=start,limit,inflight=0,demand=false;
 const ready=new Map();
 const stream=new Readable({highWaterMark:128*1024,
  construct(callback){
   sftp.open(file,'r',(error,value)=>{
    if(error)return callback(error);handle=value;
    sftp.fstat(handle,(error,attrs)=>{
     if(error)return callback(error);
     if(!Number.isSafeInteger(attrs.size)||attrs.size<0)return callback(new Error('Invalid SFTP file size'));
     limit=Math.min(end===undefined?attrs.size:end+1,attrs.size);callback();
    });
   });
  },
  read(){demand=true;pump();},
  destroy(error,callback){ready.clear();if(!handle)return callback(error);const value=handle;handle=null;sftp.close(value,closeError=>callback(error||closeError));}
 });
 function pump(){
  if(stream.destroyed||limit===undefined)return;
  while(demand&&ready.has(position)){
   const chunk=ready.get(position);ready.delete(position);position+=chunk.length;
   if(!stream.push(chunk))demand=false;
  }
  if(position>=limit){stream.push(null);return;}
  while(demand&&next<limit&&inflight+ready.size<windowSize){
   const offset=next,length=Math.min(chunkSize,limit-next);next+=length;inflight++;
   const buffer=Buffer.allocUnsafe(length);let filled=0;
   function readPart(){
    if(stream.destroyed)return;
    sftp.read(handle,buffer,filled,length-filled,offset+filled,(error,bytes)=>{
     if(stream.destroyed)return;
     if(error)return stream.destroy(error);
     if(!Number.isInteger(bytes)||bytes<=0||bytes>length-filled)return stream.destroy(new Error('SFTP file ended before the requested range'));
     filled+=bytes;
     if(filled<length)return readPart();
     inflight--;ready.set(offset,buffer);pump();
    });
   }
   readPart();
  }
 }
 return stream;
}
