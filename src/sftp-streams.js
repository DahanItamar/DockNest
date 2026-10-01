// ssh2's default _final destroys its writable before Node 24 emits finish.
// Close explicitly after finish so pipelines can observe successful completion.
export function sftpWriteStream(sftp,file) {
 const output=sftp.createWriteStream(file,{flags:'wx',mode:0o600,autoClose:false});
 output.once('finish',()=>output.destroy());
 return output;
}
