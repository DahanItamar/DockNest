import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Export the user-approved purple rasters; never recolor or redraw their glyphs.
const folder='docs/design/logo-purple-preview';
const approved={
 full:{filename:'logo-purple-full.png',sha256:'fe02431615e5b607b7c6ce62d000219156efcb8ca0ecf2a1a9ebee146ca59d2a',width:2171,height:724},
 logo:{filename:'logo-purple-web.png',sha256:'1167530b8448ef7201c359658892090184973cfc6f735b64b5913c00c31237c3',width:2015,height:395},
 mark:{filename:'mark-purple.png',sha256:'2aa3cbbf02ce09923c2df396da63307e33910b1d6fa7717a0f3d042cc3b49bdf',width:476,height:395}
};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const images={};
for(const [key,asset]of Object.entries(approved)){
 const bytes=await readFile(folder+'/'+asset.filename);
 if(hash(bytes)!==asset.sha256)throw Error('Approved '+key+' source checksum mismatch');
 if(bytes.readUInt32BE(16)!==asset.width||bytes.readUInt32BE(20)!==asset.height)throw Error('Approved '+key+' dimensions mismatch');
 images[key]=bytes;
}
const version=approved.full.sha256.slice(0,10),outputs=[];
function record(filename,bytes,key,width,height,extra={}){
 const asset=approved[key];
 outputs.push({filename,source:folder+'/'+asset.filename,sourceSha256:asset.sha256,width,height,bytes:bytes.length,sha256:hash(bytes),...extra});
}
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();
 // Keep native PNG files byte-for-byte equal to the accepted previews.
 for(const [key,filename]of [['logo','logo.png'],['mark','mark.png']]){
  await writeFile('public/brand/'+filename,images[key]);
  record(filename,images[key],key,approved[key].width,approved[key].height,{operation:'Byte-for-byte approved native PNG'});
 }
 await writeFile('docs/media/logo-purple.png',images.full);
 async function exportImage(filename,{width,size,mark=false,background,fill=.82,maskable=false,mime='image/png'}={}){
  const key=mark?'mark':'logo',asset=approved[key],crop={left:0,top:0,width:asset.width,height:asset.height};
  const result=await page.evaluate(async({data,crop,width,size,background,fill,maskable,mime})=>{
   const image=new Image();image.src=data;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=size||width||crop.width;canvas.height=size||Math.round(canvas.width*crop.height/crop.width);
   const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
   if(background){ctx.fillStyle=background;ctx.fillRect(0,0,canvas.width,canvas.height);}
   let scale=size?Math.min(size*fill/crop.width,size*fill/crop.height):canvas.width/crop.width;
   if(maskable)scale=Math.min(scale,size*.38/Math.hypot(crop.width/2,crop.height/2));
   ctx.drawImage(image,0,0,crop.width,crop.height,(canvas.width-crop.width*scale)/2,(canvas.height-crop.height*scale)/2,crop.width*scale,crop.height*scale);
   return{bytes:canvas.toDataURL(mime,.96).split(',')[1],width:canvas.width,height:canvas.height};
  },{data:'data:image/png;base64,'+images[key].toString('base64'),crop,width,size,background,fill,maskable,mime});
  const bytes=Buffer.from(result.bytes,'base64');await writeFile('public/brand/'+filename,bytes);
  record(filename,bytes,key,result.width,result.height,{crop,background,maskable,operation:'Downsample/fit approved source; no recoloring or glyph redraw'});
 }
 for(const width of [600,1200])await exportImage('logo-purple-'+width+'-'+version+'.webp',{width,mime:'image/webp'});
 for(const size of [16,32,48])await exportImage('favicon-'+size+'-'+version+'.png',{size,mark:true,fill:.96});
 await exportImage('favicon-'+version+'.png',{size:32,mark:true,fill:.96});
 for(const size of [192,512])await exportImage('app-icon-'+size+'-'+version+'.png',{size,mark:true,background:'#FFFFFF'});
 await exportImage('app-icon-maskable-512-'+version+'.png',{size:512,mark:true,background:'#FFFFFF',maskable:true});
 await exportImage('apple-touch-icon-'+version+'.png',{size:180,mark:true,background:'#FFFFFF',fill:.8});
 const entries=await Promise.all([16,32,48].map(async size=>({size,png:await readFile('public/brand/favicon-'+size+'-'+version+'.png')})));
 const header=Buffer.alloc(6+16*entries.length);header.writeUInt16LE(1,2);header.writeUInt16LE(entries.length,4);let offset=header.length;
 entries.forEach(({size,png},i)=>{const p=6+i*16;header[p]=size;header[p+1]=size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(png.length,p+8);header.writeUInt32LE(offset,p+12);offset+=png.length;});
 const ico=Buffer.concat([header,...entries.map(x=>x.png)]);await writeFile('public/brand/favicon-'+version+'.ico',ico);
 record('favicon-'+version+'.ico',ico,'mark',48,48,{sizes:[16,32,48],operation:'PNG-backed ICO with real 16/32/48 entries'});
 await writeFile('public/favicon.ico',ico);
 for(const filename of ['apple-touch-icon.png','apple-touch-icon-precomposed.png'])await writeFile('public/'+filename,await readFile('public/brand/apple-touch-icon-'+version+'.png'));
 await writeFile('public/brand/asset-manifest.json',JSON.stringify({identity:'DockNest / Homebird',color:'#673AB7',presentation:'Approved full purple logo in light and dark themes',version,approvedSources:approved,operation:'Approved PNG sources reused unchanged; responsive downsampling and centered icon fitting only. Original blue master retained.',outputs},null,2)+'\n');
 await writeFile('public/brand/site.webmanifest',JSON.stringify({id:'/',name:'DockNest',short_name:'DockNest',description:'Docker Backup & Restore',start_url:'/',scope:'/',icons:[...[192,512].map(size=>({src:'/brand/app-icon-'+size+'-'+version+'.png',sizes:size+'x'+size,type:'image/png',purpose:'any'})),{src:'/brand/app-icon-maskable-512-'+version+'.png',sizes:'512x512',type:'image/png',purpose:'maskable'}],theme_color:'#673AB7',background_color:'#EEF2F6',display:'standalone'},null,2)+'\n');
 const src='/brand/logo-purple-600-'+version+'.webp',srcSet=src+' 600w, /brand/logo-purple-1200-'+version+'.webp 1200w';
 await writeFile('web/brand-assets.json',JSON.stringify({src,srcSet,darkSrc:src,darkSrcSet:srcSet,width:600,height:Math.round(600*approved.logo.height/approved.logo.width)},null,2)+'\n');
 const index=await readFile('index.html','utf8');
 await writeFile('index.html',index.replace(new RegExp('/brand/favicon(?:-[a-f0-9]+)?[.]png','g'),'/brand/favicon-'+version+'.png').replace(new RegExp('/brand/favicon(?:-[a-f0-9]+)?[.]ico','g'),'/brand/favicon-'+version+'.ico').replace(new RegExp('/brand/apple-touch-icon(?:-[a-f0-9]+)?[.]png','g'),'/brand/apple-touch-icon-'+version+'.png').replace(new RegExp('/brand/site[.]webmanifest(?:[?]v=[a-f0-9]+)?','g'),'/brand/site.webmanifest?v='+version));
 console.log(JSON.stringify({version,outputs:outputs.map(({filename,width,height,bytes})=>({filename,width,height,bytes}))}));
}finally{await browser.close();}
