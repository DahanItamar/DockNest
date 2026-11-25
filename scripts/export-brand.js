import {chromium} from '@playwright/test';
import {readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Export the approved raster. Never redraw or independently regenerate glyphs.
const folder='docs/design/homebird-brand';
const manifest=JSON.parse(await readFile(folder+'/asset-manifest.json','utf8'));
const master=await readFile(folder+'/'+manifest.filename);
const hash=createHash('sha256').update(master).digest('hex');
if(hash!==manifest.sha256)throw Error('Source checksum mismatch');
if(master.readUInt32BE(16)!==2172||master.readUInt32BE(20)!==724)throw Error('Approved source geometry mismatch');
let version=hash.slice(0,10);const outputs=[];
// 3.0.0 accents: the approved masters keep their shape; only the hue moves to each accent's logo colour from web/tokens.css
// (--dn-brand-logo: step 9 on light, step 10 on dark). Teal is the default and also feeds the favicon and app icons.
const ACCENTS=['teal','blue','indigo','orange','pink'];
const tokenCss=await readFile('web/tokens.css','utf8');
function logoColor(accent,dark){
 const selector=accent==='teal'?(dark?':root[data-theme=dark]':':root'):':root[data-accent='+accent+']'+(dark?'[data-theme=dark]':'');
 // The block of this selector that defines the logo colour (the plain :root selector also opens other blocks).
 for(let start=tokenCss.indexOf(selector+'{');start>=0;start=tokenCss.indexOf(selector+'{',start+1)){
  const match=/--dn-brand-logo:(#[0-9A-Fa-f]{6})/.exec(tokenCss.slice(start,tokenCss.indexOf('}',start)));
  if(match)return match[1];
 }
 throw Error('No --dn-brand-logo in '+selector);
}
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();
 // Hue-shift the coloured pixels of a master to a target colour, keeping the alpha, so the shape is untouched. Lightness is kept, so the light and
 // dark masters keep their own contrast; saturation is scaled to the target colour.
 async function recolor(buffer,target,wordmark=false){
  const bytes=await page.evaluate(async({data,target,wordmark})=>{
   const image=new Image();image.src=data;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
   const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
   const frame=ctx.getImageData(0,0,canvas.width,canvas.height),px=frame.data;
   const toHsl=(r,g,b)=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2,d=max-min;if(!d)return[0,0,l];const s=d/(1-Math.abs(2*l-1));let h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;h=(h*60+360)%360;return[h,s,l]};
   const toRgb=(h,s,l)=>{const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2;const[r,g,b]=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];return[(r+m)*255,(g+m)*255,(b+m)*255]};
   const hex=target,[tr,tg,tb]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)),[th,ts,tl]=toHsl(tr,tg,tb);
   // One flat fill: every coloured pixel of the mark and the wordmark takes exactly the target colour (--dn-brand-logo), alpha untouched,
   // so the mark and the wordmark can never differ. Near-grey fringe pixels are left alone.
   for(let i=0;i<px.length;i+=4){
    if(!px[i+3])continue;const[,s]=toHsl(px[i],px[i+1],px[i+2]);if(s<=.12)continue;
    px[i]=tr;px[i+1]=tg;px[i+2]=tb;
   }
   ctx.putImageData(frame,0,0);return canvas.toDataURL('image/png').split(',')[1];
  },{data:'data:image/png;base64,'+buffer.toString('base64'),target,wordmark});
  return Buffer.from(bytes,'base64');
 }
 const original=await recolor(master,logoColor('teal',false),true);
 version=createHash('sha256').update(original).digest('hex').slice(0,10);
 const source=await page.evaluate(async data=>{
  const image=new Image();image.src=data;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  let left=canvas.width,top=canvas.height,right=-1,bottom=-1,partial=0,occupied=0,white=0;
  const columns=new Uint8Array(canvas.width);
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
   const p=(y*canvas.width+x)*4,a=pixels[p+3];
   if(a>=16){occupied++;columns[x]=1;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);if(a<240)partial++;if(pixels[p]>225&&pixels[p+1]>225&&pixels[p+2]>225)white++;}
  }
  if(left>=right||occupied>=canvas.width*canvas.height*.8)throw Error('Master has no transparent clear space');
  if(white/occupied>.005||partial/occupied>.08)throw Error('Master has a visible fringe or softened alpha');
  let start=-1,gapStart=-1,gapEnd=-1;
  for(let x=left+Math.floor((right-left)*.08);x<left+Math.floor((right-left)*.4);x++){
   if(!columns[x]&&start<0)start=x;
   if(columns[x]&&start>=0){if(x-start>gapEnd-gapStart){gapStart=start;gapEnd=x;}start=-1;}
  }
  if(gapEnd-gapStart<8)throw Error('Bird-to-wordmark corridor not found');
  let birdTop=canvas.height,birdBottom=-1;
  for(let y=0;y<canvas.height;y++)for(let x=left;x<gapStart;x++)if(pixels[(y*canvas.width+x)*4+3]>=16){birdTop=Math.min(birdTop,y);birdBottom=Math.max(birdBottom,y);}
  const pad=8;
  const crop=(l,t,r,b)=>({left:Math.max(0,l-pad),top:Math.max(0,t-pad),width:r-l+1+pad*2,height:b-t+1+pad*2});
  return{full:crop(left,top,right,bottom),bird:crop(left,birdTop,gapStart-1,birdBottom),alpha:{occupied,partial,white,pixels:canvas.width*canvas.height}};
 },'data:image/png;base64,'+original.toString('base64'));
 async function exportImage(filename,{width,size,mark=false,background,fill=.82,maskable=false,mime='image/png',sourceImage=original,sourceCrop}={}){
  const crop=sourceCrop||(mark?source.bird:source.full);
  const result=await page.evaluate(async({data,crop,width,size,background,fill,maskable,mime})=>{
   const image=new Image();image.src=data;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=size||width||crop.width;canvas.height=size||Math.round(canvas.width*crop.height/crop.width);
   const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
   if(background){ctx.fillStyle=background;ctx.fillRect(0,0,canvas.width,canvas.height);}
   let scale=size?Math.min(size*fill/crop.width,size*fill/crop.height):canvas.width/crop.width;
   if(maskable)scale=Math.min(scale,size*.38/Math.hypot(crop.width/2,crop.height/2));
   ctx.drawImage(image,crop.left,crop.top,crop.width,crop.height,(canvas.width-crop.width*scale)/2,(canvas.height-crop.height*scale)/2,crop.width*scale,crop.height*scale);
   return{bytes:canvas.toDataURL(mime,.96).split(',')[1],width:canvas.width,height:canvas.height};
  },{data:'data:image/png;base64,'+sourceImage.toString('base64'),crop,width,size,background,fill,maskable,mime});
  const bytes=Buffer.from(result.bytes,'base64');await writeFile('public/brand/'+filename,bytes);
  outputs.push({filename,source:sourceImage===original?folder+'/'+manifest.filename:'docs/media/logo-blue.png',sourceSha256:createHash('sha256').update(sourceImage).digest('hex'),width:result.width,height:result.height,crop,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  return result;
 }
 const logo=await exportImage('logo.png');await exportImage('mark.png',{mark:true});
 const blue=await readFile('docs/media/logo-blue.png'),blueHash=createHash('sha256').update(blue).digest('hex'),blueVersion=blueHash.slice(0,10);
 if(blueHash!=='dabcf86f2375d3fed6d7a0b7a0c801714d51405c1bc4660b22e5c325ac5a8365'||blue.readUInt32BE(16)!==2171||blue.readUInt32BE(20)!==724)throw Error('Approved blue source checksum or geometry mismatch');
 const blueCrop=await page.evaluate(async data=>{
  const image=new Image();image.src=data;await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;let l=c.width,t=c.height,r=-1,b=-1;
  for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(p[(y*c.width+x)*4+3]>=16){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y)}
  return{left:Math.max(0,l-8),top:Math.max(0,t-8),width:Math.min(c.width,r+9)-Math.max(0,l-8),height:Math.min(c.height,b+9)-Math.max(0,t-8)};
 },'data:image/png;base64,'+blue.toString('base64'));
 // One light and one dark logo per accent: the light master recoloured for white surfaces, the lighter master for dark ones.
 const accentLogos={},accentIcons={};
 for(const accent of ACCENTS){
  const light=await recolor(master,logoColor(accent,false),true),dark=await recolor(blue,logoColor(accent,true));
  if(accent==='teal')await writeFile('docs/media/logo-teal.png',dark); // README header: the lighter variant reads on both GitHub themes
  const lightVersion=createHash('sha256').update(light).digest('hex').slice(0,10),darkVersion=createHash('sha256').update(dark).digest('hex').slice(0,10);
  for(const width of [600,1200]){
   await exportImage('logo-'+accent+'-light-'+width+'-'+lightVersion+'.webp',{width,mime:'image/webp',sourceImage:light});
   await exportImage('logo-'+accent+'-dark-'+width+'-'+darkVersion+'.webp',{width,mime:'image/webp',sourceImage:dark,sourceCrop:blueCrop});
  }
  const set=(mode,v)=>({src:'/brand/logo-'+accent+'-'+mode+'-600-'+v+'.webp',srcSet:'/brand/logo-'+accent+'-'+mode+'-600-'+v+'.webp 600w, /brand/logo-'+accent+'-'+mode+'-1200-'+v+'.webp 1200w'});
  if(accent!=='teal'){const fav='favicon-'+accent+'-32-'+lightVersion+'.png',touch='apple-touch-icon-'+accent+'-'+lightVersion+'.png';await exportImage(fav,{size:32,mark:true,fill:.96,sourceImage:light});await exportImage(touch,{size:180,mark:true,background:'#FFFFFF',fill:.8,sourceImage:light});accentIcons[accent]=[fav,touch]}
  accentLogos[accent]={light:set('light',lightVersion),dark:set('dark',darkVersion)};
 }
 for(const size of [16,32,48])await exportImage('favicon-'+size+'-'+version+'.png',{size,mark:true,fill:.96});
 await exportImage('favicon-'+version+'.png',{size:32,mark:true,fill:.96});
 for(const size of [192,512])await exportImage('app-icon-'+size+'-'+version+'.png',{size,mark:true,background:'#FFFFFF'});
 await exportImage('app-icon-maskable-512-'+version+'.png',{size:512,mark:true,background:'#FFFFFF',maskable:true});
 await exportImage('apple-touch-icon-'+version+'.png',{size:180,mark:true,background:'#FFFFFF',fill:.8});
 // PNG-backed ICO with real 16/32/48px entries, rather than one stretched image.
 const entries=await Promise.all([16,32,48].map(async size=>({size,png:await readFile('public/brand/favicon-'+size+'-'+version+'.png')})));
 const header=Buffer.alloc(6+16*entries.length);header.writeUInt16LE(1,2);header.writeUInt16LE(entries.length,4);let offset=header.length;
 entries.forEach(({size,png},i)=>{const p=6+i*16;header[p]=size;header[p+1]=size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(png.length,p+8);header.writeUInt32LE(offset,p+12);offset+=png.length;});
 const ico=Buffer.concat([header,...entries.map(x=>x.png)]);await writeFile('public/brand/favicon-'+version+'.ico',ico);
 await writeFile('public/favicon.ico',ico);
 for(const filename of ['apple-touch-icon.png','apple-touch-icon-precomposed.png'])await writeFile('public/'+filename,await readFile('public/brand/apple-touch-icon-'+version+'.png'));
 await writeFile('public/brand/asset-manifest.json',JSON.stringify({identity:manifest.identity,presentation:'Light and dark',version,operation:'Native alpha preserved; transparent-margin cropping and downsampling only. Original unchanged. Blue README variant reused for dark surfaces.',sourceAlpha:source.alpha,outputs},null,2)+'\n');
 await writeFile('public/brand/site.webmanifest',JSON.stringify({id:'/',name:'DockNest',short_name:'DockNest',description:'Backup & Restore for Self-Hosted Apps',start_url:'/',scope:'/',icons:[...[192,512].map(size=>({src:'/brand/app-icon-'+size+'-'+version+'.png',sizes:size+'x'+size,type:'image/png',purpose:'any'})),{src:'/brand/app-icon-maskable-512-'+version+'.png',sizes:'512x512',type:'image/png',purpose:'maskable'}],theme_color:'#0D786C',background_color:'#F9F9FB',display:'standalone'},null,2)+'\n');
 await writeFile('web/brand-assets.json',JSON.stringify({width:600,height:Math.round(600*logo.height/logo.width),accents:accentLogos},null,2)+'\n');
 // Drop files of earlier exports (their names carry a content hash) so public/brand holds only the current set.
 const keep=new Set([...outputs.map(x=>x.filename),'asset-manifest.json','site.webmanifest','favicon-'+version+'.ico']);
 for(const name of await readdir('public/brand'))if(!keep.has(name))await rm('public/brand/'+name);
 {const t=await readFile('public/theme-init.js','utf8'),icons={teal:['favicon-'+version+'.png','apple-touch-icon-'+version+'.png'],...accentIcons};await writeFile('public/theme-init.js',t.replace(/const ICONS=.*?;[/][/]icons/,()=>'const ICONS='+JSON.stringify(icons)+';//icons'))}
 const index=await readFile('index.html','utf8');
 await writeFile('index.html',index.replace(new RegExp('/brand/favicon(?:-[a-f0-9]+)?[.]png','g'),'/brand/favicon-'+version+'.png').replace(new RegExp('/brand/favicon(?:-[a-f0-9]+)?[.]ico','g'),'/brand/favicon-'+version+'.ico').replace(new RegExp('/brand/apple-touch-icon(?:-[a-f0-9]+)?[.]png','g'),'/brand/apple-touch-icon-'+version+'.png').replace(new RegExp('/brand/site[.]webmanifest(?:[?]v=[a-f0-9]+)?','g'),'/brand/site.webmanifest?v='+version));
 console.log(JSON.stringify({version,source,outputs:outputs.map(({filename,width,height,bytes})=>({filename,width,height,bytes}))}));
}finally{await browser.close();}
