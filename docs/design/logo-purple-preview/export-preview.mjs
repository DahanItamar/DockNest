import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import {chromium} from '@playwright/test';
const folder=fileURLToPath(new URL('.',import.meta.url)),root=new URL('../../../',import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const alpha=png=>Buffer.from(Array.from({length:png.width*png.height},(_,i)=>png.data[i*4+3]));
const sources=[['docs/media/logo-blue.png','logo-purple-full.png'],['public/brand/logo.png','logo-purple-web.png'],['public/brand/mark.png','mark-purple.png']];
const outputs=[];
for(const[source,filename]of sources){
 const original=await readFile(new URL(source,root)),png=PNG.sync.read(original),sourceAlpha=alpha(png);
 for(let i=0;i<png.data.length;i+=4){const visible=png.data[i+3]>0;png.data[i]=visible?103:0;png.data[i+1]=visible?58:0;png.data[i+2]=visible?183:0;}
 const bytes=PNG.sync.write(png);await writeFile(folder+filename,bytes);
 const result=PNG.sync.read(bytes),resultAlpha=alpha(result);let changedAlphaPixels=0;
 for(let i=0;i<sourceAlpha.length;i++)if(sourceAlpha[i]!==resultAlpha[i])changedAlphaPixels++;
 if(changedAlphaPixels||result.width!==png.width||result.height!==png.height)throw Error('Logo geometry changed');
 outputs.push({filename,source,width:result.width,height:result.height,sha256:hash(bytes),sourceSha256:hash(original),alphaSha256:hash(resultAlpha),changedAlphaPixels,operation:'Set RGB to #673AB7; preserve every original alpha byte and canvas dimensions'});
}
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage(),mark=await readFile(folder+'mark-purple.png');
 for(const[size,filename,background,fill]of[[32,'favicon-purple-32.png',null,.96],[48,'favicon-purple-48.png',null,.96],[512,'app-icon-purple-512.png','#FFFFFF',.82]]){
  const data=await page.evaluate(async({source,size,background,fill})=>{
   const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
   const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
   if(background){ctx.fillStyle=background;ctx.fillRect(0,0,size,size);}
   const scale=Math.min(size*fill/image.width,size*fill/image.height);ctx.drawImage(image,(size-image.width*scale)/2,(size-image.height*scale)/2,image.width*scale,image.height*scale);
   return canvas.toDataURL('image/png').split(',')[1];
  },{source:'data:image/png;base64,'+mark.toString('base64'),size,background,fill});
  const bytes=Buffer.from(data,'base64');await writeFile(folder+filename,bytes);
  outputs.push({filename,source:'mark-purple.png',width:size,height:size,sha256:hash(bytes),operation:'Downsample unchanged mark geometry for preview only',background});
 }
}finally{await browser.close();}
await writeFile(folder+'verification.json',JSON.stringify({previewOnly:true,color:'#673AB7',geometry:'Native full logo, web logo and mark alpha verified pixel-for-pixel identical to their sources',imagegen:{mode:'Built-in edit; color direction draft only',reason:'Generated canvas was 2173x724 versus source 2171x724. Exact final assets retain original source alpha and dimensions.'},outputs},null,2)+'\n');
console.log(JSON.stringify(outputs.map(({filename,width,height,changedAlphaPixels})=>({filename,width,height,changedAlphaPixels})),null,2));

