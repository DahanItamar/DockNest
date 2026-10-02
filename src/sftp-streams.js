// ssh2's default _final destroys its writable before Node 24 emits finish.
// Close explicitly after finish so pipelines can observe successful completion.
export function sftpWriteStream(sftp,file) {
 const output=sftp.createWriteStream(file,{flags:'wx',mode:0o600,autoClose:false,highWaterMark:1024*1024});
 // ssh2 may report several failed requests to one batched write callback.
 // Node's Writable callback must settle once when a connection drops.
 const writev=output._writev;
 if(typeof writev==='function')output._writev=function(chunks,callback){let settled=false;writev.call(this,chunks,error=>{if(settled)return;settled=true;callback(error);});};
 output.once('finish',()=>output.destroy());
 return output;
}
