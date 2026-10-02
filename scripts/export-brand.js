import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const folder='docs/design/berry-brand',manifest=JSON.parse(await readFile(folder+'/asset-manifest.json','utf8')),original=await readFile(folder+'/'+manifest.filename);
const hash=createHash('sha256').update(original).digest('hex');if(hash!==manifest.sha256)throw Error('Source checksum mismatch');
const browser=await chromium.launch({channel:'chrome',headless:true}),outputs=[];
try{
 const page=await browser.newPage();
 async function exportImage(filename,{width=1200,size,mark=false,background}={}){
  const result=await page.evaluate(async({data,width,size,mark,background})=>{
   const image=new Image();image.src=data;await image.decode();const scan=document.createElement('canvas');scan.width=image.naturalWidth;scan.height=image.naturalHeight;const ctx=scan.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,scan.width,scan.height).data;
   let left=scan.width,top=scan.height,right=-1,bottom=-1;
   for(let y=0;y<scan.height;y++)for(let x=0;x<scan.width;x++)if(pixels[(y*scan.width+x)*4+3]>=8){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}
   if(mark){
    let start=-1,bestStart=-1,bestEnd=-1;const span=right-left;
    for(let x=left+Math.floor(span*.15);x<left+Math.floor(span*.5);x++){let occupied=false;for(let y=top;y<=bottom;y++)if(pixels[(y*scan.width+x)*4+3]>=8){occupied=true;break}if(!occupied&&start<0)start=x;if((occupied||x===left+Math.floor(span*.5)-1)&&start>=0){if(x-start>bestEnd-bestStart){bestStart=start;bestEnd=x}start=-1}}
    if(bestStart<0||bestEnd-bestStart<10)throw Error('Logo symbol corridor not found');right=bestStart-1;top=scan.height;bottom=-1;for(let y=0;y<scan.height;y++)for(let x=left;x<=right;x++)if(pixels[(y*scan.width+x)*4+3]>=8){top=Math.min(top,y);bottom=Math.max(bottom,y)}
   }
   left=Math.max(0,left-16);top=Math.max(0,top-16);right=Math.min(scan.width-1,right+16);bottom=Math.min(scan.height-1,bottom+16);const cw=right-left+1,ch=bottom-top+1,canvas=document.createElement('canvas');canvas.width=size||width;canvas.height=size||Math.round(width*ch/cw);const out=canvas.getContext('2d');out.imageSmoothingEnabled=true;out.imageSmoothingQuality='high';if(background){out.fillStyle=background;out.fillRect(0,0,canvas.width,canvas.height)}const scale=size?Math.min(size*.85/cw,size*.85/ch):width/cw;out.drawImage(image,left,top,cw,ch,(canvas.width-cw*scale)/2,(canvas.height-ch*scale)/2,cw*scale,ch*scale);return{png:canvas.toDataURL('image/png').split(',')[1],width:canvas.width,height:canvas.height,crop:{left,top,width:cw,height:ch}};
  },{data:'data:image/png;base64,'+original.toString('base64'),width,size,mark,background});
  const bytes=Buffer.from(result.png,'base64');await writeFile('public/brand/'+filename,bytes);outputs.push({filename,source:folder+'/'+manifest.filename,sourceSha256:hash,width:result.width,height:result.height,crop:result.crop,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 await exportImage('logo.png');await exportImage('mark.png',{width:1024,mark:true});
 for(const size of [16,32,192,512])await exportImage('app-icon-'+size+'.png',{size,mark:true,background:'#FFFFFF'});
 await exportImage('apple-touch-icon.png',{size:180,mark:true,background:'#FFFFFF'});await exportImage('favicon.png',{size:32,mark:true,background:'#FFFFFF'});
 const png=await readFile('public/brand/favicon.png'),header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=32;header[7]=32;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);await writeFile('public/brand/favicon.ico',Buffer.concat([header,png]));
 await writeFile('public/brand/asset-manifest.json',JSON.stringify({identity:'DockNest / Nestweave B / Berry',presentation:'Light only',operation:'Native transparent-margin cropping and downsampling only; Higgsfield original unchanged.',outputs},null,2)+'\n');
 await writeFile('public/brand/site.webmanifest',JSON.stringify({name:'DockNest',short_name:'DockNest',icons:[{src:'/brand/app-icon-192.png',sizes:'192x192',type:'image/png'},{src:'/brand/app-icon-512.png',sizes:'512x512',type:'image/png'}],theme_color:'#673AB7',background_color:'#EEF2F6',display:'standalone'},null,2)+'\n');
 console.log('Exported new Berry logo, original symbol and application icons.');
}finally{await browser.close()}
