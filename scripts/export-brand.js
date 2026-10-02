import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Export the approved raster. Never redraw or independently regenerate glyphs.
const folder='docs/design/homebird-brand';
const manifest=JSON.parse(await readFile(folder+'/asset-manifest.json','utf8'));
const original=await readFile(folder+'/'+manifest.filename);
const hash=createHash('sha256').update(original).digest('hex');
if(hash!==manifest.sha256)throw Error('Source checksum mismatch');
const version=hash.slice(0,10),outputs=[];
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();
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
 async function exportImage(filename,{width,size,mark=false,background,fill=.82,maskable=false,mime='image/png'}={}){
  const crop=mark?source.bird:source.full;
  const result=await page.evaluate(async({data,crop,width,size,background,fill,maskable,mime})=>{
   const image=new Image();image.src=data;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=size||width||crop.width;canvas.height=size||Math.round(canvas.width*crop.height/crop.width);
   const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
   if(background){ctx.fillStyle=background;ctx.fillRect(0,0,canvas.width,canvas.height);}
   let scale=size?Math.min(size*fill/crop.width,size*fill/crop.height):canvas.width/crop.width;
   if(maskable)scale=Math.min(scale,size*.38/Math.hypot(crop.width/2,crop.height/2));
   ctx.drawImage(image,crop.left,crop.top,crop.width,crop.height,(canvas.width-crop.width*scale)/2,(canvas.height-crop.height*scale)/2,crop.width*scale,crop.height*scale);
   return{bytes:canvas.toDataURL(mime,.96).split(',')[1],width:canvas.width,height:canvas.height};
  },{data:'data:image/png;base64,'+original.toString('base64'),crop,width,size,background,fill,maskable,mime});
  const bytes=Buffer.from(result.bytes,'base64');await writeFile('public/brand/'+filename,bytes);
  outputs.push({filename,source:folder+'/'+manifest.filename,sourceSha256:hash,width:result.width,height:result.height,crop,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  return result;
 }
 const logo=await exportImage('logo.png');await exportImage('mark.png',{mark:true});
 for(const width of [600,1200])await exportImage('logo-'+width+'-'+version+'.webp',{width,mime:'image/webp'});
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
 await writeFile('public/brand/asset-manifest.json',JSON.stringify({identity:manifest.identity,presentation:'Light only',version,operation:'Native alpha preserved; transparent-margin cropping and downsampling only. Original unchanged.',sourceAlpha:source.alpha,outputs},null,2)+'\n');
 await writeFile('public/brand/site.webmanifest',JSON.stringify({id:'/',name:'DockNest',short_name:'DockNest',description:'Docker Backup & Restore',start_url:'/',scope:'/',icons:[...[192,512].map(size=>({src:'/brand/app-icon-'+size+'-'+version+'.png',sizes:size+'x'+size,type:'image/png',purpose:'any'})),{src:'/brand/app-icon-maskable-512-'+version+'.png',sizes:'512x512',type:'image/png',purpose:'maskable'}],theme_color:'#673AB7',background_color:'#EEF2F6',display:'standalone'},null,2)+'\n');
 await writeFile('web/brand-assets.json',JSON.stringify({src:'/brand/logo-600-'+version+'.webp',srcSet:'/brand/logo-600-'+version+'.webp 600w, /brand/logo-1200-'+version+'.webp 1200w',width:600,height:Math.round(600*logo.height/logo.width)},null,2)+'\n');
 const index=await readFile('index.html','utf8');
 await writeFile('index.html',index.replace(new RegExp('/brand/favicon(?:-[a-f0-9]+)?[.]png','g'),'/brand/favicon-'+version+'.png').replace(new RegExp('/brand/favicon(?:-[a-f0-9]+)?[.]ico','g'),'/brand/favicon-'+version+'.ico').replace(new RegExp('/brand/apple-touch-icon(?:-[a-f0-9]+)?[.]png','g'),'/brand/apple-touch-icon-'+version+'.png').replace(new RegExp('/brand/site[.]webmanifest(?:[?]v=[a-f0-9]+)?','g'),'/brand/site.webmanifest?v='+version));
 console.log(JSON.stringify({version,source,outputs:outputs.map(({filename,width,height,bytes})=>({filename,width,height,bytes}))}));
}finally{await browser.close();}
