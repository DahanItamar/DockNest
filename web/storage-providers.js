// UI presets for the Connect storage dialog. A provider only prefills and hints the existing fields;
// the storage API still receives a plain SFTP or S3 connection.
export const PROVIDER_GROUPS=[
 {label:'Server (SFTP)',items:[
  {id:'own',label:'Own server or NAS',sub:'Linux, Synology, TrueNAS',kind:'sftp',port:22,host:'nas.example.com',username:'',root:'/home/docknest',
   fingerprint:'Read it from a trusted machine or from the server console.',steps:'ssh'},
  {id:'hetzner',label:'Hetzner Storage Box',kind:'sftp',port:23,host:'uXXXXXX.your-storagebox.de',username:'uXXXXXX',root:'/home/docknest',
   fingerprint:'Copy the SHA256 fingerprint from the Storage Box overview in Hetzner Console.',
   steps:'Open Hetzner Console, select your Storage Box, and find its SSH host fingerprints in the overview. Copy the SHA256 fingerprint. This is public server identification, not your password or private key.',
   note:'Port 23 needs SSH support turned on for the Storage Box in Hetzner Console.'},
  {id:'rsyncnet',label:'rsync.net',kind:'sftp',port:22,host:'xxxx.rsync.net',username:'',root:'/data/docknest',
   fingerprint:'Compare it with the host keys rsync.net publishes.',
   steps:'rsync.net publishes the SSH host keys of its servers in its documentation. Copy the SHA256 fingerprint for your server. This is public server identification, not your password or private key.'},
  {id:'sftp',label:'Other SFTP server',kind:'sftp',port:22,host:'sftp.example.com',username:'',root:'/home/docknest',
   fingerprint:'Read it from a trusted machine or from the server console.',steps:'ssh'}]},
 {label:'Cloud storage (S3)',items:[
  {id:'minio',label:'MinIO',sub:'Self-hosted',kind:'s3',endpointPlaceholder:'https://minio.example.com',region:'us-east-1',path:true,
   endpointHelp:'The address of your MinIO server.',regionHelp:'Usually us-east-1.'},
  {id:'aws',label:'Amazon S3',kind:'s3',template:'https://s3.{region}.amazonaws.com',region:'us-east-1',path:false,
   endpointHelp:'Built from the region. Edit it if your bucket uses a different endpoint.',regionHelp:'The AWS region of your bucket.'},
  {id:'r2',label:'Cloudflare R2',kind:'s3',accountId:true,endpointPlaceholder:'https://<account-id>.r2.cloudflarestorage.com',region:'auto',path:true,
   endpointHelp:'Built from the account ID. Edit it if you use a jurisdiction endpoint.',regionHelp:'R2 uses auto.'},
  {id:'b2',label:'Backblaze B2',kind:'s3',template:'https://s3.{region}.backblazeb2.com',region:'us-west-004',path:false,
   endpointHelp:'Built from the region. Shown on your bucket as its S3 endpoint.',regionHelp:'For example us-west-004.'},
  {id:'wasabi',label:'Wasabi',kind:'s3',template:'https://s3.{region}.wasabisys.com',region:'us-east-1',path:false,
   endpointHelp:'Built from the region. Edit it if your bucket uses a different endpoint.',regionHelp:'The region of your bucket.'},
  {id:'s3',label:'Other S3 service',kind:'s3',endpointPlaceholder:'https://s3.example.com',region:'us-east-1',path:true,
   endpointHelp:"Your provider's S3 API endpoint. HTTPS is required.",regionHelp:'Filled in from your endpoint when it names one.'}]}];
export const PROVIDERS=PROVIDER_GROUPS.flatMap(group=>group.items.map(item=>({...item,group:group.label})));
export const DEFAULT_PROVIDER='own';
export const providerById=id=>PROVIDERS.find(item=>item.id===id)||PROVIDERS[0];
// Endpoint a provider preset suggests from the region or Cloudflare account ID; '' when there is nothing to build.
export function suggestedEndpoint(provider,{region,accountId}){
 if(provider.template)return region?provider.template.replace('{region}',region):'';
 if(provider.accountId){const id=String(accountId||'').trim().toLowerCase();return /^[a-z0-9][a-z0-9-]{2,62}$/.test(id)?'https://'+id+'.r2.cloudflarestorage.com':'';}
 return '';
}
