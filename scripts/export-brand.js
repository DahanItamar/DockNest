import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Preserve the Higgsfield artwork: only crop transparent margins and downsample.
const directory = resolve('public/brand');
const sources = resolve('docs/design/ink-coral');
const logos = resolve(sources, 'logo-bottom-fix');
const utilities = resolve(sources,'utility-icons');
const utilityManifest = JSON.parse(await readFile(resolve(utilities,'asset-manifest.json'),'utf8'));
const logoManifest = JSON.parse(await readFile(resolve(logos, 'asset-manifest.json'), 'utf8'));
const atlasManifest = JSON.parse(await readFile(resolve(sources, 'asset-manifest.json'), 'utf8'));
const iconNames = ['overview','server','sites','backups','jobs','storage','schedule','download','encrypted-download','pin','restore','details','refresh','theme','access','maintenance'];
await mkdir(resolve(directory,'icons'), {recursive:true});
const browser = await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL || 'chrome',headless:true});
try {
 const page = await browser.newPage(), outputs = [];
 async function exportImage(source, output, {width,size,background,cell,rows=4,mark=false} = {}) {
  const folder=source.startsWith('logo-')?logos:source.startsWith('utility-')?utilities:sources;
  const original=await readFile(resolve(folder,source));
  const expected=[...logoManifest.assets,...atlasManifest.assets,...atlasManifest.finalRefinements,...utilityManifest.assets].find(a=>a.filename===source);
  const hash=createHash('sha256').update(original).digest('hex');
  if(!expected || hash!==expected.sha256) throw new Error(`Source checksum mismatch: ${source}`);
  const result=await page.evaluate(async ({data,width,size,background,cell,rows,mark})=>{
   const image=new Image();image.src=data;await image.decode();
   const scan=document.createElement('canvas');scan.width=image.naturalWidth;scan.height=image.naturalHeight;
   const ctx=scan.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
   const pixels=ctx.getImageData(0,0,scan.width,scan.height).data;
   const area=cell==null?{x:0,y:0,w:scan.width,h:scan.height}:{x:(cell%4)*scan.width/4,y:Math.floor(cell/4)*scan.height/rows,w:scan.width/4,h:scan.height/rows};
   let left=area.x+area.w,top=area.y+area.h,right=-1,bottom=-1;
   for(let y=area.y;y<area.y+area.h;y++)for(let x=area.x;x<area.x+area.w;x++)if(pixels[(y*scan.width+x)*4+3]>=8){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
   if(right<left)throw new Error('Empty artwork');
   if(mark){
    // A blank vertical corridor separates the original symbol and wordmark.
    const span=right-left+1;let start=-1,bestStart=-1,bestEnd=-1;
    for(let x=left+Math.floor(span*.15);x<left+Math.floor(span*.45);x++){
     let occupied=false;for(let y=top;y<=bottom;y++)if(pixels[(y*scan.width+x)*4+3]>=8){occupied=true;break;}
     if(!occupied && start<0)start=x;
     if((occupied || x===left+Math.floor(span*.45)-1) && start>=0){if(x-start>bestEnd-bestStart){bestStart=start;bestEnd=x;}start=-1;}
    }
    if(bestStart<0 || bestEnd-bestStart<20)throw new Error('Cannot isolate original logo symbol');
    right=bestStart-1;top=area.y+area.h;bottom=-1;
    for(let y=area.y;y<area.y+area.h;y++)for(let x=left;x<=right;x++)if(pixels[(y*scan.width+x)*4+3]>=8){top=Math.min(top,y);bottom=Math.max(bottom,y);}
   }
   left=Math.max(area.x,left-16);top=Math.max(area.y,top-16);right=Math.min(area.x+area.w-1,right+16);bottom=Math.min(area.y+area.h-1,bottom+16);
   const cw=right-left+1,ch=bottom-top+1,canvas=document.createElement('canvas');
   canvas.width=size||Math.min(width,cw);canvas.height=size||Math.round(canvas.width*ch/cw);
   const out=canvas.getContext('2d');out.imageSmoothingEnabled=true;out.imageSmoothingQuality='high';
   if(background){out.fillStyle=background;out.fillRect(0,0,canvas.width,canvas.height);}
   const scale=size?Math.min(size*.85/cw,size*.85/ch):canvas.width/cw;
   out.drawImage(image,left,top,cw,ch,(canvas.width-cw*scale)/2,(canvas.height-ch*scale)/2,cw*scale,ch*scale);
   return {png:canvas.toDataURL('image/png').split(',')[1],width:canvas.width,height:canvas.height,crop:{left,top,width:cw,height:ch}};
  },{data:`data:image/png;base64,${original.toString('base64')}`,width,size,background,cell,rows,mark});
  await writeFile(resolve(directory,output),Buffer.from(result.png,'base64'));
  outputs.push({filename:output,source:resolve(folder,source).replace(resolve('.')+'\\','').replaceAll('\\','/'),sourceSha256:hash,width:result.width,height:result.height,crop:result.crop});
 }
 for(const theme of ['light','dark']){
  for(const variant of ['horizontal','tagline'])await exportImage(`logo-${variant}-${theme}.png`,`logo-${variant}-${theme}.png`,{width:1200});
  await exportImage(`logo-horizontal-${theme}.png`,`mark-${theme}.png`,{width:1024,mark:true});
  for(const [cell,name] of iconNames.entries())await exportImage(`icons-${theme}-atlas.png`,`icons/${name}-${theme}.png`,{size:128,cell});
 }
 for(const theme of ['light','dark'])for(const [cell,name] of ['readiness','edit','remove','deploy','pause','resume','audit','terminal'].entries())await exportImage(`utility-${theme}-atlas.png`,`icons/${name}-${theme}.png`,{size:128,cell,rows:2});
 for(const size of [16,32,192,512])await exportImage('logo-horizontal-dark.png',`app-icon-${size}.png`,{size,background:'#161C25',mark:true});
 await exportImage('logo-horizontal-dark.png','apple-touch-icon.png',{size:180,background:'#161C25',mark:true});
 await exportImage('logo-horizontal-dark.png','favicon.png',{size:32,background:'#161C25',mark:true});
 const png=await readFile(resolve(directory,'favicon.png')),header=Buffer.alloc(22);
 header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=32;header[7]=32;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
 await writeFile(resolve(directory,'favicon.ico'),Buffer.concat([header,png]));
 await writeFile(resolve(directory,'asset-manifest.json'),JSON.stringify({identity:'DockNest / Nestweave B / Ink & Coral',operation:'Transparent-margin cropping and downsampling only; original artwork unchanged.',outputs},null,2)+'\n');
 console.log(`Exported ${outputs.length} logo and icon assets from checksum-verified Higgsfield originals.`);
}finally{await browser.close();}
